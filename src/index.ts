interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Federal Audit Clearinghouse (FAC) MCP — US single-audit data.
 *
 * Every non-federal entity (state, city, university, hospital, tribe,
 * nonprofit) that expends more than ~$750k/yr in federal awards must submit a
 * Uniform Guidance single audit (formerly OMB A-133) to the FAC. That makes
 * this the compliance / diligence layer over federal grant money: who actually
 * spends it, under which Assistance Listing (CFDA) program, and whether the
 * auditors flagged anything.
 *
 * API: https://api.fac.gov  (PostgREST — `?col=eq.x`, `ilike.*x*`, `gte.n`,
 *      plus select= / order= / limit= / offset=)
 * Auth: `X-Api-Key` header, an api.data.gov umbrella key
 *      (free at https://api.data.gov/signup).
 *
 * GOTCHA: the api.data.gov umbrella reports throttling as a JSON body
 * `{"error":{"code":"OVER_RATE_LIMIT",...}}` and it arrives with HTTP 200 as
 * often as HTTP 429. So every response body is inspected for `.error.code`
 * regardless of status — see `facGet`.
 *
 * Tools:
 * - fac_search_audits:              find audits by auditee name/UEI/EIN/state/year/size
 * - fac_get_audit:                  one audit + its federal award rows (+ findings)
 * - fac_audit_findings:             audit findings for an audit or a recipient
 * - fac_federal_awards_by_program:  who expended money under a CFDA number
 * - fac_recipient_audit_history:    one recipient's audits and spend by year
 */


const BASE_URL = 'https://api.fac.gov';

const GENERAL_SELECT =
  'report_id,auditee_uei,auditee_ein,audit_year,auditee_name,auditee_city,auditee_state,total_amount_expended,fac_accepted_date,oversight_agency';

const GENERAL_CONTACT_SELECT =
  `${GENERAL_SELECT},auditee_zip,auditee_email,auditee_phone,auditee_contact_name,auditee_contact_title,auditor_city,auditor_state`;

const AWARD_SELECT =
  'report_id,federal_agency_prefix,federal_award_extension,additional_award_identification,federal_program_name,amount_expended,is_major,audit_report_type';

interface GeneralRow {
  report_id?: string;
  auditee_uei?: string;
  auditee_ein?: string;
  audit_year?: number | string;
  auditee_name?: string;
  auditee_city?: string;
  auditee_state?: string;
  total_amount_expended?: number | string;
  fac_accepted_date?: string;
  oversight_agency?: string;
}

interface AwardRow {
  report_id?: string;
  federal_agency_prefix?: string;
  federal_award_extension?: string;
  additional_award_identification?: string;
  federal_program_name?: string;
  amount_expended?: number | string;
  is_major?: string | boolean;
  audit_report_type?: string;
}

type Row = Record<string, unknown>;

interface NotFound {
  found: false;
  reason: string;
  hint: string;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'fac_search_audits',
    description:
      'Search US single audits (Uniform Guidance / former OMB A-133) filed with the Federal Audit Clearinghouse by auditee name, UEI, EIN, state, audit year, or minimum federal dollars expended. Returns the report_id, the organization name and location, total federal awards expended for the year, the cognizant/oversight agency, and the date FAC accepted the submission. Answers "does this grant recipient file a single audit and how much federal money does it run".',
    inputSchema: {
      type: 'object',
      properties: {
        auditee_name: {
          type: 'string',
          description: 'Organization name, matched as a forgiving case-insensitive substring (e.g. "stanford", "county of los angeles"). Aliases: query, q, name.',
        },
        uei: { type: 'string', description: 'SAM.gov Unique Entity Identifier (12 chars), exact match. Alias: auditee_uei.' },
        ein: { type: 'string', description: 'Employer Identification Number, digits only, exact match. Alias: auditee_ein.' },
        state: { type: 'string', description: '2-letter auditee state code (e.g. "CA"). Alias: auditee_state.' },
        audit_year: { type: 'number', description: 'Fiscal audit year, e.g. 2023.' },
        audit_year_min: { type: 'number', description: 'Earliest audit year to include.' },
        min_total_expended: {
          type: 'number',
          description: 'Only audits whose total federal awards expended is at least this many dollars (e.g. 100000000 for billion-dollar-scale recipients).',
        },
        order_by: {
          type: 'string',
          enum: ['total_amount_expended', 'audit_year', 'fac_accepted_date', 'auditee_name'],
          description: 'Sort column, descending by default. Defaults to total_amount_expended.',
        },
        ascending: { type: 'boolean', description: 'Sort ascending instead of descending.' },
        limit: { type: 'number', description: 'Rows to return, 1-200 (default 20).' },
        offset: { type: 'number', description: 'Rows to skip, for paging.' },
      },
      required: [],
    },
  },
  {
    name: 'fac_get_audit',
    description:
      'Fetch one single audit by its FAC report_id, enriched with the full federal program detail: every Assistance Listing (CFDA) number the entity expended money under, the program name, dollars expended per program, whether it was audited as a major program, and the opinion type. Also returns auditee contact and auditor details, plus audit findings when the FAC findings table carries them. Answers "what did this specific audit cover and what did it conclude".',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: {
          type: 'string',
          description: 'FAC report id as returned by fac_search_audits, e.g. "2023-06-CENSUS-0000250449". Aliases: id, audit_id.',
        },
        award_limit: { type: 'number', description: 'Max federal award rows to include, 1-500 (default 200).' },
        include_findings: { type: 'boolean', description: 'Attach audit findings for this report (default true).' },
      },
      required: ['report_id'],
    },
  },
  {
    name: 'fac_audit_findings',
    description:
      'Audit findings recorded against single audits — the compliance exceptions, material weaknesses, significant deficiencies, questioned costs and repeat findings that auditors reported. Query by report_id, or by recipient name/UEI to sweep every audit that recipient filed. Answers "has this grant recipient had audit findings, and were they material or repeated".',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string', description: 'FAC report id to pull findings for. Aliases: id, audit_id.' },
        auditee_name: { type: 'string', description: 'Recipient name substring; the tool resolves matching audits first, then their findings. Aliases: query, q, name.' },
        uei: { type: 'string', description: 'Recipient UEI; resolves that recipient\'s audits, then their findings. Alias: auditee_uei.' },
        audit_year: { type: 'number', description: 'Restrict the resolved audits to one audit year (used with auditee_name or uei).' },
        include_text: { type: 'boolean', description: 'Also attach the narrative finding text when FAC exposes it (default false — the text rows are long).' },
        limit: { type: 'number', description: 'Max finding rows to return, 1-200 (default 50).' },
      },
      required: [],
    },
  },
  {
    name: 'fac_federal_awards_by_program',
    description:
      'List the organizations that expended money under a given federal Assistance Listing / CFDA number (e.g. "93.224" community health centers, "84.010" Title I, "20.205" highway planning), ranked by dollars expended, with the recipient name, state, audit year and whether it was a major program. Answers "who spends the money in this federal grant program and how much does each one run".',
    inputSchema: {
      type: 'object',
      properties: {
        cfda: {
          type: 'string',
          description: 'Assistance Listing / CFDA number. Accepts "93.224", "93-224", "93 224", "93224", or a bare agency prefix "93" for every program at that agency. Aliases: program_number, assistance_listing, program, cfda_number.',
        },
        federal_agency_prefix: { type: 'string', description: 'Two-digit agency prefix on its own, e.g. "93" for HHS. Alias: prefix.' },
        federal_award_extension: { type: 'string', description: 'Program extension on its own, e.g. "224". Alias: extension.' },
        state: { type: 'string', description: '2-letter recipient state code to narrow the ranking, e.g. "TX".' },
        audit_year: { type: 'number', description: 'Restrict to one audit year, e.g. 2023.' },
        major_only: { type: 'boolean', description: 'Keep only programs audited as major programs.' },
        min_amount: { type: 'number', description: 'Only rows expending at least this many dollars.' },
        limit: { type: 'number', description: 'Rows to return, 1-200 (default 25).' },
        include_recipients: { type: 'boolean', description: 'Resolve each report_id to the recipient name and state (default true; one extra upstream call).' },
      },
      required: [],
    },
  },
  {
    name: 'fac_recipient_audit_history',
    description:
      'Year-by-year single-audit history for one grant recipient, identified by UEI or by name. Returns each audit year with total federal awards expended, the report_id, the oversight agency and the FAC acceptance date, plus a growth read on the spend trend. Answers "how has this organization\'s federal funding moved over time and which years were audited".',
    inputSchema: {
      type: 'object',
      properties: {
        uei: { type: 'string', description: 'SAM.gov Unique Entity Identifier, the precise way to pin one recipient. Alias: auditee_uei.' },
        auditee_name: { type: 'string', description: 'Recipient name substring when the UEI is unknown, e.g. "johns hopkins". Aliases: query, q, name.' },
        ein: { type: 'string', description: 'Employer Identification Number, an alternative exact identifier. Alias: auditee_ein.' },
        state: { type: 'string', description: '2-letter state code, useful to disambiguate a common name.' },
        years: { type: 'number', description: 'Max audit years to return, 1-40 (default 15).' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  delete args._apiKey;
  if (!apiKey) {
    throw new Error(
      'Federal Audit Clearinghouse requires an api.data.gov API key. Contact the operator about platform credentials (PLATFORM_DATAGOV_KEY), or BYO via ?_apiKey=<key> after registering at https://api.data.gov/signup.',
    );
  }
  switch (name) {
    case 'fac_search_audits':
      return searchAudits(apiKey, args);
    case 'fac_get_audit':
      return getAudit(apiKey, args);
    case 'fac_audit_findings':
      return auditFindings(apiKey, args);
    case 'fac_federal_awards_by_program':
      return awardsByProgram(apiKey, args);
    case 'fac_recipient_audit_history':
      return recipientHistory(apiKey, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ---------------------------------------------------------------- arg utils */

function reqStr(args: Record<string, unknown>, key: string, example: string, ...aliases: string[]): string {
  for (const k of [key, ...aliases]) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
}

function optStr(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function optNum(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function optBool(args: Record<string, unknown>, key: string, dflt: boolean): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^(true|yes|1)$/i.test(v.trim())) return true;
    if (/^(false|no|0)$/i.test(v.trim())) return false;
  }
  return dflt;
}

function clampInt(v: number | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/* --------------------------------------------------------------- http layer */

interface UmbrellaError {
  error?: { code?: string; message?: string };
}

async function facRequest(
  apiKey: string,
  path: string,
  params: URLSearchParams,
): Promise<{ status: number; body: unknown; text: string }> {
  const qs = params.toString();
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body, text };
}

const UMBRELLA_CODES = [
  'OVER_RATE_LIMIT',
  'API_KEY_MISSING',
  'API_KEY_INVALID',
  'API_KEY_DISABLED',
  'API_KEY_UNAUTHORIZED',
];

/**
 * api.data.gov wraps throttle/auth failures in a body that can arrive with HTTP
 * 200. It is usually JSON (`{"error":{"code":"OVER_RATE_LIMIT",...}}`) but the
 * umbrella also serves an HTML error page carrying the same code, so the raw
 * text is checked too — otherwise an HTML 200 looks like a malformed response
 * instead of the plain "you are throttled" that it is.
 */
function umbrellaError(body: unknown, text?: string): { code: string; message: string } | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const err = (body as UmbrellaError).error;
    if (err && typeof err === 'object') {
      return {
        code: typeof err.code === 'string' ? err.code : 'UMBRELLA_ERROR',
        message: typeof err.message === 'string' ? err.message : '',
      };
    }
  }
  if (text && !Array.isArray(body)) {
    for (const code of UMBRELLA_CODES) {
      if (text.includes(code)) return { code, message: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) };
    }
  }
  return null;
}

function throwUmbrella(code: string, message: string): never {
  if (code === 'OVER_RATE_LIMIT') {
    throw new Error(
      `FAC: api.data.gov rate limit exceeded (${code}). The umbrella returns this even with HTTP 200. DEMO_KEY caps around 30 requests/hour; a registered key gets 1,000/hour. ${message}`,
    );
  }
  if (code === 'API_KEY_MISSING' || code === 'API_KEY_INVALID' || code === 'API_KEY_DISABLED' || code === 'API_KEY_UNAUTHORIZED') {
    throw new Error(`FAC: api.data.gov rejected the key (${code}). Register a fresh one at https://api.data.gov/signup. ${message}`);
  }
  throw new Error(`FAC: api.data.gov error ${code}. ${message}`);
}

/** Rows from a PostgREST table. Throws on real errors; never returns null. */
async function facRows(apiKey: string, path: string, params: URLSearchParams): Promise<Row[]> {
  const { status, body, text } = await facRequest(apiKey, path, params);
  const err = umbrellaError(body, text);
  if (err) throwUmbrella(err.code, err.message);
  if (status === 401 || status === 403) throw new Error(`FAC: unauthorized (HTTP ${status}) — check the api.data.gov key.`);
  if (status === 429) throw new Error('FAC: rate limit (HTTP 429) — api.data.gov throttled the key.');
  if (status === 408) throw new Error(`FAC: api.fac.gov timed out (HTTP 408) on ${path} — it does this under load; narrow the filters or retry shortly.`);
  if (status >= 500) throw new Error(`FAC: upstream ${status} — api.fac.gov is unavailable, retry shortly.`);
  if (status === 404) throw new Error(`FAC: table ${path} does not exist on api.fac.gov (HTTP 404).`);
  if (status >= 400) {
    throw new Error(`FAC error ${status} on ${path}: ${text.slice(0, 300)}`);
  }
  return expectRows(path, status, body, text);
}

/**
 * A 2xx that isn't a JSON array is a broken response, not an empty table —
 * returning [] there would report "no rows" for what is really an upstream or
 * intermediary failure, which is the worst possible answer to a diligence
 * question. Fail loudly instead.
 */
function expectRows(path: string, status: number, body: unknown, text: string): Row[] {
  if (Array.isArray(body)) return body as Row[];
  throw new Error(
    `FAC: HTTP ${status} on ${path} but the body was not a JSON array of rows — treating this as an upstream failure rather than an empty result. Body: ${text.slice(0, 200)}`,
  );
}

/**
 * Same as facRows but folds a missing/renamed table or a rejected column into
 * `null` instead of throwing, so a supplementary lookup (findings, finding
 * text) can degrade quietly while the primary answer still returns.
 */
async function facRowsOptional(
  apiKey: string,
  path: string,
  params: URLSearchParams,
): Promise<{ rows: Row[] } | { rows: null; status: number; detail: string }> {
  const { status, body, text } = await facRequest(apiKey, path, params);
  const err = umbrellaError(body, text);
  if (err) throwUmbrella(err.code, err.message);
  if (status === 404 || status === 400 || status === 406) {
    return { rows: null, status, detail: text.slice(0, 200) };
  }
  if (status === 401 || status === 403) throw new Error(`FAC: unauthorized (HTTP ${status}) — check the api.data.gov key.`);
  if (status === 429) throw new Error('FAC: rate limit (HTTP 429) — api.data.gov throttled the key.');
  if (status === 408) throw new Error(`FAC: api.fac.gov timed out (HTTP 408) on ${path} — it does this under load; retry shortly.`);
  if (status >= 500) throw new Error(`FAC: upstream ${status} — api.fac.gov is unavailable, retry shortly.`);
  return { rows: expectRows(path, status, body, text) };
}

/* ------------------------------------------------------------- shared shape */

function inList(values: string[]): string {
  // PostgREST `in.(a,b,c)`; quote so ids containing punctuation survive.
  return `in.(${values.map((v) => `"${v.replace(/"/g, '')}"`).join(',')})`;
}

