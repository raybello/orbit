import type { WorkspaceFile } from '@orbit/contracts';
import { innerAnswers, innerToolCalls, runAction } from '../composio.js';
import { appendRow } from '../store.js';
import { reviewSlugs } from './slug-index.js';
import { rec, str } from '../lib/coerce.js';

/**
 * After a bot creates a Google Sheet or Doc, or a change to one runs, the chat shows the file: its
 * title, a link, and a few rows or lines. Read from the action's own answer where it carries them
 * (a sheet write returns the cells it wrote; a create returns the id and title), otherwise with one
 * read of the file.
 */

const PREVIEW_ROWS = 5;
const PREVIEW_COLS = 6;

const CREATES = new Set(['GOOGLESHEETS_CREATE_GOOGLE_SHEET1', 'GOOGLESHEETS_SHEET_FROM_JSON', 'GOOGLEDOCS_CREATE_DOCUMENT', 'GOOGLEDOCS_CREATE_DOCUMENT2', 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', 'GOOGLEDOCS_COPY_DOCUMENT']);
const WRITES = new Set([...reviewSlugs('sheet'), ...reviewSlugs('doc')]);

const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
const docUrl = (id: string) => `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;
const cells = (v: unknown): string[][] => (Array.isArray(v) ? v.slice(0, PREVIEW_ROWS).map((r) => (Array.isArray(r) ? r : [r]).slice(0, PREVIEW_COLS).map((c) => (c === null || c === undefined ? '' : String(c)))) : []);
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, PREVIEW_ROWS).map((l) => [l.length > 160 ? `${l.slice(0, 160)}…` : l]);

/** The values a sheet write answered with (`updatedData`, or inside `updates` / `responses` / `spreadsheet.responses`). */
function writtenValues(data: Record<string, unknown>): unknown {
  const pick = (d: Record<string, unknown>) => rec(d.updatedData).values;
  return pick(data) ?? pick(rec(data.updates)) ?? pick(rec((data.responses as unknown[] | undefined)?.[0])) ?? pick(rec((rec(data.spreadsheet).responses as unknown[] | undefined)?.[0]));
}

async function fileFor(userId: string, slug: string, args: Record<string, unknown>, data: Record<string, unknown>): Promise<WorkspaceFile | null> {
  const created = CREATES.has(slug);
  if (slug.startsWith('GOOGLESHEETS_')) {
    const id = str(data.spreadsheetId) || str(args.spreadsheet_id) || str(args.spreadsheetId);
    if (!id) return null;
    let title = str(rec(data.properties).title) || str(args.title);
    if (!title) {
      const info = await runAction(userId, 'GOOGLESHEETS_GET_SPREADSHEET_INFO', { spreadsheet_id: id });
      title = str(rec(rec(info.data).properties).title) || 'Google Sheet';
    }
    return { app: 'googlesheets', action: created ? 'created' : 'updated', title, url: str(data.spreadsheetUrl) || sheetUrl(id), preview: cells(writtenValues(data)) };
  }
  const id = str(data.documentId) || str(data.document_id) || str(rec(data.document).documentId) || str(args.document_id) || str(args.id);
  if (!id) return null;
  if (created && str(args.markdown_text)) {
    return { app: 'googledocs', action: 'created', title: str(data.title) || str(args.title) || 'Google Doc', url: docUrl(id), preview: lines(args.markdown_text as string).map(([l]) => [l.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '• ')]) };
  }
  const text = await runAction(userId, 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', { document_id: id });
  const d = rec(text.data);
  return { app: 'googledocs', action: created ? 'created' : 'updated', title: str(d.title) || str(data.title) || str(args.title) || 'Google Doc', url: docUrl(id), preview: lines(str(d.plain_text)) };
}

/** Post a file notice for each sheet or doc this successful call created or changed. */
export async function showFiles(userId: string, botId: string, name: string, args: Record<string, unknown>, data: unknown): Promise<number> {
  const calls = innerToolCalls(name, args);
  const answers = innerAnswers(name, data).map((a, i) => ({
    ...a,
    data: rec(a.data),
    args: name === 'COMPOSIO_MULTI_EXECUTE_TOOL' ? (calls[a.index] ?? calls[i])?.args ?? {} : args,
  }));
  let shown = 0;
  for (const a of answers) {
    if (!a.ok || !(CREATES.has(a.slug) || WRITES.has(a.slug))) continue;
    const file = await fileFor(userId, a.slug, a.args, a.data).catch(() => null);
    if (!file) continue;
    const verb = file.action === 'created' ? 'Created' : 'Updated';
    appendRow(botId, 'notice', { type: 'notice', kind: 'workspace-file', text: `${verb} “${file.title}”`, tone: 'info', file });
    shown++;
  }
  return shown;
}
