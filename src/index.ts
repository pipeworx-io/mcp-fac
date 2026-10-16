interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Federal Audit Clearinghouse (FAC) MCP — US single-audit data, served from a
 * served from a Pipeworx-maintained copy of its own bulk data (fleet #2504).
 * hosting-claims-ok: internal architecture note for maintainers, not caller-visible.
 *
 * Every non-federal entity (state, city, university, hospital, tribe,
 * nonprofit) that expends more than ~$750k/yr in federal awards must submit a
 * Uniform Guidance single audit (formerly OMB A-133) to the FAC. That makes
 * this the compliance / diligence layer over federal grant money: who actually
 * spends it, under which Assistance Listing (CFDA) program, and whether the
 * auditors flagged anything.
 *
 * WHY A MIRROR, NOT A LIVE PROXY (previously this pack called api.fac.gov
 * directly): measured 60d to 2026-09-29, fac_search_audits was upstream_down
 * on 572 of ~1,620 external calls (35%, 3.9s avg) — the largest ask_pipeworx
 * no_match cluster in the catalog. Separately, api.fac.gov's own PostgREST
 * exposes no foreign key between /general and /findings (PGRST200 on any
 * embed), so a cross-table question ("material weaknesses in Texas under CFDA
 * 93.224") was structurally impossible against the live API, not merely slow.
 * Per Bruce's 2026-09-23 ruling ("build a copy when live doesn't serve"), this
 * pack now loads FAC's own public bulk CSV extracts on a weekly refresh,
 * scripts/fac-upsert.sh + .github/workflows/fac-refresh.yml) into Supabase.
 * Schema + RPCs: supabase/migrations/220_fac_local_mirror.sql (filename only; not caller-visible).
 *
 * NO API KEY NEEDED ANY MORE. The live-proxy version required a caller's own
 * api.data.gov key; none is needed any more — every tool below runs off the
 * local database via `_supabaseUrl`/`_supabaseKey`, injected by the gateway
 * (pack-manifest `injectSupabase: true`).
 *
 * NO PERSONAL DATA IN THE MIRROR (local-copy rule, task #2504). FAC's
 * general.csv carries named-individual contact fields — auditee/auditor
 * CERTIFY name+title, CONTACT name+title, email, phone. None of those are
 * loaded. Organizational identity (auditee_name, auditor_firm_name,
 * addresses, EINs) is kept — it identifies the entity filing a mandatory
 * federal disclosure, not a private individual. `fac_get_audit` used to also
 * surface auditee contact name/email/phone from the live API; that capability
 * is intentionally dropped here, not degraded — see the migration header for
 * the full column-by-column reasoning.
 *
 * `data_as_of` is on every response (the last successful refresh,
 * read from fac_ingest_runs via the fac_data_as_of() RPC).
 *
 * Tables loaded: general, federal_awards, findings, findings_text,
 * corrective_action_plans. NOT loaded yet (out of #2504's scope):
 * notes_to_sefa, passthrough, additional_ueis/eins/secondary_auditors — a
 * future extension, not a silent gap; see the pack README.
 *
 * Tools:
 * - fac_search_audits:              find audits by auditee name/UEI/EIN/state/year/size
 * - fac_get_audit:                  one audit + its federal award rows (+ findings)
 * - fac_audit_findings:             audit findings for an audit or a recipient
 * - fac_federal_awards_by_program:  who expended money under a CFDA number
 * - fac_recipient_audit_history:    one recipient's audits and spend by year
 * - fac_findings_search:            full-text search over finding narratives (NEW — a join api.fac.gov could not do)
 * - fac_cross_table_screen:         screen audits by state + CFDA + finding type / material weakness in one call (NEW)
 */


async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Federal Audit Clearinghouse data');
}

interface DbConfig {
  url: string;
  key: string;
}

type Row = Record<string, unknown>;

interface NotFound {
  found: false;
  reason: string;
  hint: string;
}

const GENERAL_SELECT =
  'report_id,auditee_uei,auditee_ein,audit_year,auditee_name,auditee_city,auditee_state,auditee_zip,total_amount_expended,fac_accepted_date,oversight_agency';

const GENERAL_DETAIL_SELECT =
  `${GENERAL_SELECT},cognizant_agency,auditor_firm_name,auditor_city,auditor_state,entity_type,audit_type,is_low_risk_auditee,dollar_threshold`;

const AWARD_SELECT =
  'report_id,award_reference,federal_agency_prefix,federal_award_extension,additional_award_identification,federal_program_name,amount_expended,is_major,audit_report_type';

interface GeneralRow {
  report_id?: string;
  auditee_uei?: string;
  auditee_ein?: string;
  audit_year?: number | string;
  auditee_name?: string;
  auditee_city?: string;
  auditee_state?: string;
  auditee_zip?: string;
  total_amount_expended?: number | string;
  fac_accepted_date?: string;
  oversight_agency?: string;
  cognizant_agency?: string;
  auditor_firm_name?: string;
  auditor_city?: string;
  auditor_state?: string;
  entity_type?: string;
  audit_type?: string;
  is_low_risk_auditee?: string;
  dollar_threshold?: number | string;
}

interface AwardRow {
  report_id?: string;
  award_reference?: string;
  federal_agency_prefix?: string;
  federal_award_extension?: string;
  additional_award_identification?: string;
  federal_program_name?: string;
  amount_expended?: number | string;
  is_major?: string | boolean;
  audit_report_type?: string;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'fac_search_audits',
    description:
      'Search US single audits (Uniform Guidance / former OMB A-133) filed with the Federal Audit Clearinghouse — "the FAC" — by auditee name, UEI, EIN, state, ZIP code, audit year, or minimum federal dollars expended. Covers every kind of non-federal recipient: cities, towns, counties, school districts, fire and water districts, housing authorities, universities, tribes, hospitals and nonprofits. Returns the report_id, summary_url (the official FAC dissemination summary page for that submission), the organization name, city, state and ZIP on file, total federal awards expended for the year, the cognizant/oversight agency, and the date FAC accepted the submission. Puerto Rico municipalities are found under either their Spanish or English legal name. Answered without a live api.data.gov key or its rate limit. Answers "does this grant recipient file a single audit and how much federal money does it run", and "what is the FAC report ID / summary URL for this entity".',
    summary: 'US federal single audits (Uniform Guidance) matching a filter, from the Federal Audit Clearinghouse.',
    inputSchema: {
      type: 'object',
      properties: {
        auditee_name: {
          type: 'string',
          description: 'Organization name, matched as a forgiving case-insensitive substring (e.g. "stanford", "county of los angeles"). A municipality name is searched in both languages FAC files under, so "MUNICIPIO DE BAYAMON" and "Municipality of Bayamon" reach the same rows. Aliases: query, q, name.',
        },
        uei: { type: 'string', description: 'SAM.gov Unique Entity Identifier (12 chars), exact match. Alias: auditee_uei.' },
        ein: { type: 'string', description: 'Employer Identification Number, digits only, exact match. Alias: auditee_ein.' },
        state: { type: 'string', description: '2-letter auditee state code (e.g. "CA"). Alias: auditee_state.' },
        zip: {
          type: 'string',
          description: 'Auditee ZIP code, matched on the 5-digit prefix so it works against both the 5-digit and 9-digit forms FAC stores ("75082", "009601588"). An auditee\'s ZIP on file changes between filing years; if it filters everything out the tool says which ZIPs FAC actually holds. Aliases: auditee_zip, zipcode, zip_code, postal_code.',
        },
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
      'Fetch one single audit by its FAC report_id (e.g. "2025-09-GSAFAC-0000422512"), including its summary_url — the official Federal Audit Clearinghouse dissemination summary page for that report — enriched with the full federal program detail: every Assistance Listing (CFDA) number the entity expended money under, the program name, dollars expended per program, whether it was audited as a major program, and the opinion type. Also returns the auditor firm and audit findings when FAC recorded any. Does NOT return named-individual contact details (auditee/auditor contact name, email, phone) — those are not carried here; see the report\'s summary_url on fac.gov for that. Answers "what did this specific audit cover and what did it conclude".',
    summary: 'One US federal single audit\'s full record, by id, from the Federal Audit Clearinghouse.',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: {
          type: 'string',
          description: 'FAC report id as returned by fac_search_audits, e.g. "2025-09-GSAFAC-0000422512". Aliases: id, audit_id.',
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
    summary: 'The findings (deficiencies) reported in one federal single audit, from the Federal Audit Clearinghouse.',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string', description: 'FAC report id to pull findings for. Aliases: id, audit_id.' },
        auditee_name: { type: 'string', description: 'Recipient name substring; the tool resolves matching audits first, then their findings. Aliases: query, q, name.' },
        uei: { type: 'string', description: 'Recipient UEI; resolves that recipient\'s audits, then their findings. Alias: auditee_uei.' },
        audit_year: { type: 'number', description: 'Restrict the resolved audits to one audit year (used with auditee_name or uei).' },
        include_text: { type: 'boolean', description: 'Also attach the narrative finding text when FAC recorded any (default false — the text rows are long; a pre-2022 migrated audit often has none on file).' },
        limit: { type: 'number', description: 'Max finding rows to return, 1-200 (default 50).' },
      },
      required: [],
    },
  },
  {
    name: 'fac_federal_awards_by_program',
    description:
      'List the organizations that expended money under a given federal Assistance Listing / CFDA number (e.g. "93.224" community health centers, "84.010" Title I, "20.205" highway planning), ranked by dollars expended, with the recipient name, state, audit year and whether it was a major program. Answers "who spends the money in this federal grant program and how much does each one run".',
    summary: 'Federal awards audited under one CFDA/assistance-listing program, from the Federal Audit Clearinghouse.',
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
        include_recipients: { type: 'boolean', description: 'Resolve each report_id to the recipient name and state (default true; one extra local query).' },
      },
      required: [],
    },
  },
  {
    name: 'fac_recipient_audit_history',
    description:
      'Year-by-year single-audit history for one grant recipient, identified by UEI or by name. Returns each audit year with total federal awards expended, the report_id, the oversight agency and the FAC acceptance date, plus a growth read on the spend trend. Answers "how has this organization\'s federal funding moved over time and which years were audited".',
    summary: 'A recipient organization\'s history of federal single audits, from the Federal Audit Clearinghouse.',
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
  {
    name: 'fac_findings_search',
    description:
      'Full-text search over audit finding NARRATIVES — the actual prose auditors wrote describing a compliance exception ("failed to submit the Federal Single Audit report within the timeframe prescribed", "total available cash was less than total advances from grantors"). This is not possible against the live FAC API, which exposes no cross-table join; it is what searching the underlying text directly unlocks. Optionally narrow by state, audit year, CFDA agency prefix, or material-weakness-only. Narrative text is only on file for more recent filings — audits migrated from the pre-2022 Census-run FAC often have none, and rows without text are simply not returned rather than shown blank. Answers "which audits mention X in their findings", e.g. "data security", "cash management", "timesheet".',
    summary: 'Full-text search over Federal Audit Clearinghouse finding narratives.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search phrase, e.g. "data security" or "questioned costs travel". Uses PostgreSQL websearch syntax (quote a phrase, "-word" to exclude). Aliases: q, text.' },
        state: { type: 'string', description: '2-letter auditee state code to narrow the search, e.g. "TX".' },
        audit_year: { type: 'number', description: 'Restrict to one audit year.' },
        federal_agency_prefix: { type: 'string', description: 'Restrict to findings on awards under this 2-digit agency prefix (e.g. "93" for HHS). Alias: cfda_prefix.' },
        material_weakness_only: { type: 'boolean', description: 'Only findings flagged as a material weakness.' },
        limit: { type: 'number', description: 'Rows to return, 1-100 (default 25).' },
        offset: { type: 'number', description: 'Rows to skip, for paging.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fac_cross_table_screen',
    description:
      'Screen single audits across state, federal program (CFDA), and finding type / material weakness in ONE call — a join FAC\'s own live API cannot express (its PostgREST has no foreign key between /general, /federal_awards and /findings). Answers compound diligence questions like "material weaknesses in Texas under CFDA 93.224" or "questioned-cost findings on highway funding (20.205) over $1M". Every filter is optional; pass at least one to keep the result meaningful. Returns one row per matching (audit, award, finding) combination, ranked by award dollar amount.',
    summary: 'Cross-table screen (state + CFDA + finding type) over Federal Audit Clearinghouse data.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '2-letter auditee state code, e.g. "TX".' },
        cfda: { type: 'string', description: 'Assistance Listing / CFDA number, e.g. "93.224" or a bare 2-digit agency prefix "93". Aliases: program_number, assistance_listing, program, cfda_number.' },
        federal_agency_prefix: { type: 'string', description: 'Two-digit agency prefix on its own. Alias: prefix.' },
        federal_award_extension: { type: 'string', description: 'Program extension on its own, e.g. "224". Alias: extension.' },
        finding_type: { type: 'string', description: 'Substring match on FAC\'s finding type_requirement code (e.g. "A" internal control, "B" allowable costs — FAC packs several letters into one field, so this matches loosely).' },
        material_weakness_only: { type: 'boolean', description: 'Only findings flagged as a material weakness.' },
        min_amount: { type: 'number', description: 'Only award rows expending at least this many dollars.' },
        audit_year: { type: 'number', description: 'Restrict to one audit year.' },
        limit: { type: 'number', description: 'Rows to return, 1-100 (default 25).' },
        offset: { type: 'number', description: 'Rows to skip, for paging.' },
      },
      required: [],
    },
  },
];