function assistanceListing(row: AwardRow): string | undefined {
  const p = row.federal_agency_prefix;
  const e = row.federal_award_extension;
  if (!p) return undefined;
  return e ? `${p}.${e}` : String(p);
}

function shapeAward(row: Row): Record<string, unknown> {
  const a = row as AwardRow;
  return {
    report_id: a.report_id,
    assistance_listing: assistanceListing(a),
    federal_program_name: a.federal_program_name,
    amount_expended: num(a.amount_expended),
    is_major: a.is_major,
    audit_report_type: a.audit_report_type,
    additional_award_identification: a.additional_award_identification || undefined,
  };
}

const YES = (v: unknown): boolean => v === 'Y' || v === true || v === 'y';

function shapeFinding(row: Row): Record<string, unknown> {
  return {
    report_id: row.report_id,
    auditee_uei: row.auditee_uei,
    audit_year: num(row.audit_year) ?? row.audit_year,
    reference_number: row.reference_number,
    award_reference: row.award_reference,
    type_requirement: row.type_requirement,
    is_material_weakness: row.is_material_weakness,
    is_significant_deficiency: row.is_significant_deficiency,
    is_questioned_costs: row.is_questioned_costs,
    is_repeat_finding: row.is_repeat_finding,
    prior_finding_ref_numbers: row.prior_finding_ref_numbers,
    is_modified_opinion: row.is_modified_opinion,
    is_other_matters: row.is_other_matters,
    is_other_findings: row.is_other_findings,
  };
}

