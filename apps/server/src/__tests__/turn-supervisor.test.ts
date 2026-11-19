// api-env must be the FIRST import: it isolates env.ts, the DB and the Hermes homes.
import { cleanupTmpEnv } from './helpers/api-env.js';
import { primaryHome } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

/**
 * The turn supervisor end to end, against a stand-in gateway that plays a script: a provider
 * outage mid-turn is retried with what already ran, a refused sign-in is repaired, a bot that
 * loops is stopped and sent to reassess (visibly), a run that keeps looping goes to the person,
 * Stop and a new message cancel a waiting retry, and a restart picks up unfinished work.
 */

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
type Step = (res: http.ServerResponse) => void;

/** What the gateway does with each request, in order; the last repeats. Each request's input is kept. */
let script: Step[] = [];
const inputs: string[] = [];
const hermes = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'); return; }
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    inputs.push(String(JSON.parse(body).input ?? ''));
    const step = script[Math.min(inputs.length - 1, script.length - 1)];
    step(res);
  });
});
await new Promise<void>((resolve) => hermes.listen(0, '127.0.0.1', resolve));
const port = (hermes.address() as AddressInfo).port;
fs.writeFileSync(path.join(primaryHome, '.env'), 'API_SERVER_KEY=stand-in\n');

await import('../agent/loop.js');
const { currentTurnRunner, enqueue, interrupt, registerTurnRunner, resumeRuns, supervisorTiming } = await import('../core/turn-queue.js');
const { db } = await import('../db.js');
await import('../db-config.js');
(await import('../agent/subagents.js')).initSubagents();
(await import('../agent/rooms.js')).initRooms();
supervisorTiming.scale = 0.001;
// A real repair restarts the engine, which here would move the bot off the stand-in's port.
const repairs: string[] = [];
registerTurnRunner({ ...currentTurnRunner(), repair: async (_bot, what) => { repairs.push(what); } });

const USER = 'usr_supervisor';
const BOT = 'bot_supervised';
const NOW = 1_700_000_000_000;
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'sup@test.local', 'Sup', NOW);
db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(BOT, USER, 'Quill', 'primary', port, 1, NOW, NOW);

after(() => { hermes.close(); cleanupTmpEnv(); });
beforeEach(() => {
  inputs.length = 0;
  repairs.length = 0;
  db.prepare('DELETE FROM rows WHERE bot_id=?').run(BOT);
  db.prepare('DELETE FROM turn_runs').run();
});

// ---------- gateway steps ----------
const answer = (text: string): Step => (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse('response.output_text.delta', { type: 'response.output_text.delta', delta: text }));
  res.end(sse('response.completed', { type: 'response.completed' }));
};
let call = 0;
const toolCallRaw = (res: http.ServerResponse, name: string, args: unknown, output: string) => {
  const id = `call_${++call}`;
  res.write(sse('response.output_item.added', { type: 'response.output_item.added', item: { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) } }));
  res.write(sse('response.output_item.done', { type: 'response.output_item.done', item: { type: 'function_call_output', call_id: id, output } }));
};
const toolCall = (res: http.ServerResponse, name: string, args: unknown, output: unknown) => toolCallRaw(res, name, args, JSON.stringify(output));
/** One tool call that works, then the provider fails mid-turn. */
const failsMidTurn = (message: string): Step => (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  toolCall(res, 'terminal', { command: 'ls' }, { output: 'notes.md' });
  res.end(sse('response.failed', { type: 'response.failed', response: { error: { message } } }));
};
const refused = (status: number, message: string): Step => (res) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message } })); };
/**
 * The same failing call, over and over, until Orbit hangs up, with the result as Hermes sends it:
 * the command's JSON, then from the second repeat its loop warning and note, whose count changes
 * every time (the shape recorded from a live Haiku bot).
 */
const loops: Step = (res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let n = 0;
  const tick = () => {
    if (res.destroyed || res.writableEnded) return;
    n++;
    const result = '{"output": "cat: /missing.txt: No such file or directory", "exit_code": 1, "error": null}'
      + (n < 2 ? '' : `\n\n[Tool loop warning: repeated_exact_failure_warning; count=${n}; terminal has failed ${n} times with identical arguments.]\n\n[hermes note: this is the ${n}th consecutive identical call to terminal.]`);
    toolCallRaw(res, 'terminal', { command: 'cat /missing.txt' }, result);
    setTimeout(tick, 5);
  };
  res.on('close', () => res.destroyed || res.end());
  tick();
};

