import { db, now } from '../db.js';
import { env } from '../env.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, emitBot, getBotRow, getLive, getRow, setLive, updateRow } from '../store.js';
import type { ActivityKind, MessageBody, MessageFile, ToolCallBody } from '../types.js';
import { toolkitInfo } from '../composio.js';
import { screenForWork } from '../computer.js';
import { computerKindFor } from '../computer-provider-registry.js';
import { dockerProvider } from '../docker-provider.js';
import { engineFor } from '../engine.js';
import { instructionsFor } from './prompt.js';
import { activityFor, appToolName, humanizeSlug, LIBRARY_ROOT, policyFor } from './tools.js';
import { MIME_BY_EXTENSION } from '../lib/mime.js';
import { sendPushNotification } from '../push.js';

/**
 * A turn: one message handed to the bot's Hermes engine and streamed back into the conversation.
 *
 * Hermes owns the agent loop, the history and the tools. This file only
 *  - queues turns so a bot handles one at a time,
 *  - posts the trigger to the engine's /v1/responses endpoint and turns the event stream into
 *    rows (assistant messages, tool calls) and live state (what the bot is doing right now),
 *  - keeps the bookkeeping the app's own tools need while a turn runs (see mcp.ts): which tool-call
 *    row a call belongs to, and approvals the user has to answer before a call goes ahead.
 */

export type Trigger =
  | { type: 'user'; text: string }
  | { type: 'routine'; routineId: string; name: string; prompt: string }
  | { type: 'bot'; fromBotId: string; fromName: string; text: string; depth: number }
  /** `_groupDepth` is set by the group-chat dispatcher (agent/rooms.ts): how many bot-to-bot hops into one group conversation this turn is. */
  | { type: 'system'; text: string; _groupDepth?: number };

// ---------- pending files from tool calls ----------

/** Files collected from show_file tool calls; keyed by botId. Drained into the next assistant message. */
const pendingFilesByBot = new Map<string, MessageFile[]>();

/** Keep one attachment per filename within a response, preserving the first saved file. */
function uniqueFiles(files: MessageFile[]): MessageFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.filename.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function addPendingFiles(botId: string, files: MessageFile[]) {
  if (!files.length) return;
  const existing = pendingFilesByBot.get(botId) ?? [];
  pendingFilesByBot.set(botId, uniqueFiles([...existing, ...files]));
}

// ---------- per-bot serial queue ----------

const queues = new Map<string, Promise<void>>();
const aborts = new Map<string, AbortController>();

export function enqueue(botId: string, trigger: Trigger) {
  // A new message from the user supersedes whatever is waiting for their approval.
  if (trigger.type === 'user') expireApprovals(botId);
  const prev = queues.get(botId) ?? Promise.resolve();
  const next = prev.then(() => runTurn(botId, trigger)).catch((e) => console.error('[agent] turn failed', botId, e));
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
}

export function interrupt(botId: string) {
  expireApprovals(botId);
  aborts.get(botId)?.abort();
}

/** Run a job in the bot's serial queue, after any running turn. */
export function runInBotQueue<T>(botId: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(botId) ?? Promise.resolve();
  const result = prev.then(job);
  const next = result.then(() => {}, () => {});
  queues.set(botId, next);
  next.finally(() => { if (queues.get(botId) === next) queues.delete(botId); });
  return result;
}

export const isBotBusy = (botId: string) => queues.has(botId);

export function enqueueBotMessage(fromBotId: string, toBotId: string, text: string, depth: number) {
  const from = getBotRow(fromBotId);
  appendRow(toBotId, 'message', { type: 'message', role: 'user', text, from: { kind: 'bot', id: fromBotId, name: from.name } });
  enqueue(toBotId, { type: 'bot', fromBotId, fromName: from.name, text, depth });
}

function triggerText(t: Trigger): string {
  switch (t.type) {
    case 'user': return t.text;
    case 'routine': return `[Routine "${t.name}" is running now. Do this:]\n${t.prompt}`;
    case 'bot': return `[Message from ${t.fromName}, another Bot on the team. Reply to them with send_to_bot if they asked you something.]\n${t.text}`;
    case 'system': return `[System notice] ${t.text}`;
  }
}