/** Roll the Y/N flags up so a caller sees severity without scanning rows. */
function findingsSummary(rows: Row[]): Record<string, number> {
  return {
    findings: rows.length,
    material_weaknesses: rows.filter((r) => YES(r.is_material_weakness)).length,
    significant_deficiencies: rows.filter((r) => YES(r.is_significant_deficiency)).length,
    questioned_costs: rows.filter((r) => YES(r.is_questioned_costs)).length,
    repeat_findings: rows.filter((r) => YES(r.is_repeat_finding)).length,
    modified_opinions: rows.filter((r) => YES(r.is_modified_opinion)).length,
  };
}

function shapeGeneral(row: Row): Record<string, unknown> {
  const g = row as GeneralRow;
  return {
    report_id: g.report_id,
    audit_year: num(g.audit_year) ?? g.audit_year,
    auditee_name: g.auditee_name,
    auditee_uei: g.auditee_uei,
    auditee_ein: g.auditee_ein,
    auditee_city: g.auditee_city,
    auditee_state: g.auditee_state,
    total_amount_expended: num(g.total_amount_expended),
    oversight_agency: g.oversight_agency,
    fac_accepted_date: g.fac_accepted_date,
  };
}

/* ------------------------------------------------------- 1. fac_search_audits */

const ORDER_COLUMNS = new Set(['total_amount_expended', 'audit_year', 'fac_accepted_date', 'auditee_name']);

