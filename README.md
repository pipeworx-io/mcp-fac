# @pipeworx/fac

Federal Audit Clearinghouse MCP — US single-audit filings (Uniform Guidance, formerly OMB A-133): who spends federal grant money, under which Assistance Listing program, and what the auditors found. Backed by a weekly-refreshed copy of FAC's own bulk data (fleet #2504) — **no API key needed.**

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1864+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `fac_search_audits(auditee_name|uei|ein|state|zip|audit_year|min_total_expended, ...)` — find audits; returns report_id, organization identity (including the ZIP on file), total federal awards expended, oversight agency, FAC acceptance date.
- `fac_get_audit(report_id, ...)` — one audit plus every federal program row on its Schedule of Expenditures of Federal Awards (Assistance Listing number, program name, dollars expended, major-program flag, opinion type), auditor firm, and findings when FAC carries them.
- `fac_audit_findings(report_id | auditee_name | uei, ...)` — findings recorded against an audit, or swept across every audit one recipient filed, rolled up into a severity summary (material weaknesses, significant deficiencies, questioned costs, repeat findings, modified opinions). `include_text` attaches the narrative finding text.
- `fac_federal_awards_by_program(cfda | federal_agency_prefix + federal_award_extension, ...)` — who expended money under a CFDA number (e.g. `93.224`), ranked by dollars, joined to recipient name/state/year.
- `fac_recipient_audit_history(uei | auditee_name | ein, ...)` — one recipient's audits year by year with total expended per year and a percent-change read on the trend.
- `fac_findings_search(query, ...)` — **NEW.** Full-text search over finding narratives ("failed to submit... within the timeframe prescribed", "questioned costs"). Not expressible against the live FAC API at all (no cross-table join); backed by a Postgres `websearch_to_tsquery` RPC (`fac_findings_search`) over a GIN-indexed tsvector column.
- `fac_cross_table_screen(state | cfda | finding_type | material_weakness_only | min_amount | audit_year, ...)` — **NEW.** Screens audits across state, CFDA program and finding type in one call ("material weaknesses in Texas under CFDA 93.224"). Backed by a 3-way SQL join RPC (`fac_cross_table_screen`) across `fac_general` + `fac_federal_awards` + `fac_findings`.

Forgiving aliases throughout: `query` / `q` / `name` for `auditee_name`; `zip` / `auditee_zip` / `zipcode` / `zip_code` / `postal_code`; `cfda` / `program_number` / `assistance_listing` / `program` all accept `"93.224"`, `"93-224"`, `"93224"`, or a bare `"93"` for every program at that agency.

**An argument this pack does not recognize is reported, not dropped.** Any unknown key comes back in `ignored_arguments` with a `warnings` line saying the filter was not applied and listing what the tool does accept. Silently discarding the most specific thing a caller said is worse than erroring, because the response still looks like an answer.

**Every response carries `data_as_of`** — the timestamp of the last successful refresh (from `fac_ingest_runs`). Before the first refresh completes it is `null` and the response adds a `coverage_status` note saying so, rather than silently returning an empty result that looks like "no audits exist".

## Why this data is loaded ahead of time (fleet #2504)

This pack used to call `api.fac.gov` (a PostgREST API fronted by the api.data.gov umbrella) live on every request. Measured 60 days to 2026-09-29: `fac_search_audits` was `upstream_down` on 572 of ~1,620 external calls (35%, 3.9s average latency) — the single largest `ask_pipeworx` no-match cluster in the catalog (roughly 25 distinct question shapes: name+state+ZIP variants, report_id lookups, "audits with findings about X"). Separately, `api.fac.gov`'s own PostgREST exposes **no foreign key between `/general` and `/findings`** (`PGRST200` on any embed attempt), so a cross-table question like "material weaknesses in Texas under CFDA 93.224" was structurally impossible against the live API, not merely slow.

Per Bruce's 2026-09-23 ruling ("build a copy when live doesn't serve / is too slow"), the pack now reads its own periodically-refreshed table instead. Refreshed weekly by `scripts/fac-upsert.sh`, scheduled by `.github/workflows/fac-refresh.yml`. Schema + RPCs: `supabase/migrations/220_fac_local_mirror.sql`.