// ---------- helpers ----------
type Row = { kind: string; body: Record<string, any> };
const rows = (): Row[] => (db.prepare('SELECT kind, body FROM rows WHERE bot_id=? ORDER BY seq').all(BOT) as { kind: string; body: string }[]).map((r) => ({ kind: r.kind, body: JSON.parse(r.body) }));
const notices = () => rows().filter((r) => r.kind === 'notice').map((r) => `${r.body.kind ?? '-'}: ${r.body.text}`);
const messages = () => rows().filter((r) => r.kind === 'message' && r.body.role === 'assistant').map((r) => r.body.text);
const run = () => db.prepare('SELECT state, run_state, last_error FROM turn_runs ORDER BY created_at DESC LIMIT 1').get() as { state: string; run_state: string; last_error: string | null };
async function until(cond: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}. notices: ${JSON.stringify(notices())}; run: ${JSON.stringify(run())}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a provider outage mid-turn is retried, and the retry is told what already ran', async () => {
  script = [failsMidTurn('Error code: 529 - Overloaded'), failsMidTurn('Error code: 529 - Overloaded'), answer('Report done.')];
  enqueue(BOT, { type: 'user', text: 'Write the weekly report' });
  await until(() => run()?.state === 'done', 'the run to finish');

  assert.equal(inputs.length, 3);
  assert.match(inputs[1], /^\[System notice\] Your previous attempt at this request stopped because the model provider is not answering right now\./);
  assert.match(inputs[1], /- terminal: ran/);
  assert.match(inputs[1], /The request was:\nWrite the weekly report$/);
  assert.deepEqual(notices(), [
    'retrying: Quill paused because the model provider is not answering right now. Trying again in 15 s.',
    'retrying: Quill paused because the model provider is not answering right now. Trying again in 45 s.',
  ]);
  assert.deepEqual(messages(), ['Report done.']);
  assert.equal(JSON.parse(run().run_state).retries, 2);
});

test('a refused sign-in is repaired and retried once, then handed to the person', async () => {
  script = [refused(401, 'No Anthropic credentials found'), answer('Back.')];
  enqueue(BOT, { type: 'user', text: 'Hello' });
  await until(() => run()?.state === 'done', 'the repaired run to finish');
  assert.match(inputs[1], /stopped because its model sign-in was refused/);
  assert.deepEqual(notices(), ['retrying: Quill stopped because its model sign-in was refused. Refreshing its sign-in and trying again.']);
  assert.deepEqual(repairs, ['auth']);

  inputs.length = 0;
  db.prepare('DELETE FROM rows WHERE bot_id=?').run(BOT);
  script = [refused(401, 'No Anthropic credentials found')];
  enqueue(BOT, { type: 'user', text: 'Hello again' });
  await until(() => run()?.state === 'failed', 'the run to give up');
  assert.equal(inputs.length, 2, 'one repair, one retry, no more');
  assert.match(notices().at(-1)!, /^gave-up: Quill stopped because its model sign-in was refused, again after refreshing it\. Sign the primary agent in again under Settings → Engine Auth/);
});

test('an agent that dies mid-turn (the stream is cut) is restarted and the work continues', async () => {
  const dies: Step = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    toolCall(res, 'terminal', { command: 'echo step-one' }, { output: 'step-one', exit_code: 0 });
    setTimeout(() => res.socket?.destroy(), 20);
  };
  script = [dies, answer('step-one step-two')];
  enqueue(BOT, { type: 'user', text: 'Run the two steps' });
  await until(() => run()?.state === 'done', 'the run to recover');
  assert.deepEqual(repairs, ['gateway']);
  assert.deepEqual(notices(), ['retrying: Quill stopped because its agent stopped responding. Restarting it and trying again.']);
  assert.match(inputs[1], /- terminal: ran/);
});

test('a conversation Hermes fenced after losing a turn is cleared and the work continues', async () => {
  script = [refused(409, 'unknown_execution'), answer('Carrying on.')];
  enqueue(BOT, { type: 'user', text: 'Continue' });
  await until(() => run()?.state === 'done', 'the run to recover');
  assert.deepEqual(repairs, ['discard']);
  assert.deepEqual(notices(), ['retrying: Quill stopped because its agent lost the turn it was on when it restarted. Clearing it and continuing.']);
});

test('a turn whose agent goes silent on a tool call is stopped, its agent restarted, and retried', async () => {
  // What a wedged terminal call looked like live: the call starts, then nothing, forever.
  const silent: Step = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('response.output_item.added', { type: 'response.output_item.added', item: { type: 'function_call', name: 'terminal', call_id: 'call_hang', arguments: '{"command":"sleep 25; echo step-one"}' } }));
  };
  script = [silent, answer('step-one step-two')];
  enqueue(BOT, { type: 'user', text: 'Run the two steps' });
  await until(() => run()?.state === 'done', 'the stalled run to recover');
  assert.deepEqual(repairs, ['gateway']);
  assert.deepEqual(notices(), ['retrying: Quill stopped because its agent stopped responding. Restarting it and trying again.']);
  assert.equal(rows().find((r) => r.kind === 'tool-call')?.body.summary, 'Never returned');
  assert.match(inputs[1], /stopped because its agent stopped responding/);
  assert.deepEqual(messages(), ['step-one step-two']);
});

test('a model that does not exist, or an empty account, is not retried', async () => {
  script = [refused(404, 'model: claude-nope not found')];
  enqueue(BOT, { type: 'user', text: 'Hi' });
  await until(() => run()?.state === 'failed', 'the run to give up');
  assert.equal(inputs.length, 1);
  assert.match(notices()[0], /^gave-up: Quill stopped because its model is not available .* Pick another model/);
});