async function searchAudits(apiKey: string, args: Record<string, unknown>) {
  const name = optStr(args, 'auditee_name', 'query', 'q', 'name');
  const uei = optStr(args, 'uei', 'auditee_uei');
  const ein = optStr(args, 'ein', 'auditee_ein');
  const state = optStr(args, 'state', 'auditee_state');
  const auditYear = optNum(args, 'audit_year', 'year');
  const auditYearMin = optNum(args, 'audit_year_min', 'min_audit_year');
  const minExpended = optNum(args, 'min_total_expended', 'min_amount', 'min_expended');
  const limit = clampInt(optNum(args, 'limit'), 20, 1, 200);
  const offset = clampInt(optNum(args, 'offset'), 0, 0, 100000);

  if (!name && !uei && !ein && !state && auditYear === undefined && auditYearMin === undefined && minExpended === undefined) {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Pass at least one filter: auditee_name ("stanford"), uei, ein, state ("CA"), audit_year (2023), or min_total_expended.',
    } satisfies NotFound;
  }

  const orderByRaw = optStr(args, 'order_by', 'sort');
  const orderBy = orderByRaw && ORDER_COLUMNS.has(orderByRaw) ? orderByRaw : 'total_amount_expended';
  const dir = optBool(args, 'ascending', false) ? 'asc' : 'desc';

  const params = new URLSearchParams({
    select: GENERAL_SELECT,
    order: `${orderBy}.${dir}`,
    limit: String(limit),
  });
  if (offset) params.set('offset', String(offset));
  if (name) params.set('auditee_name', `ilike.*${name}*`);
  if (uei) params.set('auditee_uei', `eq.${uei.toUpperCase()}`);
  if (ein) params.set('auditee_ein', `eq.${ein.replace(/\D/g, '')}`);
  if (state) params.set('auditee_state', `eq.${state.toUpperCase()}`);
  if (auditYear !== undefined) params.set('audit_year', `eq.${Math.trunc(auditYear)}`);
  else if (auditYearMin !== undefined) params.set('audit_year', `gte.${Math.trunc(auditYearMin)}`);
  if (minExpended !== undefined) params.set('total_amount_expended', `gte.${Math.trunc(minExpended)}`);

  const rows = await facRows(apiKey, '/general', params);
  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_audits_match',
      hint: `No single audit matched. Try a shorter auditee_name fragment${name ? ` than "${name}"` : ''}, drop the audit_year, or search by uei. Entities under the ~$750k federal-spend threshold never file.`,
    } satisfies NotFound;
  }

  return {
    found: true,
    filters: { auditee_name: name, uei, ein, state, audit_year: auditYear, audit_year_min: auditYearMin, min_total_expended: minExpended },
    count: rows.length,
    order: `${orderBy}.${dir}`,
    audits: rows.map(shapeGeneral),
    source: 'Federal Audit Clearinghouse /general',
  };
}

