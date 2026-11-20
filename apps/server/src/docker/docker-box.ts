import { TYPE_FROM_STDIN, type BashResult, type Box } from '../box.js';
import { execInContainer, writeFileInContainer } from './exec.js';

/**
 * A box that reaches a bot's container. It speaks exactly the interface desk.ts uses on the shared
 * computer, so the same dressing scripts run unchanged against a per-bot container.
 */

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const BASE_ENV = {
  HOME: '/home/bot',
  USER: 'root',
  LANG: 'C.UTF-8',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  HQ_PROFILES: '/home/bot/.local/share/grokbot/profiles',
  HQ_LOGS: '/home/bot/.local/share/hq/logs',
  NO_AT_BRIDGE: '1',
};

function screenEnv(screenId?: string | null): Record<string, string> {
  const display = !screenId || screenId === 'default' ? ':1' : `:${screenId.replace('screen-', '')}`;
  return { ...BASE_ENV, DISPLAY: display, HQ_SCREEN: display.slice(1) };
}

export function dockerBox(containerId: string): Box {
  return {
    async bash(command: string, timeoutSec = 60, screenId?: string | null): Promise<BashResult> {
      const r = await execInContainer(containerId, ['bash', '-c', command], screenEnv(screenId), timeoutSec * 1000);
      return { output: `${r.stdout}${r.stderr}`, exit_code: r.code };
    },

    async writeFile(file: string, content: string | Buffer, mode = '0644'): Promise<void> {
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      await writeFileInContainer(containerId, file, buf, mode);
    },

    async readFile(file: string): Promise<Buffer | null> {
      const r = await execInContainer(
        containerId,
        ['bash', '-c', `[ -f ${q(file)} ] && base64 -w0 ${q(file)} || echo __missing__`],
        BASE_ENV,
        30_000,
      );
      const out = r.stdout.trim();
      if (!out || out.endsWith('__missing__')) return null;
      return Buffer.from(out, 'base64');
    },

    async typeSecret(secret, screenId): Promise<void> {
      const r = await execInContainer(containerId, TYPE_FROM_STDIN, screenEnv(screenId), 60_000, Buffer.from(secret.reveal(), 'utf8'));
      if (r.code !== 0) throw new Error(secret.redact(`typing failed (exit ${r.code}): ${`${r.stderr}${r.stdout}`.trim().slice(-200)}`));
    },

    quote: q,
  };
}
