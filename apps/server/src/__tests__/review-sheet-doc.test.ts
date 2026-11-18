// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DocReview, NoticeBody, SheetReview } from '@orbit/contracts';

process.env.COMPOSIO_API_KEY = '';

const { db, now } = await import('../db.js');
const { composioIO } = await import('../composio.js');
const { applyReviewEdits, buildReview, ReviewEditError } = await import('../review/index.js');
const { blocksOf, colIndex, colName, parseA1 } = await import('../review/sheet.js');
const { lineDiff } = await import('../review/doc.js');
const { showFiles } = await import('../review/files.js');

after(() => cleanupTmpEnv());

/**
 * The Sheet and Doc cards against Composio's real responses (phase 0 fixtures): every write shown
 * cell by cell or as text, edits landing in the right place of the bot's arguments, and the file
 * notice that follows a create or a change.
 */

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/composio');
const fixture = (rel: string) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
const data = (name: string) => fixture(`responses/${name}.json`).response.data;

const asked: [string, Record<string, unknown>][] = [];
let answers: Record<string, unknown> = {};
beforeEach(() => {
  asked.length = 0;
  answers = {
    GOOGLESHEETS_VALUES_GET: data('sheets-values-get'),
    GOOGLESHEETS_EXECUTE_SQL: { operation: 'DELETE', affected_rows: 3 },
    GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT: data('docs-get-plaintext'),
    GOOGLESHEETS_GET_SPREADSHEET_INFO: { properties: { title: 'Budget' } },
  };
  composioIO.runAction = async (_u, slug, args) => {
    asked.push([slug, args]);
    return slug in answers ? { successful: true, data: answers[slug], error: null } : { successful: false, data: null, error: 'unexpected' };
  };
});

test('A1 addresses: columns both ways, quoted sheet names, single cells', () => {
  assert.deepEqual([colName(0), colName(25), colName(26), colName(701)], ['A', 'Z', 'AA', 'ZZ']);
  assert.deepEqual([colIndex('A'), colIndex('AA'), colIndex('zz')], [0, 26, 701]);
  assert.deepEqual(parseA1('Sheet1!B2:D4'), { sheet: 'Sheet1', col: 1, row: 1 });
  assert.deepEqual(parseA1("'My sheet'!C3"), { sheet: 'My sheet', col: 2, row: 2 });
  assert.deepEqual(parseA1('E10'), { sheet: '', col: 4, row: 9 });
});

