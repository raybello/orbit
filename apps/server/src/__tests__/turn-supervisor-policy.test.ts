import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure, errorText } from '../domain/turn-failure.js';
import { checkLoop, DEFAULT_LIMITS, toolResultText, type ToolEvent } from '../domain/tool-loop.js';
import { BACKOFF_MS, MAX_REASSESS, RETRY_WINDOW_MS, freshRun, nextStep, reassessInput, retryInput, type RunState } from '../domain/supervisor-policy.js';

/** The supervisor's rules, from the error text a gateway really sends to what happens next. */

test('failures are classified from the text gateways really send', () => {
  const cases: [string, number | undefined, string][] = [
    ['No Anthropic credentials found. Run hermes login or set ANTHROPIC_API_KEY.', undefined, 'auth'],
    ['Error code: 429 - {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', undefined, 'transient'],
    ['Error code: 529 - Overloaded', undefined, 'transient'],
    ['upstream 503 Service Unavailable', 503, 'transient'],
    ['model: claude-sonnet-4-5-20250929 not found', undefined, 'model'],
    ['{"error":{"type":"not_found_error","message":"model: claude-x"}}', 404, 'model'],
    ['Your credit balance is too low to access the Anthropic API.', 400, 'billing'],
    ['You exceeded your current quota, please check your plan and billing details.', 429, 'billing'],
    ['prompt is too long: 210000 tokens > 200000 maximum', 400, 'context'],
    ['fetch failed', undefined, 'gateway'],
    ['connect ECONNREFUSED 127.0.0.1:8650', undefined, 'gateway'],
    ['invalid x-api-key', 401, 'auth'],
    ['Something strange happened', undefined, 'fatal'],
  ];
  for (const [message, status, kind] of cases) assert.equal(classifyFailure(message, status).kind, kind, message);
});

const ev = (name: string, args: string, ok: boolean, output = 'x', error?: string): ToolEvent => ({ name, args, ok, output, ...(error ? { error } : {}) });

test('a loop trips one step past Hermes\'s own warning, and not on honest work', () => {
  const fail = ev('terminal', '{"command":"cat /nope"}', false, 'e', 'No such file');
  assert.equal(checkLoop([fail, fail]), null, 'Hermes warns at two; the bot gets that chance');
  assert.deepEqual(checkLoop([fail, ev('terminal', '{"command":"ls"}', true), fail, fail]), { rule: 'same-call-failed', tool: 'terminal', count: 3, error: 'No such file' });

  const different = ['a', 'b', 'c', 'd'].map((x) => ev('terminal', `{"command":"${x}"}`, false));
  assert.equal(checkLoop(different.slice(0, 3)), null);
  assert.equal(checkLoop(different)?.rule, 'consecutive-failures');

  const read = ev('read_file', '{"path":"a"}', true, 'same');
  assert.equal(checkLoop([read, read]), null);
  assert.deepEqual(checkLoop([read, read, read]), { rule: 'no-progress', tool: 'read_file', count: 3 });
  assert.equal(checkLoop([read, read, ev('read_file', '{"path":"a"}', true, 'changed')]), null, 'a changed result is progress');
  const shot = ev('computer_screenshot', '{}', true, 'same');
  assert.equal(checkLoop([shot, shot, shot, shot]), null, 'looking again at a screen is not a loop');

  const busy = Array.from({ length: DEFAULT_LIMITS.maxToolCalls + 1 }, (_, i) => ev('terminal', `{"i":${i}}`, true, String(i)));
  assert.equal(checkLoop(busy)?.rule, 'step-budget');
  assert.equal(checkLoop(busy.slice(0, -1)), null);
});

const failed = (message: string, status?: number) => ({ ok: false as const, failure: classifyFailure(message, status), events: [] });

test('a provider outage is retried with backoff for at most twenty minutes from its first failure', () => {
  let run: RunState = freshRun();
  let now = 1_000_000;
  const waits: number[] = [];
  for (;;) {
    const next = nextStep(run, failed('Error code: 529 - Overloaded'), now, 'Quill');
    if (next.do !== 'retry') { assert.equal(next.do, 'give-up'); assert.match(next.notice, /^Quill stopped because the model provider is not answering right now, and it still was after \d+ min/); break; }
    waits.push(next.afterMs);
    assert.match(next.notice, /^Quill paused because the model provider is not answering right now\. Trying again in /);
    run = next.state;
    now += next.afterMs;
  }
  assert.deepEqual(waits.slice(0, 5), [...BACKOFF_MS]);
  assert.ok(now - 1_000_000 <= RETRY_WINDOW_MS, 'no attempt is scheduled past the window');
  assert.ok(waits.reduce((a, b) => a + b, 0) >= RETRY_WINDOW_MS - BACKOFF_MS.at(-1)!, 'the window is used, not given up early');
});