/* ---------------------------------------------------------------- arg utils
   (unchanged from the live-proxy version — these only build query strings) */

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

/* ------------------------------------------------- zip + entity-name matching
   (unchanged business logic — FAC's own data quirks, not an api.fac.gov artifact) */

function zipPrefix(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5) return undefined;
  return digits.slice(0, 5);
}

function applyZipFilter(params: URLSearchParams, zip5: string | undefined): void {
  if (zip5) params.set('auditee_zip', `like.${zip5}*`);
}

function safePattern(v: string): string {
  return v.replace(/[,()"*\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

const MUNI_RE =
  /^\s*(?:municipio(?:\s+autonomo)?|municipalidad(?:\s+autonoma)?|(?:autonomous\s+)?municipality)\s+(?:de\s+la|de\s+los|del|de|of\s+the|of)\s+(.+?)\s*$/i;

function accentTolerant(place: string): string | undefined {
  if (/[^\x00-\x7F]/.test(place)) return undefined;
  const loose = place.replace(/[aeiounAEIOUN]/g, '_');
  return loose === place ? undefined : loose;
}

interface NameMatch {
  apply: (params: URLSearchParams) => void;
  note?: string;
  /** Present only on a token-fallback match (fleet #3193) — the words it required. */
  tokens?: string[];
}

function orIlike(patterns: string[]): (params: URLSearchParams) => void {
  const uniq = [...new Set(patterns)];
  return (params) => {
    if (uniq.length === 1) params.set('auditee_name', `ilike.*${uniq[0]}*`);
    else params.set('or', `(${uniq.map((p) => `auditee_name.ilike.*${p}*`).join(',')})`);
  };
}

const NAME_STOPWORDS = new Set([
  'the', 'of', 'and', 'for', 'at', 'in', 'on', 'a', 'an',
  'inc', 'incorporated', 'llc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited',
]);

export function nameTokens(raw: string): string[] {
  const words = safePattern(raw)
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/gi, ''))
    .filter((w) => w.length > 1 && !NAME_STOPWORDS.has(w.toLowerCase()));
  return [...new Set(words)];
}

/**
 * Common-name -> legal-name fallback (fleet #3193). FAC files the SAME
 * recipient under different legal names in different filing years —
 * Stanford's FYE 2025-08-31 audit is filed as "Board of Trustees of the
 * Leland Stanford Junior University", every other year as plain "Stanford
 * University" or "STANFORD UNIVERSITY". An exact-phrase ilike alone never
 * matches that row ("Stanford Junior University" is not the substring
 * "Stanford University").
 *
 * The fallback is combined with the exact phrase in ONE query via `or=`,
 * not tried only when the exact phrase finds nothing. A retry-on-empty would
 * have missed this exact shape: asking for "Stanford University" with no
 * year ALREADY finds the 2024/2021 filings (they use that literal name), so
 * it is never empty — it is a partial answer wearing the shape of a complete
 * one. That is the same failure the Puerto Rico municipality dual-language
 * matching below exists to avoid, and the same fix: put every spelling in
 * the primary query so a match that already finds *some* rows still finds
 * the rest.
 */
function nameMatch(rawName: string): NameMatch {
  const name = safePattern(rawName);
  const muni = MUNI_RE.exec(name);
  if (muni) {
    const place = safePattern(muni[1]);
    if (place) {
      const places = [place];
      const loose = accentTolerant(place);
      if (loose) places.push(loose);
      const patterns = places.flatMap((pl) => [`Municipality of ${pl}`, `Municipio de ${pl}`]);
      return {
        apply: orIlike(patterns),
        note:
          `Searched every spelling FAC actually files municipalities under — "Municipality of ${place}" and "Municipio de ${place}"` +
          (loose ? ', each also matched accent-blind so the Spanish-accented rows ("MUNICIPALITY OF AÑASCO") come back too' : '') +
          '. FAC uses either language depending on the submission year, so matching only the name you passed would have returned some of the audits and hidden the rest.',
      };
    }
  }

  const tokens = nameTokens(name);
  if (tokens.length < 2) return { apply: orIlike([name]) };

  return {
    apply: (params) => {
      const exactPred = `auditee_name.ilike.*${name}*`;
      const tokenPred = `and(${tokens.map((t) => `auditee_name.ilike.*${t}*`).join(',')})`;
      params.set('or', `(${exactPred},${tokenPred})`);
    },
    tokens,
    note:
      `Matched the exact phrase "${name}", or any audit whose filed name contains every one of these words in any order: ${tokens.join(', ')}. ` +
      'FAC sometimes files the same recipient under a different legal name in a different filing year (e.g. "Board of Trustees of the Leland Stanford Junior University" for "Stanford University") — the exact phrase alone would have found some years and silently hidden that one.',
  };
}

const MUNI_HINT =
  'For Puerto Rico municipalities, FAC files under the English name ("MUNICIPALITY OF BAYAMON") about as often as the Spanish one ("MUNICIPIO DE MANATI"), and spells places with their accents ("MUNICIPALITY OF AÑASCO"). This tool already searches both languages — if it still missed, try the bare place name on its own with state="PR".';

function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Grades one candidate name against the query, for ranking/disclosure once a
 *  token-fallback match (or any broad match) returns more than one row:
 *  exact — the filed name IS the query (case/punctuation-insensitive)
 *  contains — the query appears as a contiguous phrase inside the filed name
 *  token — only matched because every word is present, not the phrase */
export function gradeNameMatch(query: string, candidate: unknown): 'exact' | 'contains' | 'token' {
  const q = nameKey(query);
  const c = nameKey(typeof candidate === 'string' ? candidate : '');
  if (!q || !c) return 'token';
  if (q === c) return 'exact';
  return ` ${c} `.includes(` ${q} `) ? 'contains' : 'token';
}
const NAME_MATCH_ORDER = { exact: 0, contains: 1, token: 2 } as const;

/** Ranks shaped rows (anything carrying auditee_name) exact-first, contains-next,
 *  token-last, and tags each with its grade — so a broadened match discloses
 *  which rows are the recipient asked for and which are merely plausible. */
function rankByNameMatch<T extends { auditee_name?: unknown }>(
  query: string,
  rows: T[],
): (T & { auditee_name_match: 'exact' | 'contains' | 'token' })[] {
  return rows
    .map((row, i) => ({ row: { ...row, auditee_name_match: gradeNameMatch(query, row.auditee_name) }, i }))
    .sort((a, b) => NAME_MATCH_ORDER[a.row.auditee_name_match] - NAME_MATCH_ORDER[b.row.auditee_name_match] || a.i - b.i)
    .map(({ row }) => row);
}

/** Pre-2022 records migrated from the old Census-run FAC carry the literal
 *  string "GSA_MIGRATION" in auditee_uei as a placeholder, not a real UEI
 *  (scripts/fac-normalize.py nulls this sentinel out of narrative-text columns
 *  but not identity columns, since FAC's own extract carries it there too).
 *  Grouping by UEI without excluding it splits one recipient's own migrated-era
 *  audits into a second, fake "entity" sharing every other filer's sentinel —
 *  exactly the cross-entity confusion fix (2) exists to prevent. Prefer EIN
 *  (always a real tax id, stable across the migration boundary) over UEI. */
const UEI_SENTINEL = 'GSA_MIGRATION';
export function entityKey(row: { auditee_ein?: unknown; auditee_uei?: unknown; auditee_name?: unknown }): string {
  const ein = row.auditee_ein;
  if (typeof ein === 'string' && ein.trim()) return `ein:${ein.trim()}`;
  const uei = row.auditee_uei;
  if (typeof uei === 'string' && uei.trim() && uei.trim() !== UEI_SENTINEL) return `uei:${uei.trim()}`;
  const name = row.auditee_name;
  if (typeof name === 'string' && name.trim()) return `name:${nameKey(name)}`;
  return 'unknown';
}

/* --------------------------------------------- unrecognized-argument guard */

const ACCEPTED_ARGS: Record<string, string[]> = {
  fac_search_audits: [
    'auditee_name', 'query', 'q', 'name',
    'uei', 'auditee_uei', 'ein', 'auditee_ein',
    'state', 'auditee_state',
    'zip', 'auditee_zip', 'zipcode', 'zip_code', 'postal_code',
    'audit_year', 'year', 'audit_year_min', 'min_audit_year',
    'min_total_expended', 'min_amount', 'min_expended',
    'order_by', 'sort', 'ascending', 'limit', 'offset',
  ],
  fac_get_audit: ['report_id', 'id', 'audit_id', 'award_limit', 'include_findings'],
  fac_audit_findings: [
    'report_id', 'id', 'audit_id',
    'auditee_name', 'query', 'q', 'name',
    'uei', 'auditee_uei', 'audit_year', 'year',
    'include_text', 'limit',
  ],
  fac_federal_awards_by_program: [
    'cfda', 'program_number', 'assistance_listing', 'program', 'cfda_number',
    'federal_agency_prefix', 'prefix', 'federal_award_extension', 'extension',
    'state', 'audit_year', 'major_only', 'min_amount', 'limit', 'include_recipients',
  ],
  fac_recipient_audit_history: [
    'uei', 'auditee_uei', 'ein', 'auditee_ein',
    'auditee_name', 'query', 'q', 'name',
    'state', 'auditee_state', 'years', 'limit',
  ],
  fac_findings_search: [
    'query', 'q', 'text', 'state', 'audit_year',
    'federal_agency_prefix', 'cfda_prefix', 'material_weakness_only', 'limit', 'offset',
  ],
  fac_cross_table_screen: [
    'state', 'cfda', 'program_number', 'assistance_listing', 'program', 'cfda_number',
    'federal_agency_prefix', 'prefix', 'federal_award_extension', 'extension',
    'finding_type', 'material_weakness_only', 'min_amount', 'audit_year', 'limit', 'offset',
  ],
};

function unrecognizedArgs(tool: string, args: Record<string, unknown>): string[] {
  const accepted = ACCEPTED_ARGS[tool];
  if (!accepted) return [];
  const known = new Set(accepted);
  return Object.keys(args).filter((k) => !k.startsWith('_') && !known.has(k) && args[k] !== undefined && args[k] !== null);
}

function withArgWarning(tool: string, result: unknown, ignored: string[]): unknown {
  if (ignored.length === 0) return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const accepted = (ACCEPTED_ARGS[tool] ?? []).join(', ');
  return {
    ...(result as Record<string, unknown>),
    ignored_arguments: ignored,
    warnings: [
      `${tool} does not accept ${ignored.map((k) => `"${k}"`).join(', ')} — ${ignored.length === 1 ? 'that filter was' : 'those filters were'} NOT applied, so this result is broader than what you asked for. Accepted arguments: ${accepted}.`,
    ],
  };
}

/* --------------------------------------------------------------- db layer */

async function sbRequest(cfg: DbConfig, path: string, params: URLSearchParams): Promise<Response> {
  const qs = params.toString();
  const url = `${cfg.url}/rest/v1${path}${qs ? `?${qs}` : ''}`;
  return pwFetch(url, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
  });
}

