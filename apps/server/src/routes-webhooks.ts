import { Hono } from 'hono';
import { z } from 'zod';
import { db, now } from './db.js';
import { env } from './env.js';
import { composioSignatureValid } from './lib/composio-webhook.js';
import { connectionWatch } from './core/connection-watch.js';

/**
 * /webhooks: calls from services, not from a signed-in person, so nothing here sits behind a session.
 * Each route proves its caller another way.
 */
export const webhooksApi = new Hono();

/** The one field of a `composio.connected_account.expired` event this server acts on. */
const ConnectionExpiredSchema = z.object({
  type: z.literal('composio.connected_account.expired'),
  data: z.object({ user_id: z.string() }),
});

/**
 * Composio's project webhook. It only arrives where this server has a public URL and
 * COMPOSIO_WEBHOOK_SECRET is set; everywhere else the sweep in core/connection-watch.ts finds the
 * same thing a little later. The event is a prompt to look, not the source of truth: the account
 * list is read again, so a replayed or stale event cannot raise a card on its own.
 */
webhooksApi.post('/composio', async (c) => {
  if (!env.composioWebhookSecret) return c.json({ error: 'not configured' }, 404);
  const body = await c.req.text();
  const signed = composioSignatureValid(
    { id: c.req.header('webhook-id'), timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature'), body },
    env.composioWebhookSecret,
    now(),
  );
  if (!signed) return c.json({ error: 'bad signature' }, 401);

  let json: unknown;
  try { json = JSON.parse(body); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  const event = ConnectionExpiredSchema.safeParse(json);
  // Other event types share this endpoint; they are acknowledged so Composio does not retry them.
  if (event.success && db.prepare('SELECT 1 FROM users WHERE id=?').get(event.data.data.user_id)) {
    void connectionWatch.check(event.data.data.user_id).catch((e) => console.warn('[connections] webhook check failed', (e as Error).message));
  }
  return c.json({ ok: true });
});