test('a bot looping on a failing call is stopped and sent to reassess, and says so in the chat', async () => {
  script = [loops, answer("I was stuck on reading /missing.txt, so I'm listing the folder instead.")];
  enqueue(BOT, { type: 'user', text: 'Summarise /missing.txt' });
  await until(() => run()?.state === 'done', 'the reassessed run to finish');

  const stuck = rows().filter((r) => r.kind === 'tool-call');
  assert.equal(stuck.length, 3, 'stopped on the third identical failure, one past Hermes\'s warning');
  assert.match(inputs[1], /^\[System notice\] You were stuck: terminal failed 3 times with the same arguments: Exit code 1: cat: \/missing\.txt: No such file or directory\. Do not call terminal again with those arguments\./);
  assert.match(inputs[1], /Start your reply with one short line telling the user what you were stuck on/);
  assert.deepEqual(notices(), ['reassessing: Quill was stuck: terminal failed 3 times with the same arguments: Exit code 1: cat: /missing.txt: No such file or directory. Asked it to step back and try another way.']);
  assert.deepEqual(messages(), ["I was stuck on reading /missing.txt, so I'm listing the folder instead."]);
});

test('a bot still looping after two reassessments stops and leaves it to the person', async () => {
  script = [loops];
  enqueue(BOT, { type: 'user', text: 'Summarise /missing.txt' });
  await until(() => run()?.state === 'failed', 'the run to give up', 15_000);
  assert.equal(inputs.length, 3, 'the first attempt and two reassessments');
  assert.deepEqual(notices().map((n) => n.split(':')[0]), ['reassessing', 'reassessing', 'gave-up']);
  assert.match(notices()[2], /still stuck after trying another way 2 times: terminal failed 3 times/);
});

test('Stop cancels a waiting retry, and so does a new message from the person', async () => {
  supervisorTiming.scale = 1;
  try {
    script = [failsMidTurn('Error code: 529 - Overloaded'), answer('ok')];
    enqueue(BOT, { type: 'user', text: 'First' });
    await until(() => run()?.state === 'retry_wait', 'the retry to be scheduled');
    interrupt(BOT);
    assert.equal(run().state, 'stopped');

    inputs.length = 0;
    script = [failsMidTurn('Error code: 529 - Overloaded'), answer('ok')];
    enqueue(BOT, { type: 'user', text: 'Second' });
    await until(() => (db.prepare("SELECT COUNT(*) n FROM turn_runs WHERE state='retry_wait'").get() as { n: number }).n === 1, 'the retry to be scheduled');
    script = [answer('On it.')];
    enqueue(BOT, { type: 'user', text: 'Never mind, do this' });
    await until(() => messages().includes('On it.'), 'the new message to be answered');
    assert.equal((db.prepare("SELECT COUNT(*) n FROM turn_runs WHERE state='retry_wait'").get() as { n: number }).n, 0);
    assert.ok(notices().includes('gave-up: Stopped retrying the earlier request: you sent a new message.'));
  } finally {
    supervisorTiming.scale = 0.001;
  }
});

test('after a restart, a run that was in flight carries on, and a stale one is reported', async () => {
  const at = Date.now();
  db.prepare("INSERT INTO turn_runs(id,bot_id,root,state,run_state,created_at,updated_at) VALUES ('run_live',?,?,'running','{\"retries\":0,\"reassessments\":0,\"firstFailureAt\":null,\"authRepaired\":false,\"gatewayRestarted\":false}',?,?)")
    .run(BOT, JSON.stringify({ type: 'routine', routineId: 'rtn_x', name: 'Morning brief', prompt: 'Brief me' }), at, at);
  db.prepare("INSERT INTO turn_runs(id,bot_id,root,state,run_state,created_at,updated_at) VALUES ('run_old',?,?,'running','{}',?,?)")
    .run(BOT, JSON.stringify({ type: 'user', text: 'old' }), at - 3_600_000, at - 3_600_000);
  script = [answer('Here is your brief.')];
  const { appendRow, settleOrphanToolRows } = await import('../store.js');
  appendRow(BOT, 'tool-call', { type: 'tool-call', callId: 'call_dead', name: 'terminal', label: 'Running a command', status: 'running' });

  assert.equal(settleOrphanToolRows(), 1, 'the call the crash cut off is closed');
  assert.deepEqual([rows().find((r) => r.body.callId === 'call_dead')?.body.status, rows().find((r) => r.body.callId === 'call_dead')?.body.summary], ['error', 'Interrupted by a restart']);
  assert.equal(resumeRuns(), 1);
  await until(() => (db.prepare("SELECT state FROM turn_runs WHERE id='run_live'").get() as { state: string }).state === 'done', 'the resumed run');
  assert.match(inputs[0], /^\[System notice\] The team app restarted while you were working on this request\. Continue the task\./);
  assert.match(inputs[0], /Routine "Morning brief"/);
  assert.equal((db.prepare("SELECT state FROM turn_runs WHERE id='run_old'").get() as { state: string }).state, 'failed');
  assert.match(notices()[0], /^gave-up: Quill was interrupted by a restart and it was too long ago to pick up again/);
});
