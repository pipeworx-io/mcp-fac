# @pipeworx/fac

Federal Audit Clearinghouse MCP — US single-audit filings (Uniform Guidance, formerly OMB A-133): who spends federal grant money, under which Assistance Listing program, and what the auditors found. api.data.gov key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `fac_search_audits(auditee_name|uei|ein|state|zip|audit_year|min_total_expended, ...)` — find audits; returns report_id, organization identity (including the ZIP on file), total federal awards expended, oversight agency, FAC acceptance date.
- `fac_get_audit(report_id, ...)` — one audit plus every federal program row on its Schedule of Expenditures of Federal Awards (Assistance Listing number, program name, dollars expended, major-program flag, opinion type), auditee/auditor contact detail, and findings when FAC carries them.
- `fac_audit_findings(report_id | auditee_name | uei, ...)` — findings recorded against an audit, or swept across every audit one recipient filed, rolled up into a severity summary (material weaknesses, significant deficiencies, questioned costs, repeat findings, modified opinions). `include_text` attaches the narrative finding text.
- `fac_federal_awards_by_program(cfda | federal_agency_prefix + federal_award_extension, ...)` — who expended money under a CFDA number (e.g. `93.224`), ranked by dollars, joined to recipient name/state/year.
- `fac_recipient_audit_history(uei | auditee_name | ein, ...)` — one recipient's audits year by year with total expended per year and a percent-change read on the trend.

Forgiving aliases throughout: `query` / `q` / `name` for `auditee_name`; `zip` / `auditee_zip` / `zipcode` / `zip_code` / `postal_code`; `cfda` / `program_number` / `assistance_listing` / `program` all accept `"93.224"`, `"93-224"`, `"93224"`, or a bare `"93"` for every program at that agency.

**An argument this pack does not recognize is reported, not dropped.** Any unknown key comes back in `ignored_arguments` with a `warnings` line saying the filter was not applied and listing what the tool does accept. Silently discarding the most specific thing a caller said is worse than erroring, because the response still looks like an answer.

## Auth

Platform key (`PLATFORM_DATAGOV_KEY`) with BYO fallback via `?_apiKey=<key>`.

This is an **api.data.gov umbrella key** — the same key works across every federal API behind the umbrella. Register free at https://api.data.gov/signup. Sent as the `X-Api-Key` header. A registered key gets 1,000 requests/hour; `DEMO_KEY` works for smoke tests but caps around 30/hour and 50/day **per source IP**.

## Data sources

- `https://api.fac.gov/general` — one row per accepted audit submission (auditee identity, audit year, total federal awards expended, oversight agency, acceptance date)
- `https://api.fac.gov/federal_awards` — one row per federal program inside an audit (agency prefix + award extension, program name, amount expended, major-program flag, report type)
- `https://api.fac.gov/findings` — audit findings per report; carries `auditee_uei` and `audit_year` alongside `report_id`, plus the `is_material_weakness` / `is_repeat_finding` / `is_questioned_costs` Y-N flags and `type_requirement`
- `https://api.fac.gov/findings_text` — narrative finding text, keyed `report_id` + `finding_ref_number` (attached only when `include_text: true`)
- API docs: https://www.fac.gov/developers/ · Assistance Listing lookup: https://sam.gov/content/assistance-listings

### Name and ZIP matching

**ZIP is stored in two encodings and must be prefix-matched.** `auditee_zip` holds 5 digits (`75082`) for some rows and 9-digit ZIP+4 with no separator (`009601588`, `750814198`) for others, so `eq.` misses most of the table — a Puerto Rico caller passing `00960` would match nothing at all. The pack filters on the 5-digit prefix (`auditee_zip=like.00960*`), which is the only part both encodings share, and accepts ZIP+4 input by truncating it.

**An auditee's ZIP on file changes between filing years.** CITY OF RICHARDSON TX is filed under `75080` (2018–2021), `75083` (2022) and `75082` (2025) — all the same UEI. So a current ZIP legitimately fails to match an older audit. When a `zip` filter empties an otherwise-matching result, the pack re-asks without it and returns `reason: 'zip_no_match'` naming the ZIPs FAC actually holds for that entity, rather than a bare miss the caller cannot diagnose.