/* ---------------------------------------------------------- 2. fac_get_audit */

async function getAudit(apiKey: string, args: Record<string, unknown>) {
  const reportId = reqStr(args, 'report_id', '"2023-06-CENSUS-0000250449"', 'id', 'audit_id');
  const awardLimit = clampInt(optNum(args, 'award_limit'), 200, 1, 500);

  const generalRows = await facRows(
    apiKey,
    '/general',
    new URLSearchParams({ select: GENERAL_CONTACT_SELECT, report_id: `eq.${reportId}`, limit: '1' }),
  );
  if (generalRows.length === 0) {
    return {
      found: false,
      reason: 'report_id_not_found',
      hint: `No audit with report_id "${reportId}". Report ids look like "2023-06-CENSUS-0000250449"; get one from fac_search_audits.`,
    } satisfies NotFound;
  }
  const g = generalRows[0] as GeneralRow & Row;

  const awards = await facRows(
    apiKey,
    '/federal_awards',
    new URLSearchParams({
      select: AWARD_SELECT,
      report_id: `eq.${reportId}`,
      order: 'amount_expended.desc',
      limit: String(awardLimit),
    }),
  );

  const shapedAwards = awards.map(shapeAward);
  const programs = shapedAwards.length;
  const majorPrograms = shapedAwards.filter((a) => YES(a.is_major)).length;
  const awardTotal = shapedAwards.reduce((s, a) => s + (typeof a.amount_expended === 'number' ? a.amount_expended : 0), 0);

  const result: Record<string, unknown> = {
    found: true,
    report_id: reportId,
    audit: {
      ...shapeGeneral(g),
      auditee_zip: g['auditee_zip'],
      auditee_contact_name: g['auditee_contact_name'],
      auditee_contact_title: g['auditee_contact_title'],
      auditee_email: g['auditee_email'],
      auditee_phone: g['auditee_phone'],
      auditor_city: g['auditor_city'],
      auditor_state: g['auditor_state'],
    },
    federal_awards: {
      program_count: programs,
      major_program_count: majorPrograms,
      amount_expended_total: awardTotal,
      truncated: awards.length === awardLimit,
      rows: shapedAwards,
    },
    source: 'Federal Audit Clearinghouse /general + /federal_awards',
  };

  if (optBool(args, 'include_findings', true)) {
    const findings = await facRowsOptional(
      apiKey,
      '/findings',
      new URLSearchParams({ report_id: `eq.${reportId}`, limit: '100' }),
    );
    if (findings.rows === null) {
      result.findings = {
        available: false,
        reason: `FAC /findings returned HTTP ${findings.status}`,
        hint: 'The findings table did not answer; the per-program audit_report_type above is the surviving compliance signal.',
      };
    } else {
      result.findings = {
        available: true,
        summary: findingsSummary(findings.rows),
        clean: findings.rows.length === 0,
        rows: findings.rows.map(shapeFinding),
      };
    }
  }

  return result;
}

