import crypto from 'node:crypto';

/**
 * Composio signs a webhook as HMAC-SHA256 over `<webhook-id>.<webhook-timestamp>.<body>` with the
 * project's webhook secret, base64, sent as `v1,<signature>` (several may be listed, space-separated).
 * The SDK's own verifier only accepts trigger payloads, so the account events are checked here.
 */

export interface SignedWebhook {
  id: string | undefined;
  /** Unix seconds, as the `webhook-timestamp` header carries it. */
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
}

/** How old a webhook may be. A captured request cannot be replayed after this. */
const TOLERANCE_MS = 5 * 60_000;

function sameBytes(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function composioSignatureValid(hook: SignedWebhook, secret: string, nowMs: number): boolean {
  if (!secret || !hook.id || !hook.timestamp || !hook.signature || !hook.body) return false;
  const sentAt = Number(hook.timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(nowMs - sentAt) > TOLERANCE_MS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${hook.id}.${hook.timestamp}.${hook.body}`).digest('base64');
  return hook.signature.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    return version === 'v1' && Boolean(value) && sameBytes(value, expected);
  });
}