// ---------- the running turn, as the app's tools see it ----------

interface ToolRef { seq: number; callId: string; name: string; claimed: boolean; done: boolean }
interface Outcome { status?: ToolCallBody['status']; summary?: string }

interface Turn {
  botId: string;
  userId: string;
  /** How many bot-to-bot hops led here (send_to_bot stops a ping-pong at 3). */
  depth: number;
  /** How deep into one group conversation this turn is (a user turn is 0); post_to_group dispatches from it. */
  groupDepth: number;
  /** A tool ended the conversation for now (asked the user, stayed silent): drop any closing text. */
  silent: boolean;
  tools: ToolRef[];
  /** What an app tool said about its own call; beats what we would guess from the raw output. */
  outcomes: Map<number, Outcome>;
}

const turns = new Map<string, Turn>();

export const turnDepth = (botId: string) => turns.get(botId)?.depth ?? 0;

/** How deep into one group conversation the bot's current turn is (0 for a user turn or no turn). */
export const turnGroupDepth = (botId: string) => turns.get(botId)?.groupDepth ?? 0;

export function markSilent(botId: string) {
  const t = turns.get(botId);
  if (t) t.silent = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An app tool was called through MCP: find the tool-call row the event stream made for it.
 * The stream announces a call just before the engine runs it, so wait a moment for the row.
 * Returns null when the call did not come from a turn started here (e.g. the agent used the tool
 * while talking to its owner somewhere else).
 */
export async function claimToolRow(botId: string, name: string): Promise<number | null> {
  const deadline = Date.now() + 600;
  for (;;) {
    const t = turns.get(botId);
    if (!t) return null;
    const ref = t.tools.find((r) => !r.claimed && !r.done && r.name === name);
    if (ref) { ref.claimed = true; return ref.seq; }
    if (Date.now() > deadline) return null;
    await sleep(40);
  }
}

export function noteToolOutcome(botId: string, seq: number | null, outcome: Outcome) {
  if (seq === null) return;
  turns.get(botId)?.outcomes.set(seq, outcome);
  patchToolRow(botId, seq, outcome);
}

function patchToolRow(botId: string, seq: number, patch: Partial<ToolCallBody>) {
  const row = getRow(botId, seq);
  if (row && row.body.type === 'tool-call') updateRow(botId, seq, { ...row.body, ...patch });
}

// ---------- approvals ----------

export type ApprovalDecision = 'allow' | 'deny' | 'expired';

/** Longest a tool call waits for the user. Kept under the engines' 30 minute tool timeout. */
const APPROVAL_WAIT_MS = 25 * 60_000;

const waiters = new Map<string, { botId: string; resolve: (d: ApprovalDecision) => void }>();

function setApprovalCard(botId: string, rowSeq: number, approvalId: string, status: string) {
  const card = getRow(botId, rowSeq);
  if (card && card.body.type === 'card' && card.body.card === 'approval' && card.body.approvalId === approvalId) {
    updateRow(botId, rowSeq, { ...card.body, status } as any);
  }
}

const pendingApprovals = (botId: string) => db.prepare("SELECT * FROM approvals WHERE bot_id=? AND status='pending'").all(botId) as any[];

/** Put an approval card in the conversation and wait for the user's answer. */
export async function requestApproval(
  who: { userId: string; botId: string },
  pol: { key: string; toolkit?: string; title: string },
  args: any,
  rowSeq: number | null,
): Promise<ApprovalDecision> {
  const { userId, botId } = who;
  const approvalId = newId('apr');
  const tk = pol.toolkit ? await toolkitInfo(pol.toolkit).catch(() => undefined) : undefined;
  const card = appendRow(botId, 'card', {
    type: 'card', card: 'approval', approvalId, title: `Allow ${getBotRow(botId).name} to ${pol.title.split(': ')[1] ?? pol.title}?`,
    detail: describeArgs(args), tool: pol.key, toolkit: pol.toolkit, toolkitName: tk?.name, logo: tk?.logo, args, status: 'pending',
  });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, '', pol.key, 'pending', now());
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
  if (rowSeq !== null) patchToolRow(botId, rowSeq, { status: 'awaiting-approval' });
  setLive(botId, { isRunning: false, activity: { kind: 'waiting_for_you', since: now() }, awaiting: { reason: humanizeSlug(pol.key), since: now() } });
  hub.emit(userId, { type: 'tasks', botId });
  emitBot(botId);
  // Nothing moves until someone answers, so this one is pushed even when a screen is open.
  // A deleted bot leaves no row to name, and this runs outside push.ts's own guard.
  void sendPushNotification(userId, {
    title: `${getBotRow(botId)?.name ?? 'A bot'} needs your input`,
    body: card.body.type === 'card' && card.body.card === 'approval' ? card.body.title.slice(0, 80) : 'A tool needs your approval.',
    data: { botId },
  });

  let timer: NodeJS.Timeout | undefined;
  const decision = await new Promise<ApprovalDecision>((resolve) => {
    waiters.set(approvalId, { botId, resolve });
    timer = setTimeout(() => expireApproval(approvalId), APPROVAL_WAIT_MS);
  });
  clearTimeout(timer);
  waiters.delete(approvalId);

  if (rowSeq !== null) {
    if (decision === 'allow') patchToolRow(botId, rowSeq, { status: 'running' });
    else noteToolOutcome(botId, rowSeq, { status: 'denied', summary: decision === 'deny' ? 'Not allowed' : 'Skipped' });
  }
  if (!pendingApprovals(botId).length) {
    if (turns.has(botId)) setLive(botId, { isRunning: true, activity: { kind: decision === 'allow' ? 'connecting_service' : 'thinking', detail: decision === 'allow' ? tk?.name : undefined, since: now() }, awaiting: null });
    else setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
  }
  hub.emit(userId, { type: 'tasks', botId });
  return decision;
}

