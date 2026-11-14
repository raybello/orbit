export {};
/**
 * Acceptance run for per-Bot computers: DeepSeek by default, the Bot really driving its desktop, and
 * a person taking control / handing it back — all verified by a shell command typed into a terminal
 * window on the Bot's screen (not by trusting a tool's own report).
 *
 *   BASE=http://127.0.0.1:8787 EMAIL=you@example.com npx tsx --env-file=../.env scripts/e2e-control.ts
 */
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const base = process.env.BASE ?? 'http://127.0.0.1:8787';
const email = process.env.EMAIL;
if (!email) throw new Error('EMAIL is required');
const dbPath = process.env.DB_PATH ?? '../data/grokbot.db';
let cookie = '';
let failures = 0;
const ok = (n: string, d = '') => console.log(`PASS  ${n}${d ? ` — ${d}` : ''}`);
const bad = (n: string, d: string) => { failures++; console.log(`FAIL  ${n} — ${d}`); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, init: any = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return res;
}

const mcpToken = (botId: string) => crypto.createHmac('sha256', process.env.SESSION_SECRET ?? '').update(`mcp:${botId}`).digest('hex');

async function mcp(botId: string, tool: string, args: any) {
  const res = await fetch(`${base}/mcp/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcpToken(botId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? raw;
  const json = JSON.parse(line);
  return { text: json?.result?.content?.[0]?.text ?? JSON.stringify(json).slice(0, 400), error: Boolean(json?.result?.isError) };
}

/** Minimal RFB client: handshake plus real pointer and key events. */
class Rfb {
  private ws: any;
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void }[] = [];
  constructor(ws: any) { this.ws = ws; ws.on('message', (d: Buffer) => this.feed(Buffer.from(d))); }
  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve) => { this.waiters.push({ n, resolve }); this.feed(Buffer.alloc(0)); });
  }
  static async open(botId: string, mode: 'watch' | 'control'): Promise<Rfb> {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://${base.replace(/^http:\/\//, '')}/api/bots/${botId}/screen?mode=${mode}`, ['binary'], { headers: { cookie } });
    const rfb = new Rfb(ws);
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the screen did not answer within 240s')), 240_000);
      ws.once('open', () => { clearTimeout(timer); res(); });
      ws.once('error', (e: Error) => { clearTimeout(timer); rej(e); });
      ws.once('close', (code: number) => { clearTimeout(timer); rej(new Error(`relay closed the connection (${code})`)); });
    });
    await rfb.read(12);
    ws.send(Buffer.from('RFB 003.008\n'));
    await rfb.read(2);
    ws.send(Buffer.from([1]));
    await rfb.read(4);
    ws.send(Buffer.from([1]));
    const head = await rfb.read(24);
    await rfb.read(head.readUInt32BE(20));
    return rfb;
  }
  click(x: number, y: number) { this.ws.send(Buffer.from([5, 1, 0, 0, x >> 8, x & 255, y >> 8, y & 255])); }
  key(keysym: number, down: boolean) {
    const b = Buffer.alloc(8);
    b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym, 4);
    this.ws.send(b);
  }
  async type(text: string) {
    for (const ch of text) {
      const keysym = ch === '\n' ? 0xff0d : ch.charCodeAt(0);
      this.key(keysym, true); await wait(25);
      this.key(keysym, false); await wait(25);
    }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const rowsOf = async (botId: string) => ((await (await call(`/api/bots/${botId}/rows?limit=200`)).json()) as any).rows as any[];
const answerOf = (rows: any[]) => [...rows].reverse().find((r) => r.body?.role === 'assistant' && r.body?.text)?.body?.text ?? '';

async function send(botId: string, text: string) {
  const posted = await call(`/api/bots/${botId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
  const sent = (await posted.json()).row as any;
  const lastSeq = Number(sent?.seq ?? 0);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const rows = await rowsOf(botId);
    const fresh = rows.filter((r) => Number(r.seq ?? 0) > lastSeq);
    const answer = [...fresh].reverse().find((r) => r.body?.role === 'assistant' && r.body?.text);
    if (answer) return { rows, text: answer.body.text };
    await wait(2500);
  }
  return { rows: await rowsOf(botId), text: '' };
}

// ---------------------------------------------------------------- the run

const login = await call('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email }) });
if (login.status !== 200) { bad('sign in', String(login.status)); process.exit(1); }

const { bot } = await (await call('/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Control Test', avatarColor: 'magenta' }) })).json();
const engine = (await (await call(`/api/bots/${bot.id}/engine`)).json()).engine;
if (engine?.model === 'deepseek-flash' && engine?.provider === 'deepseek') ok('default model', `${engine.provider}/${engine.model}`);
else bad('default model', JSON.stringify({ model: engine?.model, provider: engine?.provider }));

const watch = process.env.NOWATCH === '1' ? null : await Rfb.open(bot.id, 'watch');
ok(`screen relay${watch ? '' : ' (control only)'}`);

// A terminal on the Bot's screen: keyboard input shows up in a file, which nothing can fake.
const shell = async (command: string) => (await mcp(bot.id, 'computer_shell', { command })).text;
const fileText = async (file: string) => {
  const out = await shell(`cat ${file} 2>/dev/null || echo __MISSING__`);
  return /__MISSING__/.test(out) ? null : out.split('\n')[0].trim();
};
const focusTerminal = async () => shell(
  // xdotool only: a window manager may not be up yet, and wmctrl needs one. Activate the terminal,
  // click inside it so it really holds the keyboard, and report which window has focus.
  'if ! xdotool search --name PROBE >/dev/null 2>&1; then nohup xfce4-terminal --disable-server --title=PROBE --geometry=100x24 >/dev/null 2>&1 & sleep 4; fi; ' +
  'id=$(xdotool search --name PROBE | head -1); ' +
  'xdotool windowfocus --sync $id 2>/dev/null || true; ' +
  'eval $(xdotool getwindowgeometry --shell $id); ' +
  'xdotool mousemove --sync $((X + WIDTH / 2)) $((Y + HEIGHT / 2)) click 1; sleep 0.3; ' +
  'xdotool getwindowfocus getwindowname',
);
const opened = await focusTerminal();
if (/PROBE/.test(opened)) ok('terminal opened and focused on the Bot screen', opened); else bad('terminal opened and focused on the Bot screen', opened.slice(0, 200));

// 1. the Bot answers on DeepSeek
const pong = await send(bot.id, 'Reply with exactly: PONG');
if (/\bPONG\b/i.test(pong.text)) ok('DeepSeek turn', JSON.stringify(pong.text.slice(0, 80)));
else bad('DeepSeek turn', JSON.stringify(pong.text.slice(0, 200)));

// 2. the Bot uses its computer through the app's tools
const winTurn = await send(bot.id, 'Use the computer_windows tool now, then reply with just the number of windows you saw.');
if (JSON.stringify(await rowsOf(bot.id)).includes('computer_windows')) ok('bot used computer_windows', JSON.stringify(winTurn.text.slice(0, 60)));
else bad('bot used computer_windows', 'no computer_windows call in the conversation');

const shellTurn = await send(bot.id, 'Use the computer_shell tool to run "uname -s; echo DISPLAY=$DISPLAY", then reply with exactly what it printed.');
if (/Linux/i.test(shellTurn.text)) ok('bot used computer_shell', JSON.stringify(shellTurn.text.slice(0, 100)));
else bad('bot used computer_shell', JSON.stringify(shellTurn.text.slice(0, 200)));

// 3. the typing tool really reaches the screen
await shell('rm -f /home/bot/tool-typed.txt');
await focusTerminal();
await mcp(bot.id, 'computer_type', { text: 'echo tool-typed > /home/bot/tool-typed.txt' });
await mcp(bot.id, 'computer_key', { key: 'Return' });
await wait(1500);
const toolTyped = await fileText('/home/bot/tool-typed.txt');
if (toolTyped === 'tool-typed') ok('computer_type + computer_key reach the screen', toolTyped);
else bad('computer_type + computer_key reach the screen', String(toolTyped));

// 4. the screenshot tool lands in the Library
const shot = await mcp(bot.id, 'computer_screenshot', {});
const shotName = /screenshots\/([\w.-]+)/.exec(shot.text)?.[1];
const files = (await (await call(`/api/bots/${bot.id}/files?path=screenshots`)).json()) as any;
const raw = shotName ? await call(`/api/bots/${bot.id}/files/raw?path=${encodeURIComponent(`screenshots/${shotName}`)}`) : null;
if (shotName && files.files?.some((f: any) => f.name === shotName) && raw?.status === 200) ok('computer_screenshot lands in the Library', shotName);
else bad('computer_screenshot lands in the Library', JSON.stringify({ shot: shot.text.slice(0, 100), files: files.files?.map((f: any) => f.name), raw: raw?.status }));

// 5. watching is view-only: the same keystrokes must change nothing
if (watch) {
  await shell('rm -f /home/bot/watch-typed.txt');
  await wait(300);
  await watch.type('echo watch-typed > /home/bot/watch-typed.txt\n');
  await wait(2000);
  const watchTyped = await fileText('/home/bot/watch-typed.txt');
  if (watchTyped === null) ok('watch mode drops keystrokes');
  else bad('watch mode drops keystrokes', String(watchTyped));
}

// 6. a person takes control: the same keystrokes now reach the screen
// The app closes the watch socket when the user takes control, so this does too.
watch?.close();
await wait(1000);
const take = await call(`/api/bots/${bot.id}/screen/control`, { method: 'POST', body: JSON.stringify({ action: 'take' }) });
const takeBody = await take.json();
const control = await Rfb.open(bot.id, 'control');
await wait(800);
await shell('rm -f /home/bot/control-typed.txt');
await wait(1500);
await control.type('echo control-typed > /home/bot/control-typed.txt\n');
await wait(3000);
let controlTyped = await fileText('/home/bot/control-typed.txt');
if (controlTyped === null) {
  // A terminal opened moments ago may still be starting its shell; one retry covers it.
  await control.type('echo control-typed > /home/bot/control-typed.txt\n');
  await wait(3000);
  controlTyped = await fileText('/home/bot/control-typed.txt');
}
const focusNow = await shell('xdotool getwindowfocus getwindowname 2>&1; xdotool getactivewindow getwindowname 2>&1');
const tokenAfterTake = execSync(`sqlite3 ${dbPath} "select coalesce(control_token,'NULL') from computer_screens where bot_id='${bot.id}'"`).toString().trim();
if (takeBody?.control === 'human' && controlTyped === 'control-typed' && tokenAfterTake === 'NULL') {
  ok('person took control', `typed "${controlTyped}" over VNC`);
} else bad('person took control', JSON.stringify({ take: takeBody, controlTyped, token: tokenAfterTake, focusNow: focusNow.slice(0, 160) }));

// 7. handing it back: control token returns, and a fresh control viewer still types
control.close();
await wait(1200);
const give = await call(`/api/bots/${bot.id}/screen/control`, { method: 'POST', body: JSON.stringify({ action: 'give' }) });
const giveBody = await give.json();
const tokenAfterGive = execSync(`sqlite3 ${dbPath} "select coalesce(control_token,'NULL') from computer_screens where bot_id='${bot.id}'"`).toString().trim();
await shell('rm -f /home/bot/after-give.txt');
await wait(500);
const late = await Rfb.open(bot.id, 'control');
await wait(1000);
await late.type('echo after-give > /home/bot/after-give.txt\n');
await wait(1500);
late.close();
const afterGiveFile = await fileText('/home/bot/after-give.txt');
if (giveBody?.control === 'bot' && tokenAfterGive !== 'NULL' && afterGiveFile === 'after-give') {
  ok('control handed back', `token=${tokenAfterGive.slice(0, 8)}…, a fresh control viewer still types`);
} else bad('control handed back', JSON.stringify({ give: giveBody, token: tokenAfterGive, afterGiveFile }));

const del = await call(`/api/bots/${bot.id}`, { method: 'DELETE' });
if (del.status === 200) ok('delete bot'); else bad('delete bot', String(del.status));

console.log(failures ? `\n${failures} step(s) failed` : '\nALL STEPS PASSED');
process.exit(failures ? 1 : 0);