/* ----------------------------------------------------- 3. fac_audit_findings */

async function auditFindings(apiKey: string, args: Record<string, unknown>) {
  const reportId = optStr(args, 'report_id', 'id', 'audit_id');
  const name = optStr(args, 'auditee_name', 'query', 'q', 'name');
  const uei = optStr(args, 'uei', 'auditee_uei');
  const auditYear = optNum(args, 'audit_year', 'year');
  const limit = clampInt(optNum(args, 'limit'), 50, 1, 200);

  const params = new URLSearchParams({ limit: String(limit), order: 'audit_year.desc,reference_number.asc' });
  const scope: Record<string, unknown> = {};
  let context: Record<string, unknown>[] = [];
  let reportIds: string[] = [];

  if (reportId) {
    params.set('report_id', `eq.${reportId}`);
    scope.report_id = reportId;
    reportIds = [reportId];
  } else if (uei) {
    // /findings carries auditee_uei and audit_year itself, so a recipient sweep
    // filters directly — no /general resolution hop, and no 25-audit ceiling.
    params.set('auditee_uei', `eq.${uei.toUpperCase()}`);
    scope.auditee_uei = uei.toUpperCase();
    if (auditYear !== undefined) {
      params.set('audit_year', `eq.${Math.trunc(auditYear)}`);
      scope.audit_year = Math.trunc(auditYear);
    }
  } else if (name) {
    // /findings has no auditee_name column, so a name has to become report_ids first.
    const gp = new URLSearchParams({ select: GENERAL_SELECT, order: 'audit_year.desc', limit: '25' });
    gp.set('auditee_name', `ilike.*${name}*`);
    if (auditYear !== undefined) gp.set('audit_year', `eq.${Math.trunc(auditYear)}`);
    const generalRows = await facRows(apiKey, '/general', gp);
    if (generalRows.length === 0) {
      return {
        found: false,
        reason: 'no_audits_match',
        hint: `No audit matched "${name}", so there are no findings to pull. Try a shorter name fragment or confirm the recipient with fac_search_audits.`,
      } satisfies NotFound;
    }
    context = generalRows.map(shapeGeneral);
    reportIds = generalRows.map((r) => String((r as GeneralRow).report_id ?? '')).filter(Boolean);
    params.set('report_id', reportIds.length === 1 ? `eq.${reportIds[0]}` : inList(reportIds));
    scope.auditee_name = name;
    scope.audits_matched = reportIds.length;
  } else {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Pass report_id, or auditee_name / uei to sweep a recipient\'s audits for findings.',
    } satisfies NotFound;
  }

  const findings = await facRowsOptional(apiKey, '/findings', params);

  if (findings.rows === null) {
    return {
      found: false,
      reason: 'findings_table_unavailable',
      hint: `FAC /findings answered HTTP ${findings.status}. Use fac_get_audit for the same report_id — its federal award rows carry audit_report_type (the per-program opinion), which is the surviving compliance signal. Detail: ${findings.detail}`,
    } satisfies NotFound;
  }

  if (findings.rows.length === 0) {
    return {
      found: false,
      reason: 'no_findings',
      hint: 'FAC recorded no findings in scope. A clean single audit legitimately has zero rows here, so read this as "no findings reported" rather than missing data.',
      scope,
      audits_checked: reportIds.length ? reportIds : undefined,
    };
  }

  const shaped = findings.rows.map(shapeFinding);
  const shapedIds = [...new Set(shaped.map((f) => String(f.report_id ?? '')).filter(Boolean))];

  const result: Record<string, unknown> = {
    found: true,
    scope,
    summary: findingsSummary(findings.rows),
    truncated: findings.rows.length === limit,
    report_ids: shapedIds,
    findings: shaped,
    audits: context.length ? context : undefined,
    source: 'Federal Audit Clearinghouse /findings',
  };

  if (optBool(args, 'include_text', false)) {
    // Narrative text keys on report_id + finding_ref_number; scope it to the
    // reports we actually returned rows for so the payload stays bounded.
    const textParams = new URLSearchParams({ limit: String(limit) });
    textParams.set('report_id', shapedIds.length === 1 ? `eq.${shapedIds[0]}` : inList(shapedIds));
    const texts = await facRowsOptional(apiKey, '/findings_text', textParams);
    result.findings_text =
      texts.rows === null
        ? { available: false, reason: `FAC /findings_text returned HTTP ${texts.status}` }
        : {
            available: true,
            count: texts.rows.length,
            rows: texts.rows.map((r) => ({
              report_id: r.report_id,
              finding_ref_number: r.finding_ref_number,
              contains_chart_or_table: r.contains_chart_or_table,
              finding_text: typeof r.finding_text === 'string' ? r.finding_text.trim() : r.finding_text,
            })),
          };
  }

  return result;
}

/* -------------------------------------- 4. fac_federal_awards_by_program */

