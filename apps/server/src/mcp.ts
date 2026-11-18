import crypto from 'node:crypto';
import { Hono } from 'hono';
import { getBotRow } from './store.js';
import { composioTools, innerToolCalls, innerToolSlugs, runAction } from './composio.js';
import { applyReviewEdits, buildReview, type PreStep } from './review/index.js';
import { showDrafts } from './review/drafts.js';
import { showFiles } from './review/files.js';
import { connectionWatch, expiredAppNotice } from './core/connection-watch.js';
import { mcpToken, primaryBotId } from './engine.js';
import { addPendingFiles, claimToolRow, enqueue, enqueueBotMessage, markSilent, noteToolOutcome, requestApproval, turnDepth, turnGroupDepth } from './agent/loop.js';
import { policyFor, runComposioTool, toolMap, TOOLS, type ToolCtx } from './agent/tools.js';
import { strictest } from './domain/rules.js';
import { blockedByRule, recordReview, reviewToolCall } from './core/rule-service.js';

/**
 * The app's tools, served to the Hermes engines over MCP (streamable HTTP, JSON answers only).
 *
 *   POST /mcp/<botId>     one bot's engine; the bearer token is derived from the bot id
 *   POST /mcp/primary     the primary engine, whichever bot it is bound to (so that agent's config
 *                         can be written before the bot exists)
 *
 * Every call is stateless: the URL says which bot is calling. Besides the app's own tools the list
 * carries the user's Composio tools, so connected apps (and the approvals around them) work the
 * same for every engine.
 */

const DECLINED = 'The user declined this action. Do not retry it. Find another way, or tell the user what you could not do.';
const SKIPPED = 'Skipped: the user did not approve this (they sent a new message or did not answer in time). Do not retry unless they ask.';

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface CallResult { content: { type: 'text'; text: string }[]; isError?: boolean }
const text = (t: string, isError = false): CallResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Which bot a request is for, or null when the token does not fit the URL. `botId` is null for /mcp/primary before a bot is bound to it. */
function caller(slug: string, auth: string | undefined): { botId: string | null } | null {
  const given = (auth ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!given || !sameToken(given, mcpToken(slug))) return null;
  if (slug === 'primary') return { botId: primaryBotId() };
  return getBotRow(slug) ? { botId: slug } : null;
}

/** A JSON-RPC message or payload from a client, read field by field. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

async function listTools(botId: string | null) {
  const own = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
  const bot = botId ? getBotRow(botId) : null;
  if (!bot) return own;
  const apps = (await composioTools(bot.user_id))
    .filter((t: unknown) => (t as { type?: unknown; name?: unknown } | null)?.type === 'function' && typeof (t as { name?: unknown }).name === 'string' && !toolMap.has((t as { name: string }).name))
    .map((t) => {
      const tool = t as { name: string; description?: unknown; parameters?: unknown };
      return { name: tool.name, description: String(tool.description ?? ''), inputSchema: tool.parameters ?? { type: 'object', properties: {} } };
    });
  return [...own, ...apps];
}

type Who = { userId: string; botId: string };
/** What the gate decided: why the call must not run, or the arguments it runs with and what to tell the bot about them. */
type Gate = { refused: string } | { name?: string; args: Record<string, unknown>; notes: string[]; before: PreStep[]; rollback: PreStep[] };

/**
 * The gate every call passes before it runs: the user's approval policy ("Always allow" and its
 * defaults) and the bot's own rules, whichever is stricter.
 *
 * A Composio call can hold several app actions. Each action that needs the person gets its own
 * card, all shown at once; each is decided on its own, and only what was allowed runs, with any
 * edits the person made. A call that a rule asks about keeps the single card naming that rule.
 */
