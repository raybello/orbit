import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpRoot, cleanupTmpEnv } from './helpers/tmp-env.js';

// tmp-env isolates the database, engines dir and Hermes home. The Library has one more root —
// BOT_DATA_DIR — so point it inside the same temp dir before env.ts is first imported below.
const botDataDir = path.join(tmpRoot, 'bot-data');
process.env.BOT_DATA_DIR = botDataDir;

// env.ts snapshots process.env at import, so these must stay dynamic imports.
const { aggregateFiles, fileIdFor, listAttachmentFiles, listLibraryFiles, listWorkspaceFiles, resolveFileId } = await import('../files.js');
const { db } = await import('../db.js');
const { filesApi } = await import('../routes-files.js');

// ---------- fixtures ----------

const LIB = path.join(botDataDir, 'files');
const WRK = path.join(process.env.ENGINES_DIR!, 'bot_a', 'workspace');

function write(dir: string, rel: string, content = 'x'): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const t0 = Date.UTC(2026, 0, 1);
const at = (n: number) => new Date(t0 + n * 1000);

function touch(file: string, when: Date) {
  fs.utimesSync(file, when, when);
}

function addUser(id: string, email: string) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, id, Date.now());
}

function addBot(id: string, userId: string, name: string, engine: string | null = null) {
  db.prepare('INSERT INTO bots(id,user_id,name,engine,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, userId, name, engine, Date.now(), Date.now());
}

function addMessage(botId: string, files: { path: string; filename: string; mediaType: string }[], seq = 1, createdAt = Date.now()) {
  const body = JSON.stringify({ type: 'message', role: 'assistant', text: 'here you go', files });
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,1,?,?,?,?,?)').run(botId, seq, seq, 'message', body, createdAt);
}

addUser('usr_a', 'a@example.com');
addUser('usr_b', 'b@example.com');
addBot('bot_a', 'usr_a', 'Ada', 'managed');
addBot('bot_b', 'usr_b', 'Bob');

// Ada's Library: a top-level report, a nested note and an image.
touch(write(LIB, 'bot_a/report-q3.pdf', 'pdf'), at(1));
touch(write(LIB, 'bot_a/notes/todo.txt', 'todo'), at(2));
touch(write(LIB, 'bot_a/images/photo.png', 'png-bytes'), at(3));
// A message attachment that still exists on disk, and one whose file is gone.
addMessage('bot_a', [
  { path: 'report-q3.pdf', filename: 'report-q3.pdf', mediaType: 'application/pdf' },
  { path: 'images/deleted.png', filename: 'deleted.png', mediaType: 'image/png' },
]);
// A message with no files at all must not produce an attachment.
db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,1,2,2,?,?,?)').run(
  'bot_a',
  'message',
  JSON.stringify({ type: 'message', role: 'user', text: 'hi' }),
  Date.now(),
);
// Ada's agent workspace.
touch(write(WRK, 'output/data.csv', 'a,b'), at(4));
// Bob's Library: must never show up for Ada.
touch(write(LIB, 'bot_b/bob-secret.txt', 'secret'), at(5));

// A second bot with exactly ten Library files, oldest first, for the pagination test.
addBot('bot_page', 'usr_a', 'Pager');
for (let i = 1; i <= 10; i++) touch(write(LIB, `bot_page/file-${String(i).padStart(2, '0')}.txt`, `file ${i}`), at(100 + i));

// Session for Ada, so the route tests can call the router as a signed-in user.
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('tok_ada', 'usr_a', Date.now(), Date.now() + 3_600_000);
const asAda = { authorization: 'Bearer tok_ada' };

test.after(() => cleanupTmpEnv());

// ---------- the three sources ----------

test('listLibraryFiles walks the Library recursively and describes each file', () => {
  const files = listLibraryFiles('bot_a', 'Ada');
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['images/photo.png', 'notes/todo.txt', 'report-q3.pdf'],
  );
  const report = files.find((f) => f.path === 'report-q3.pdf')!;
  assert.equal(report.type, 'library');
  assert.equal(report.filename, 'report-q3.pdf');
  assert.equal(report.botId, 'bot_a');
  assert.equal(report.botName, 'Ada');
  assert.equal(report.mediaType, 'application/pdf');
  assert.equal(report.size, 3);
  assert.equal(report.createdAt, at(1).getTime());
  assert.equal(report.downloadUrl, `/api/files/${report.id}/download`);
  assert.equal(files.find((f) => f.path === 'notes/todo.txt')!.mediaType, 'text/plain; charset=utf-8');
});

test('listLibraryFiles is empty for a bot with no Library, not an error', () => {
  assert.deepEqual(listLibraryFiles('bot_none', 'Nobody'), []);
});

test('listWorkspaceFiles reads a managed bot workspace and is empty when there is none', () => {
  const files = listWorkspaceFiles('bot_a', 'Ada');
  assert.deepEqual(files.map((f) => f.path), ['output/data.csv']);
  assert.equal(files[0].type, 'workspace');
  assert.deepEqual(listWorkspaceFiles('bot_none', 'Nobody'), []);
});