function expireApproval(approvalId: string) {
  const ap = db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId) as any;
  if (ap?.status === 'pending') {
    db.prepare("UPDATE approvals SET status='expired', resolved_at=? WHERE id=?").run(now(), approvalId);
    setApprovalCard(ap.bot_id, ap.row_seq, approvalId, 'expired');
  }
  waiters.get(approvalId)?.resolve('expired');
}

export function expireApprovals(botId: string) {
  for (const ap of pendingApprovals(botId)) expireApproval(ap.id);
}

/** After a restart nothing is waiting on old approval cards any more. */
export function expireStaleApprovals() {
  for (const ap of db.prepare("SELECT id FROM approvals WHERE status='pending'").all() as any[]) expireApproval(ap.id);
}

/** Resolve an approval card from the UI. */
export function resolveApproval(userId: string, approvalId: string, decision: 'allow' | 'always' | 'deny') {
  const ap = db.prepare('SELECT a.*, b.user_id FROM approvals a JOIN bots b ON b.id=a.bot_id WHERE a.id=?').get(approvalId) as any;
  if (!ap || ap.user_id !== userId) throw new Error('not found');
  if (ap.status !== 'pending') return;
  const waiter = waiters.get(approvalId);
  if (!waiter) return expireApproval(approvalId);
  const status = decision === 'deny' ? 'denied' : decision === 'always' ? 'always' : 'allowed';
  db.prepare('UPDATE approvals SET status=?, resolved_at=? WHERE id=?').run(status, now(), approvalId);
  if (decision === 'always') db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, ap.tool);
  setApprovalCard(ap.bot_id, ap.row_seq, approvalId, status);
  waiter.resolve(decision === 'deny' ? 'deny' : 'allow');
}

function describeArgs(args: any): string {
  if (!args || typeof args !== 'object') return '';
  const inner = Array.isArray(args.tools) ? args.tools.map((t: any) => t.arguments ?? t.args ?? t) : [args];
  const flat = inner.map((a: any) => Object.entries(a ?? {}).filter(([, v]) => typeof v !== 'object' || v === null).slice(0, 6).map(([k, v]) => `${k}: ${String(v).slice(0, 160)}`).join('\n'));
  return flat.join('\n\n').slice(0, 1200);
}

