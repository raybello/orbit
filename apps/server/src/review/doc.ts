import { z } from 'zod';
import type { DocReview, ReviewPayload } from '@orbit/contracts';
import { runAction } from '../composio.js';
import { ReviewEditError, type Applied, type ReviewAdapter } from './types.js';
import { rec, str } from '../lib/coerce.js';

/**
 * The Doc card: changes to an existing Google Doc. The card reads the document's text
 * (GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT) to show its title and what the change does to it:
 *   INSERT_TEXT_ACTION          text_to_insert, at the end or at an index — the text is editable
 *   REPLACE_ALL_TEXT            find_text → replace_text, with how many matches — the replacement is editable
 *   UPDATE_DOCUMENT_MARKDOWN    id, markdown: a whole-document rewrite, shown as a line diff — the markdown is editable
 * Anything else (deleting ranges, tabs, headers…) is described in a sentence.
 */

const MAX_DIFF = 200;

const documentIdOf = (args: Record<string, unknown>) => str(args.document_id) || str(args.id) || str(args.documentId);

/** Markdown read as the plain lines Google keeps (headings and list markers become text). */
const plainLines = (md: string) => md.split('\n').map((l) => l.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '● ').replace(/\*\*(.+?)\*\*/g, '$1')).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));

/** A line diff by longest common subsequence: "  " kept, "- " removed, "+ " added. */
export function lineDiff(before: string[], after: string[]): string[] {
  if (before.length * after.length > 250_000) return [...before.map((l) => `- ${l}`), ...after.map((l) => `+ ${l}`)];
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { out.push(`  ${before[i]}`); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${before[i++]}`);
    else out.push(`+ ${after[j++]}`);
  }
  while (i < n) out.push(`- ${before[i++]}`);
  while (j < m) out.push(`+ ${after[j++]}`);
  return out;
}

const count = (text: string, find: string, matchCase: boolean) => {
  if (!find) return 0;
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  let n = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) n++;
  return n;
};

export const docReview: ReviewAdapter = {
  kind: 'doc',

  async build(userId, slug, args): Promise<ReviewPayload> {
    const documentId = documentIdOf(args);
    const r = await runAction(userId, 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', { document_id: documentId });
    const d = rec(r.data);
    const text = r.successful ? str(d.plain_text) : '';
    const base: DocReview = { kind: 'doc', documentId, ...(str(d.title) ? { title: str(d.title) } : {}), steps: [], editable: false };

    if (slug === 'GOOGLEDOCS_INSERT_TEXT_ACTION') {
      const where = args.append_to_end === true ? 'Adds this at the end of the document' : `Inserts this at position ${Number(args.insertion_index) || 1}`;
      return { ...base, insert: str(args.text_to_insert), steps: [where], editable: true };
    }
    if (slug === 'GOOGLEDOCS_REPLACE_ALL_TEXT') {
      const matchCase = args.match_case === true;
      const find = str(args.find_text);
      const n = r.successful ? count(text, find, matchCase) : -1;
      const steps = [n < 0 ? 'Replaces every match' : n === 0 ? 'No match in the document now: nothing would change' : `Replaces ${n} match${n === 1 ? '' : 'es'}`];
      return { ...base, replace: { find, with: str(args.replace_text), matchCase }, steps, editable: true };
    }
    if (slug === 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN') {
      const markdown = str(args.markdown);
      const diff = lineDiff(text.split('\n'), plainLines(markdown));
      const shown = diff.length > MAX_DIFF ? [...diff.slice(0, MAX_DIFF), `  … ${diff.length - MAX_DIFF} more lines`] : diff;
      return { ...base, markdown, diff: r.successful ? shown : undefined, steps: ['Replaces the whole document'], editable: true };
    }
    const words = slug.replace(/^GOOGLEDOCS_/, '').toLowerCase().replace(/_/g, ' ');
    const detail = Object.entries(args).filter(([k]) => !['document_id', 'id', 'documentId'].includes(k)).map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 80)}`).join(', ');
    return { ...base, steps: [`${words.charAt(0).toUpperCase()}${words.slice(1)}${detail ? ` (${detail})` : ''}`] };
  },

  validate(review, edits) {
    parseEdits(review, edits);
  },

  async apply(_userId, slug, args, review, edits): Promise<Applied> {
    const e = parseEdits(review, edits);
    const changes: string[] = [];
    const next = { ...args };
    if (slug === 'GOOGLEDOCS_INSERT_TEXT_ACTION' && e.insert !== undefined && e.insert !== str(args.text_to_insert)) { next.text_to_insert = e.insert; changes.push('inserted text edited'); }
    if (slug === 'GOOGLEDOCS_REPLACE_ALL_TEXT' && e.replaceWith !== undefined && e.replaceWith !== str(args.replace_text)) { next.replace_text = e.replaceWith; changes.push(`replacement changed to “${e.replaceWith}”`); }
    if (slug === 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN' && e.markdown !== undefined && e.markdown !== str(args.markdown)) { next.markdown = e.markdown; changes.push('new document text edited'); }
    return { args: changes.length ? next : args, before: [], changes };
  },
};

const DocEditsSchema = z.strictObject({
  insert: z.string().max(200_000).optional(),
  replaceWith: z.string().max(50_000).optional(),
  markdown: z.string().max(1_000_000).optional(),
});

function parseEdits(review: ReviewPayload, edits: unknown) {
  if (review.kind !== 'doc') throw new ReviewEditError('This card is not a document.');
  const parsed = DocEditsSchema.safeParse(edits ?? {});
  if (!parsed.success) throw new ReviewEditError(parsed.error.issues[0]?.message ?? 'Those changes could not be read.');
  const e = parsed.data;
  if (e.insert !== undefined && review.insert === undefined) throw new ReviewEditError('This change inserts no text to edit.');
  if (e.replaceWith !== undefined && !review.replace) throw new ReviewEditError('This change replaces nothing.');
  if (e.markdown !== undefined && review.markdown === undefined) throw new ReviewEditError('This change does not rewrite the document.');
  return e;
}
