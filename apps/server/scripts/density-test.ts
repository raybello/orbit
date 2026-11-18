/**
 * Density test for the Docker computer provider: boots N bot computers through the real provider
 * (container, screen, desk, the bot's Chrome), loads real pages in each, and measures what they
 * cost together. Then checks the idle pause, waking from it, and making room when Docker is full.
 * Not part of the build: run it by hand against a scratch database and a running Docker daemon.
 *
 *   DB_PATH=/tmp/orbit-density.db COMPUTER_HOME_DIR=$HOME/.orbit-density \
 *     npx tsx scripts/density-test.ts
 *
 * COMPUTER_HOME_DIR must be somewhere Docker can mount (your home folder on colima/Docker Desktop).
 * DENSITY_BOTS (default 10), DENSITY_HOLD_SEC (default 90), DENSITY_KEEP=1 leaves the bots running.
 * It only ever touches containers and folders of the bots it creates (bot_density_<run>_*).
 */
import { db, now } from '../src/db.js';
import '../src/db-config.js';
import { env } from '../src/env.js';
import { dockerProvider } from '../src/docker-provider.js';
import { getComputer, getScreen } from '../src/computer-store.js';
import { containerStatus, dockerHostMemory } from '../src/docker/container.js';
import { docker } from '../src/docker/client.js';
import { execInContainer } from '../src/docker/exec.js';

const COUNT = Number(process.env.DENSITY_BOTS ?? 10);
const HOLD_SEC = Number(process.env.DENSITY_HOLD_SEC ?? 90);
const USER = 'usr_density';
const SITES = [
  'https://github.com/firecracker-microvm/firecracker',
  'https://en.wikipedia.org/wiki/Virtual_machine',
  'https://www.bbc.com/news',
  'https://news.ycombinator.com',
  'https://stackoverflow.com/questions',
  'https://www.nytimes.com',
  'https://www.reddit.com/r/programming/',
  'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  'https://www.theguardian.com/international',
  'https://docs.python.org/3/library/asyncio.html',
];

const MB = 1024 ** 2;
const mb = (n: number) => `${Math.round(n / MB)} MB`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A fresh id per run: colima's sshfs share can serve a stale view of a home folder that a previous
// run removed and this one recreates under the same name.
const RUN = Date.now().toString(36);
const botId = (i: number) => `bot_density_${RUN}_${String(i + 1).padStart(2, '0')}`;

function seed(ids: string[]) {
  db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'density@example.com', 'Density', now());
  const ins = db.prepare(
    `INSERT OR REPLACE INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,engine,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ids.forEach((id, i) => ins.run(id, USER, `Bot ${i + 1}`, 'Density', '', '', 'blob', 'violet', 'personal', 0, 'managed', now(), now()));
}

function containerOf(id: string): string {
  const c = getComputer(id)?.container_id;
  if (!c) throw new Error(`${id} has no container`);
  return c;
}

/** cgroup v2 numbers for one bot container, read from inside it. */
async function cgroup(id: string): Promise<{ current: number; anon: number; file: number; oomKills: number }> {
  const r = await execInContainer(containerOf(id), ['sh', '-c', 'cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.stat; cat /sys/fs/cgroup/memory.events'], {}, 10_000);
  const field = (name: string) => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? 0);
  return { current: Number(r.stdout.split('\n')[0]), anon: field('anon'), file: field('file'), oomKills: field('oom_kill') };
}

/** The Docker VM's own view: total and available memory, from any bot container's /proc/meminfo. */
async function vmMemory(id: string): Promise<{ total: number; available: number }> {
  const r = await execInContainer(containerOf(id), ['cat', '/proc/meminfo'], {}, 10_000);
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(r.stdout)?.[1] ?? 0) * 1024;
  return { total: kb('MemTotal'), available: kb('MemAvailable') };
}

async function cpuPercent(containerId: string): Promise<number> {
  const s = (await docker().getContainer(containerId).stats({ stream: false })) as any;
  const cpu = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sys = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const n = s.cpu_stats.online_cpus ?? 1;
  return sys > 0 ? (cpu / sys) * n * 100 : 0;
}

async function cdpBase(id: string): Promise<string> {
  const screen = getScreen(id);
  if (!screen) throw new Error(`${id} has no screen`);
  return dockerProvider.cdpUrl(id, screen.screen_id);
}

async function openTab(id: string, url: string): Promise<void> {
  const base = await cdpBase(id);
  const r = await fetch(`${base}/json/new?${url}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`${id}: could not open ${url} (${r.status})`);
}