interface ProgramRef {
  prefix: string;
  extension?: string;
  label: string;
}

function resolveProgram(args: Record<string, unknown>): ProgramRef | NotFound {
  let prefix = optStr(args, 'federal_agency_prefix', 'prefix', 'agency_prefix');
  let extension = optStr(args, 'federal_award_extension', 'extension', 'award_extension');
  const raw = optStr(args, 'cfda', 'program_number', 'assistance_listing', 'program', 'cfda_number', 'query', 'q');

  if (raw && (!prefix || !extension)) {
    const cleaned = raw.replace(/\s+/g, '');
    const dotted = cleaned.match(/^(\d{2})[.\-_/](\S+)$/);
    if (dotted) {
      prefix = prefix ?? dotted[1];
      extension = extension ?? dotted[2];
    } else if (/^\d{2}$/.test(cleaned)) {
      prefix = prefix ?? cleaned;
    } else {
      const glued = cleaned.match(/^(\d{2})([0-9A-Za-z]{2,4})$/);
      if (glued) {
        prefix = prefix ?? glued[1];
        extension = extension ?? glued[2];
      }
    }
  }

  // FAC stores the extension zero-padded to three characters ("076", not "76"),
  // so a caller who writes "47.76" still resolves to the right program.
  if (extension && /^\d{1,3}$/.test(extension)) extension = extension.padStart(3, '0');

  if (!prefix || !/^\d{1,2}$/.test(prefix)) {
    return {
      found: false,
      reason: 'unparsed_program_number',
      hint: 'Pass cfda as an Assistance Listing number like "93.224" (or "93-224" / "93224"), or pass federal_agency_prefix "93" plus federal_award_extension "224". A bare two-digit prefix returns every program at that agency.',
    };
  }
  prefix = prefix.padStart(2, '0');
  return { prefix, extension, label: extension ? `${prefix}.${extension}` : prefix };
}

async function awardsByProgram(apiKey: string, args: Record<string, unknown>) {
  const program = resolveProgram(args);
  if ('found' in program) return program;

  const limit = clampInt(optNum(args, 'limit'), 25, 1, 200);
  const state = optStr(args, 'state', 'auditee_state');
  const auditYear = optNum(args, 'audit_year', 'year');
  const majorOnly = optBool(args, 'major_only', false);
  const minAmount = optNum(args, 'min_amount', 'min_expended');
  const wantRecipients = optBool(args, 'include_recipients', true);

  // /federal_awards has no auditee columns, so state / audit_year are applied
  // against the /general rows we join for recipient identity. Over-fetch when a
  // recipient-side filter is in play so the post-join ranking still fills up.
  const recipientFilter = Boolean(state) || auditYear !== undefined;
  const fetchLimit = recipientFilter ? Math.min(500, limit * 8) : limit;

  const params = new URLSearchParams({
    select: AWARD_SELECT,
    federal_agency_prefix: `eq.${program.prefix}`,
    order: 'amount_expended.desc',
    limit: String(fetchLimit),
  });
  if (program.extension) params.set('federal_award_extension', `eq.${program.extension}`);
  if (majorOnly) params.set('is_major', 'eq.Y');
  if (minAmount !== undefined) params.set('amount_expended', `gte.${Math.trunc(minAmount)}`);

  const awardRows = await facRows(apiKey, '/federal_awards', params);
  if (awardRows.length === 0) {
    return {
      found: false,
      reason: 'no_awards_for_program',
      hint: `No single-audit rows expended money under Assistance Listing ${program.label}. Verify the number on https://sam.gov/content/assistance-listings, or drop the extension and pass just the agency prefix "${program.prefix}" to see that agency's programs.`,
    } satisfies NotFound;
  }

  let shaped = awardRows.map(shapeAward);
  const recipients = new Map<string, Record<string, unknown>>();

  if (wantRecipients || recipientFilter) {
    const ids = [...new Set(shaped.map((r) => String(r.report_id ?? '')).filter(Boolean))].slice(0, 200);
    if (ids.length) {
      const generalRows = await facRows(
        apiKey,
        '/general',
        new URLSearchParams({ select: GENERAL_SELECT, report_id: inList(ids), limit: String(ids.length) }),
      );
      for (const row of generalRows) {
        const g = row as GeneralRow;
        if (g.report_id) recipients.set(g.report_id, shapeGeneral(row));
      }
    }
  }

  if (recipientFilter) {
    const wantState = state?.toUpperCase();
    shaped = shaped.filter((r) => {
      const g = recipients.get(String(r.report_id));
      if (!g) return false;
      if (wantState && String(g.auditee_state ?? '').toUpperCase() !== wantState) return false;
      if (auditYear !== undefined && Number(g.audit_year) !== Math.trunc(auditYear)) return false;
      return true;
    });
  }

  const scanned = awardRows.length;
  shaped = shaped.slice(0, limit);

  if (shaped.length === 0) {
    return {
      found: false,
      reason: 'no_awards_after_filter',
      hint: `Assistance Listing ${program.label} has award rows, but none in the top ${scanned} by dollar amount matched ${state ? `state ${state}` : ''}${state && auditYear !== undefined ? ' and ' : ''}${auditYear !== undefined ? `audit year ${auditYear}` : ''}. Drop one filter, or raise limit to scan deeper.`,
    } satisfies NotFound;
  }

  return {
    found: true,
    assistance_listing: program.label,
    federal_agency_prefix: program.prefix,
    federal_award_extension: program.extension,
    filters: { state, audit_year: auditYear, major_only: majorOnly || undefined, min_amount: minAmount },
    count: shaped.length,
    rows_scanned: scanned,
    ranked_by: 'amount_expended.desc',
    awards: shaped.map((a) => {
      const g = recipients.get(String(a.report_id));
      return {
        ...a,
        auditee_name: g?.auditee_name,
        auditee_uei: g?.auditee_uei,
        auditee_state: g?.auditee_state,
        auditee_city: g?.auditee_city,
        audit_year: g?.audit_year,
      };
    }),
    source: 'Federal Audit Clearinghouse /federal_awards joined to /general',
  };
}