async function gate(who: Who, name: string, args: Record<string, unknown>, ownTool: boolean, rowSeq: number | null): Promise<Gate> {
  const pass: Gate = { args, notes: [], before: [], rollback: [] };
  const pol = policyFor(who.userId, name, args, who.botId);
  const review = await reviewToolCall(who.botId, name, args, ownTool);
  const rule = review.verdict.decidedBy?.rule;
  const decision = strictest(pol.decision, review.verdict.decision);
  if (decision === 'block') {
    const byRule = review.verdict.decision === 'block' ? rule : undefined;
    noteToolOutcome(who.botId, rowSeq, { status: 'denied', summary: byRule ? `Blocked by your rule: ${byRule.description}`.slice(0, 200) : 'Not allowed' });
    recordReview(who.botId, review, 'blocked');
    return { refused: byRule ? blockedByRule(byRule) : DECLINED };
  }
  if (decision === 'allow') {
    recordReview(who.botId, review, 'ran');
    return pass;
  }

  const calls = ownTool ? [] : innerToolCalls(name, args);
  if (review.verdict.decision === 'ask' || calls.length === 0) {
    // A rule that asks is named on the card, so the person sees why and is not offered "Always allow".
    const subject = rule ? { ...review.subject, rule: { id: rule.id, description: rule.description } } : pol;
    const answer = await requestApproval(who, subject, args, rowSeq);
    if (answer.decision !== 'allow') {
      recordReview(who.botId, review, answer.decision === 'deny' ? 'denied' : 'expired');
      return { refused: answer.decision === 'deny' ? DECLINED : SKIPPED };
    }
    recordReview(who.botId, review, 'ran');
    return pass;
  }

  // One card per action that asks; the rest run as they are.
  const outcomes = await Promise.all(calls.map(async (call) => {
    const v = policyFor(who.userId, call.slug, call.args, who.botId);
    if (v.decision !== 'ask') return { call, asked: false, decision: 'allow' as const, applied: { args: call.args, before: [] as PreStep[], changes: [] as string[] } };
    const payload = await buildReview(who.userId, call.slug, call.args);
    const answer = await requestApproval(who, v, call.args, rowSeq, payload);
    if (answer.decision !== 'allow') return { call, asked: true, decision: answer.decision, applied: null };
    try {
      return { call, asked: true, decision: 'allow' as const, applied: await applyReviewEdits(who.userId, call.slug, call.args, payload, answer.edits) };
    } catch (e) {
      // The edits were checked when the person answered; this only happens if the card changed under them.
      return { call, asked: true, decision: 'deny' as const, applied: null, error: (e as Error).message };
    }
  }));

  const ran = outcomes.filter((o) => o.decision === 'allow');
  // Nothing the person was asked about was allowed: the call does not run at all, as it did before
  // batches were split, so the bot is not handed the leftovers as if its request had gone through.
  const failedEdit = outcomes.find((o) => 'error' in o && o.error);
  if (!outcomes.some((o) => o.asked && o.decision === 'allow')) {
    if (failedEdit) {
      recordReview(who.botId, review, 'denied');
      return { refused: `Not run: the user allowed ${failedEdit.call.slug}, but their changes could not be applied (${(failedEdit as { error: string }).error}). Tell the user.` };
    }
    const anyDenied = outcomes.some((o) => o.decision === 'deny');
    recordReview(who.botId, review, anyDenied ? 'denied' : 'expired');
    return { refused: anyDenied ? DECLINED : SKIPPED };
  }
  recordReview(who.botId, review, 'ran');

  const notes: string[] = [];
  for (const o of outcomes) {
    if ('error' in o && o.error) notes.push(`Not run: ${o.call.slug}, because the user's changes to it could not be applied (${o.error}).`);
    else if (o.decision !== 'allow') notes.push(`Not run: ${o.call.slug}, because the user ${o.decision === 'deny' ? 'declined it' : 'did not answer'}. Do not retry it unless they ask.`);
    else if (o.applied?.changes.length) notes.push(`The user edited ${o.call.slug} before it ran: ${o.applied.changes.join('; ')}.`);
  }
  const before = ran.flatMap((o) => o.applied?.before ?? []);
  const rollback = ran.flatMap((o) => o.applied?.rollback ?? []);
  if (name !== 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    const only = ran[0].applied!;
    return { name: only.slug ?? name, args: only.args, notes, before, rollback };
  }
  return { args: withCalls(args, ran.map((o) => ({ index: calls.indexOf(o.call), args: o.applied!.args, slug: o.applied!.slug }))), notes, before, rollback };
}

/**
 * The batch call again, with only the listed actions, each with its (possibly edited) arguments.
 * Every other field of each item, and the key it used for arguments, is kept as the bot sent it.
 */
function withCalls(args: Record<string, unknown>, keep: { index: number; args: Record<string, unknown>; slug?: string }[]): Record<string, unknown> {
  const key = Array.isArray(args.tools) ? 'tools' : Array.isArray(args.tool_calls) ? 'tool_calls' : 'actions';
  const items = (args[key] as Record<string, unknown>[]).filter((t) => {
    const slug = String(t?.tool_slug ?? t?.slug ?? t?.name ?? t?.tool ?? '');
    return Boolean(slug);
  });
  const next = keep.map(({ index, args: a, slug }) => {
    const item = items[index] ?? {};
    const argKey = 'arguments' in item ? 'arguments' : 'tool_params' in item ? 'tool_params' : 'args' in item ? 'args' : 'arguments';
    const slugKey = 'tool_slug' in item ? 'tool_slug' : 'slug' in item ? 'slug' : 'name' in item ? 'name' : 'tool' in item ? 'tool' : 'tool_slug';
    return { ...item, ...(slug ? { [slugKey]: slug } : {}), [argKey]: a };
  });
  return { ...args, [key]: next };
}

/** Actions the gate says must run before the call (writing the person's edits into a draft before it is sent). */
async function runBefore(userId: string, steps: PreStep[]): Promise<string | null> {
  for (const step of steps) {
    const r = await runAction(userId, step.slug, step.args);
    if (!r.successful) return `Could not apply the user's edits (${step.slug} failed: ${JSON.stringify(r.error).slice(0, 300)}). Nothing was sent. Tell the user.`;
  }
  return null;
}