test('each value-writing action is read from the arguments Composio really takes', () => {
  const cases: [string, string][] = [['sheets-values-update', 'GOOGLESHEETS_VALUES_UPDATE'], ['sheets-values-append', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND'], ['sheets-update-values-batch', 'GOOGLESHEETS_UPDATE_VALUES_BATCH'], ['sheets-batch-update', 'GOOGLESHEETS_BATCH_UPDATE']];
  for (const [name, slug] of cases) {
    const blocks = blocksOf(slug, fixture(`responses/${name}.json`).request);
    assert.ok(blocks.length && blocks.every((b) => b.values.length), slug);
  }
  assert.deepEqual(blocksOf('GOOGLESHEETS_BATCH_UPDATE', fixture('responses/sheets-batch-update.json').request).map((b) => [b.sheet, b.col, b.row]), [['Sheet1', 4, 0]]);
});

test('a cell write shows what each cell holds now and what it will hold', async () => {
  const args = { spreadsheet_id: 's1', range: 'Sheet1!A1:C2', value_input_option: 'USER_ENTERED', values: [['Name', 'Count', 'Note'], ['alpha', 5, 'changed']] };
  const r = (await buildReview('u', 'GOOGLESHEETS_VALUES_UPDATE', args)) as SheetReview;
  assert.deepEqual(asked[0], ['GOOGLESHEETS_VALUES_GET', { spreadsheet_id: 's1', range: 'Sheet1!A1:C2' }]);
  assert.deepEqual(r.changes.find((c) => c.cell === 'Sheet1!B2'), { cell: 'Sheet1!B2', before: '1', after: '5' });
  assert.deepEqual([r.sheet, r.editable, r.more], ['Sheet1', true, 0]);
});

test('an append shows new rows, which have no before', async () => {
  const r = (await buildReview('u', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', fixture('responses/sheets-values-append.json').request)) as SheetReview;
  assert.equal(asked.length, 0, 'nothing to read for rows that do not exist yet');
  assert.deepEqual(r.changes[0], { cell: 'Sheet1 new row 1, A', before: '', after: 'beta' });
  assert.match(r.steps[0], /Add 2 row\(s\)/);
});

test('an edited cell lands in the right place of the bot\'s arguments, whatever the action', async () => {
  const batch = fixture('responses/sheets-update-values-batch.json').request;
  const review = await buildReview('u', 'GOOGLESHEETS_UPDATE_VALUES_BATCH', batch);
  const a = await applyReviewEdits('u', 'GOOGLESHEETS_UPDATE_VALUES_BATCH', batch, review, { cells: { 'Sheet1!C3': 'edited' } });
  assert.deepEqual((a.args.data as { values: unknown[][] }[])[1].values, [['edited']]);
  assert.deepEqual((a.args.data as { values: unknown[][] }[])[0].values, [[10]], 'other cells are untouched');
  assert.deepEqual(batch.data[1].values, [['changed']], 'the bot\'s own arguments are not mutated');
  assert.deepEqual(a.changes, ['Sheet1!C3 set to “edited”']);
  const append = fixture('responses/sheets-values-append.json').request;
  const r2 = await buildReview('u', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', append);
  const a2 = await applyReviewEdits('u', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', append, r2, { cells: { 'Sheet1 new row 2, B': '30' } });
  assert.deepEqual((a2.args.values as unknown[][])[1], ['gamma', '30', 'third']);
});

test('a cell the change does not write cannot be edited', async () => {
  const args = { spreadsheet_id: 's1', range: 'Sheet1!A1', values: [['x']] };
  const review = await buildReview('u', 'GOOGLESHEETS_VALUES_UPDATE', args);
  await assert.rejects(() => applyReviewEdits('u', 'GOOGLESHEETS_VALUES_UPDATE', args, review, { cells: { 'Sheet1!Z99': 'y' } }), (e: Error) => e instanceof ReviewEditError && /not one of the cells/.test(e.message));
});

test('an SQL write is described from Composio\'s dry run; structural changes in a sentence', async () => {
  const sql = (await buildReview('u', 'GOOGLESHEETS_EXECUTE_SQL', { spreadsheet_id: 's1', sql: 'DELETE FROM "Sheet1" WHERE count < 2' })) as SheetReview;
  assert.deepEqual(asked[0], ['GOOGLESHEETS_EXECUTE_SQL', { spreadsheet_id: 's1', sql: 'DELETE FROM "Sheet1" WHERE count < 2', dry_run: true }]);
  assert.equal(sql.steps[0], 'DELETE · 3 row(s): DELETE FROM "Sheet1" WHERE count < 2');
  assert.equal(sql.editable, false);
  const add = (await buildReview('u', 'GOOGLESHEETS_ADD_SHEET', { spreadsheet_id: 's1', properties: { title: 'Q4' } })) as SheetReview;
  assert.deepEqual(add.steps, ['Add a sheet called “Q4”']);
  const clear = (await buildReview('u', 'GOOGLESHEETS_CLEAR_VALUES', { spreadsheet_id: 's1', range: 'Sheet1!A1:C2' })) as SheetReview;
  assert.deepEqual(clear.changes[0], { cell: 'Sheet1!A1', before: 'Name', after: '' });
});

test('the line diff keeps, removes and adds lines in order', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c'], ['a', 'c', 'd']), ['  a', '- b', '  c', '+ d']);
});

test('a doc insert, replace and rewrite are shown against the document as it is', async () => {
  const insert = (await buildReview('u', 'GOOGLEDOCS_INSERT_TEXT_ACTION', fixture('responses/docs-insert-text.json').request)) as DocReview;
  assert.deepEqual([insert.title, insert.insert, insert.steps[0], insert.editable], [data('docs-get-plaintext').title, '\nAppended by the shapes script.', 'Adds this at the end of the document', true]);
  const replace = (await buildReview('u', 'GOOGLEDOCS_REPLACE_ALL_TEXT', fixture('responses/docs-replace-all-text.json').request)) as DocReview;
  assert.deepEqual([replace.replace?.find, replace.steps[0]], ['Second point', 'Replaces 1 match']);
  const rewrite = (await buildReview('u', 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN', fixture('responses/docs-update-markdown.json').request)) as DocReview;
  assert.ok(rewrite.diff?.includes('  Weekly notes'), 'the heading is unchanged');
  assert.ok(rewrite.diff?.includes('- ● First point'));
  assert.ok(rewrite.diff?.includes('+ Replaced in full.'));
});

test('doc edits replace the text the bot proposed, under Composio\'s own argument names', async () => {
  const args = fixture('responses/docs-replace-all-text.json').request;
  const review = await buildReview('u', 'GOOGLEDOCS_REPLACE_ALL_TEXT', args);
  const a = await applyReviewEdits('u', 'GOOGLEDOCS_REPLACE_ALL_TEXT', args, review, { replaceWith: 'Second point (final)' });
  assert.equal(a.args.replace_text, 'Second point (final)');
  await assert.rejects(() => applyReviewEdits('u', 'GOOGLEDOCS_REPLACE_ALL_TEXT', args, review, { markdown: 'x' }), /does not rewrite/);
  const md = fixture('responses/docs-update-markdown.json').request;
  const r2 = await buildReview('u', 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN', md);
  assert.equal((await applyReviewEdits('u', 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN', md, r2, { markdown: '# New' })).args.markdown, '# New');
});

// ---------- file notices ----------

const BOT = 'bot_files';
db.prepare('INSERT OR IGNORE INTO users(id,name,email,created_at) VALUES (?,?,?,?)').run('u_files', 'F', 'f@example.test', now());
db.prepare("INSERT OR IGNORE INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(BOT, 'u_files', 'Filer', now(), now());
const notices = () => (db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='notice' ORDER BY seq").all(BOT) as { body: string }[]).map((r) => JSON.parse(r.body) as NoticeBody);

test('a created sheet and doc, and a sheet write, each show the file with a link and a preview', async () => {
  const batch = (tool_slug: string, args: unknown, d: unknown) => ({ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', args: { tools: [{ tool_slug, arguments: args }] }, data: { results: [{ tool_slug, index: 0, response: { successful: true, data: d } }] } });
  const cases = [
    batch('GOOGLESHEETS_CREATE_GOOGLE_SHEET1', { title: 'T' }, data('sheets-create')),
    batch('GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', fixture('responses/docs-create-markdown.json').request, data('docs-create-markdown')),
    batch('GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', fixture('responses/sheets-values-append.json').request, data('sheets-values-append')),
    batch('GMAIL_FETCH_EMAILS', {}, { messages: [] }),
  ];
  for (const c of cases) await showFiles('u_files', BOT, c.name, c.args, c.data);
  const [sheet, doc, appended] = notices();
  assert.equal(notices().length, 3, 'reads post nothing');
  assert.deepEqual([sheet.kind, sheet.file?.app, sheet.file?.action, sheet.file?.title], ['workspace-file', 'googlesheets', 'created', data('sheets-create').properties.title]);
  assert.deepEqual([doc.file?.app, doc.file?.preview[0], doc.file?.preview[1]], ['googledocs', ['Weekly notes'], ['• First point']]);
  assert.match(String(doc.file?.url), /^https:\/\/docs\.google\.com\/document\/d\//);
  assert.deepEqual([appended.file?.action, appended.file?.title, appended.file?.preview], ['updated', 'Budget', [['beta', '2', 'second'], ['gamma', '3', 'third']]]);
});