test('a refused sign-in or a dead gateway is repaired once, then handled as itself', () => {
  const auth = nextStep(freshRun(), failed('No Anthropic credentials found'), 0);
  assert.deepEqual([auth.do, auth.do === 'retry' && auth.repair, auth.do === 'retry' && auth.afterMs], ['retry', 'auth', 0]);
  const again = nextStep((auth as { state: RunState }).state, failed('No Anthropic credentials found'), 1);
  assert.equal(again.do, 'give-up');
  assert.match((again as { notice: string }).notice, /Settings → Engine Auth/);

  const gw = nextStep(freshRun(), failed('fetch failed'), 0);
  assert.equal(gw.do === 'retry' && gw.repair, 'gateway');
  const gw2 = nextStep((gw as { state: RunState }).state, failed('fetch failed'), 1);
  assert.equal(gw2.do === 'retry' && gw2.repair, undefined, 'a second gateway failure backs off like an outage');

  for (const [message, status, hint] of [['model: x not found', 404, /another model/], ['prompt is too long', 400, /new chat/], ['Your credit balance is too low', 400, /credit/], ['weird', undefined, /stopped: weird/]] as const) {
    const n = nextStep(freshRun(), failed(message, status), 0);
    assert.equal(n.do, 'give-up', message);
    assert.match((n as { notice: string }).notice, hint);
  }
});

test('a stuck bot is sent to reassess twice, then the person is asked', () => {
  const trip = { ok: false as const, trip: { rule: 'same-call-failed' as const, tool: 'terminal', count: 3, error: 'No such file' }, events: [] };
  let run = freshRun();
  for (let i = 0; i < MAX_REASSESS; i++) {
    const n = nextStep(run, trip, 0, 'Quill');
    assert.equal(n.do, 'reassess');
    assert.equal((n as { notice: string }).notice, 'Quill was stuck: terminal failed the same way 3 times with nothing changed in between: No such file. Asked it to step back and try another way.');
    run = (n as { state: RunState }).state;
  }
  const last = nextStep(run, trip, 0, 'Quill');
  assert.equal(last.do, 'give-up');
  assert.match((last as { notice: string }).notice, /still stuck after trying another way 2 times/);
  assert.equal(nextStep(run, { ok: true }, 0).do, 'done');
  assert.equal(nextStep(run, { ok: false, stopped: true }, 0).do, 'stopped');
});

test('fixing a build between runs is iteration, not a loop', () => {
  // Recorded from Atlas on the desktop stack: make ran three times, failing differently each time,
  // with a package installed or the Makefile patched in between. The old rule tripped on the third.
  const make = '{"command":"cd /data/engines/primary/workspace/riscv-demo && make 2>&1"}';
  const live = [
    ev('terminal', make, false, 'h127', 'Exit code 127: /usr/bin/bash: line 7: make: command not found'),
    ev('terminal', '{"command":"apt-get install -y make 2>&1 | tail -3"}', true),
    ev('terminal', '{"command":"apt-get update -q && apt-get install -y make","timeout":120}', true),
    ev('terminal', make, false, 'h255', 'Exit code 2: make: *** [Makefile:14: main.elf] Error 255'),
    ev('terminal', '{"command":"apt-get install -y gcc-riscv64-unknown-elf qemu-system-misc","timeout":120}', true),
    ev('patch', '{"path":"riscv-demo/Makefile","old_string":"CC = /opt/riscv/bin/gcc","new_string":"CC = riscv64-unknown-elf-gcc"}', true),
    ev('terminal', make, false, 'h1', 'Exit code 2: make: *** [Makefile:15: main.elf] Error 1'),
  ];
  for (let i = 1; i <= live.length; i++) assert.equal(checkLoop(live.slice(0, i)), null, `no trip after call ${i}`);

  const sameError = (out: string) => ev('terminal', make, false, out, 'Exit code 2: make: *** [Makefile:15: main.elf] Error 1');
  const edit = ev('patch', '{"path":"Makefile","old_string":"a","new_string":"b"}', true);
  assert.equal(checkLoop([sameError('h1'), edit, sameError('h1'), edit, sameError('h1')]), null, 'each run after an edit tests new code');
  assert.equal(checkLoop([sameError('h1'), sameError('h2'), sameError('h3')]), null, 'a different result is a different failure');
  assert.deepEqual(
    checkLoop([sameError('h1'), ev('read_file', '{"path":"Makefile"}', true), sameError('h1'), sameError('h1')]),
    { rule: 'same-call-failed', tool: 'terminal', count: 3, error: 'Exit code 2: make: *** [Makefile:15: main.elf] Error 1' },
    'reading a file changes nothing, so three identical failures still trip',
  );
  assert.deepEqual(checkLoop([sameError('h1'), edit, sameError('h1'), sameError('h1'), sameError('h1')])?.count, 3, 'the count restarts at the edit');
});