async function callTool(botId: string | null, rawName: string, args: Record<string, unknown>): Promise<CallResult> {
  const bot = botId ? getBotRow(botId) : null;
  if (!botId || !bot) return text('The team app has no bot for this agent yet. Ask the user to open the app once, then try again.', true);
  const userId: string = bot.user_id;
  const name = [...toolMap.keys()].find((k) => k.toLowerCase() === rawName.toLowerCase()) ?? rawName;
  const rowSeq = await claimToolRow(botId, name);
  const ctx: ToolCtx = { userId, botId, enqueueBotMessage, enqueue, depth: turnDepth(botId), groupDepth: turnGroupDepth(botId) };
  const own = toolMap.get(name);
  try {
    // An app whose sign-in expired cannot run this, so say so before asking anyone to approve it.
    const expiredApp = own ? null : await connectionWatch.expiredAppFor(userId, botId, innerToolSlugs(name, args));
    if (expiredApp) {
      noteToolOutcome(botId, rowSeq, { status: 'error', summary: `${expiredApp} needs reconnecting` });
      return text(expiredAppNotice(expiredApp));
    }
    const g = await gate({ userId, botId }, name, args, own !== undefined, rowSeq);
    if ('refused' in g) return text(g.refused);
    if (own) {
      const r = await own.impl(args, ctx);
      if (r.endTurn) markSilent(botId);
      noteToolOutcome(botId, rowSeq, { status: 'done', summary: r.summary });
      if (/\[hq-file:/.test(r.output)) {
        const matches = [...r.output.matchAll(/\[hq-file:([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/g)];
        const files = matches.map(([, path, filename, mediaType]) => ({ path: path.trim(), filename: filename.trim(), mediaType: mediaType.trim() }));
        if (files.length) addPendingFiles(botId, files);
      }
      return text(r.output);
    }

    const prep = await runBefore(userId, g.before);
    if (prep) {
      noteToolOutcome(botId, rowSeq, { status: 'error', summary: 'Could not apply your edits' });
      return text(prep);
    }
    const runName = g.name ?? name;
    const r = await runComposioTool(ctx, runName, g.args);
    const failed = r.summary === 'failed';
    // A change made in two steps is undone when its second step did not go through.
    if ((failed || r.summary === 'partial') && g.rollback.length) {
      const undo = await runBefore(userId, g.rollback);
      g.notes.push(undo ? `The change failed part-way and could not be fully undone: ${undo}` : 'The change failed part-way, so its first step was undone; the calendar is as it was.');
    }
    noteToolOutcome(botId, rowSeq, { status: failed ? 'error' : 'done', summary: failed ? 'Failed' : r.summary === 'partial' ? 'Partly failed' : undefined });
    if (failed || r.summary === 'partial') connectionWatch.noteFailure(userId, botId);
    // A draft the bot wrote goes in front of the person as an email card.
    const draftNote = failed ? null : await showDrafts(userId, botId, runName, g.args, r.data).catch((e) => { console.warn('[drafts] could not show a draft', (e as Error).message); return null; });
    // A sheet or doc it created or changed is shown in the chat with a link and a preview.
    if (!failed) await showFiles(userId, botId, runName, g.args, r.data).catch((e) => console.warn('[files] could not show a file', (e as Error).message));
    const notes = draftNote ? [...g.notes, draftNote] : g.notes;
    return text(notes.length ? `${notes.join('\n')}\n\n${r.output}` : r.output);
  } catch (e) {
    const msg = String((e as { message?: unknown } | null)?.message ?? e);
    noteToolOutcome(botId, rowSeq, { status: 'error', summary: msg.slice(0, 200) });
    if (!own) connectionWatch.noteFailure(userId, botId);
    return text(`Tool error: ${msg}`, true);
  }
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Answer one JSON-RPC message; null for notifications (they get no answer). */
async function handle(msg: unknown, botId: string | null): Promise<object | null> {
  const m = asRecord(msg);
  const method = m?.method;
  if (!m || m.jsonrpc !== '2.0' || typeof method !== 'string') {
    // A response to something we never asked; nothing to do with it.
    if (m && ('result' in m || 'error' in m)) return null;
    return rpcError(m?.id, -32600, 'Invalid request');
  }
  const { id } = m;
  const params = asRecord(m.params);
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const asked = String(params?.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hq', title: 'Team app', version: '1.0.0' },
          instructions: 'Tools of the team app: connected apps, files for the user, tasks, routines, other agents on the team.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: await listTools(botId) } };
    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !name) return rpcError(id, -32602, 'Missing tool name');
      const args = params?.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      return { jsonrpc: '2.0', id, result: await callTool(botId, name, args) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export const mcpApi = new Hono();

mcpApi.post('/:bot', async (c) => {
  const who = caller(c.req.param('bot'), c.req.header('authorization'));
  if (!who) return c.json(rpcError(null, -32001, 'Unauthorized'), 401);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const answers = (await Promise.all(body.map((m) => handle(m, who.botId)))).filter(Boolean);
    return answers.length ? c.json(answers) : c.body(null, 202);
  }
  const answer = await handle(body, who.botId);
  return answer ? c.json(answer) : c.body(null, 202);
});

// No server-to-client stream and no sessions to end.
mcpApi.all('/:bot', (c) => c.body(null, 405, { Allow: 'POST' }));
