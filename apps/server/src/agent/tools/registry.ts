import { db, now } from '../../db.js';
import { newId } from '../../lib/ids.js';
import { hub } from '../../lib/hub.js';
import { box } from '../../box.js';
import { env } from '../../env.js';
import { safetyIdentifier } from '../../lib/xai.js';
import { appendRow, listRoutines, toRoutine, describeCron, type RoutineRow } from '../../store.js';
import type { Trigger } from '../../core/turn-queue.js';
import { connectedToolkits, toolkitInfo } from '../../composio.js';
import { type ReviewCard } from '../../domain/google-actions.js';
import { scheduleRoutine, unscheduleRoutine } from '../../routines.js';
import { createEventRoutine, deleteEventTrigger, describeEvent, listTriggerTypes } from '../../triggers.js';
import { setCheckins } from '../../proactive.js';
import { createRoom, postToRoom } from '../rooms.js';
import type { ActivityKind } from '@orbit/contracts';
import { Cron } from 'croner';
import { COMPUTER_TOOLS } from '../../computer-tools.js';
import { RESEARCH_TOOLS } from '../../computer-research.js';
import { BOT_TOOLS } from '../bot-tools.js';
import { VAULT_TOOLS } from '../../vault-tools.js';
import { listCalendars, listMirror, mirrorState, syncCalendar } from '../../calendar/mirror.js';
import { buildCalendar, type CalendarRoutineRow } from '../../domain/calendar-view.js';

/** Tool arguments as the model sent them: a JSON object, read field by field. */
export type ToolArgs = Record<string, unknown>;

/** A JSON object from a third party, or null for anything else. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Message off a caught value, which may be an Error or anything a dependency threw. */
const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

export interface ToolCtx {
  userId: string;
  botId: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number) => void;
  depth: number;
  /** The agent loop's per-bot queue, so post_to_group can dispatch @mentioned group members. */
  enqueue?: (botId: string, turn: Trigger) => void;
  /** The group-chat chain depth of this turn (the dispatcher's `_groupDepth`), 0 outside a group. */
  groupDepth?: number;
}

export interface ToolResult {
  /** Text handed back to the agent. */
  output: string;
  /** The app's raw answer, for a Composio call (the server reads drafts out of it). */
  data?: unknown;
  summary?: string;
  /** End the turn after this tool (e.g. a question was asked). */
  endTurn?: boolean;
}

