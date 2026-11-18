import { z } from 'zod';
import type { EmailReview, ReviewPayload } from '@orbit/contracts';
import { runAction } from '../composio.js';
import { ReviewEditError, type Applied, type ReviewAdapter } from './types.js';

/**
 * The Email card: GMAIL_SEND_EMAIL, GMAIL_REPLY_TO_THREAD, GMAIL_SEND_DRAFT and GMAIL_FORWARD_MESSAGE.
 *
 * Argument names follow Composio's schemas (toolkit 20261116_00): one `recipient_email` plus
 * `extra_recipients`, `cc` and `bcc` lists; the text is `body`, except on a reply where it is
 * `message_body`. Sending a draft takes only `draft_id`, so the card reads the draft to show it, and
 * edits to it are written with GMAIL_UPDATE_DRAFT before the send.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** "Ada <ada@x.test>, bob@y.test" → ["Ada <ada@x.test>", "bob@y.test"]. */
const addresses = (header: string) => header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim()).filter(Boolean);

function header(payload: Record<string, unknown>, name: string): string {
  const headers = Array.isArray(payload.headers) ? (payload.headers as { name?: unknown; value?: unknown }[]) : [];
  return str(headers.find((h) => String(h.name).toLowerCase() === name.toLowerCase())?.value);
}

/** The draft as GMAIL_GET_DRAFT returns it: Composio adds `subject`, `to` and `messageText` beside the raw payload. */
export function readDraft(data: unknown): Pick<EmailReview, 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'threadId'> {
  const message = rec(rec(data).message);
  const payload = rec(message.payload);
  const to = str(message.to) || header(payload, 'To');
  return {
    to: addresses(to),
    cc: addresses(header(payload, 'Cc')),
    bcc: addresses(header(payload, 'Bcc')),
    subject: str(message.subject) || header(payload, 'Subject'),
    body: str(message.messageText).replace(/\n$/, ''),
    threadId: str(message.threadId) || undefined,
  };
}

const Address = z.string().trim().min(3).max(320).regex(/@/, 'Each recipient needs an email address.');
const EmailEditsSchema = z.strictObject({
  to: z.array(Address).min(1, 'An email needs at least one recipient.').max(50).optional(),
  cc: z.array(Address).max(50).optional(),
  bcc: z.array(Address).max(50).optional(),
  subject: z.string().max(998).optional(),
  body: z.string().max(200_000).optional(),
});

const ACTIONS: Record<string, EmailReview['action']> = {
  GMAIL_SEND_EMAIL: 'send', GMAIL_REPLY_TO_THREAD: 'reply', GMAIL_SEND_DRAFT: 'send_draft', GMAIL_FORWARD_MESSAGE: 'forward',
};

function fromArgs(slug: string, args: Record<string, unknown>): EmailReview {
  const action = ACTIONS[slug];
  return {
    kind: 'email',
    action,
    to: [...list(args.recipient_email), ...list(args.extra_recipients)],
    cc: list(args.cc),
    bcc: list(args.bcc),
    subject: str(args.subject),
    body: str(action === 'reply' ? args.message_body ?? args.body : args.body),
    isHtml: args.is_html === true,
    ...(str(args.thread_id) ? { threadId: str(args.thread_id) } : {}),
    // Forwarding's arguments are not ones the card can rewrite safely.
    editable: action !== 'forward',
  };
}

/** Recipients as Composio wants them: the first in `recipient_email`, the rest in `extra_recipients`. */
const recipientArgs = (to: string[]) => ({ recipient_email: to[0] ?? '', extra_recipients: to.slice(1) });

function describeChanges(before: EmailReview, after: EmailReview): string[] {
  const out: string[] = [];
  const same = (a: string[], b: string[]) => a.join(',').toLowerCase() === b.join(',').toLowerCase();
  if (!same(before.to, after.to)) out.push(`recipients changed to ${after.to.join(', ')}`);
  if (!same(before.cc, after.cc)) out.push(after.cc.length ? `cc changed to ${after.cc.join(', ')}` : 'cc removed');
  if (!same(before.bcc, after.bcc)) out.push(after.bcc.length ? `bcc changed to ${after.bcc.join(', ')}` : 'bcc removed');
  if (before.subject !== after.subject) out.push(`subject changed to “${after.subject}”`);
  if (before.body !== after.body) out.push('body edited (sent as the user wrote it)');
  return out;
}

export const emailReview: ReviewAdapter = {
  kind: 'email',
  slugs: Object.keys(ACTIONS),

  async build(userId, slug, args) {
    const review = fromArgs(slug, args);
    if (review.action !== 'send_draft') return review;
    const r = await runAction(userId, 'GMAIL_GET_DRAFT', { draft_id: str(args.draft_id) });
    if (!r.successful) return { ...review, draftId: str(args.draft_id), editable: false };
    return { ...review, ...readDraft(r.data), draftId: str(args.draft_id), editable: true };
  },

  apply(slug, args, review: ReviewPayload, edits): Applied {
    if (review.kind !== 'email') throw new ReviewEditError('This card is not an email.');
    const parsed = EmailEditsSchema.safeParse(edits);
    if (!parsed.success) throw new ReviewEditError(parsed.error.issues[0]?.message ?? 'Those changes could not be read.');
    const e = parsed.data;
    // A reply keeps its thread's subject: Composio's reply action has no subject to set.
    const subject = review.action === 'reply' ? review.subject : e.subject ?? review.subject;
    const after: EmailReview = { ...review, to: e.to ?? review.to, cc: e.cc ?? review.cc, bcc: e.bcc ?? review.bcc, subject, body: e.body ?? review.body };
    const changes = describeChanges(review, after);
    if (!changes.length) return { args, before: [], changes };

    if (review.action === 'send_draft') {
      // A draft is sent exactly as stored, so the edits are written into it first.
      const update = { draft_id: review.draftId, ...recipientArgs(after.to), cc: after.cc, bcc: after.bcc, subject: after.subject, body: after.body, is_html: after.isHtml };
      return { args, before: [{ slug: 'GMAIL_UPDATE_DRAFT', args: update }], changes };
    }
    const text = review.action === 'reply' ? { message_body: after.body } : { body: after.body };
    const next: Record<string, unknown> = { ...args, ...recipientArgs(after.to), cc: after.cc, bcc: after.bcc, ...text };
    if (review.action === 'send') next.subject = after.subject;
    return { args: next, before: [], changes };
  },
};
