# @pipeworx/fac

Federal Audit Clearinghouse MCP — US single-audit filings (Uniform Guidance, formerly OMB A-133): who spends federal grant money, under which Assistance Listing program, and what the auditors found. api.data.gov key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `fac_search_audits(auditee_name|uei|ein|state|audit_year|min_total_expended, ...)` — find audits; returns report_id, organization identity, total federal awards expended, oversight agency, FAC acceptance date.
- `fac_get_audit(report_id, ...)` — one audit plus every federal program row on its Schedule of Expenditures of Federal Awards (Assistance Listing number, program name, dollars expended, major-program flag, opinion type), auditee/auditor contact detail, and findings when FAC carries them.
- `fac_audit_findings(report_id | auditee_name | uei, ...)` — findings recorded against an audit, or swept across every audit one recipient filed, rolled up into a severity summary (material weaknesses, significant deficiencies, questioned costs, repeat findings, modified opinions). `include_text` attaches the narrative finding text.
- `fac_federal_awards_by_program(cfda | federal_agency_prefix + federal_award_extension, ...)` — who expended money under a CFDA number (e.g. `93.224`), ranked by dollars, joined to recipient name/state/year.
- `fac_recipient_audit_history(uei | auditee_name | ein, ...)` — one recipient's audits year by year with total expended per year and a percent-change read on the trend.

Forgiving aliases throughout: `query` / `q` / `name` for `auditee_name`; `cfda` / `program_number` / `assistance_listing` / `program` all accept `"93.224"`, `"93-224"`, `"93224"`, or a bare `"93"` for every program at that agency.

## Auth

Platform key (`PLATFORM_DATAGOV_KEY`) with BYO fallback via `?_apiKey=<key>`.

This is an **api.data.gov umbrella key** — the same key works across every federal API behind the umbrella. Register free at https://api.data.gov/signup. Sent as the `X-Api-Key` header. A registered key gets 1,000 requests/hour; `DEMO_KEY` works for smoke tests but caps around 30/hour and 50/day **per source IP**.

## Data sources

- `https://api.fac.gov/general` — one row per accepted audit submission (auditee identity, audit year, total federal awards expended, oversight agency, acceptance date)
- `https://api.fac.gov/federal_awards` — one row per federal program inside an audit (agency prefix + award extension, program name, amount expended, major-program flag, report type)
- `https://api.fac.gov/findings` — audit findings per report; carries `auditee_uei` and `audit_year` alongside `report_id`, plus the `is_material_weakness` / `is_repeat_finding` / `is_questioned_costs` Y-N flags and `type_requirement`
- `https://api.fac.gov/findings_text` — narrative finding text, keyed `report_id` + `finding_ref_number` (attached only when `include_text: true`)
- API docs: https://www.fac.gov/developers/ · Assistance Listing lookup: https://sam.gov/content/assistance-listings

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Fac data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
