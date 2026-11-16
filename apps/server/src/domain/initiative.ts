import type { CardBody, InitiativeLevel } from '@orbit/contracts';

export type InitiativeSignal =
  | { kind: 'routine_failed'; routineId: string; routineName: string; botName: string; ranAt: number }
  | { kind: 'card_waiting'; botId: string; botName: string; generation: number; seq: number; title: string; since: number }
  | { kind: 'user_idle'; lastActiveAt: number; hours: number }
  /** Raised by the Composio integration through emitInitiativeSignal. */
  | { kind: 'connection_expired'; connectionId: string; toolkit: string; toolkitName?: string };

export type SignalKind = InitiativeSignal['kind'];
export type UnsolicitedKind = 'checkin' | 'briefing' | SignalKind;

const RANK: Record<InitiativeLevel, number> = { off: 0, reactive: 1, proactive: 2 };

const MIN_LEVEL: Record<UnsolicitedKind, Exclude<InitiativeLevel, 'off'>> = {
  checkin: 'proactive',
  briefing: 'proactive',
  card_waiting: 'proactive',
  user_idle: 'proactive',
  routine_failed: 'reactive',
  connection_expired: 'reactive',
};

export const allows = (level: InitiativeLevel, kind: UnsolicitedKind): boolean => RANK[level] >= RANK[MIN_LEVEL[kind]];

/** Alerts are what even a reactive Bot reports: something is broken until the person acts. */
export const isAlert = (kind: SignalKind): boolean => MIN_LEVEL[kind] === 'reactive';

/** One key per occurrence: the same failed run, waiting card or idle stretch never signals twice. */
export function signalKey(s: InitiativeSignal): string {
  switch (s.kind) {
    case 'routine_failed': return `routine_failed:${s.routineId}:${s.ranAt}`;
    case 'card_waiting': return `card_waiting:${s.botId}:${s.generation}:${s.seq}`;
    case 'user_idle': return `user_idle:${s.lastActiveAt}`;
    case 'connection_expired': return `connection_expired:${s.connectionId}`;
  }
}

const hoursSince = (from: number, at: number) => Math.max(1, Math.round((at - from) / 3_600_000));

function signalLine(s: InitiativeSignal, at: number): string {
  switch (s.kind) {
    case 'routine_failed': return `The routine "${s.routineName}" (${s.botName}) failed on its last run.`;
    case 'card_waiting': return `${s.botName} has been waiting on the user for ${hoursSince(s.since, at)}h: ${s.title}`;
    case 'user_idle': return `The user has not sent a message in over ${s.hours} hours.`;
    case 'connection_expired': return `The ${s.toolkitName ?? s.toolkit} connection expired, so anything that uses it fails until the user reconnects it.`;
  }
}

/** The system turn that hands a batch of new signals to the primary Bot. */
export function signalPrompt(signals: readonly InitiativeSignal[], at: number): string {
  const lines = signals.map((s) => `- ${isAlert(s.kind) ? '[alert] ' : ''}${signalLine(s, at)}`);
  return (
    `[initiative] Things you noticed that the user may want to know about:\n${lines.join('\n')}\n` +
    'Send ONE short message. Mention every [alert], and anything else only if it is genuinely useful. ' +
    'Offer what you could do about it and ask before doing anything. ' +
    'If there is no [alert] and nothing is worth their attention, call stay_silent and send nothing.'
  );
}

/** What a waiting card asks of the person, in a few words. */
export function cardTitle(card: CardBody): string {
  switch (card.card) {
    case 'approval': return card.title;
    case 'question': return card.question;
    case 'connect': return `Connect ${card.toolkitName}`;
    case 'draft': return `Review a ${card.channel} draft to ${card.to}`;
    case 'secure-form': return `Enter credentials for ${card.label}`;
  }
}

export const BRIEFING_NAME = 'Morning Briefing';
export const DEFAULT_BRIEFING_TIME = '08:00';
/** Weekdays, as the plan's Morning Briefing starter has it; the time is what the settings change. */
export const DEFAULT_BRIEFING_DAYS = '1-5';

export const BRIEFING_PROMPT =
  "Give the user their morning briefing, in one short message:\n" +
  "1. Today's calendar events (use the connected Google Calendar).\n" +
  '2. Unread email that needs them (use the connected Gmail): who, what, and whether it needs a reply.\n' +
  '3. Open tasks on the team, from the list below.\n' +
  '4. Anything still waiting on them from yesterday (approvals, questions), from the list below.\n' +
  'Skip a section that has nothing in it. If an app is not connected, say so once at the end. ' +
  'Close by offering one or two concrete things you could do today, and ask before doing them.';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" on the given cron day-of-week field, or null for a malformed time. */
export function briefingCron(time: string, days: string = DEFAULT_BRIEFING_DAYS): string | null {
  const m = HHMM.exec(time);
  return m ? `${Number(m[2])} ${Number(m[1])} * * ${days}` : null;
}

/** The local time and day field of a "minute hour * * days" cron; null for any other schedule. */
export function briefingSchedule(cron: string): { time: string; days: string } | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || f[2] !== '*' || f[3] !== '*' || !/^\d{1,2}$/.test(f[0]) || !/^\d{1,2}$/.test(f[1])) return null;
  const minute = Number(f[0]);
  const hour = Number(f[1]);
  if (minute > 59 || hour > 23) return null;
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, days: f[4] };
}

export function briefingContext(input: {
  tasks: readonly { botName: string; title: string; state: 'working' | 'needs_input' }[];
  waiting: readonly { botName: string; title: string }[];
}): string {
  const tasks = input.tasks.length
    ? input.tasks.map((t) => `- ${t.title} (${t.botName}${t.state === 'needs_input' ? ', needs the user' : ''})`).join('\n')
    : '- none';
  const waiting = input.waiting.length ? input.waiting.map((w) => `- ${w.botName}: ${w.title}`).join('\n') : '- none';
  return `Open tasks:\n${tasks}\nWaiting on the user:\n${waiting}`;
}

/** Hours of silence before an idle check; 0 turns it off. */
export const DEFAULT_IDLE_HOURS = 24;
export const MAX_IDLE_HOURS = 24 * 30;