// ---------- the engine's event stream ----------

interface StreamEvent { type: string; data: any }

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buf = (buf + dec.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = '';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue; // a keepalive comment
      const raw = data.join('\n');
      if (raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        yield { type: event || json?.type || '', data: json };
      } catch { /* not ours to understand */ }
    }
  }
}

async function failureText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const j = JSON.parse(raw);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === 'string' && m) return m;
  } catch { /* plain text */ }
  if (res.status === 401 || res.status === 403) return 'the engine did not accept our key';
  return raw.slice(0, 300) || `the engine answered ${res.status}`;
}

/** What a tool's raw result says about how it went. */
function readOutcome(item: any): Outcome {
  const text = Array.isArray(item?.output) ? item.output.map((p: any) => p?.text ?? '').join('') : String(item?.output ?? '');
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (j.error) return { status: 'error', summary: String(typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).slice(0, 200) };
      if (typeof j.exit_code === 'number' && j.exit_code !== 0) return { status: 'error', summary: `Exit code ${j.exit_code}` };
      if (j.success === false) return { status: 'error', summary: String(j.message ?? 'Failed').slice(0, 200) };
    }
  } catch { /* not JSON */ }
  if (/^(tool )?error\b/i.test(text.trim())) return { status: 'error', summary: text.trim().slice(0, 200) };
  return { status: 'done' };
}

/** A short line for the "thinking" chip out of the model's running reasoning. */
function captionFrom(reasoning: string): string | null {
  const titles = [...reasoning.matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
  if (titles.length) return titles[titles.length - 1][1].trim();
  const para = reasoning.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).pop();
  if (!para) return null;
  const sentence = para.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim();
  if (sentence.length < 4) return null;
  return sentence.length > 84 ? `${sentence.slice(0, 81).trimEnd()}…` : sentence;
}

// ---------- the turn ----------

/** Hermes' own tool lookup (it loads rarely used tools on demand). */
const TOOLBOX = new Set(['tool_search', 'tool_describe']);

/** `Default`/`` is what the settings panel stores when nothing was picked; treat it as "no choice". */
function realModel(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  return !text || text.toLowerCase() === 'default' ? null : text;
}