test('listAttachmentFiles lists message files, with disk size when present and 0 when gone', () => {
  const files = listAttachmentFiles('bot_a', 'Ada');
  assert.equal(files.length, 2);
  const live = files.find((f) => f.path === 'report-q3.pdf')!;
  assert.equal(live.type, 'attachment');
  assert.equal(live.size, 3);
  assert.equal(live.mediaType, 'application/pdf');
  const gone = files.find((f) => f.path === 'images/deleted.png')!;
  assert.equal(gone.size, 0);
  assert.ok(gone.createdAt > 0, 'a missing attachment keeps its message time');
});

// ---------- the aggregate ----------

test('aggregateFiles with type=library leaves out attachments and workspaces', () => {
  const res = aggregateFiles({ userId: 'usr_a', botId: 'bot_a', type: 'library' });
  assert.equal(res.total, 3);
  assert.deepEqual([...new Set(res.files.map((f) => f.type))], ['library']);
});

test("aggregateFiles with type=all gathers all three sources for the user's bots only", () => {
  const res = aggregateFiles({ userId: 'usr_a', botId: 'bot_a' });
  const types = res.files.map((f) => f.type).sort();
  assert.deepEqual(types, ['attachment', 'attachment', 'library', 'library', 'library', 'workspace']);
  assert.ok(res.files.every((f) => f.botId === 'bot_a'));
  assert.ok(!res.files.some((f) => f.filename.includes('bob-secret')), "another user's bot stays out of the list");
});

test('aggregateFiles matches search against the filename, case-insensitively', () => {
  const res = aggregateFiles({ userId: 'usr_a', botId: 'bot_a', search: 'REPORT' });
  assert.equal(res.total, 2, 'the library file and the message attachment that shares its name');
  assert.ok(res.files.every((f) => f.filename.toLowerCase().includes('report')));
  // A substring that matches nothing anywhere comes back empty rather than unfiltered.
  assert.equal(aggregateFiles({ userId: 'usr_a', search: 'no-such-file-anywhere' }).total, 0);
});

test('aggregateFiles sorts newest first and pages without losing or repeating items', () => {
  const first = aggregateFiles({ userId: 'usr_a', botId: 'bot_page', type: 'library', page: 1, pageSize: 5 });
  assert.equal(first.total, 10);
  assert.equal(first.files.length, 5);
  assert.deepEqual(first.files.map((f) => f.filename), ['file-10.txt', 'file-09.txt', 'file-08.txt', 'file-07.txt', 'file-06.txt']);

  const second = aggregateFiles({ userId: 'usr_a', botId: 'bot_page', type: 'library', page: 2, pageSize: 5 });
  assert.deepEqual(second.files.map((f) => f.filename), ['file-05.txt', 'file-04.txt', 'file-03.txt', 'file-02.txt', 'file-01.txt']);
  assert.equal(second.total, 10);
  assert.equal(second.page, 2);
  assert.equal(second.pageSize, 5);

  const past = aggregateFiles({ userId: 'usr_a', botId: 'bot_page', page: 3, pageSize: 5 });
  assert.deepEqual(past.files, []);
});

test('aggregateFiles caps pageSize and floors page', () => {
  const res = aggregateFiles({ userId: 'usr_a', botId: 'bot_page', page: 0, pageSize: 1000 });
  assert.equal(res.page, 1);
  assert.equal(res.pageSize, 200);
  assert.equal(aggregateFiles({ userId: 'usr_a', botId: 'bot_page', pageSize: 0 }).pageSize, 50);
});

test("aggregateFiles returns nothing for a bot the user does not own", () => {
  assert.deepEqual(aggregateFiles({ userId: 'usr_a', botId: 'bot_b' }), { files: [], total: 0, page: 1, pageSize: 50 });
});

// ---------- ids and the path guard ----------

test('fileIdFor and resolveFileId round-trip a library file', () => {
  const entry = listLibraryFiles('bot_a', 'Ada').find((f) => f.path === 'images/photo.png')!;
  assert.match(entry.id, /^[A-Za-z0-9_-]+$/, 'ids stay URL-safe');
  const resolved = resolveFileId(entry.id)!;
  assert.equal(resolved.kind, 'library');
  assert.equal(resolved.botId, 'bot_a');
  assert.equal(resolved.path, 'images/photo.png');
  assert.equal(resolved.filename, 'photo.png');
  assert.equal(resolved.mediaType, 'image/png');
  assert.equal(resolved.size, fs.statSync(resolved.file).size);
  assert.equal(fs.readFileSync(resolved.file, 'utf8'), 'png-bytes');
});

