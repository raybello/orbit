import type { CardBody } from '@orbit/contracts';
import { db, now } from '../db.js';
import { hub } from '../lib/hub.js';
import { sendPushNotification } from '../push.js';
import { appendRow, emitBot, getBotRow, updateRow } from '../store.js';
import { composioEnabled, connectionsDetail, toolkitInfo } from '../composio.js';
import { connectionHealth, planReconnectAlerts, slugInToolkit, type ConnectionAccount } from '../domain/connections.js';
import { decideCard } from './card-service.js';

/**
 * Notices a connected app whose sign-in has expired and puts a reconnect card in the chat of the
 * bot it affects, instead of leaving that bot's tool calls and event routines to fail quietly.
 *
 * Composio only announces an expiry over a webhook, which a server on someone's own machine cannot
 * receive, so the account list is the source of truth and three things prompt a look at it: a
 * periodic sweep, a webhook when one does arrive (routes-webhooks.ts), and a connected-app call
 * that fails or that names an app already known to be expired (mcp.ts).
 */

db.exec(`
-- One row per app the user has been told to reconnect and that has not been healthy since. It is what
-- keeps the sweep from raising the same card every time it runs.
CREATE TABLE IF NOT EXISTS connection_alerts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  toolkit TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, toolkit)
);
`);

export interface ConnectionSource {
  /** Every connected account of the user, whatever its status. */
  accounts(userId: string): Promise<ConnectionAccount[]>;
  /** The app's display name and logo, when the catalog knows the slug. */
  toolkit(slug: string): Promise<{ name: string; logo?: string } | undefined>;
}

type ConnectCard = Extract<CardBody, { card: 'connect' }>;

const SWEEP_MS = 10 * 60_000;
/** A failing call prompts a look at the accounts, but a bot retrying in a loop must not turn into one request per retry. */
const FAILURE_CHECK_MS = 60_000;

const alertedToolkits = (userId: string) =>
  new Set((db.prepare('SELECT toolkit FROM connection_alerts WHERE user_id=?').all(userId) as { toolkit: string }[]).map((r) => r.toolkit));

/** The user's open reconnect cards for one app, in the conversations as they stand now. */
function pendingReconnectCards(userId: string, toolkit: string, botId?: string): { botId: string; seq: number; body: ConnectCard }[] {
  const rows = db.prepare(`
    SELECT r.bot_id, r.seq, r.body FROM rows r JOIN bots b ON b.id = r.bot_id AND b.generation = r.generation
    WHERE b.user_id = ? AND r.kind = 'card' AND json_extract(r.body, '$.card') = 'connect'
      AND json_extract(r.body, '$.toolkit') = ? AND json_extract(r.body, '$.status') = 'pending'
      AND json_extract(r.body, '$.reconnect') = 1`).all(userId, toolkit) as { bot_id: string; seq: number; body: string }[];
  return rows
    .filter((r) => !botId || r.bot_id === botId)
    .map((r) => ({ botId: r.bot_id, seq: r.seq, body: JSON.parse(r.body) as ConnectCard }));
}

/**
 * Where a background alert goes: the bot with an event routine on that app, since that routine has
 * stopped firing, otherwise the user's primary bot.
 */
function homeBot(userId: string, toolkit: string): string | null {
  const routine = db.prepare(`
    SELECT r.bot_id FROM routines r JOIN bots b ON b.id = r.bot_id
    WHERE b.user_id = ? AND r.enabled = 1 AND r.schedule LIKE ? ESCAPE '\\' ORDER BY r.created_at LIMIT 1`)
    .get(userId, `event:${toolkit.toUpperCase().replace(/[\\%_]/g, '\\$&')}\\_%`) as { bot_id: string } | undefined;
  if (routine) return routine.bot_id;
  const primary = db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1 ORDER BY created_at LIMIT 1').get(userId) as { id: string } | undefined;
  return primary?.id ?? null;
}