type Impl = (args: ToolArgs, ctx: ToolCtx) => Promise<ToolResult>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  /** Default approval requirement. 'needs_approval' goes through the approval card before running. */
  policy?: 'needs_approval';
  impl: Impl;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function botByName(userId: string, name: string) {
  return db.prepare('SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(userId, name.trim()) as
    { id: string; name: string; kind: string | null } | undefined;
}

/** Live X research through xAI's search tool. Returns the answer text followed by the posts it cites. */
async function xSearch(a: ToolArgs, userId: string): Promise<string> {
  const clean = (v: unknown) => (Array.isArray(v) ? v.map((h) => String(h).replace(/^@/, '').trim()).filter(Boolean).slice(0, 10) : []);
  const tool: Record<string, unknown> = { type: 'x_search' };
  const only = clean(a.handles);
  const not = clean(a.exclude_handles);
  if (only.length) tool.allowed_x_handles = only;
  else if (not.length) tool.excluded_x_handles = not;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (day.test(String(a.from_date ?? ''))) tool.from_date = a.from_date;
  if (day.test(String(a.to_date ?? ''))) tool.to_date = a.to_date;
  const res = await fetch(`${env.xaiBaseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.xaiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(240_000),
    body: JSON.stringify({
      model: env.xaiModel,
      store: false,
      safety_identifier: safetyIdentifier(userId),
      tools: [tool],
      input: [
        { role: 'system', content: 'You are a research tool used by another AI agent. Search X and answer the question precisely. For each post you rely on give the author handle, the date, engagement numbers when you can see them, and the link. No preamble and no advice.' },
        { role: 'user', content: String(a.query ?? '') },
      ],
    }),
  });
  if (!res.ok) throw new Error(`X search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = asRecord(await res.json());
  const parts: string[] = [];
  const links = new Set<string>();
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    const message = asRecord(item);
    if (message?.type !== 'message') continue;
    for (const c of Array.isArray(message.content) ? message.content : []) {
      const chunk = asRecord(c);
      if (typeof chunk?.text === 'string') parts.push(chunk.text);
      for (const an of Array.isArray(chunk?.annotations) ? chunk.annotations : []) {
        const annotation = asRecord(an);
        if (annotation?.url) links.add(String(annotation.url));
      }
    }
  }
  for (const u of Array.isArray(data?.citations) ? data.citations : []) if (typeof u === 'string') links.add(u);
  const text = parts.join('\n\n').trim() || 'No answer came back.';
  const sources = [...links].slice(0, 40);
  return (sources.length ? `${text}\n\nSources:\n${sources.map((u) => `- ${u}`).join('\n')}` : text).slice(0, 60000);
}

/** Where each bot's Library lives on the shared computer. */
export const LIBRARY_ROOT = `${env.botDataDir}/files`;

export const TOOLS: ToolDef[] = [
  {
    name: 'save_file',
    description: "Save a finished deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it. Saved under /root/grokbot/files/<your id>/ on your computer. Files you write into that folder yourself show up in the Library too.",
    parameters: obj({ filename: { type: 'string', description: 'e.g. briefing-2026-11-09.md' }, content: { type: 'string' } }, ['filename', 'content']),
    activity: 'drafting_file',
    label: 'Saving a file',
    impl: async (a, ctx) => {
      const name = String(a.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file.txt';
      const file = `${LIBRARY_ROOT}/${ctx.botId}/${name}`;
      await box.writeFile(file, String(a.content ?? ''));
      return { output: JSON.stringify({ ok: true, path: file }), summary: `Saved ${name}` };
    },
  },
  {
    name: 'show_file',
    description: "Download an image or file from a URL and show it inline in the chat so the user can see it. The file is saved to your Library and displayed in the message. Use this whenever you have an image URL that the user should see — for example, after finding a photo, chart, or diagram. Returns a marker that embeds the file in your next message.",
    parameters: obj({
      url: { type: 'string', description: 'The direct URL of the file to download and show.' },
      filename: { type: 'string', description: 'What to call the file, e.g. "lewis-hamilton.jpg". Include the correct extension.' },
    }, ['url', 'filename']),
    activity: 'working',
    label: 'Downloading image',
    impl: async (a, ctx) => {
      const rawName = String(a.filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
      const relPath = `images/${rawName}`;
      const dest = `${LIBRARY_ROOT}/${ctx.botId}/${relPath}`;
      await box.bash(`mkdir -p "${LIBRARY_ROOT}/${ctx.botId}/images"`, 10);
      const res = await fetch(String(a.url), { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { output: `Download failed: HTTP ${res.status}` };
      const buf = Buffer.from(await res.arrayBuffer());
      await box.writeFile(dest, buf);
      const mediaType = res.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
      // The [hq-file:...] marker is parsed by loop.ts and auto-attached to the next message.
      return {
        output: `[hq-file:${relPath}|${rawName}|${mediaType}] File saved and will be shown inline in your reply automatically. Tell the user what you downloaded.`,
        summary: `Downloaded ${rawName}`,
      };
    },
  },
  {
    name: 'x_search',
    description: "Research X (Twitter) live: what people are posting about a topic, what is going viral, reactions to news, or one account's recent posts. Returns a written answer with links to the posts. Ask one focused question per call and say what you want back, e.g. \"the 10 most-engaged posts about AI agents from the last 48 hours, with author, likes and link\".",
    parameters: obj({
      query: { type: 'string', description: 'What to find out, in plain words.' },
      handles: { type: 'array', items: { type: 'string' }, description: 'Only search posts from these accounts (without @). Up to 10.' },
      exclude_handles: { type: 'array', items: { type: 'string' }, description: 'Leave out posts from these accounts.' },
      from_date: { type: 'string', description: 'Earliest post date, YYYY-MM-DD.' },
      to_date: { type: 'string', description: 'Latest post date, YYYY-MM-DD.' },
    }, ['query']),
    activity: 'searching_web',
    label: 'Searching X',
    impl: async (a, ctx) => {
      const r = await xSearch(a, ctx.userId);
      return { output: r, summary: 'Searched X' };
    },
  },
  {
    name: 'create_routine',
    description: 'Create a recurring routine you will run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction you will follow each time it runs.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' } }, ['name', 'prompt', 'schedule']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      try { new Cron(a.schedule as string, { paused: true, timezone: (a.timezone as string) || 'UTC' }); } catch (e) { return { output: `Invalid schedule: ${(e as Error).message}` }; }
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, ctx.botId, a.name, a.prompt, a.schedule, (a.timezone as string) || 'UTC', now());
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id) as RoutineRow);
      scheduleRoutine(r);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${String(a.name)} · ${describeCron(a.schedule as string)}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: `Created routine ${String(a.name)}` };
    },
  },
  {
    name: 'list_event_triggers',
    description: 'List the event triggers a connected app offers (e.g. new email, new Slack message, new GitHub PR), with each trigger\'s config fields. Use before create_event_routine.',
    parameters: obj({ toolkit: { type: 'string', description: 'Composio toolkit slug, e.g. gmail, slack, github, googlecalendar' } }, ['toolkit']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a) => ({ output: JSON.stringify(await listTriggerTypes(String(a.toolkit).toLowerCase())) }),
  },
  {
    name: 'create_event_routine',
    description: 'Create a routine that runs whenever an event happens in a connected app (instead of on a schedule). `trigger_slug` comes from list_event_triggers; `config_json` is a JSON object string with that trigger\'s config fields (use "{}" if none). `prompt` is what you will do each time, given the event payload.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, trigger_slug: { type: 'string' }, config_json: { type: 'string' } }, ['name', 'prompt', 'trigger_slug']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      let config: Record<string, unknown> = {};
      try { config = a.config_json ? (JSON.parse(String(a.config_json)) as Record<string, unknown>) : {}; } catch { return { output: 'config_json must be a JSON object string.' }; }
      try {
        const r = await createEventRoutine(ctx.userId, ctx.botId, { name: a.name as string, prompt: a.prompt as string, trigger_slug: a.trigger_slug as string, config });
        appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${String(a.name)} · ${describeEvent(`event:${String(a.trigger_slug).toUpperCase()}`)}`, ref: r.id });
        hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
        return { output: JSON.stringify({ ok: true, routine_id: r.id }), summary: `Created event routine ${String(a.name)}` };
      } catch (e) {
        return { output: `Could not create the trigger: ${messageOf(e)}. If the app isn't connected, call request_app_connection first.` };
      }
    },
  },
  {
    name: 'calendar_list',
    description: "Read the user's calendar as the app shows it: their Google Calendar events (title, time, location, guests, calendar) and the team's scheduled routines (which Bot runs what, when), merged and in order. Faster than Google Calendar's own tools and covers the next 90 days and the last 30. Dates are YYYY-MM-DD; times come back as ISO with the event's timezone. To change a Google event, use Google Calendar's PATCH_EVENT through Composio (the user approves it).",
    parameters: obj({
      from: { type: 'string', description: 'First day, YYYY-MM-DD. Default: today.' },
      to: { type: 'string', description: 'Last day, YYYY-MM-DD (inclusive). Default: 7 days after `from`.' },
      include: { type: 'string', enum: ['all', 'google', 'routines'], description: 'Which events. Default all.' },
    }),
    activity: 'working',
    label: 'Checking the calendar',
    impl: async (a, ctx) => {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const from = day.test(String(a.from ?? '')) ? new Date(`${a.from as string}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      const to = day.test(String(a.to ?? '')) ? new Date(Date.parse(`${a.to as string}T00:00:00Z`) + 86_400_000) : new Date(from.getTime() + 8 * 86_400_000);
      if (to <= from) return { output: '`to` must be on or after `from`.' };
      const include = String(a.include ?? 'all');
      const out: Record<string, unknown> = { from: from.toISOString().slice(0, 10), to: new Date(to.getTime() - 1).toISOString().slice(0, 10) };
      if (include !== 'routines') {
        const state = mirrorState();
        if (!state.available) out.google = { unavailable: state.reason };
        else {
          let cals = new Map(listCalendars(ctx.userId).map((c) => [c.key, c]));
          // Connected but never synced (just connected, or the scheduler is off): sync now rather than
          // telling the bot Calendar is not connected.
          if (!cals.size && (await connectedToolkits(ctx.userId).catch(() => new Set<string>())).has('googlecalendar')) {
            await syncCalendar(ctx.userId).catch(() => null);
            cals = new Map(listCalendars(ctx.userId).map((c) => [c.key, c]));
          }
          if (!cals.size) out.google = { unavailable: 'Google Calendar is not connected. Use request_app_connection with googlecalendar if the user wants it.' };
          else out.google = listMirror(ctx.userId, from, to).slice(0, 200).map((e) => ({
            title: e.title, start: e.start, end: e.end, all_day: e.allDay, timezone: e.timezone, ...(e.location ? { location: e.location } : {}),
            ...(e.attendees.length ? { guests: e.attendees } : {}), calendar: cals.get(e.calendarKey)?.name, event_id: e.eventId, calendar_id: e.calendarId,
            ...(e.recurringEventId ? { repeating: true } : {}), ...(e.meetLink ? { meet: e.meetLink } : {}),
          }));
        }
      }
      if (include !== 'google') {
        const rows = db.prepare('SELECT r.*, b.name AS bot_name FROM routines r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? ORDER BY r.created_at').all(ctx.userId) as CalendarRoutineRow[];
        out.routines = buildCalendar(rows, from, to).slice(0, 200).map((e) => ({ title: e.title, bot: e.botName, start: e.start, repeating: e.eventType === 'recurring' }));
      }
      return { output: JSON.stringify(out), summary: 'Read the calendar' };
    },
  },
  {
    name: 'stay_silent',
    description: 'End this turn without sending the user anything. Use during check-ins, routines or bot-to-bot exchanges when there is nothing worth telling the user.',
    parameters: obj({ reason: { type: 'string' } }),
    activity: 'working',
    label: 'Finishing up',
    impl: async () => ({ output: 'OK, staying silent. End your turn now without writing a reply.', endTurn: true, summary: 'Stayed silent' }),
  },
  {
    name: 'set_checkins',
    description: "Turn proactive check-ins on or off and set when they happen (only the primary Bot does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Ask the user for their timezone if you don't know it.",
    parameters: obj({ enabled: { type: 'boolean' }, times: { type: 'array', items: { type: 'string' } }, timezone: { type: 'string' } }, ['enabled']),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.userId, { enabled: !!a.enabled, times: a.times as string[] | undefined, timezone: a.timezone as string | undefined });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e) {
        return { output: `Could not update check-ins: ${messageOf(e)}` };
      }
    },
  },
  {
    name: 'list_routines',
    description: 'List your routines.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking routines',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listRoutines(ctx.botId)) }),
  },
  {
    name: 'update_routine',
    description: 'Change or pause one of your routines.',
    parameters: obj({ routine_id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string' }, enabled: { type: 'boolean' } }, ['routine_id']),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = db.prepare('SELECT * FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId) as RoutineRow | undefined;
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: (a.name as string | undefined) ?? cur.name, prompt: (a.prompt as string | undefined) ?? cur.prompt, schedule: (a.schedule as string | undefined) ?? cur.schedule, timezone: (a.timezone as string | undefined) ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e) { return { output: `Invalid schedule: ${(e as Error).message}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(cur.id) as RoutineRow);
      r.enabled ? scheduleRoutine(r) : unscheduleRoutine(r.id);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-updated', text: `Routine updated: ${r.name} · ${r.enabled ? r.description : 'Paused'}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete one of your routines.',
    parameters: obj({ routine_id: { type: 'string' } }, ['routine_id']),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      unscheduleRoutine(String(a.routine_id));
      await deleteEventTrigger(String(a.routine_id));
      db.prepare('DELETE FROM routines WHERE id=? AND bot_id=?').run(a.routine_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: 'Deleted.' };
    },
  },
  {
    name: 'create_task',
    description: 'Track a piece of work the user asked for as a task (use one per request when asked for several things at once).',
    parameters: obj({ title: { type: 'string' } }, ['title']),
    activity: 'working',
    label: 'Making a task',
    impl: async (a, ctx) => {
      const id = newId('task');
      db.prepare("INSERT INTO tasks(id,bot_id,title,state,created_at,updated_at) VALUES (?,?,?,'working',?,?)").run(id, ctx.botId, a.title, now(), now());
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: JSON.stringify({ task_id: id }) };
    },
  },
  {
    name: 'update_task',
    description: 'Update a task: state is working, needs_input, or done.',
    parameters: obj({ task_id: { type: 'string' }, state: { type: 'string', enum: ['working', 'needs_input', 'done'] }, note: { type: 'string' } }, ['task_id', 'state']),
    activity: 'working',
    label: 'Updating a task',
    impl: async (a, ctx) => {
      db.prepare('UPDATE tasks SET state=?, note=COALESCE(?, note), updated_at=? WHERE id=? AND bot_id=?').run(a.state, a.note ?? null, now(), a.task_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'tasks', botId: ctx.botId });
      return { output: 'Updated.' };
    },
  },
  {
    name: 'send_to_bot',
    description: "Send a message to another Bot on the user's team (by name) to delegate work or ask a question. Their reply will arrive later as a new message to you.",
    parameters: obj({ bot_name: { type: 'string' }, message: { type: 'string' } }, ['bot_name', 'message']),
    activity: 'messaging_named',
    label: 'Messaging a Bot',
    impl: async (a, ctx) => {
      const target = botByName(ctx.userId, String(a.bot_name));
      if (!target) return { output: `No bot named "${String(a.bot_name)}". Team: ${(db.prepare('SELECT name FROM bots WHERE user_id=?').all(ctx.userId) as { name: string }[]).map((b) => b.name).join(', ')}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (ctx.depth >= 3) return { output: 'Too many hops between bots; answer the user directly instead.' };
      ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1);
      return { output: `Sent to ${target.name}. Their reply will come back to you as a message.`, summary: `Messaged ${target.name}` };
    },
  },
  {
    name: 'create_group',
    description: "Create a group chat between the user and several Bots on the team (by name). It appears in the user's sidebar; when the user posts there, the relevant Bots answer.",
    parameters: obj({ name: { type: 'string' }, bot_names: { type: 'array', items: { type: 'string' } } }, ['name', 'bot_names']),
    activity: 'working',
    label: 'Setting up a group',
    impl: async (a, ctx) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of (a.bot_names ?? []) as string[]) {
        const b = botByName(ctx.userId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const id = createRoom(ctx.userId, String(a.name), [...new Set(ids)]);
      appendRow(id, 'event', { type: 'event', event: 'bot-message', text: `Group created with ${(a.bot_names as string[]).filter((n) => !missing.includes(n)).join(', ')}` });
      return { output: JSON.stringify({ ok: true, group_id: id, missing }), summary: `Created group ${String(a.name)}` };
    },
  },
  {
    name: 'post_to_group',
    description: 'Post a message into a group chat you are a member of.',
    parameters: obj({ group_name: { type: 'string' }, text: { type: 'string' } }, ['group_name', 'text']),
    activity: 'messaging_named',
    label: 'Posting to the group',
    impl: async (a, ctx) => {
      // The turn's chain depth keeps a bot-to-bot @mention chain inside the group's depth limit.
      const out = postToRoom(ctx.botId, String(a.group_name), String(a.text), ctx.groupDepth ?? 0, ctx.enqueue);
      return { output: out, summary: `Posted to ${String(a.group_name)}`, endTurn: out === 'Posted to the group.' };
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a multiple-choice question when you need a decision before continuing. Ends your turn; their answer arrives as their next message.',
    parameters: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question', 'options']),
    activity: 'waiting_for_you',
    label: 'Waiting on you',
    impl: async (a, ctx) => {
      appendRow(ctx.botId, 'card', { type: 'card', card: 'question', question: a.question as string, options: ((a.options as string[] | undefined) ?? []).slice(0, 6), status: 'pending' });
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  },
  {
    name: 'request_app_connection',
    description: 'Ask the user to connect an app (e.g. gmail, googlecalendar, slack, github, notion, linear) so you can use it. Use the Composio toolkit slug.',
    parameters: obj({ toolkit: { type: 'string' }, reason: { type: 'string' } }, ['toolkit', 'reason']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a, ctx) => {
      const info = await toolkitInfo(String(a.toolkit).toLowerCase());
      if (!info) return { output: `Unknown toolkit "${String(a.toolkit)}". Use COMPOSIO_SEARCH_TOOLS to find the right toolkit slug.` };
      appendRow(ctx.botId, 'card', { type: 'card', card: 'connect', toolkit: info.slug, toolkitName: info.name, logo: info.logo, reason: a.reason as string, status: 'pending' });
      return { output: `Asked the user to connect ${info.name}. Stop here; you'll be told when it's connected.`, endTurn: true };
    },
  },

  // Computer control on the Bot's own desktop (a container or the shared computer). See
  // computer-tools.ts for why this is not Hermes' own computer_use toolset.
  ...(COMPUTER_TOOLS as unknown as ToolDef[]),

  // Research on the Bot's own browser, over CDP: the user watches the tab open and the files land.
  ...(RESEARCH_TOOLS as unknown as ToolDef[]),

  // The team itself: list, create, edit, remove and promote Bots. Only a primary Bot may write.
  ...(BOT_TOOLS as unknown as ToolDef[]),

  // Saved logins: filled in on the Bot's screen, or asked for in a secure form. See vault-tools.ts.
  ...(VAULT_TOOLS as unknown as ToolDef[]),
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

export type Decision = 'allow' | 'ask' | 'block';

/** What the approval gate decides for one tool call. */
export interface PolicyVerdict {
  decision: Decision;
  key: string;
  toolkit?: string;
  title: string;
  /** False when the call holds an action that must ask every time (sending email): the card hides "Always allow". */
  offerAlways?: boolean;
  /** Set when the calling bot has per-bot "Always allow" turned on: the card offers "Always allow for <Bot>", for any action. */
  alwaysFor?: { botId: string; botName: string };
  /** The custom card for the action that asks, when it has one (phase 3 renders these). */
  card?: ReviewCard;
}