**Tables loaded:** `general`, `federal_awards`, `findings`, `findings_text`, `corrective_action_plans` (as `fac_general`, `fac_federal_awards`, `fac_findings`, `fac_findings_text`, `fac_corrective_action_plans`). **NOT loaded yet** (out of #2504's scope, a future extension, not a silent gap): `notes_to_sefa` (725MB), `passthrough` (559MB), and the small `additional_ueis`/`additional_eins`/`secondary_auditors` tables.

### No personal data

FAC's `general.csv` extract carries named-individual contact fields — auditee/auditor **CERTIFY name+title**, **CONTACT name+title**, **email**, **phone**. **None of those are loaded.** Organizational identity (`auditee_name`, `auditor_firm_name`, addresses, EINs) is kept — it identifies the entity filing a mandatory federal compliance disclosure, not a private individual, and is the same class of data the `samgov` and `fed-nic` packs already carry. `fac_get_audit` used to also surface auditee contact name/email/phone when proxying the live API (`GENERAL_CONTACT_SELECT`); that capability is intentionally **dropped**, not degraded — every response from `fac_get_audit` carries a `personal_data_note` pointing to the report's `summary_url` on fac.gov instead. See the migration and `scripts/fac-normalize.py` headers for the full column-by-column reasoning.

### Refresh path

```
node scripts/fac-upsert.sh          # local dry run (needs the database connection secret in env — see the script header)
```

In production this runs on a GitHub Actions runner (`.github/workflows/fac-refresh.yml`, weekly, `workflow_dispatch`-able), not the CF gateway Worker — `federal_awards` alone is ~1.34GB uncompressed, far past a Worker's execution budget, and `psql \copy` does the load in one shot where a Worker's streaming parser could not (same reasoning as the `samgov` and `openfema` packs). The loader:

1. Applies every `*_fac_*.sql` migration (idempotent — no separate "apply once by hand" step to forget).
2. Downloads each table's CSV from `https://app.fac.gov/dissemination/public-data/gsa/full/{table}.csv` (follows the 302 to a presigned S3 URL that expires in ~30s — never resolve and reuse the Location header, same trap as migration 135's samgov table).
3. Normalizes with `scripts/fac-normalize.py` — streams row-by-row (never buffers a whole file in memory), drops the personal-data columns, and NULLs the literal `"GSA_MIGRATION"` sentinel FAC's own data uses as a placeholder for finding text/corrective-action-plan text on records migrated from the pre-2022 Census-run FAC (verified live 2026-09-29 — thousands of 2016-era report_ids carry that literal string as if it were content).
4. Loads into a staging table via `psql \copy`, then upserts into the live table in batches (never a single giant transaction).
5. Records the run in `fac_ingest_runs` (status, row counts, `finished_at`) — this is what `data_as_of` reads.

## Data sources

- `https://www.fac.gov/data/download/current/` — the human-readable index of bulk extracts.
- `https://app.fac.gov/dissemination/public-data/gsa/full/{general,federal_awards,findings,findings_text,corrective_action_plans}.csv` — the actual downloads (302 → presigned S3, no credential). Sizes observed 2026-09-29: general 271MB, federal_awards 1.34GB, findings 68MB, findings_text 258MB, corrective_action_plans 110MB.
- API docs (for the live upstream shape this data is derived from): https://www.fac.gov/developers/ · Assistance Listing lookup: https://sam.gov/content/assistance-listings
- US federal single-audit data collected under 2 CFR 200 Subpart F — public domain.

### Name and ZIP matching

**ZIP is stored in two encodings and must be prefix-matched.** `auditee_zip` holds 5 digits (`75082`) for some rows and 9-digit ZIP+4 with no separator (`009601588`, `750814198`) for others, so `eq.` misses most of the table — a Puerto Rico caller passing `00960` would match nothing at all. The pack filters on the 5-digit prefix (`auditee_zip=like.00960*`), which is the only part both encodings share, and accepts ZIP+4 input by truncating it.

