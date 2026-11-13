/**
 * Drives the HTTP and WebSocket surface of the Docker computer provider against a running server:
 * sign in, create a bot, open its screen, take control, grab a screenshot. Dev helper.
 */
const base = process.env.BASE ?? 'http://127.0.0.1:8799';
let cookie = '';

async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return res;
}

const login = await call('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email: 'smoke@example.com', name: 'Smoke' }) });
console.log('login', login.status);

const created = await call('/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Docker Bot', avatarColor: 'green' }) });
const { bot } = await created.json();
console.log('bot', bot.id);

const { WebSocket } = await import('ws');
const ws = new WebSocket(`ws://127.0.0.1:8799/api/bots/${bot.id}/screen?mode=watch`, ['binary'], { headers: { cookie } });
const first = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no RFB greeting within 180s')), 180_000);
  ws.on('message', (d) => {
    clearTimeout(timer);
    resolve(Buffer.from(d).subarray(0, 12).toString());
  });
  ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  ws.on('close', (code) => { clearTimeout(timer); reject(new Error(`closed ${code}`)); });
});
console.log('browser-side greeting:', JSON.stringify(first));
ws.close();

const take = await call(`/api/bots/${bot.id}/screen/control`, { method: 'POST', body: JSON.stringify({ action: 'take' }) });
console.log('take control', take.status, await take.text());
const give = await call(`/api/bots/${bot.id}/screen/control`, { method: 'POST', body: JSON.stringify({ action: 'give' }) });
console.log('give control', give.status, await give.text());

const shot = await call(`/api/bots/${bot.id}/screenshot`);
console.log('screenshot', shot.status, shot.headers.get('content-type'), (await shot.arrayBuffer()).byteLength, 'bytes');

const del = await call(`/api/bots/${bot.id}`, { method: 'DELETE' });
console.log('delete', del.status, await del.text());