async function cdpAlive(id: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(`${await cdpBase(id)}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function chromeIsLean(id: string): Promise<boolean> {
  const r = await execInContainer(containerOf(id), ['sh', '-c', "ps -eo args | grep -c '[r]enderer-process-limit=2'"], {}, 10_000);
  return Number(r.stdout.trim()) > 0;
}

async function snapshot(ids: string[], label: string) {
  const per = await Promise.all(ids.map(async (id) => ({ id, ...(await cgroup(id)) })));
  const vm = await vmMemory(ids[0]);
  const total = per.reduce((a, b) => a + b.current, 0);
  const anon = per.reduce((a, b) => a + b.anon, 0);
  const kills = per.reduce((a, b) => a + b.oomKills, 0);
  const max = per.reduce((a, b) => (b.current > a.current ? b : a));
  console.log(
    `[${label}] bots=${ids.length} sum=${mb(total)} (anon ${mb(anon)}) avg=${mb(total / ids.length)} ` +
      `max=${mb(max.current)} (${max.id}) vm_available=${mb(vm.available)}/${mb(vm.total)} oom_kills=${kills}`,
  );
  return { label, total, anon, avg: total / ids.length, max: max.current, vmAvailable: vm.available, vmTotal: vm.total, kills, per };
}

async function main() {
  const ids = Array.from({ length: COUNT }, (_, i) => botId(i));
  seed(ids);
  console.log(`Docker host memory ${mb(await dockerHostMemory())}; limit ${env.computerMemoryLimit}, reservation ${env.computerMemoryReservation}, cpus ${env.computerCpuLimit}`);

  // 1. Boot every bot through the real provider, three at a time (like a morning of bots waking up).
  const t0 = Date.now();
  const bootTimes: number[] = [];
  for (let i = 0; i < ids.length; i += 3) {
    await Promise.all(
      ids.slice(i, i + 3).map(async (id) => {
        const s = Date.now();
        await dockerProvider.readyScreen(USER, id);
        if (!(await cdpAlive(id, 10_000))) throw new Error(`${id}: Chrome did not answer after the desk was dressed`);
        bootTimes.push(Date.now() - s);
      }),
    );
  }
  console.log(`booted ${ids.length} bots in ${Math.round((Date.now() - t0) / 1000)} s (each ${Math.round(Math.min(...bootTimes) / 1000)}-${Math.round(Math.max(...bootTimes) / 1000)} s)`);
  const lean = await Promise.all(ids.map(chromeIsLean));
  console.log(`lean Chrome on ${lean.filter(Boolean).length}/${ids.length} bots`);
  const idle = await snapshot(ids, 'desks up, home page only');

  // 2. A working load: every bot has two pages open; three bots are heavy users with four.
  for (const [i, id] of ids.entries()) {
    await openTab(id, SITES[i % SITES.length]);
    await openTab(id, SITES[(i + 5) % SITES.length]);
    if (i < 3) {
      await openTab(id, 'https://www.youtube.com');
      await openTab(id, SITES[(i + 3) % SITES.length]);
    }
  }
  await sleep(30_000);
  const loaded = await snapshot(ids, '2 tabs each, 3 bots with 4');

  // 3. Hold the load and sample, so a slow leak or a late OOM shows.
  let worst = loaded;
  const cpu: number[] = [];
  for (let t = 0; t < HOLD_SEC; t += 30) {
    await sleep(30_000);
    const s = await snapshot(ids, `held ${t + 30}s`);
    if (s.total > worst.total) worst = s;
    cpu.push((await Promise.all(ids.map((id) => cpuPercent(containerOf(id))))).reduce((a, b) => a + b, 0));
  }
  console.log(`CPU across all bots while idle on their pages: ${cpu.map((c) => `${Math.round(c)}%`).join(', ')} (of ${await docker().info().then((i: any) => i.NCPU)} cores x 100%)`);
  const alive = await Promise.all(ids.map((id) => cdpAlive(id)));
  console.log(`Chrome answering on ${alive.filter(Boolean).length}/${ids.length} bots after the hold`);

  // 4. Idle pause: freeze three, check they cost no CPU, then wake one the way a turn does.
  const frozen = ids.slice(0, 3);
  for (const id of frozen) await dockerProvider.pause(id);
  const st = await Promise.all(frozen.map((id) => containerStatus(containerOf(id))));
  await sleep(3000);
  const frozenCpu = await Promise.all(frozen.map((id) => cpuPercent(containerOf(id))));
  console.log(`paused ${st.filter((s) => s.paused).length}/3; their CPU ${frozenCpu.map((c) => c.toFixed(1)).join(', ')}%; screenshot while paused: ${(await dockerProvider.screenshot(frozen[0], '')) === null ? 'skipped' : 'TAKEN'}`);
  const w0 = Date.now();
  await dockerProvider.readyScreen(USER, frozen[0]);
  const wakeMs = Date.now() - w0;
  console.log(`woke ${frozen[0]} in ${wakeMs} ms; paused=${(await containerStatus(containerOf(frozen[0]))).paused}; Chrome answering=${await cdpAlive(frozen[0])}; tabs kept=${(await (await fetch(`${await cdpBase(frozen[0])}/json/list`)).json() as any[]).filter((t) => t.type === 'page').length}`);

  // 5. Making room: count each bot at 1 GB so ten do not fit, then start an eleventh.
  const extra = botId(COUNT);
  seed([...ids, extra]);
  const saved = env.computerMemoryReservation;
  (env as { computerMemoryReservation: string }).computerMemoryReservation = env.computerMemoryLimit;
  const r0 = Date.now();
  let roomResult = '';
  try {
    await dockerProvider.ensureComputer(extra);
    const suspended = ids.filter((id) => getComputer(id)?.state === 'suspended');
    roomResult = `started ${extra} in ${Math.round((Date.now() - r0) / 1000)} s after suspending ${suspended.length} (${suspended.join(', ')}); frozen ones first: ${suspended.every((id) => frozen.includes(id)) || suspended.slice(0, 2).every((id) => frozen.includes(id))}`;
  } catch (e) {
    roomResult = `could not start ${extra}: ${(e as Error).message}`;
  } finally {
    (env as { computerMemoryReservation: string }).computerMemoryReservation = saved;
  }
  console.log(roomResult);

  console.log(
    JSON.stringify({
      bots: COUNT,
      idleAvgMB: Math.round(idle.avg / MB),
      loadedAvgMB: Math.round(loaded.avg / MB),
      worstSumMB: Math.round(worst.total / MB),
      worstMaxMB: Math.round(worst.max / MB),
      vmTotalMB: Math.round(worst.vmTotal / MB),
      vmAvailableAtWorstMB: Math.round(worst.vmAvailable / MB),
      oomKills: worst.kills,
      wakeMs,
    }),
  );

  if (process.env.DENSITY_KEEP !== '1') {
    for (const id of [...ids, extra]) await dockerProvider.destroy(id, { wipeWorkspace: true }).catch(() => undefined);
    console.log('removed every density bot');
  }
}

main().then(
  () => process.exit(0),
  async (e) => {
    console.error(e);
    process.exit(1);
  },
);