test('resolveFileId round-trips a workspace file as well', () => {
  const entry = listWorkspaceFiles('bot_a', 'Ada')[0];
  const resolved = resolveFileId(entry.id)!;
  assert.equal(resolved.kind, 'workspace');
  assert.equal(fs.readFileSync(resolved.file, 'utf8'), 'a,b');
});

test('a traversing path is rejected rather than resolved outside the root', () => {
  const escape = (p: string) => Buffer.from(JSON.stringify({ k: 'library', b: 'bot_a', p }), 'utf8').toString('base64url');
  for (const p of ['../secret', '../../../../etc/passwd', 'notes/../../secret', '/etc/passwd', '.']) {
    assert.equal(resolveFileId(escape(p)), null, `expected ${p} to be refused`);
  }
  // A file id crafted with a traversal path cannot be used to read the file that would answer to it.
  write(tmpRoot, 'secret.txt', 'do not read me');
  assert.equal(resolveFileId(escape('../secret.txt')), null);
  // A bot id is a plain token, so an id cannot name a path as the bot either.
  assert.equal(resolveFileId(Buffer.from(JSON.stringify({ k: 'library', b: '../usr_b', p: 'x.txt' }), 'utf8').toString('base64url')), null);
});

test('resolveFileId rejects junk and files that are not there', () => {
  assert.equal(resolveFileId('not-a-real-id'), null);
  assert.equal(resolveFileId(''), null);
  assert.equal(resolveFileId(Buffer.from('{"k":"library","b":"bot_a","p":"missing.txt"}', 'utf8').toString('base64url')), null);
  assert.equal(resolveFileId(Buffer.from(JSON.stringify({ k: 'nope', b: 'bot_a', p: 'x' }), 'utf8').toString('base64url')), null);
  assert.equal(fileIdFor({ kind: 'library', botId: 'bot_a', path: 'missing.txt' }).length > 0, true);
});

test('a symlink inside the Library that points outside it is not served', () => {
  const outside = write(tmpRoot, 'outside/leak.txt', 'leaked');
  fs.symlinkSync(outside, path.join(LIB, 'bot_a/link-to-outside.txt'));
  const entry = listLibraryFiles('bot_a', 'Ada').find((f) => f.path === 'link-to-outside.txt');
  assert.equal(entry, undefined, 'the walk skips it');
  assert.equal(resolveFileId(fileIdFor({ kind: 'library', botId: 'bot_a', path: 'link-to-outside.txt' })), null);
});

// ---------- the routes ----------

test('GET /files needs a signed-in user', async () => {
  const res = await filesApi.request('/');
  assert.equal(res.status, 401);
});

test('GET /files answers FilesResponse for the query the Files view sends', async () => {
  const res = await filesApi.request('/?botId=bot_a&type=library&page=1&pageSize=2', { headers: asAda });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.deepEqual(Object.keys(body).sort(), ['files', 'page', 'pageSize', 'total']);
  assert.equal(body.total, 3);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 2);
  assert.equal(body.files.length, 2);
});

test('GET /files filters by search, and by type=attachment', async () => {
  const searched = (await (await filesApi.request('/?search=todo', { headers: asAda })).json()) as any;
  assert.deepEqual(searched.files.map((f: any) => f.filename), ['todo.txt']);

  const attachments = (await (await filesApi.request('/?type=attachment&botId=bot_a', { headers: asAda })).json()) as any;
  assert.equal(attachments.total, 2);
  assert.ok(attachments.files.every((f: any) => f.type === 'attachment'));

  // The same list answers at /files, so the router works mounted at /api as well as at /api/files.
  const alias = (await (await filesApi.request('/files?botId=bot_page&type=library&pageSize=1', { headers: asAda })).json()) as any;
  assert.equal(alias.total, 10);
  assert.equal(alias.files.length, 1);
});

test('GET /files/:id/download streams the file with an inline type and its bytes', async () => {
  const image = listLibraryFiles('bot_a', 'Ada').find((f) => f.filename === 'photo.png')!;
  const res = await filesApi.request(`/${image.id}/download`, { headers: asAda });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition') ?? '', /^inline;/);
  assert.match(res.headers.get('content-disposition') ?? '', /filename\*=UTF-8''photo\.png$/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('utf8'), 'png-bytes');
});

test('GET /files/:id/download downloads what cannot preview', async () => {
  const csv = listWorkspaceFiles('bot_a', 'Ada')[0];
  const res = await filesApi.request(`/${csv.id}/download`, { headers: asAda });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment;/);
  await res.arrayBuffer();
});

test("GET /files/:id/download is 404 for another user's file and for a bad id", async () => {
  const bob = listLibraryFiles('bot_b', 'Bob')[0];
  assert.equal((await filesApi.request(`/${bob.id}/download`, { headers: asAda })).status, 404);
  assert.equal((await filesApi.request('/garbage/download', { headers: asAda })).status, 404);
  // Signed out, the download does not even look at the disk.
  assert.equal((await filesApi.request(`/${bob.id}/download`)).status, 401);
});