/** Rows from a local FAC table. Throws on real errors; never returns null for an empty table. */
async function sbRows(cfg: DbConfig, path: string, params: URLSearchParams): Promise<Row[]> {
  const res = await sbRequest(cfg, path, params);
  if (!res.ok) throw await httpError(res, 'Federal Audit Clearinghouse data');
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error('Federal Audit Clearinghouse data: expected a row array — treating this as a failure rather than an empty result.');
  }
  return body as Row[];
}

/** Same as sbRows but folds a missing/renamed table into null so a supplementary lookup can degrade quietly. */
async function sbRowsOptional(
  cfg: DbConfig,
  path: string,
  params: URLSearchParams,
): Promise<{ rows: Row[] } | { rows: null; status: number }> {
  const res = await sbRequest(cfg, path, params);
  if (res.status === 404 || res.status === 400 || res.status === 406) {
    return { rows: null, status: res.status };
  }
  if (!res.ok) throw await httpError(res, 'Federal Audit Clearinghouse data');
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error('Federal Audit Clearinghouse data: expected a row array — treating this as a failure rather than an empty result.');
  }
  return { rows: body as Row[] };
}

/** Call an RPC (the cross-table joins the local schema exposes that plain PostgREST filters cannot). */
async function sbRpc(cfg: DbConfig, fn: string, body: Record<string, unknown>): Promise<Row[]> {
  const url = `${cfg.url}/rest/v1/rpc/${fn}`;
  const res = await pwFetch(url, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Prefer: 'params=single-object',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, 'Federal Audit Clearinghouse data');
  const parsed = await res.json();
  if (!Array.isArray(parsed)) {
    throw new Error('Federal Audit Clearinghouse data: RPC did not return a row array — treating this as a failure.');
  }
  return parsed as Row[];
}