test('the continuation messages carry the request, what already ran, and the visible first line', () => {
  const events = [ev('GMAIL_CREATE_EMAIL_DRAFT', '{}', true), ev('terminal', '{}', false, 'e', 'exit 1')];
  const r = retryInput('Draft the Monday email', 'the model provider is rate limiting', events);
  assert.match(r, /stopped because the model provider is rate limiting/);
  assert.match(r, /- GMAIL_CREATE_EMAIL_DRAFT: ran\n- terminal: failed \(exit 1\)/);
  assert.match(r, /before you repeat anything that sends, creates or changes something/);
  assert.match(r, /The request was:\nDraft the Monday email$/);
  const a = reassessInput('Read the notes', { rule: 'same-call-failed', tool: 'terminal', count: 3 }, events);
  assert.match(a, /Running it again unchanged will fail the same way\. Find out why it failed first/);
  assert.doesNotMatch(a, /Do not call/, 'the bot may run the command again once it has fixed the cause');
  assert.match(a, /"I was stuck on X, so I'm trying Y\."/);
});

test("Hermes's loop notes are stripped from a tool result, so a repeat reads as the same failure", () => {
  // Recorded from a live Haiku bot on the dev stack: the 27th identical failing call.
  const live = '{"output": "cat: /tmp/orbit-report-7731.txt: No such file or directory", "exit_code": 1, "error": null}\n\n[Tool loop warning: repeated_exact_failure_warning; count=27; terminal has failed 27 times with identical arguments. This looks like a loop; inspect the error and change strategy instead of retrying it unchanged.]\n\n[hermes note: this is the 27th consecutive identical call to terminal with identical arguments returning the same result. Do not repeat it — change arguments, use a different tool, or proceed with what you have.]';
  assert.equal(toolResultText(live), '{"output": "cat: /tmp/orbit-report-7731.txt: No such file or directory", "exit_code": 1, "error": null}');
  assert.equal(toolResultText(live.replace(/27/g, '28')), toolResultText(live), 'the count is gone, so the 27th and 28th compare equal');
  assert.equal(toolResultText('plain output'), 'plain output');
  assert.equal(toolResultText('see [hermes notes] in the docs'), 'see [hermes notes] in the docs', 'only a trailing note is a note');
});

test('a stream dropped by a dead agent is read through its cause, as Node reports it', () => {
  // What Node's fetch threw live when the bot's gateway was killed mid-turn.
  const dropped = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(errorText(dropped), 'terminated: other side closed: UND_ERR_SOCKET');
  assert.equal(classifyFailure(errorText(dropped)).kind, 'gateway');
  assert.equal(classifyFailure('terminated').kind, 'fatal', 'the bare word alone says nothing about why');
  assert.equal(errorText('plain'), 'plain');
});

test("a turn Hermes lost in a restart is cleared once, never retried blind", () => {
  // The body Hermes's API server answered with, live, after its gateway was killed mid-turn.
  const lost = classifyFailure('{"error": {"message": "unknown_execution", "type": "invalid_request_error", "param": null, "code": "unknown_execution"}}', 409);
  assert.equal(lost.kind, 'lost-turn', 'the text wins over the 409, which would otherwise read as transient');
  const first = nextStep(freshRun(), { ok: false, failure: lost, events: [] }, 0, 'Quill');
  assert.deepEqual([first.do, first.do === 'retry' && first.repair, first.do === 'retry' && first.afterMs], ['retry', 'discard', 0]);
  assert.equal((first as { notice: string }).notice, 'Quill stopped because its agent lost the turn it was on when it restarted. Clearing it and continuing.');
  assert.equal(nextStep((first as { state: RunState }).state, { ok: false, failure: lost, events: [] }, 1).do, 'give-up');
  const gw = nextStep(freshRun(), { ok: false, failure: classifyFailure('terminated: other side closed: UND_ERR_SOCKET'), events: [] }, 0);
  assert.equal((gw as { state: RunState }).state.turnsDiscarded, true, 'a restart repair clears the lost turn as part of it');
});
