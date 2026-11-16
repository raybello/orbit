import type { InitiativeLevel, InitiativeSettings, InitiativeSettingsPatch } from '@orbit/contracts';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { toRoutine, type RoutineRow } from './store.js';
import { createRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import {
  allows,
  BRIEFING_NAME,
  BRIEFING_PROMPT,
  briefingCron,
  briefingSchedule,
  DEFAULT_BRIEFING_DAYS,
  DEFAULT_BRIEFING_TIME,
  DEFAULT_IDLE_HOURS,
  signalPrompt,
  type InitiativeSignal,
} from './domain/initiative.js';
import { pendingSignals, primaryBotOf, pruneSignals, queueSignal, settleSignals, waitingCards } from './initiative-store.js';
import type { Trigger } from './agent/loop.js';

/**
 * Everything the primary Bot does unasked (Grok Bot: "checks in proactively"), gated by its
 * initiative level (domain/initiative.ts):
 *  - check-ins: the user (or the bot, via set_checkins) picks local times; at each one the primary bot
 *    gets a [check-in] turn and either sends ONE concise message or stays silent;
 *  - signals: things that need the person (a failed routine, a card left waiting, a long silence, an
 *    expired app connection), queued in an outbox and handed over in one turn;
 *  - the Morning Briefing: a routine seeded, switched off, on each person's primary Bot.
 */

interface ProactivityRow {
  user_id: string;
  enabled: number;
  times: string;
  timezone: string;
  last_fired: string | null;
  silent_streak: number;
  idle_hours: number;
}

let enqueueFn: ((botId: string, t: Trigger) => void) | null = null;

/** Wire the queue proactive turns land in, without timers. Also used by tests. */
export function setProactiveEnqueue(enqueue: (botId: string, t: Trigger) => void) {
  enqueueFn = enqueue;
}

const SIGNAL_TICK_MS = 5 * 60_000;

export function initProactive(enqueue: (botId: string, t: Trigger) => void) {
  setProactiveEnqueue(enqueue);
  setInterval(tick, 60_000).unref();
  setInterval(() => initiativeTick(), SIGNAL_TICK_MS).unref();
  initiativeTick();
  console.log(`[proactive] ${(db.prepare('SELECT COUNT(*) n FROM proactivity WHERE enabled=1').get() as { n: number }).n} user(s) with check-ins`);
}

const proactivityRow = (userId: string) => db.prepare('SELECT * FROM proactivity WHERE user_id=?').get(userId) as ProactivityRow | undefined;

export function getCheckins(userId: string) {
  const r = proactivityRow(userId);
  return r ? { enabled: !!r.enabled, times: JSON.parse(r.times) as string[], timezone: r.timezone } : { enabled: false, times: ['09:00', '16:30'], timezone: 'UTC' };
}

export function setCheckins(userId: string, p: { enabled?: boolean; times?: string[]; timezone?: string }) {
  const cur = getCheckins(userId);
  const times = (p.times ?? cur.times).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 6);
  const tz = p.timezone ?? cur.timezone;
  new Intl.DateTimeFormat('en-US', { timeZone: tz }); // throws on a bad zone
  db.prepare(`INSERT INTO proactivity(user_id,enabled,times,timezone,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled, times=excluded.times, timezone=excluded.timezone, updated_at=excluded.updated_at`)
    .run(userId, (p.enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(times), tz, now());
  return getCheckins(userId);
}

/** Record whether the last check-in produced a message (used to back off when the bot keeps staying silent). */
export function noteCheckinOutcome(userId: string, sentMessage: boolean) {
  db.prepare('UPDATE proactivity SET silent_streak = CASE WHEN ? THEN 0 ELSE silent_streak + 1 END WHERE user_id=?').run(sentMessage ? 1 : 0, userId);
}

function localParts(tz: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

function tick() {
  if (!enqueueFn) return;
  const rows = db.prepare('SELECT * FROM proactivity WHERE enabled=1').all() as ProactivityRow[];
  for (const r of rows) {
    try {
      const { date, hm } = localParts(r.timezone);
      const times: string[] = JSON.parse(r.times);
      const slot = times.find((t) => minutesBetween(t, hm) >= 0 && minutesBetween(t, hm) < 5);
      if (!slot) continue;
      const key = `${date} ${slot}`;
      if (r.last_fired === key) continue;
      db.prepare('UPDATE proactivity SET last_fired=? WHERE user_id=?').run(key, r.user_id);
      fireCheckin(r.user_id, r.silent_streak);
    } catch (e) {
      console.warn('[proactive] tick failed for', r.user_id, (e as Error).message);
    }
  }
}

const minutesBetween = (from: string, to: string) => {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return th * 60 + tm - (fh * 60 + fm);
};

/** An unsolicited turn waits while the person is in the middle of a conversation. */
const ACTIVE_CONVERSATION_MS = 20 * 60_000;

const lastUserMessageAt = (userId: string) =>
  (db.prepare("SELECT MAX(created_at) t FROM rows WHERE bot_id IN (SELECT id FROM bots WHERE user_id=?) AND kind='message' AND json_extract(body,'$.role')='user'").get(userId) as { t: number | null } | undefined)?.t ?? null;

export function fireCheckin(userId: string, silentStreak = 0, force = false) {
  const primary = primaryBotOf(userId);
  if (!primary || !enqueueFn) return;
  // "Check in now" is the person asking, so only scheduled check-ins answer to the initiative level.
  if (!force && !allows(primary.initiative, 'checkin')) return;
  const lastUser = lastUserMessageAt(userId);
  if (!force && lastUser && now() - lastUser < ACTIVE_CONVERSATION_MS) return;

  const needsInput = db.prepare("SELECT b.name, t.title FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? AND t.state='needs_input' LIMIT 10").all(userId) as { name: string; title: string }[];
  const since = now() - 12 * 3600_000;
  const routineRuns = db.prepare("SELECT b.name bot, r.name FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.last_run_at > ?").all(userId, since) as { bot: string; name: string }[];
  const pendingApprovals = db.prepare("SELECT b.name bot, a.tool FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE b.user_id=? AND a.status='pending'").all(userId) as { bot: string; tool: string }[];
  const otherBots = db.prepare("SELECT name, label FROM bots WHERE user_id=? AND is_primary=0").all(userId) as { name: string; label: string | null }[];

  const context = [
    needsInput.length ? `Tasks waiting on the user: ${needsInput.map((t) => `${t.title} (${t.name})`).join('; ')}` : 'No tasks waiting on the user.',
    pendingApprovals.length ? `Pending approvals: ${pendingApprovals.map((a) => `${a.bot}: ${a.tool}`).join('; ')}` : 'No pending approvals.',
    routineRuns.length ? `Routines that ran in the last 12h: ${routineRuns.map((r) => `${r.name} (${r.bot})`).join('; ')}` : 'No routines ran in the last 12h.',
    otherBots.length ? `Team: ${otherBots.map((b) => `${b.name}${b.label ? ` (${b.label})` : ''}`).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  enqueueFn(primary.id, {
    type: 'system',
    text:
      `[check-in] Scheduled proactive check-in. Look at what's going on (use connected apps like calendar or email if useful, read your memories, check on other Bots if needed). ` +
      `If there is something genuinely useful to tell the user (a decision they owe, something that changed, today's schedule, a finished result), send ONE short message. ` +
      `If not, call stay_silent and send nothing.${silentStreak >= 3 ? ' You have stayed silent several times in a row; that is fine.' : ''}\n${context}`,
  });
}

// ------------------------------------------------------------------ signals

/** Approvals expire after 25 minutes (agent/loop.ts), so in practice this catches questions, connects and drafts. */
const CARD_WAIT_MS = 3_600_000;
/** Older than this, a waiting card is history rather than news. */
const CARD_LOOKBACK_MS = 3 * 86_400_000;
const FAILURE_LOOKBACK_MS = 86_400_000;
const SIGNAL_RETENTION_MS = 30 * 86_400_000;

/** The signals that hold right now and that `level` lets through. Reads state; changes nothing. */
export function detectSignals(userId: string, level: InitiativeLevel, at: number = now()): InitiativeSignal[] {
  const found: InitiativeSignal[] = [];
  if (allows(level, 'routine_failed')) {
    const failed = db.prepare(
      "SELECT r.id, r.name, r.last_run_at, b.name bot FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.last_run_status='failed' AND r.last_run_at > ?",
    ).all(userId, at - FAILURE_LOOKBACK_MS) as { id: string; name: string; last_run_at: number; bot: string }[];
    for (const r of failed) found.push({ kind: 'routine_failed', routineId: r.id, routineName: r.name, botName: r.bot, ranAt: r.last_run_at });
  }
  if (allows(level, 'card_waiting')) {
    for (const c of waitingCards(userId, { after: at - CARD_LOOKBACK_MS, before: at - CARD_WAIT_MS })) found.push({ kind: 'card_waiting', ...c });
  }
  if (allows(level, 'user_idle')) {
    const hours = proactivityRow(userId)?.idle_hours ?? DEFAULT_IDLE_HOURS;
    const joined = (db.prepare('SELECT created_at FROM users WHERE id=?').get(userId) as { created_at: number } | undefined)?.created_at;
    const lastActiveAt = lastUserMessageAt(userId) ?? joined;
    if (hours > 0 && lastActiveAt !== undefined && at - lastActiveAt >= hours * 3_600_000) found.push({ kind: 'user_idle', lastActiveAt, hours });
  }
  return found;
}

/** Hand every pending signal to the primary Bot in one turn, unless the person is mid-conversation. */
export function deliverSignals(userId: string, at: number = now()): number {
  const primary = primaryBotOf(userId);
  if (!primary || !enqueueFn) return 0;
  const pending = pendingSignals(userId);
  if (!pending.length) return 0;
  const lastUser = lastUserMessageAt(userId);
  if (lastUser && at - lastUser < ACTIVE_CONVERSATION_MS) return 0;
  // The level may have dropped since these were queued; what it no longer allows is dropped, not held.
  settleSignals(userId, pending.filter((s) => !allows(primary.initiative, s.kind)), 'suppressed', at);
  const allowed = pending.filter((s) => allows(primary.initiative, s.kind));
  if (!allowed.length) return 0;
  // Settled before the turn is queued: a crash in between loses one nudge rather than repeating it.
  settleSignals(userId, allowed, 'delivered', at);
  enqueueFn(primary.id, { type: 'system', text: signalPrompt(allowed, at) });
  return allowed.length;
}

export type SignalOutcome = 'queued' | 'duplicate' | 'suppressed' | 'no-primary';

/**
 * Raise a signal from outside the scheduler, such as the Composio `connected_account.expired`
 * webhook. Safe to call repeatedly: one occurrence (see signalKey) reaches the Bot at most once,
 * across restarts. It is delivered now, or on a later tick if the person is mid-conversation.
 */
export function emitInitiativeSignal(userId: string, signal: InitiativeSignal, at: number = now()): SignalOutcome {
  const primary = primaryBotOf(userId);
  if (!primary) return 'no-primary';
  if (!allows(primary.initiative, signal.kind)) return 'suppressed';
  if (!queueSignal(userId, signal, at)) return 'duplicate';
  deliverSignals(userId, at);
  return 'queued';
}

/** One pass of the initiative loop: seed briefings, queue what is newly true, deliver, forget old news. */
export function initiativeTick(at: number = now()) {
  seedMorningBriefings(at);
  const users = db.prepare('SELECT DISTINCT user_id FROM bots WHERE is_primary=1').all() as { user_id: string }[];
  for (const { user_id: userId } of users) {
    try {
      const primary = primaryBotOf(userId);
      if (!primary) continue;
      for (const s of detectSignals(userId, primary.initiative, at)) queueSignal(userId, s, at);
      deliverSignals(userId, at);
    } catch (e) {
      console.warn('[proactive] signals failed for', userId, (e as Error).message);
    }
  }
  pruneSignals(at - SIGNAL_RETENTION_MS);
}

// ------------------------------------------------------------------ morning briefing

interface BriefingRoutine { id: string; bot_id: string; enabled: number; schedule: string; timezone: string }

const briefingRoutine = (userId: string) =>
  db.prepare('SELECT r.id, r.bot_id, r.enabled, r.schedule, r.timezone FROM morning_briefings m JOIN routines r ON r.id=m.routine_id WHERE m.user_id=?').get(userId) as
    | BriefingRoutine
    | undefined;

function createBriefing(userId: string, botId: string, p: { enabled: boolean; time: string; timezone: string }, at: number): string {
  const routine = createRoutine({
    botId,
    title: BRIEFING_NAME,
    prompt: BRIEFING_PROMPT,
    eventType: 'recurring',
    schedule: briefingCron(p.time) ?? briefingCron(DEFAULT_BRIEFING_TIME)!,
    timezone: p.timezone,
    enabled: p.enabled,
  });
  db.prepare(`INSERT INTO morning_briefings(user_id,bot_id,routine_id,created_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET bot_id=excluded.bot_id, routine_id=excluded.routine_id`).run(userId, botId, routine.id, at);
  hub.emit(userId, { type: 'routines', botId });
  return routine.id;
}

/**
 * Give each person's primary Bot a Morning Briefing, once, switched off: it spends model time and
 * reads their mail and calendar every morning, so it waits for them to turn it on. Converges: anyone
 * who already has one, or deleted theirs, is skipped.
 */
export function seedMorningBriefings(at: number = now()): number {
  const users = db.prepare(
    "SELECT DISTINCT b.user_id FROM bots b WHERE b.is_primary=1 AND COALESCE(b.hidden,0)=0 AND COALESCE(b.kind,'agent')<>'room' AND NOT EXISTS (SELECT 1 FROM morning_briefings m WHERE m.user_id=b.user_id)",
  ).all() as { user_id: string }[];
  const seed = db.transaction((userId: string) => {
    const primary = primaryBotOf(userId);
    if (primary) createBriefing(userId, primary.id, { enabled: false, time: DEFAULT_BRIEFING_TIME, timezone: getCheckins(userId).timezone }, at);
  });
  for (const { user_id: userId } of users) seed(userId);
  return users.length;
}

export class InitiativeSettingsError extends Error {}

export function getInitiativeSettings(userId: string): InitiativeSettings {
  const r = briefingRoutine(userId);
  return {
    idleHours: proactivityRow(userId)?.idle_hours ?? DEFAULT_IDLE_HOURS,
    briefing: r
      ? { routineId: r.id, enabled: !!r.enabled, time: briefingSchedule(r.schedule)?.time ?? null, timezone: r.timezone }
      : { routineId: null, enabled: false, time: DEFAULT_BRIEFING_TIME, timezone: getCheckins(userId).timezone },
  };
}

/** Apply a validated patch. A briefing change when the person has none (never seeded, or deleted) creates it. */
export function setInitiativeSettings(userId: string, patch: InitiativeSettingsPatch, at: number = now()): InitiativeSettings {
  if (patch.idleHours !== undefined) {
    db.prepare(`INSERT INTO proactivity(user_id,idle_hours,updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET idle_hours=excluded.idle_hours, updated_at=excluded.updated_at`).run(userId, patch.idleHours, at);
  }
  const b = patch.briefing;
  if (b) {
    if (b.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch { throw new InitiativeSettingsError(`Unknown timezone: ${b.timezone}`); }
    }
    const cur = briefingRoutine(userId);
    if (!cur) {
      const primary = primaryBotOf(userId);
      if (!primary) throw new InitiativeSettingsError('There is no primary Bot to give the briefing to.');
      createBriefing(userId, primary.id, { enabled: b.enabled ?? false, time: b.time ?? DEFAULT_BRIEFING_TIME, timezone: b.timezone ?? getCheckins(userId).timezone }, at);
    } else {
      const days = briefingSchedule(cur.schedule)?.days ?? DEFAULT_BRIEFING_DAYS;
      const schedule = b.time !== undefined ? briefingCron(b.time, days) ?? cur.schedule : cur.schedule;
      const enabled = b.enabled ?? !!cur.enabled;
      db.prepare('UPDATE routines SET schedule=?, timezone=?, enabled=? WHERE id=?').run(schedule, b.timezone ?? cur.timezone, enabled ? 1 : 0, cur.id);
      const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(cur.id) as RoutineRow);
      if (enabled) scheduleRoutine(next);
      else unscheduleRoutine(cur.id);
      hub.emit(userId, { type: 'routines', botId: cur.bot_id });
    }
  }
  return getInitiativeSettings(userId);
}