**An auditee's ZIP on file changes between filing years.** CITY OF RICHARDSON TX is filed under `75080` (2018–2021), `75083` (2022) and `75082` (2025) — all the same UEI. So a current ZIP legitimately fails to match an older audit. When a `zip` filter empties an otherwise-matching result, the pack re-asks without it and returns `reason: 'zip_no_match'` naming the ZIPs FAC actually holds for that entity, rather than a bare miss the caller cannot diagnose.

**Puerto Rico municipalities are filed in BOTH languages, and which one depends on the submission year.** FAC holds `MUNICIPALITY OF BAYAMON` and `MUNICIPALITY OF SAN JUAN`, but also `MUNICIPIO DE MANATI`, `MUNICIPIO DE CAMUY`, `MUNICIPIO DE NARANJITO` — and Corozal appears as `MUNICIPIO DE COROZAL` for 2019 and `MUNICIPALITY OF COROZAL` for 2017–2024, from the same entity. A caller working from a Puerto Rico government source has the Spanish legal name, which no substring of the English row contains; a one-way rewrite to English would have lost the Spanish rows instead. The pack detects a municipality name in either language (`MUNICIPIO DE X`, `MUNICIPIO AUTONOMO DE X`, `MUNICIPALIDAD DE X`, `(AUTONOMOUS) MUNICIPALITY OF X`), extracts the place, and queries **both** spellings in one PostgREST `or=(...)`, echoing what it did in `name_match`.

**Place names carry their Spanish accents, inconsistently.** FAC holds `MUNICIPALITY OF AÑASCO` (and in one row the mojibaked `MUNICIPALITY OF A?ASCO`) *and* the plain `MUNICIPIO DE ANASCO`, so **neither spelling finds all of them**: ASCII `ANASCO` returns 1 audit, accented `AÑASCO` returns 4, and the entity has 5. Each place pattern therefore also goes out accent-blind, with the letters that can carry a Spanish accent replaced by LIKE's single-character wildcard (`Municipality of ___SC_`); the surviving consonants and the fixed length keep it specific.

This rides in the **primary** query rather than as a retry-on-empty, and that distinction is the whole point: a retry only fires when the literal spelling found *nothing*, but the actual failure is that it finds *some* — a partial answer wearing the shape of a complete one. `or=(...)` is a single SQL predicate, so the extra branches union without duplicating rows or costing a second round trip.

### Other gotchas

**`federal_agency_prefix` and `federal_award_extension` are stored separately** and only mean something concatenated: prefix `93` + extension `224` is Assistance Listing `93.224`, so callers who pass the dotted number get it split for them and every response echoes `assistance_listing` back. The extension is stored **zero-padded to three characters** (`47.076`, never `47.76`), so a numeric extension is padded before it is sent — an unpadded one matches nothing rather than erroring. **`fac_federal_awards` carries no auditee columns** — recipient name, state and audit year live on `fac_general`, so `fac_federal_awards_by_program` joins the two by `report_id`; when a `state` or `audit_year` filter is set it over-fetches the top rows by dollar amount and filters after the join, and reports `rows_scanned` so a caller can tell a deeper scan is needed. **Zero findings is an answer, not a gap**: a clean single audit legitimately has no rows in `fac_findings`, which is returned as `found: false, reason: 'no_findings'` with the audits that were checked, distinct from `reason: 'findings_table_unavailable'`. Entities spending under the ~$750k/yr federal threshold never file at all, so an absent organization is usually below threshold rather than missing. **Finding/corrective-action narrative text is often absent for older audits** — `fac_findings_search` and `include_text: true` on `fac_audit_findings` both simply omit rows with no text on file (post-`GSA_MIGRATION`-sentinel-nulling) rather than showing an empty string as if it were a real (terse) answer.

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

Both URLs reach the same gateway and the same 1864+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fac_search_audits \
  -H 'Content-Type: application/json' \
  -d '{"auditee_name":"stanford","limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fac_search_audits`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-fac` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/fac/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "fac": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fac"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

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
