import { z } from 'zod';
import type { CellChange, ReviewPayload, SheetReview } from '@orbit/contracts';
import { runAction } from '../composio.js';
import { ReviewEditError, type Applied, type ReviewAdapter } from './types.js';

/**
 * The Sheet card: writes to an existing Google Sheet.
 *
 * Value writes are shown cell by cell, before → after, and the person may change any "after" value.
 * Argument names follow Composio's schemas (toolkit 20261116_00), whose casing varies:
 *   VALUES_UPDATE          spreadsheet_id, range, values
 *   SPREADSHEETS_VALUES_APPEND  spreadsheetId, range, values (rows go after the table's last row)
 *   UPDATE_VALUES_BATCH    spreadsheet_id, data: [{ range, values }]
 *   BATCH_UPDATE           spreadsheet_id, sheet_name, first_cell_location, values
 * Structural changes and SQL writes are described in sentences; an SQL write is described from
 * Composio's own dry run, which reports the operation and how many rows it touches.
 */

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const MAX_CELLS = 200;

export const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
export const colIndex = (s: string): number => [...s.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** "Sheet1!B2:D4", "'My sheet'!C3", "A1" → the sheet and the top-left cell (0-based). */
export function parseA1(range: string): { sheet: string; col: number; row: number } {
  const bang = range.lastIndexOf('!');
  const sheet = bang >= 0 ? range.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'") : '';
  const cell = /^([A-Za-z]+)(\d+)/.exec(bang >= 0 ? range.slice(bang + 1) : range);
  return { sheet, col: cell ? colIndex(cell[1]) : 0, row: cell ? Number(cell[2]) - 1 : 0 };
}

const quoteSheet = (s: string) => (s && /[^A-Za-z0-9_]/.test(s) ? `'${s.replace(/'/g, "''")}'` : s);
const address = (sheet: string, col: number, row: number) => `${sheet ? `${quoteSheet(sheet)}!` : ''}${colName(col)}${row + 1}`;
const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const grid = (v: unknown): unknown[][] => (Array.isArray(v) ? v.map((r) => (Array.isArray(r) ? r : [r])) : []);

/** One written block: where it lands and its values, and where in the arguments those values live. */
interface Block { sheet: string; col: number; row: number; values: unknown[][]; path: (string | number)[]; append: boolean }

const VALUE_SLUGS = new Set(['GOOGLESHEETS_VALUES_UPDATE', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', 'GOOGLESHEETS_UPDATE_VALUES_BATCH', 'GOOGLESHEETS_BATCH_UPDATE']);

export function blocksOf(slug: string, args: Record<string, unknown>): Block[] {
  if (slug === 'GOOGLESHEETS_VALUES_UPDATE') return [{ ...parseA1(str(args.range)), values: grid(args.values), path: ['values'], append: false }];
  if (slug === 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND') return [{ ...parseA1(str(args.range)), values: grid(args.values), path: ['values'], append: true }];
  if (slug === 'GOOGLESHEETS_UPDATE_VALUES_BATCH') {
    return (Array.isArray(args.data) ? args.data : []).map((d, i) => ({ ...parseA1(str(rec(d).range)), values: grid(rec(d).values), path: ['data', i, 'values'], append: false }));
  }
  if (slug === 'GOOGLESHEETS_BATCH_UPDATE') {
    const at = parseA1(str(args.first_cell_location) || 'A1');
    return [{ sheet: str(args.sheet_name), col: at.col, row: at.row, values: grid(args.values), path: ['values'], append: false }];
  }
  return [];
}

/** The label a cell is shown and edited under. Appended rows have no address until they land. */
const labelOf = (b: Block, r: number, c: number) => (b.append ? `${b.sheet ? `${b.sheet} ` : ''}new row ${r + 1}, ${colName(b.col + c)}` : address(b.sheet, b.col + c, b.row + r));

const spreadsheetIdOf = (args: Record<string, unknown>) => str(args.spreadsheet_id) || str(args.spreadsheetId);

/** What the written cells hold now, read in one call per block (a few at most). */
async function currentValues(userId: string, id: string, blocks: Block[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const b of blocks.filter((x) => !x.append).slice(0, 5)) {
    const rows = b.values.length;
    const cols = Math.max(0, ...b.values.map((r) => r.length));
    if (!rows || !cols) continue;
    const range = `${address(b.sheet, b.col, b.row)}:${colName(b.col + cols - 1)}${b.row + rows}`;
    const r = await runAction(userId, 'GOOGLESHEETS_VALUES_GET', { spreadsheet_id: id, range });
    if (!r.successful) continue;
    grid(rec(r.data).values).forEach((row, ri) => row.forEach((v, ci) => out.set(address(b.sheet, b.col + ci, b.row + ri), asText(v))));
  }
  return out;
}

function describeStructure(slug: string, args: Record<string, unknown>): string {
  const props = rec(args.properties);
  switch (slug) {
    case 'GOOGLESHEETS_ADD_SHEET': return `Add a sheet${str(props.title) || str(args.title) ? ` called “${str(props.title) || str(args.title)}”` : ''}`;
    case 'GOOGLESHEETS_DELETE_SHEET': return `Delete a sheet${str(args.sheet_name) ? ` (“${str(args.sheet_name)}”)` : args.sheet_id !== undefined ? ` (id ${asText(args.sheet_id)})` : ''}`;
    case 'GOOGLESHEETS_CLEAR_VALUES': return `Clear ${str(args.range) || 'a range'}`;
    case 'GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_CLEAR': return `Clear ${(Array.isArray(args.ranges) ? args.ranges : []).map(asText).join(', ') || 'several ranges'}`;
    default: {
      const words = slug.replace(/^GOOGLESHEETS_/, '').toLowerCase().replace(/_/g, ' ');
      const detail = Object.entries(args).filter(([k]) => k !== 'spreadsheet_id' && k !== 'spreadsheetId').map(([k, v]) => `${k}: ${asText(v).slice(0, 80)}`).join(', ');
      return `${words.charAt(0).toUpperCase()}${words.slice(1)}${detail ? ` (${detail})` : ''}`;
    }
  }
}

export const sheetReview: ReviewAdapter = {
  kind: 'sheet',
  slugs: [
    ...VALUE_SLUGS, 'GOOGLESHEETS_EXECUTE_SQL', 'GOOGLESHEETS_ADD_SHEET', 'GOOGLESHEETS_DELETE_SHEET', 'GOOGLESHEETS_INSERT_DIMENSION',
    'GOOGLESHEETS_DELETE_DIMENSION', 'GOOGLESHEETS_APPEND_DIMENSION', 'GOOGLESHEETS_CLEAR_VALUES', 'GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_CLEAR',
    'GOOGLESHEETS_UPSERT_ROWS', 'GOOGLESHEETS_CREATE_SPREADSHEET_ROW', 'GOOGLESHEETS_CREATE_SPREADSHEET_COLUMN', 'GOOGLESHEETS_FIND_REPLACE',
    'GOOGLESHEETS_SORT_RANGE', 'GOOGLESHEETS_UPDATE_SHEET_PROPERTIES', 'GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER', 'GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER',
  ],

  async build(userId, slug, args): Promise<ReviewPayload> {
    const spreadsheetId = spreadsheetIdOf(args);
    const base: SheetReview = { kind: 'sheet', spreadsheetId, changes: [], more: 0, steps: [], editable: false };

    if (VALUE_SLUGS.has(slug)) {
      const blocks = blocksOf(slug, args);
      const now = await currentValues(userId, spreadsheetId, blocks);
      const changes: CellChange[] = [];
      let total = 0;
      for (const b of blocks) {
        b.values.forEach((row, r) => row.forEach((v, c) => {
          total++;
          if (changes.length < MAX_CELLS) changes.push({ cell: labelOf(b, r, c), before: b.append ? '' : now.get(address(b.sheet, b.col + c, b.row + r)) ?? '', after: asText(v) });
        }));
      }
      const sheets = [...new Set(blocks.map((b) => b.sheet).filter(Boolean))];
      const steps = blocks.some((b) => b.append) ? [`Add ${blocks.reduce((n, b) => n + (b.append ? b.values.length : 0), 0)} row(s) after the last row of the table`] : [];
      return { ...base, ...(sheets.length === 1 ? { sheet: sheets[0] } : {}), changes, more: Math.max(0, total - changes.length), steps, editable: total <= MAX_CELLS };
    }

    if (slug === 'GOOGLESHEETS_EXECUTE_SQL') {
      const sql = str(args.sql);
      const dry = await runAction(userId, 'GOOGLESHEETS_EXECUTE_SQL', { spreadsheet_id: spreadsheetId, sql, dry_run: true });
      const d = rec(dry.data);
      const what = dry.successful && str(d.operation) ? `${str(d.operation)} · ${asText(d.affected_rows)} row(s)` : 'An SQL change';
      return { ...base, steps: [`${what}: ${sql}`] };
    }

    if (slug === 'GOOGLESHEETS_CLEAR_VALUES' && str(args.range)) {
      // Clearing is shown as the cells it empties.
      const at = parseA1(str(args.range));
      const r = await runAction(userId, 'GOOGLESHEETS_VALUES_GET', { spreadsheet_id: spreadsheetId, range: str(args.range) });
      const values = r.successful ? grid(rec(r.data).values) : [];
      const changes: CellChange[] = [];
      let total = 0;
      values.forEach((row, ri) => row.forEach((v, ci) => { total++; if (changes.length < MAX_CELLS) changes.push({ cell: address(at.sheet, at.col + ci, at.row + ri), before: asText(v), after: '' }); }));
      return { ...base, changes, more: Math.max(0, total - changes.length), steps: [describeStructure(slug, args)] };
    }
    return { ...base, steps: [describeStructure(slug, args)] };
  },

  validate(review, edits) {
    parseEdits(review, edits);
  },

  async apply(_userId, slug, args, review, edits): Promise<Applied> {
    const cells = parseEdits(review, edits);
    if (!Object.keys(cells).length) return { args, before: [], changes: [] };
    const next = structuredClone(args) as Record<string, unknown>;
    const changes: string[] = [];
    for (const b of blocksOf(slug, args)) {
      b.values.forEach((row, r) => row.forEach((v, c) => {
        const label = labelOf(b, r, c);
        if (!(label in cells) || cells[label] === asText(v)) return;
        let target: unknown = next;
        for (const key of b.path) target = (target as Record<string | number, unknown>)[key];
        (target as unknown[][])[r][c] = cells[label];
        changes.push(`${label} set to “${cells[label]}”`);
      }));
    }
    return { args: next, before: [], changes };
  },
};

const SheetEditsSchema = z.strictObject({ cells: z.record(z.string().max(120), z.string().max(50_000)).optional() });

function parseEdits(review: ReviewPayload, edits: unknown): Record<string, string> {
  if (review.kind !== 'sheet') throw new ReviewEditError('This card is not a sheet.');
  const parsed = SheetEditsSchema.safeParse(edits ?? {});
  if (!parsed.success) throw new ReviewEditError(parsed.error.issues[0]?.message ?? 'Those changes could not be read.');
  const cells = parsed.data.cells ?? {};
  const known = new Set(review.changes.map((c) => c.cell));
  const unknown = Object.keys(cells).find((k) => !known.has(k));
  if (unknown) throw new ReviewEditError(`${unknown} is not one of the cells this change writes.`);
  return cells;
}