let cachedDataAsOf: string | null | undefined;

/** The last successful refresh, read once per Worker instance and reused across tool calls in the same call. */
async function dataAsOf(cfg: DbConfig): Promise<string | null> {
  if (cachedDataAsOf !== undefined) return cachedDataAsOf;
  try {
    const rows = await sbRows(
      cfg,
      '/fac_ingest_runs',
      new URLSearchParams({ status: 'eq.ok', select: 'finished_at', order: 'finished_at.desc', limit: '1' }),
    );
    cachedDataAsOf = rows.length ? (rows[0]['finished_at'] as string) : null;
  } catch {
    cachedDataAsOf = null; // freshness is metadata, never the reason a call fails
  }
  return cachedDataAsOf;
}

function withDataAsOf<T extends Record<string, unknown>>(result: T, asOf: string | null): T & { data_as_of: string | null } {
  return {
    ...result,
    data_as_of: asOf,
    ...(asOf
      ? {}
      : {
          coverage_status:
            'This data source has not completed its first load yet — results may be empty or incomplete. This is a deployment state, not a query problem.',
        }),
  };
}

/* ------------------------------------------------------------- shared shape */

function inList(values: string[]): string {
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
    award_reference: a.award_reference,
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
    award_reference: row.award_reference,
    reference_number: row.reference_number,
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

// The public FAC page for one submission. Not a column the local table carries —
// it is a deterministic path off report_id (verified live: /dissemination/
// summary/2025-09-GSAFAC-0000422512 is a 200 carrying CENTRAL FALLS HOUSING
// AUTHORITY). Kept from the live-proxy version for the same reason it was
// added there: callers keep asking for it BY NAME.
const summaryUrl = (reportId: string | undefined): string | undefined =>
  reportId ? `https://app.fac.gov/dissemination/summary/${encodeURIComponent(reportId)}` : undefined;

function shapeGeneral(row: Row): Record<string, unknown> {
  const g = row as GeneralRow;
  return {
    report_id: g.report_id,
    summary_url: summaryUrl(g.report_id),
    audit_year: num(g.audit_year) ?? g.audit_year,
    auditee_name: g.auditee_name,
    auditee_uei: g.auditee_uei,
    auditee_ein: g.auditee_ein,
    auditee_city: g.auditee_city,
    auditee_state: g.auditee_state,
    auditee_zip: g.auditee_zip,
    total_amount_expended: num(g.total_amount_expended),
    oversight_agency: g.oversight_agency,
    fac_accepted_date: g.fac_accepted_date,
  };
}

/* ------------------------------------------------------- 1. fac_search_audits */

const ORDER_COLUMNS = new Set(['total_amount_expended', 'audit_year', 'fac_accepted_date', 'auditee_name']);

async function searchAudits(cfg: DbConfig, args: Record<string, unknown>) {
  const name = optStr(args, 'auditee_name', 'query', 'q', 'name');
  const uei = optStr(args, 'uei', 'auditee_uei');
  const ein = optStr(args, 'ein', 'auditee_ein');
  const state = optStr(args, 'state', 'auditee_state');
  const zipRaw = optStr(args, 'zip', 'auditee_zip', 'zipcode', 'zip_code', 'postal_code');
  const zip5 = zipPrefix(zipRaw);
  const auditYear = optNum(args, 'audit_year', 'year');
  const auditYearMin = optNum(args, 'audit_year_min', 'min_audit_year');
  const minExpended = optNum(args, 'min_total_expended', 'min_amount', 'min_expended');
  const limit = clampInt(optNum(args, 'limit'), 20, 1, 200);
  const offset = clampInt(optNum(args, 'offset'), 0, 0, 100000);

  if (zipRaw && !zip5) {
    return {
      found: false,
      reason: 'bad_zip',
      hint: `"${zipRaw}" is not a usable ZIP — pass 5 digits ("75082") or ZIP+4 ("75082-1234"). FAC stores both 5- and 9-digit forms, so this tool matches on the 5-digit prefix.`,
    } satisfies NotFound;
  }

  if (!name && !uei && !ein && !state && !zip5 && auditYear === undefined && auditYearMin === undefined && minExpended === undefined) {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Pass at least one filter: auditee_name ("stanford"), uei, ein, state ("CA"), zip ("75082"), audit_year (2023), or min_total_expended.',
    } satisfies NotFound;
  }

  const orderByRaw = optStr(args, 'order_by', 'sort');
  const orderBy = orderByRaw && ORDER_COLUMNS.has(orderByRaw) ? orderByRaw : 'total_amount_expended';
  const dir = optBool(args, 'ascending', false) ? 'asc' : 'desc';

  const baseParams = (opts: { includeAuditYear?: boolean } = {}): URLSearchParams => {
    const params = new URLSearchParams({
      select: GENERAL_SELECT,
      order: `${orderBy}.${dir}`,
      limit: String(limit),
    });
    if (offset) params.set('offset', String(offset));
    if (uei) params.set('auditee_uei', `eq.${uei.toUpperCase()}`);
    if (ein) params.set('auditee_ein', `eq.${ein.replace(/\D/g, '')}`);
    if (state) params.set('auditee_state', `eq.${state.toUpperCase()}`);
    if (opts.includeAuditYear !== false) {
      if (auditYear !== undefined) params.set('audit_year', `eq.${Math.trunc(auditYear)}`);
      else if (auditYearMin !== undefined) params.set('audit_year', `gte.${Math.trunc(auditYearMin)}`);
    }
    if (minExpended !== undefined) params.set('total_amount_expended', `gte.${Math.trunc(minExpended)}`);
    return params;
  };

  const match = name ? nameMatch(name) : undefined;

  const buildParams = (opts?: { includeAuditYear?: boolean }): URLSearchParams => {
    const params = baseParams(opts);
    match?.apply(params);
    applyZipFilter(params, zip5);
    return params;
  };

  const rows = await sbRows(cfg, '/fac_general', buildParams());

  if (rows.length === 0) {
    if (zip5) {
      const probe = baseParams();
      probe.set('limit', '25');
      match?.apply(probe);
      const without = await sbRows(cfg, '/fac_general', probe);
      if (without.length > 0) {
        const zips = [...new Set(without.map((r) => (r as GeneralRow).auditee_zip).filter(Boolean) as string[])];
        return {
          found: false,
          reason: 'zip_no_match',
          hint: `The other filters matched ${without.length} audit${without.length === 1 ? '' : 's'}, but none is filed under ZIP ${zip5}. FAC holds ${zips.length === 1 ? 'ZIP' : 'ZIPs'} ${zips.join(', ')} for ${name ? `"${name}"` : 'that entity'}${auditYear !== undefined ? ` in ${auditYear}` : ''} — an auditee's ZIP on file changes between filing years, so a current ZIP will not match an older audit. Re-run without zip, or with one of those.`,
          zips_on_file: zips,
          matches_without_zip: without.map(shapeGeneral),
        };
      }
    }

    // The recipient may be on file under this name but not in the year asked
    // for — same disclosure shape as the zip fallback above (fleet #3193). A
    // bare "no match" here is indistinguishable from "never filed that year",
    // which is exactly the silent-wrong-answer shape the Stanford FY2025 bug
    // took: the caller cannot tell "not filed" from "filed under a name/year
    // this query didn't try" unless the years actually on file are named.
    if (name && (auditYear !== undefined || auditYearMin !== undefined)) {
      const probeNoYear = buildParams({ includeAuditYear: false });
      probeNoYear.set('limit', '25');
      const withoutYear = await sbRows(cfg, '/fac_general', probeNoYear);
      if (withoutYear.length > 0) {
        const years = [...new Set(
          withoutYear.map((r) => num((r as GeneralRow).audit_year)).filter((y): y is number => y !== undefined),
        )].sort((a, b) => b - a);
        return {
          found: false,
          reason: 'audit_year_no_match',
          hint: `"${name}" matched ${withoutYear.length} audit${withoutYear.length === 1 ? '' : 's'}, but none for audit_year ${auditYear ?? `>= ${auditYearMin}`}. FAC holds audit_year ${years.join(', ')} for this recipient — re-run with one of those, or drop audit_year.`,
          audit_years_on_file: years,
          matches_other_years: withoutYear.map(shapeGeneral),
        };
      }
    }

    return {
      found: false,
      reason: 'no_audits_match',
      hint: `No single audit matched. Try a shorter auditee_name fragment${name ? ` than "${name}"` : ''}, drop the audit_year, or search by uei. Entities under the ~$750k federal-spend threshold never file.${match?.note && !match.tokens ? ` ${MUNI_HINT}` : ''}`,
      filters_tried: {
        auditee_name: name,
        uei,
        ein,
        state,
        zip: zip5,
        audit_year: auditYear,
        audit_year_min: auditYearMin,
        min_total_expended: minExpended,
      },
      name_match_attempted: name
        ? {
            exact_phrase: name,
            tokens_also_tried: match?.tokens,
          }
        : undefined,
    };
  }

  const shaped = rows.map(shapeGeneral);
  const audits = name ? rankByNameMatch(name, shaped) : shaped;

  return {
    found: true,
    filters: {
      auditee_name: name,
      uei,
      ein,
      state,
      zip: zip5,
      audit_year: auditYear,
      audit_year_min: auditYearMin,
      min_total_expended: minExpended,
    },
    name_match: match?.note,
    count: rows.length,
    order: `${orderBy}.${dir}`,
    audits,
    source: 'Federal Audit Clearinghouse /general',
  };
}

