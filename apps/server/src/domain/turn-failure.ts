/**
 * What kind of failure ended a turn, read from the HTTP status and the error text the gateway
 * reported. The kind decides what the supervisor does next (domain/supervisor-policy.ts).
 *
 * Hermes already retries a transient provider error itself (api_max_retries, its fallback chain,
 * then auto_recovery_cycles), but only while nothing in the turn has been delivered; what reaches
 * Orbit is a failure Hermes gave up on, or one it never retries.
 */

export type FailureKind = 'transient' | 'gateway' | 'lost-turn' | 'auth' | 'model' | 'context' | 'billing' | 'fatal';

export interface TurnFailure { kind: FailureKind; message: string; status?: number }

/** First match wins, so the narrower kinds come before the broad "transient". */
const RULES: readonly (readonly [FailureKind, RegExp])[] = [
  // Hermes fences a turn its gateway lost mid-run and refuses the conversation until it is discarded.
  ['lost-turn', /unknown_execution/],
  ['billing', /credit balance|insufficient[_ ]quota|billing|payment required|exceeded your current quota/i],
  ['auth', /no [\w-]+ credentials|unauthori[sz]ed|invalid[_ -]?(api[_ -]?)?key|authentication|invalid_grant|token (has )?expired|not signed in|sign in again/i],
  ['model', /model\b[^\n]{0,60}\b(not found|does not exist|not available|unknown|not supported)|unknown model|model_not_found|no such model/i],
  ['context', /context (length|window)|too many tokens|prompt is too long|maximum context|input is too long/i],
  ['gateway', /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|other side closed|EPIPE|the agent stopped|agent is not running|gateway (is )?not (running|ready)|UND_ERR/i],
  ['transient', /rate.?limit|overloaded|temporarily unavailable|timed? ?out|timeout|try again|service unavailable|bad gateway|internal server error|server error|stream (ended|closed)|\b(429|500|502|503|504|529)\b/i],
];

const BY_STATUS: Record<number, FailureKind> = { 401: 'auth', 402: 'billing', 403: 'auth', 404: 'model', 408: 'transient', 409: 'transient', 425: 'transient', 429: 'transient' };
/** Kinds the error text decides even when the status says otherwise. */
const TEXT_WINS: ReadonlySet<FailureKind> = new Set(['billing', 'lost-turn']);

/**
 * An error and the errors it was caused by, as one line. Node's fetch reports a dropped stream as
 * `TypeError: terminated` with the reason (`other side closed`, `UND_ERR_SOCKET`) only in `cause`.
 */
export function errorText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 4; depth++) {
    const o = cur as { message?: unknown; code?: unknown; cause?: unknown };
    const message = typeof o.message === 'string' ? o.message : typeof cur === 'string' ? cur : '';
    if (message && !parts.includes(message)) parts.push(message);
    if (typeof o.code === 'string' && !parts.includes(o.code)) parts.push(o.code);
    cur = o.cause;
  }
  return parts.join(': ') || String(e);
}

export function classifyFailure(message: string, status?: number): TurnFailure {
  const text = message.trim() || 'the agent run failed';
  const byText = RULES.find(([, re]) => re.test(text))?.[0];
  // A 429 that is really "out of credit" must not be retried for twenty minutes.
  const byStatus = status === undefined ? undefined : status >= 500 ? 'transient' : BY_STATUS[status];
  const kind: FailureKind = byText && TEXT_WINS.has(byText) ? byText : byStatus ?? byText ?? 'fatal';
  return { kind, message: text.slice(0, 500), ...(status !== undefined ? { status } : {}) };
}

/** A short reason for a person: what went wrong, not the raw provider payload. */
export function failureReason(f: TurnFailure): string {
  switch (f.kind) {
    case 'transient': return /rate.?limit|\b429\b/i.test(f.message) ? 'the model provider is rate limiting' : 'the model provider is not answering right now';
    case 'gateway': return 'its agent stopped responding';
    case 'lost-turn': return 'its agent lost the turn it was on when it restarted';
    case 'auth': return 'its model sign-in was refused';
    case 'model': return 'its model is not available';
    case 'context': return 'the conversation is too long for its model';
    case 'billing': return 'the model account is out of credit';
    case 'fatal': return f.message;
  }
}
