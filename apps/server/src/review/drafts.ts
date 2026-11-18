import type { CardBody, EmailReview } from '@orbit/contracts';
import { db } from '../db.js';
import { innerToolCalls, runAction } from '../composio.js';
import { appendRow, getRow, updateRow } from '../store.js';
import { emailReview, readDraft } from './email.js';
import { ReviewEditError } from './types.js';

/**
 * Draft-first email. A bot writes email as a real Gmail draft (GMAIL_CREATE_EMAIL_DRAFT runs without
 * asking, since nothing leaves the account), and the draft appears in the chat as an Email card. The
 * person edits, sends or discards it there: the server writes edits with GMAIL_UPDATE_DRAFT, sends
 * with GMAIL_SEND_DRAFT and discards with GMAIL_DELETE_DRAFT, then tells the bot what happened.
 * A bot that updates its own draft updates the same card.
 */

type DraftCard = Extract<CardBody, { card: 'draft' }>;
const DRAFT_SLUGS = new Set(['GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_UPDATE_DRAFT']);

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

/** A draft the bot just wrote: which action, the arguments it ran with and the draft's id. */
export interface WrittenDraft { slug: string; args: Record<string, unknown>; draftId: string; threadId?: string }

/**
 * The drafts a successful Composio call wrote. A batch answers per action in `results[]`
 * (`{ tool_slug, response: { successful, data } }`); a direct call answers with the action's data.
 * The draft id is the draft resource's `id` (GMAIL_CREATE_EMAIL_DRAFT returns `{ id, message }`).
 */
export function draftsWritten(name: string, args: Record<string, unknown>, data: unknown): WrittenDraft[] {
  const calls = innerToolCalls(name, args);
  const answers: { slug: string; data: unknown; ok: boolean }[] = name === 'COMPOSIO_MULTI_EXECUTE_TOOL'
    ? (Array.isArray(rec(data).results) ? (rec(data).results as unknown[]) : []).map((x) => {
      const item = rec(x);
      const response = rec(item.response);
      return { slug: str(item.tool_slug).toUpperCase(), data: response.data, ok: response.successful !== false };
    })
    : [{ slug: name.toUpperCase(), data, ok: true }];
  const out: WrittenDraft[] = [];
  answers.forEach((a, i) => {
    if (!a.ok || !DRAFT_SLUGS.has(a.slug)) return;
    const call = calls.find((c, j) => c.slug.toUpperCase() === a.slug && (j === i || calls.length === 1)) ?? calls.find((c) => c.slug.toUpperCase() === a.slug);
    const d = rec(a.data);
    const draftId = str(d.id) || str(call?.args.draft_id);
    if (!draftId) return;
    out.push({ slug: a.slug, args: call?.args ?? {}, draftId, threadId: str(rec(d.message).threadId) || undefined });
  });
  return out;
}

function pendingDraftCard(botId: string, draftId: string): { seq: number; body: DraftCard } | undefined {
  const rows = db.prepare("SELECT seq, body FROM rows WHERE bot_id=? AND kind='card' ORDER BY seq DESC LIMIT 200").all(botId) as { seq: number; body: string }[];
  for (const r of rows) {
    const body = JSON.parse(r.body) as CardBody;
    if (body.type === 'card' && body.card === 'draft' && body.status === 'pending' && body.email?.draftId === draftId) return { seq: r.seq, body };
  }
  return undefined;
}

const cardOf = (email: EmailReview): DraftCard => ({
  type: 'card', card: 'draft', channel: 'email', to: email.to.join(', '), subject: email.subject, text: email.body,
  approvalId: `draft_${email.draftId}`, email, status: 'pending',
});

/** The fields an update named; the rest stay as the card shows them. */
function merged(base: EmailReview, args: Record<string, unknown>): EmailReview {
  const to = 'recipient_email' in args || 'extra_recipients' in args ? [...list(args.recipient_email), ...list(args.extra_recipients)] : base.to;
  return {
    ...base,
    to,
    cc: 'cc' in args ? list(args.cc) : base.cc,
    bcc: 'bcc' in args ? list(args.bcc) : base.bcc,
    subject: 'subject' in args ? str(args.subject) : base.subject,
    body: 'body' in args ? str(args.body) : base.body,
    isHtml: 'is_html' in args ? args.is_html === true : base.isHtml,
  };
}

/**
 * Put each draft the bot wrote in front of the person. Returns the sentence the bot is told, or
 * null when the call wrote no draft.
 */