/* -------------------------------------------- 5. fac_recipient_audit_history */

async function recipientHistory(apiKey: string, args: Record<string, unknown>) {
  const uei = optStr(args, 'uei', 'auditee_uei');
  const ein = optStr(args, 'ein', 'auditee_ein');
  const name = optStr(args, 'auditee_name', 'query', 'q', 'name');
  const state = optStr(args, 'state', 'auditee_state');
  const years = clampInt(optNum(args, 'years', 'limit'), 15, 1, 40);

  if (!uei && !ein && !name) {
    return {
      found: false,
      reason: 'no_recipient',
      hint: 'Identify the recipient: pass uei (best), ein, or auditee_name ("johns hopkins").',
    } satisfies NotFound;
  }

  const params = new URLSearchParams({
    select: GENERAL_SELECT,
    order: 'audit_year.desc',
    limit: String(Math.max(years * 2, 20)),
  });
  if (uei) params.set('auditee_uei', `eq.${uei.toUpperCase()}`);
  if (ein) params.set('auditee_ein', `eq.${ein.replace(/\D/g, '')}`);
  if (!uei && !ein && name) params.set('auditee_name', `ilike.*${name}*`);
  if (state) params.set('auditee_state', `eq.${state.toUpperCase()}`);

  const rows = await facRows(apiKey, '/general', params);
  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_audit_history',
      hint: `No single audits on file for that recipient${name ? ` matching "${name}"` : ''}. Try a shorter name fragment, drop the state filter, or confirm the UEI with fac_search_audits.`,
    } satisfies NotFound;
  }

  const shaped = rows.map(shapeGeneral);

  // Name search can straddle several legal entities; say which one this is.
  const entities = new Map<string, { auditee_uei?: string; auditee_name?: string; auditee_state?: string; audits: number }>();
  for (const r of shaped) {
    const key = String(r.auditee_uei ?? r.auditee_ein ?? r.auditee_name ?? 'unknown');
    const e = entities.get(key);
    if (e) e.audits += 1;
    else
      entities.set(key, {
        auditee_uei: r.auditee_uei as string | undefined,
        auditee_name: r.auditee_name as string | undefined,
        auditee_state: r.auditee_state as string | undefined,
        audits: 1,
      });
  }

  const byYear = new Map<number, { audit_year: number; total_amount_expended: number; report_ids: string[] }>();
  for (const r of shaped) {
    const y = Number(r.audit_year);
    if (!Number.isFinite(y)) continue;
    const slot = byYear.get(y) ?? { audit_year: y, total_amount_expended: 0, report_ids: [] };
    slot.total_amount_expended += typeof r.total_amount_expended === 'number' ? r.total_amount_expended : 0;
    if (r.report_id) slot.report_ids.push(String(r.report_id));
    byYear.set(y, slot);
  }

  const history = [...byYear.values()].sort((a, b) => b.audit_year - a.audit_year).slice(0, years);
  const oldest = history[history.length - 1];
  const newest = history[0];
  const trend =
    history.length > 1 && oldest.total_amount_expended > 0
      ? {
          from_year: oldest.audit_year,
          to_year: newest.audit_year,
          from_amount: oldest.total_amount_expended,
          to_amount: newest.total_amount_expended,
          pct_change: Number((((newest.total_amount_expended - oldest.total_amount_expended) / oldest.total_amount_expended) * 100).toFixed(1)),
        }
      : undefined;

  return {
    found: true,
    resolved_to: [...entities.values()],
    matched_entity_count: entities.size,
    ambiguous: entities.size > 1 ? 'Several legal entities matched that name — pass uei to pin one.' : undefined,
    years_returned: history.length,
    history,
    trend,
    audits: shaped,
    source: 'Federal Audit Clearinghouse /general',
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