async function runTurn(botId: string, trigger: Trigger) {
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room') return;
  const userId: string = bot.user_id;
  const ctrl = new AbortController();
  aborts.set(botId, ctrl);
  const turn: Turn = {
    botId,
    userId,
    depth: trigger.type === 'bot' ? trigger.depth : 0,
    groupDepth: trigger.type === 'system' ? Number(trigger._groupDepth ?? 0) : 0,
    silent: false,
    tools: [],
    outcomes: new Map(),
  };
  turns.set(botId, turn);
  setLive(botId, { isRunning: true, activity: { kind: 'thinking', since: now() }, awaiting: null, startedAt: now(), caption: null, steps: 0 });

  // The assistant message being written right now.
  let msgSeq: number | null = null;
  let text = '';
  /** Text of the last assistant message this turn wrote, for the push notification at the end. */
  let lastMessageText = '';
  let lastFlush = 0;
  let wroteText = false;
  // Parse [hq-file:path|filename|mediaType] markers out of text, returning cleaned text + files.
  // A `MEDIA:/abs/path` line pointing inside this bot's Library becomes an attachment too, so a
  // screenshot the model mentions shows up as a picture instead of a path.
  const extractFiles = (raw: string): { text: string; files: MessageFile[] } => {
    const files: MessageFile[] = [];
    let cleaned = raw.replace(/\[hq-file:([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/g, (_, path, filename, mediaType) => {
      files.push({ path: path.trim(), filename: filename.trim(), mediaType: mediaType.trim() });
      return '';
    });
    const root = `${LIBRARY_ROOT}/${botId}/`;
    cleaned = cleaned.split('\n').filter((line) => {
      const m = /^\s*MEDIA:(\S+)\s*$/.exec(line);
      if (!m) return true;
      const abs = m[1];
      if (!abs.startsWith(root)) return true;
      const rel = abs.slice(root.length);
      const filename = rel.split('/').pop()!;
      const mediaType = MIME_BY_EXTENSION[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
      files.push({ path: rel, filename, mediaType });
      return false;
    }).join('\n');
    return { text: cleaned.trim(), files };
  };

  const flush = (streaming: boolean) => {
    // Drain module-level pending files into local array once per message.
    const fromMcp = pendingFilesByBot.get(botId);
    if (fromMcp?.length) { pendingFiles.push(...fromMcp); pendingFilesByBot.delete(botId); }
    const { text: cleanText, files: markerFiles } = extractFiles(text);
    const allFiles = uniqueFiles([...pendingFiles, ...markerFiles]);
    const b: MessageBody = { type: 'message', role: 'assistant', text: cleanText, streaming, ...(allFiles.length ? { files: allFiles } : {}) };
    if (msgSeq === null) msgSeq = appendRow(botId, 'message', b).seq;
    else updateRow(botId, msgSeq, b);
    if (cleanText) lastMessageText = cleanText;
    lastFlush = Date.now();
  };
  const hasPendingFiles = () => pendingFiles.length > 0 || (pendingFilesByBot.get(botId)?.length ?? 0) > 0;
  // `final` = true only at turn end; defers file-only messages so they attach to the next text reply.
  const closeMessage = (final = false) => {
    if (msgSeq === null && !hasPendingFiles()) return;
    if (text.trim() || (hasPendingFiles() && (msgSeq !== null || final))) {
      flush(false);
      db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
      pendingFiles.length = 0;
    } else if (msgSeq !== null) {
      updateRow(botId, msgSeq, { type: 'message', role: 'assistant', text: '', streaming: false });
    }
    msgSeq = null;
    text = '';
  };
  const say = (t: string) => {
    if (turn.silent && !hasPendingFiles()) return;
    closeMessage();
    if (!t.trim() && !hasPendingFiles()) return;
    // Drain module-level files into local for this standalone message.
    const fromMcp = pendingFilesByBot.get(botId);
    if (fromMcp?.length) { pendingFiles.push(...fromMcp); pendingFilesByBot.delete(botId); }
    const { text: cleanText, files: markerFiles } = extractFiles(t.trim());
    const allFiles = uniqueFiles([...pendingFiles, ...markerFiles]);
    pendingFiles.length = 0;
    appendRow(botId, 'message', { type: 'message', role: 'assistant', text: cleanText, streaming: false, ...(allFiles.length ? { files: allFiles } : {}) });
    db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(botId);
    if (cleanText) lastMessageText = cleanText;
    wroteText = true;
  };

  // Local ref to pending files for this turn (also populated via addPendingFiles from mcp.ts).
  // We keep a separate local array so the two paths merge cleanly.
  const pendingFiles: MessageFile[] = [];

  let reasoning = '';
  let lastCaption = 0;
  const caption = (c: string | null, force = false) => {
    if (!c || c === getLive(botId).caption) return;
    if (!force && Date.now() - lastCaption < 300) return;
    lastCaption = Date.now();
    setLive(botId, { caption: c });
  };
  const outputsSeen = new Set<string>();
  let steps = 0;
  let failed = false;

  try {
    // The screen first: the engine's browser and computer tools point at it.
    if (computerKindFor(botId) === 'docker') {
      await dockerProvider.readyScreen(userId, botId).catch((e) => console.warn(`[docker] screen not ready for ${botId}: ${e?.message ?? e}`));
    } else {
      await screenForWork(userId, botId).catch((e) => console.warn(`[computer] screen not ready for ${botId}: ${e?.message ?? e}`));
    }
    const engine = await engineFor(botId);
    if (ctrl.signal.aborted) throw new Error('interrupted');

    let input = triggerText(trigger);
    if (bot.handback_at) {
      input = `[Note: the user took control of your screen for a while and has just handed it back. Look at the screen before you rely on what was there.]\n\n${input}`;
      db.prepare('UPDATE bots SET handback_at=NULL WHERE id=?').run(botId);
    }

    const res = await fetch(`${engine.url}/v1/responses`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(engine.key ? { authorization: `Bearer ${engine.key}` } : {}) },
      body: JSON.stringify({
        // A stored `Default` is the settings panel's placeholder, not a model id. A managed Bot with no
        // model of its own sends neither field, so its gateway answers with the model in its own config —
        // the primary agent's — instead of a default this app invented.
        ...(realModel(bot.model) ? { model: realModel(bot.model) } : engine.kind === 'managed' ? {} : { model: 'hermes-agent' }),
        ...(realModel(bot.provider) ? { provider: realModel(bot.provider) } : {}),
        input,
        instructions: await instructionsFor(userId, botId),
        // One engine-side thread per conversation; "New chat" bumps the generation and starts another.
        conversation: `hq-${botId}-g${bot.generation}`,
        stream: true,
        store: true,
        model_options: { reasoning_effort: bot.effort ?? 'medium' },
      }),
    });
    if (!res.ok || !res.body) throw new Error(await failureText(res));

    for await (const ev of sseEvents(res.body)) {
      const d = ev.data;
      switch (ev.type) {
        case 'response.output_text.delta': {
          if (turn.silent || typeof d.delta !== 'string') break;
          // Models often open with blank lines; a message never starts with them.
          const piece = text ? d.delta : d.delta.trimStart();
          if (!piece) break;
          text += piece;
          wroteText = true;
          if (msgSeq === null) setLive(botId, { activity: { kind: 'working', since: now() } });
          if (msgSeq === null || Date.now() - lastFlush > 120) flush(true);
          break;
        }

        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (typeof d.delta === 'string') {
            reasoning = (reasoning + d.delta).slice(-4000);
            caption(captionFrom(reasoning));
          }
          break;
        }

        case 'hermes.status': {
          if (typeof d?.text === 'string' && d.text.trim()) caption(d.text.trim().slice(0, 84), true);
          break;
        }

        case 'response.output_item.added': {
          const item = d.item;
          if (item?.type === 'reasoning') {
            reasoning = '';
            if (getLive(botId).activity?.kind !== 'thinking') setLive(botId, { activity: { kind: 'thinking', since: now() } });
          }
          if (item?.type === 'function_call') {
            // Text written before this call is its own message; what follows starts a new one.
            closeMessage();
            const { name, ours } = appToolName(String(item.name ?? ''));
            // The agent looking through its own toolbox is not a step worth showing.
            if (!ours && TOOLBOX.has(name)) {
              caption('Finding the right tool', true);
              break;
            }
            const act = activityFor(String(item.name ?? ''));
            let args: any;
            try { args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments; } catch { args = undefined; }
            const row = appendRow(botId, 'tool-call', { type: 'tool-call', callId: String(item.call_id ?? item.id ?? ''), name, label: act.label, status: 'running', args } satisfies ToolCallBody);
            turn.tools.push({ seq: row.seq, callId: String(item.call_id ?? item.id ?? ''), name, claimed: false, done: false });
            steps++;
            const kind: ActivityKind = name === 'send_to_bot' ? 'messaging_named' : act.kind;
            const detail = name === 'send_to_bot' ? String(args?.bot_name ?? '') || undefined : act.detail;
            // A call that is waiting for the user keeps its "waiting for you" state.
            if (!getLive(botId).awaiting) setLive(botId, { isRunning: true, activity: { kind, detail, since: now() }, steps, caption: null });
            else setLive(botId, { steps });
            reasoning = '';
            if (ours && name.startsWith('COMPOSIO_')) {
              const tk = policyFor(userId, name, args ?? {}).toolkit;
              if (tk) {
                void toolkitInfo(tk).then((info) => {
                  const live = getLive(botId);
                  if (info?.name && turns.get(botId) === turn && live.activity?.kind === kind && !live.awaiting) setLive(botId, { activity: { ...live.activity, detail: info.name } });
                }).catch(() => {});
              }
            }
          }
          break;
        }

        case 'response.output_item.done': {
          const item = d.item;
          if (item?.type === 'message') {
            const full = (item.content ?? []).map((c: any) => c?.text ?? '').join('');
            if (item.phase === 'commentary') say(full);
            else if (msgSeq !== null) closeMessage();
            else if (!wroteText) say(full);
          }
          break;
        }

        case 'response.failed':
        case 'error':
          throw new Error(d?.response?.error?.message ?? d?.error?.message ?? d?.message ?? 'the agent run failed');
      }

      // A tool result arrives as an item of its own (announced twice: added and done).
      const item = d?.item;
      if (item?.type === 'function_call_output' && item.call_id && !outputsSeen.has(item.call_id)) {
        outputsSeen.add(item.call_id);
        const ref = turn.tools.find((r) => r.callId === item.call_id);
        if (ref) {
          ref.done = true;
          const told = turn.outcomes.get(ref.seq);
          const guess = readOutcome(item);
          patchToolRow(botId, ref.seq, told?.status && told.status !== 'running' ? told : { status: guess.status, summary: told?.summary ?? guess.summary });
          if (!getLive(botId).awaiting) setLive(botId, { activity: { kind: 'thinking', since: now() } });

          // Auto-attach images saved to the library via terminal (e.g. curl -o <path>).
          if (ref.name === 'terminal' && guess.status !== 'error') {
            const row = getRow(botId, ref.seq);
            if (row?.body.type === 'tool-call') {
              const args = (row.body as ToolCallBody).args as Record<string, unknown> | undefined;
              const cmd = String(args?.command ?? '');
              const libBot = `${LIBRARY_ROOT}/${botId}/`;
              // Match curl -o <path> or curl --output <path>
              const pathMatch = cmd.match(/curl\s+.*?(?:-o|--output)\s+"?([^\s"']+)"?/s);
              if (pathMatch) {
                const absPath = pathMatch[1].replace(/^'|'$/g, '');
                if (absPath.startsWith(libBot)) {
                  const relPath = absPath.slice((`${LIBRARY_ROOT}/${botId}/`).length);
                  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
                  const EXT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
                  const mediaType = EXT_TYPES[ext];
                  if (mediaType) {
                    const filename = relPath.split('/').pop() ?? relPath;
                    pendingFiles.push({ path: relPath, filename, mediaType });
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (e: any) {
    failed = true;
    const stopped = ctrl.signal.aborted;
    closeMessage(true);
    appendRow(botId, 'notice', { type: 'notice', text: stopped ? 'Stopped.' : `Something went wrong: ${e?.message ?? e}`, tone: stopped ? 'info' : 'error' });
    if (!stopped) console.error('[agent]', botId, e);
  } finally {
    closeMessage(true);
    for (const ref of turn.tools) {
      if (ref.done) continue;
      const row = getRow(botId, ref.seq);
      if (row?.body.type !== 'tool-call' || (row.body.status !== 'running' && row.body.status !== 'awaiting-approval')) continue;
      patchToolRow(botId, ref.seq, failed ? { status: 'error', summary: ctrl.signal.aborted ? 'Stopped' : 'Did not finish' } : { status: 'done' });
    }
    if (aborts.get(botId) === ctrl) aborts.delete(botId);
    if (turns.get(botId) === turn) turns.delete(botId);
    // An approval asked for outside this turn may still be waiting; leave its state alone.
    if (!pendingApprovals(botId).length) setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null, caption: null });
    else setLive(botId, { isRunning: false, caption: null });
    emitBot(botId);
    // The bot is idle and said something. Someone with no stream open (phone in a pocket) is told;
    // anyone watching the app in a browser already sees the message arrive.
    const finished = lastMessageText.trim();
    if (finished && !failed && !turn.silent && hub.connections(userId) === 0) {
      void sendPushNotification(userId, { title: `${getBotRow(botId)?.name ?? 'A bot'} finished`, body: finished.slice(0, 80), data: { botId } });
    }
  }
}