export async function showDrafts(userId: string, botId: string, name: string, args: Record<string, unknown>, data: unknown): Promise<string | null> {
  const drafts = draftsWritten(name, args, data);
  if (!drafts.length) return null;
  for (const d of drafts) {
    const existing = pendingDraftCard(botId, d.draftId);
    let email: EmailReview;
    if (existing?.body.email) {
      email = merged(existing.body.email, d.args);
    } else if (d.slug === 'GMAIL_CREATE_EMAIL_DRAFT') {
      email = merged({ kind: 'email', action: 'send_draft', to: [], cc: [], bcc: [], subject: '', body: '', isHtml: false, draftId: d.draftId, editable: true }, d.args);
    } else {
      // An update to a draft the card does not show (made earlier, or elsewhere): read it as it is now.
      const r = await runAction(userId, 'GMAIL_GET_DRAFT', { draft_id: d.draftId });
      email = { kind: 'email', action: 'send_draft', to: [], cc: [], bcc: [], subject: '', body: '', isHtml: false, draftId: d.draftId, editable: r.successful, ...(r.successful ? readDraft(r.data) : {}) };
    }
    if (d.threadId) email.threadId = d.threadId;
    if (existing) updateRow(botId, existing.seq, cardOf(email));
    else appendRow(botId, 'card', cardOf(email));
  }
  return `The draft is in front of the user as an email card, where they can edit it, send it or discard it. Do not send it yourself; you will be told what they did.`;
}

export class DraftActionError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) {
    super(message);
    this.name = 'DraftActionError';
  }
}

/**
 * The person acts on a draft card: save edits into the draft, send it (with any edits first), or
 * discard it. Answers with the card as it is afterwards and, for send and discard, the line the
 * bot is told. Nothing changes on the card unless Gmail accepted the change.
 */
export async function actOnDraft(userId: string, botId: string, seq: number, action: 'save' | 'send' | 'discard', edits?: unknown): Promise<{ card: DraftCard; tell?: string }> {
  const row = getRow(botId, seq);
  const body = row?.body;
  if (!row || body?.type !== 'card' || body.card !== 'draft' || !body.email?.draftId) throw new DraftActionError(404, 'Not a Gmail draft card.');
  if (body.status !== 'pending') throw new DraftActionError(409, body.status === 'sent' ? 'This draft was already sent.' : 'This draft was discarded.');
  const email = body.email;
  const draftId = email.draftId!;

  if (action === 'discard') {
    const r = await runAction(userId, 'GMAIL_DELETE_DRAFT', { draft_id: draftId });
    const card: DraftCard = { ...body, status: 'discarded' };
    updateRow(botId, seq, card);
    const gone = r.successful ? 'and it was deleted from Gmail' : 'but it could not be deleted from Gmail, so it is still in the Drafts folder';
    return { card, tell: `The user discarded your draft “${email.subject}” ${gone}. Do not send it.` };
  }

  let current = email;
  let changes: string[] = [];
  if (edits !== undefined && edits !== null) {
    let applied;
    try {
      applied = emailReview.apply('GMAIL_SEND_DRAFT', { draft_id: draftId }, email, edits);
    } catch (e) {
      if (e instanceof ReviewEditError) throw new DraftActionError(400, e.message);
      throw e;
    }
    changes = applied.changes;
    for (const step of applied.before) {
      const r = await runAction(userId, step.slug, step.args);
      if (!r.successful) throw new DraftActionError(502, `Gmail did not accept the changes: ${JSON.stringify(r.error).slice(0, 200)}`);
    }
    const e = edits as Partial<EmailReview>;
    current = { ...email, to: e.to ?? email.to, cc: e.cc ?? email.cc, bcc: e.bcc ?? email.bcc, subject: e.subject ?? email.subject, body: e.body ?? email.body };
  }

  if (action === 'save') {
    const card = cardOf(current);
    updateRow(botId, seq, card);
    return { card };
  }

  if (!current.to.length) throw new DraftActionError(400, 'Add at least one recipient before sending.');
  const r = await runAction(userId, 'GMAIL_SEND_DRAFT', { draft_id: draftId });
  if (!r.successful) {
    updateRow(botId, seq, cardOf(current));
    throw new DraftActionError(502, `Gmail did not send it: ${JSON.stringify(r.error).slice(0, 200)}`);
  }
  const card: DraftCard = { ...cardOf(current), status: 'sent' };
  updateRow(botId, seq, card);
  const edited = changes.length ? ` after editing it (${changes.join('; ')})` : '';
  return { card, tell: `The user sent your draft “${current.subject}” to ${current.to.join(', ')}${edited}. It is in their Sent folder.` };
}