/* ---------------------------------------------------------- 2. fac_get_audit */

async function getAudit(cfg: DbConfig, args: Record<string, unknown>) {
  const reportId = reqStr(args, 'report_id', '"2025-09-GSAFAC-0000422512"', 'id', 'audit_id');
  const awardLimit = clampInt(optNum(args, 'award_limit'), 200, 1, 500);

  const generalRows = await sbRows(
    cfg,
    '/fac_general',
    new URLSearchParams({ select: GENERAL_DETAIL_SELECT, report_id: `eq.${reportId}`, limit: '1' }),
  );
  if (generalRows.length === 0) {
    return {
      found: false,
      reason: 'report_id_not_found',
      hint: `No audit with report_id "${reportId}". Report ids look like "2025-09-GSAFAC-0000422512"; get one from fac_search_audits.`,
    } satisfies NotFound;
  }
  const g = generalRows[0] as GeneralRow & Row;

  const awards = await sbRows(
    cfg,
    '/fac_federal_awards',
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
      cognizant_agency: g.cognizant_agency,
      auditor_firm_name: g.auditor_firm_name,
      auditor_city: g.auditor_city,
      auditor_state: g.auditor_state,
      entity_type: g.entity_type,
      audit_type: g.audit_type,
      is_low_risk_auditee: g.is_low_risk_auditee,
      dollar_threshold: num(g.dollar_threshold),
    },
    federal_awards: {
      program_count: programs,
      major_program_count: majorPrograms,
      amount_expended_total: awardTotal,
      truncated: awards.length === awardLimit,
      rows: shapedAwards,
    },
    personal_data_note:
      'Named-individual contact fields (auditee/auditor contact name, email, phone) are not carried here. See summary_url for FAC\'s own record if you need them.',
    source: 'Federal Audit Clearinghouse /general + /federal_awards',
  };

  if (optBool(args, 'include_findings', true)) {
    const findings = await sbRowsOptional(
      cfg,
      '/fac_findings',
      new URLSearchParams({ report_id: `eq.${reportId}`, limit: '100' }),
    );
    if (findings.rows === null) {
      result.findings = {
        available: false,
        reason: `Federal Audit Clearinghouse data returned HTTP ${findings.status}`,
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

async function auditFindings(cfg: DbConfig, args: Record<string, unknown>) {
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
    params.set('auditee_uei', `eq.${uei.toUpperCase()}`);
    scope.auditee_uei = uei.toUpperCase();
    if (auditYear !== undefined) {
      params.set('audit_year', `eq.${Math.trunc(auditYear)}`);
      scope.audit_year = Math.trunc(auditYear);
    }
  } else if (name) {
    // Combined exact + every-word-present match (fleet #3193), one query —
    // so "Stanford University" finds the one filing year ("Board of
    // Trustees of the Leland Stanford Junior University") an exact phrase
    // alone cannot, even though the exact phrase already matches other years.
    const match = nameMatch(name);
    const gp = new URLSearchParams({ select: GENERAL_SELECT, order: 'audit_year.desc', limit: '25' });
    match.apply(gp);
    if (auditYear !== undefined) gp.set('audit_year', `eq.${Math.trunc(auditYear)}`);
    const generalRows = await sbRows(cfg, '/fac_general', gp);
    if (generalRows.length === 0) {
      return {
        found: false,
        reason: 'no_audits_match',
        hint: `No audit matched "${name}", so there are no findings to pull. Try a shorter name fragment or confirm the recipient with fac_search_audits.${match.note && !match.tokens ? ` ${MUNI_HINT}` : ''}`,
        name_match_attempted: { exact_phrase: name, tokens_also_tried: match.tokens },
      };
    }

    // Fix (2), fleet #3193: findings must never be reported against a
    // different audit than the one asked about. A broadened (token) name
    // match can pull in more than one real-world recipient that merely
    // shares every word — never pool their findings into one unlabeled
    // summary. Name the mismatch instead of guessing whose data this is.
    // entityKey ignores the "GSA_MIGRATION" UEI-migration sentinel, so one
    // recipient's own pre-2022 rows are never miscounted as a second entity.
    const distinctEntities = [...new Set(generalRows.map((r) => entityKey(r as GeneralRow)))];
    if (distinctEntities.length > 1) {
      return {
        found: false,
        reason: 'ambiguous_name_match',
        hint: `"${name}" matched ${distinctEntities.length} different legal entities, not one recipient — reporting findings would pool unrelated audits under one summary. Pass uei or report_id to pin one, or audit_year to narrow it.`,
        candidates: rankByNameMatch(name, generalRows.map(shapeGeneral)),
      };
    }

    context = rankByNameMatch(name, generalRows.map(shapeGeneral));
    reportIds = generalRows.map((r) => String((r as GeneralRow).report_id ?? '')).filter(Boolean);
    params.set('report_id', reportIds.length === 1 ? `eq.${reportIds[0]}` : inList(reportIds));
    scope.auditee_name = name;
    scope.audits_matched = reportIds.length;
    scope.audits_searched_report_ids = reportIds;
    scope.matched_audit_years = [...new Set(
      generalRows.map((r) => num((r as GeneralRow).audit_year)).filter((y): y is number => y !== undefined),
    )].sort((a, b) => b - a);
  } else {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Pass report_id, or auditee_name / uei to sweep a recipient\'s audits for findings.',
    } satisfies NotFound;
  }

  const findings = await sbRowsOptional(cfg, '/fac_findings', params);

  if (findings.rows === null) {
    return {
      found: false,
      reason: 'findings_table_unavailable',
      hint: `Federal Audit Clearinghouse data answered HTTP ${findings.status}. Use fac_get_audit for the same report_id — its federal award rows carry audit_report_type (the per-program opinion), which is the surviving compliance signal.`,
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
    const textParams = new URLSearchParams({ limit: String(limit) });
    textParams.set('report_id', shapedIds.length === 1 ? `eq.${shapedIds[0]}` : inList(shapedIds));
    const texts = await sbRowsOptional(cfg, '/fac_findings_text', textParams);
    result.findings_text =
      texts.rows === null
        ? { available: false, reason: `Federal Audit Clearinghouse data returned HTTP ${texts.status}` }
        : {
            available: true,
            count: texts.rows.filter((r) => r.finding_text).length,
            rows: texts.rows
              .filter((r) => r.finding_text)
              .map((r) => ({
                report_id: r.report_id,
                finding_ref_number: r.finding_ref_number,
                finding_text: typeof r.finding_text === 'string' ? r.finding_text.trim() : r.finding_text,
              })),
            note: 'Rows with no narrative on file (common for audits migrated from the pre-2022 Census-run FAC) are omitted rather than shown blank.',
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

async function awardsByProgram(cfg: DbConfig, args: Record<string, unknown>) {
  const program = resolveProgram(args);
  if ('found' in program) return program;

  const limit = clampInt(optNum(args, 'limit'), 25, 1, 200);
  const state = optStr(args, 'state', 'auditee_state');
  const auditYear = optNum(args, 'audit_year', 'year');
  const majorOnly = optBool(args, 'major_only', false);
  const minAmount = optNum(args, 'min_amount', 'min_expended');
  const wantRecipients = optBool(args, 'include_recipients', true);

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

  const awardRows = await sbRows(cfg, '/fac_federal_awards', params);
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
      const generalRows = await sbRows(
        cfg,
        '/fac_general',
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

async function recipientHistory(cfg: DbConfig, args: Record<string, unknown>) {
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

  // Name filter only applies when resolving by name alone — a caller who
  // already gave uei/ein is identified, so no name filter is applied.
  // nameMatch combines the exact phrase with the every-word-present
  // fallback in one query (fleet #3193).
  const match = !uei && !ein && name ? nameMatch(name) : undefined;
  const buildParams = (m?: NameMatch): URLSearchParams => {
    const params = new URLSearchParams({
      select: GENERAL_SELECT,
      order: 'audit_year.desc',
      limit: String(Math.max(years * 2, 20)),
    });
    if (uei) params.set('auditee_uei', `eq.${uei.toUpperCase()}`);
    if (ein) params.set('auditee_ein', `eq.${ein.replace(/\D/g, '')}`);
    m?.apply(params);
    if (state) params.set('auditee_state', `eq.${state.toUpperCase()}`);
    return params;
  };

  const rows = await sbRows(cfg, '/fac_general', buildParams(match));

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_audit_history',
      hint: `No single audits on file for that recipient${name ? ` matching "${name}"` : ''}. Try a shorter name fragment, drop the state filter, or confirm the UEI with fac_search_audits.${match?.note && !match.tokens ? ` ${MUNI_HINT}` : ''}`,
      name_match_attempted: name ? { exact_phrase: name, tokens_also_tried: match?.tokens } : undefined,
    };
  }

  const shapedRaw = rows.map(shapeGeneral);
  const shaped = name ? rankByNameMatch(name, shapedRaw) : shapedRaw;

  // Group by entity, not by name string — entityKey prefers EIN (stable
  // across the 2022 FAC migration) and ignores the literal "GSA_MIGRATION"
  // UEI placeholder, so one recipient's pre-2022 rows are never miscounted
  // as a second, fake "entity" sharing every other filer's sentinel. This
  // guards the exact scenario fix (1) widens exposure to: Stanford's own
  // 2019-2021 rows carry auditee_uei="GSA_MIGRATION", and a naive
  // uei-first grouping key would have reported a false "2 entities matched"
  // for a single university the moment token matching started returning its
  // full multi-year history.
  const entities = new Map<string, { auditee_uei?: string; auditee_name?: string; auditee_state?: string; audits: number }>();
  for (const r of shaped) {
    const key = entityKey(r);
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
    name_match: match?.note,
    years_returned: history.length,
    history,
    trend,
    audits: shaped,
    source: 'Federal Audit Clearinghouse /general',
  };
}

/* --------------------------------------------------- 6. fac_findings_search */

async function findingsSearch(cfg: DbConfig, args: Record<string, unknown>) {
  const q = reqStr(args, 'query', '"data security"', 'q', 'text');
  const state = optStr(args, 'state');
  const auditYear = optNum(args, 'audit_year');
  const prefix = optStr(args, 'federal_agency_prefix', 'cfda_prefix');
  const materialOnly = optBool(args, 'material_weakness_only', false);
  const limit = clampInt(optNum(args, 'limit'), 25, 1, 100);
  const offset = clampInt(optNum(args, 'offset'), 0, 0, 5000);

  const rows = await sbRpc(cfg, 'fac_findings_search', {
    q,
    state_in: state ? state.toUpperCase() : null,
    audit_year_in: auditYear !== undefined ? Math.trunc(auditYear) : null,
    cfda_prefix_in: prefix ? prefix.padStart(2, '0') : null,
    material_weakness_only: materialOnly,
    lim: limit,
    off: offset,
  });

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_findings_matched',
      hint: `No finding narrative matched "${q}"${state ? ` in ${state.toUpperCase()}` : ''}. Try a shorter or less specific phrase — narrative text is only on file for more recent filings, so a very narrow search over an older audit year can legitimately come back empty.`,
      query: q,
    } satisfies NotFound & { query: string };
  }

  return {
    found: true,
    query: q,
    filters: { state: state?.toUpperCase(), audit_year: auditYear, federal_agency_prefix: prefix, material_weakness_only: materialOnly || undefined },
    count: rows.length,
    truncated: rows.length === limit,
    results: rows.map((r) => ({
      report_id: r.report_id,
      summary_url: summaryUrl(r.report_id as string | undefined),
      auditee_name: r.auditee_name,
      auditee_state: r.auditee_state,
      audit_year: num(r.audit_year) ?? r.audit_year,
      finding_ref_number: r.finding_ref_number,
      type_requirement: r.type_requirement,
      is_material_weakness: r.is_material_weakness,
      is_significant_deficiency: r.is_significant_deficiency,
      finding_text: r.finding_text,
      rank: num(r.rank),
    })),
    source: 'Federal Audit Clearinghouse, full-text search over finding narratives',
  };
}

/* ---------------------------------------------- 7. fac_cross_table_screen */

async function crossTableScreen(cfg: DbConfig, args: Record<string, unknown>) {
  const state = optStr(args, 'state');
  const findingType = optStr(args, 'finding_type');
  const materialOnly = optBool(args, 'material_weakness_only', false);
  const minAmount = optNum(args, 'min_amount');
  const auditYear = optNum(args, 'audit_year');
  const limit = clampInt(optNum(args, 'limit'), 25, 1, 100);
  const offset = clampInt(optNum(args, 'offset'), 0, 0, 5000);

  let prefix: string | undefined;
  let extension: string | undefined;
  if (args.cfda || args.program_number || args.assistance_listing || args.program || args.cfda_number || args.federal_agency_prefix || args.prefix) {
    const program = resolveProgram(args);
    if ('found' in program) return program;
    prefix = program.prefix;
    extension = program.extension;
  }

  if (!state && !prefix && !findingType && !materialOnly && minAmount === undefined && auditYear === undefined) {
    return {
      found: false,
      reason: 'no_filter',
      hint: 'Pass at least one filter: state ("TX"), cfda ("93.224"), finding_type, material_weakness_only, min_amount, or audit_year — a fully unfiltered screen is not a useful answer.',
    } satisfies NotFound;
  }

  const rows = await sbRpc(cfg, 'fac_cross_table_screen', {
    state_in: state ? state.toUpperCase() : null,
    cfda_prefix_in: prefix ?? null,
    cfda_extension_in: extension ?? null,
    finding_type_in: findingType ?? null,
    material_weakness_only: materialOnly,
    min_amount_in: minAmount ?? null,
    audit_year_in: auditYear !== undefined ? Math.trunc(auditYear) : null,
    lim: limit,
    off: offset,
  });

  if (rows.length === 0) {
    return {
      found: false,
      reason: 'no_matches',
      hint: 'No (audit, award, finding) combination matched every filter together. Drop one filter — state and CFDA both being narrow, plus material_weakness_only, is a combination few audits satisfy at once.',
      filters: { state: state?.toUpperCase(), cfda: prefix ? (extension ? `${prefix}.${extension}` : prefix) : undefined, finding_type: findingType, material_weakness_only: materialOnly || undefined, min_amount: minAmount, audit_year: auditYear },
    } satisfies NotFound & { filters: Record<string, unknown> };
  }

  return {
    found: true,
    filters: { state: state?.toUpperCase(), cfda: prefix ? (extension ? `${prefix}.${extension}` : prefix) : undefined, finding_type: findingType, material_weakness_only: materialOnly || undefined, min_amount: minAmount, audit_year: auditYear },
    count: rows.length,
    truncated: rows.length === limit,
    ranked_by: 'amount_expended.desc',
    results: rows.map((r) => ({
      report_id: r.report_id,
      summary_url: summaryUrl(r.report_id as string | undefined),
      auditee_name: r.auditee_name,
      auditee_state: r.auditee_state,
      audit_year: num(r.audit_year) ?? r.audit_year,
      total_amount_expended: num(r.total_amount_expended),
      award_reference: r.award_reference,
      assistance_listing: assistanceListing(r as AwardRow),
      federal_program_name: r.federal_program_name,
      amount_expended: num(r.amount_expended),
      reference_number: r.reference_number,
      type_requirement: r.type_requirement,
      is_material_weakness: r.is_material_weakness,
      is_significant_deficiency: r.is_significant_deficiency,
    })),
    source: 'Federal Audit Clearinghouse, joined across /general + /federal_awards + /findings — not expressible against the live FAC API in one call',
  };
}

/* -------------------------------------------------------------- dispatch */

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) {
    throw new Error(
      'fac is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.',
    );
  }
  const cfg: DbConfig = { url, key };

  const ignored = unrecognizedArgs(name, args);
  const asOf = await dataAsOf(cfg);
  const result = await dispatch(name, cfg, args);
  const withFreshness =
    result && typeof result === 'object' && !Array.isArray(result) ? withDataAsOf(result as Record<string, unknown>, asOf) : result;
  return withArgWarning(name, withFreshness, ignored);
}

async function dispatch(name: string, cfg: DbConfig, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'fac_search_audits':
      return searchAudits(cfg, args);
    case 'fac_get_audit':
      return getAudit(cfg, args);
    case 'fac_audit_findings':
      return auditFindings(cfg, args);
    case 'fac_federal_awards_by_program':
      return awardsByProgram(cfg, args);
    case 'fac_recipient_audit_history':
      return recipientHistory(cfg, args);
    case 'fac_findings_search':
      return findingsSearch(cfg, args);
    case 'fac_cross_table_screen':
      return crossTableScreen(cfg, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