**Puerto Rico municipalities are filed in BOTH languages, and which one depends on the submission year.** FAC holds `MUNICIPALITY OF BAYAMON` and `MUNICIPALITY OF SAN JUAN`, but also `MUNICIPIO DE MANATI`, `MUNICIPIO DE CAMUY`, `MUNICIPIO DE NARANJITO` — and Corozal appears as `MUNICIPIO DE COROZAL` for 2019 and `MUNICIPALITY OF COROZAL` for 2017–2024, from the same entity. A caller working from a Puerto Rico government source has the Spanish legal name, which no substring of the English row contains; a one-way rewrite to English would have lost the Spanish rows instead. The pack detects a municipality name in either language (`MUNICIPIO DE X`, `MUNICIPIO AUTONOMO DE X`, `MUNICIPALIDAD DE X`, `(AUTONOMOUS) MUNICIPALITY OF X`), extracts the place, and queries **both** spellings in one PostgREST `or=(...)`, echoing what it did in `name_match`.

**Place names carry their Spanish accents, inconsistently.** FAC holds `MUNICIPALITY OF AÑASCO` (and in one row the mojibaked `MUNICIPALITY OF A?ASCO`) *and* the plain `MUNICIPIO DE ANASCO`, so **neither spelling finds all of them**: ASCII `ANASCO` returns 1 audit, accented `AÑASCO` returns 4, and the entity has 5. Each place pattern therefore also goes out accent-blind, with the letters that can carry a Spanish accent replaced by LIKE's single-character wildcard (`Municipality of ___SC_`); the surviving consonants and the fixed length keep it specific.

This rides in the **primary** query rather than as a retry-on-empty, and that distinction is the whole point: a retry only fires when the literal spelling found *nothing*, but the actual failure is that it finds *some* — a partial answer wearing the shape of a complete one. `or=(...)` is a single SQL predicate, so the extra branches union without duplicating rows or costing a second round trip.

Gotchas. **The umbrella lies about status codes:** api.data.gov reports throttling as a body carrying `OVER_RATE_LIMIT` that arrives with **HTTP 200 as often as HTTP 429**, so every response body is inspected before it is treated as data — a status-only check silently hands an error object back to the caller as if it were rows. That body is usually JSON (`{"error":{"code":"OVER_RATE_LIMIT",...}}`) but the umbrella **also serves an HTML error page with the same code**, so the raw text is scanned for the known umbrella codes too; without that, an HTML 200 reads as a malformed response instead of the plain "you are throttled" it actually is. Relatedly, **a 2xx whose body is not a JSON array is treated as an upstream failure, never as an empty table** — returning "no rows" for a broken response is the worst possible answer to a diligence question, and it is exactly what a naive `Array.isArray(body) ? body : []` does. **api.fac.gov also emits HTTP 408** ("Oops... Request Timeout") under load rather than queueing, which is called out as a retry rather than a client error. **It is a PostgREST API**, so filters are operator-prefixed (`?auditee_name=ilike.*stanford*`, `?audit_year=eq.2023`, `?total_amount_expended=gte.1000000`) and an unknown column produces a 400, not an ignored parameter; that is why the supplementary lookups (`/findings`, `/findings_text` — both verified live) degrade to an `available: false` note rather than throwing: a renamed table must not take the primary answer down with it. **`federal_agency_prefix` and `federal_award_extension` are stored separately** and only mean something concatenated: prefix `93` + extension `224` is Assistance Listing `93.224`, so callers who pass the dotted number get it split for them and every response echoes `assistance_listing` back. The extension is stored **zero-padded to three characters** (`47.076`, never `47.76`), so a numeric extension is padded before it is sent — an unpadded one matches nothing rather than erroring. **Every numeric-looking column is text:** `audit_year` comes back as `"2023"`, and the Y/N flags are single-character strings, so values are coerced on the way out and `eq.` filters are written against the text form. **`/federal_awards` carries no auditee columns** — recipient name, state and audit year live on `/general`, so `fac_federal_awards_by_program` joins the two by `report_id`; when a `state` or `audit_year` filter is set it over-fetches the top rows by dollar amount and filters after the join, and reports `rows_scanned` so a caller can tell a deeper scan is needed. Finally, **zero findings is an answer, not a gap**: a clean single audit legitimately has no rows in `/findings`, which is returned as `found: false, reason: 'no_findings'` with the audits that were checked, distinct from `reason: 'findings_table_unavailable'`. Entities spending under the ~$750k/yr federal threshold never file at all, so an absent organization is usually below threshold rather than missing.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fac": {
      "url": "https://gateway.pipeworx.io/fac/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fac/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fac data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