export function createConnectionWatch(source: ConnectionSource) {
  const lastFailureCheck = new Map<string, number>();

  /** Put a reconnect card in one bot's chat, unless an open one is already there. */
  async function raiseCard(userId: string, botId: string, toolkit: string): Promise<void> {
    const info = await source.toolkit(toolkit).catch(() => undefined);
    if (pendingReconnectCards(userId, toolkit, botId).length) return;
    const name = info?.name ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
    const bot = getBotRow(botId);
    appendRow(botId, 'card', {
      type: 'card', card: 'connect', toolkit, toolkitName: name, logo: info?.logo, reconnect: true, status: 'pending',
      reason: `Its sign-in expired, so ${bot.name} can no longer use it. Reconnect to pick up where things left off.`,
    });
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    emitBot(botId);
    void sendPushNotification(userId, { title: `${name} needs reconnecting`, body: `${bot.name} can no longer use ${name} until you sign in again.`, data: { botId } });
  }

  /**
   * Read the user's accounts and bring alerts and cards in line with them. Safe to run any number
   * of times: an app already alerted is left alone, and one that is healthy again has its alert
   * dropped and its open cards closed. `botId` is the bot that ran into the problem, when one did.
   * Answers with the apps that are expired right now.
   */
  async function check(userId: string, opts: { botId?: string } = {}): Promise<Set<string>> {
    const { expired } = connectionHealth(await source.accounts(userId));
    const plan = planReconnectAlerts(expired, alertedToolkits(userId));
    for (const toolkit of plan.forget) {
      db.prepare('DELETE FROM connection_alerts WHERE user_id=? AND toolkit=?').run(userId, toolkit);
      for (const card of pendingReconnectCards(userId, toolkit)) {
        updateRow(card.botId, card.seq, decideCard(card.body, { type: 'connect', userId, at: now() }, String(card.seq)));
      }
    }
    for (const toolkit of plan.alert) {
      const target = opts.botId ?? homeBot(userId, toolkit);
      if (!target) continue;
      db.prepare('INSERT OR IGNORE INTO connection_alerts(user_id,toolkit,created_at) VALUES (?,?,?)').run(userId, toolkit, now());
      await raiseCard(userId, target, toolkit);
    }
    if (plan.alert.length || plan.forget.length) hub.emit(userId, { type: 'connections' });
    return expired;
  }

  /**
   * Before a connected-app call runs: the expired app it would use, if any, with a reconnect card
   * now in this bot's chat. The usual answer is null from a local lookup; the accounts are only
   * read again when an alert says the app was expired, to make sure it still is.
   */
  async function expiredAppFor(userId: string, botId: string, slugs: readonly string[]): Promise<string | null> {
    const suspect = [...alertedToolkits(userId)].find((t) => slugs.some((s) => slugInToolkit(s, t)));
    if (!suspect) return null;
    try {
      if (!(await check(userId, { botId })).has(suspect)) return null;
      await raiseCard(userId, botId, suspect);
      return suspect;
    } catch (e) {
      console.warn('[connections] could not confirm an expired app', (e as Error).message);
      return null;
    }
  }

  /** A connected-app call failed. An expired sign-in is one reason it might have, so look, but not on every retry. */
  function noteFailure(userId: string, botId: string): void {
    if (now() - (lastFailureCheck.get(userId) ?? 0) < FAILURE_CHECK_MS) return;
    lastFailureCheck.set(userId, now());
    void check(userId, { botId }).catch((e) => console.warn('[connections] check failed', (e as Error).message));
  }

  async function sweep(): Promise<void> {
    const users = db.prepare('SELECT user_id FROM composio_sessions').all() as { user_id: string }[];
    for (const { user_id } of users) {
      await check(user_id).catch((e) => console.warn('[connections] sweep failed for', user_id, (e as Error).message));
    }
  }

  function start(): void {
    setTimeout(() => void sweep(), 30_000).unref();
    setInterval(() => void sweep(), SWEEP_MS).unref();
  }

  return { check, expiredAppFor, noteFailure, sweep, start };
}

/** The watch over the real Composio account list. */
export const connectionWatch = createConnectionWatch({
  accounts: async (userId) => {
    // "No key" is not "no accounts": answering with an empty list would read as every app being healthy again.
    if (!composioEnabled()) throw new Error('Composio is not configured');
    return connectionsDetail(userId);
  },
  toolkit: (slug) => toolkitInfo(slug),
});

/** What an engine is told when the app a call needs has an expired sign-in. */
export const expiredAppNotice = (toolkit: string) =>
  `The ${toolkit} connection has expired, so this did not run. The user has been shown a card to reconnect it. Stop here; you will be told when it is connected again.`;
