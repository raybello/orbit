import { db } from './db.js';
import { env } from './env.js';
import { box } from './box.js';
import { dockerProvider } from './docker-provider.js';
import { dockerComputers } from './computer-store.js';
import type { ComputerState } from '@orbit/contracts';

/**
 * The team's computers as the app shows them. Every Bot has a computer of its own (a container, see
 * docker-provider.ts) that starts on demand, so there is no shared machine to wait for: the state is
 * running, with the screens the Bots' containers have open.
 */
export function computerState(userId: string): ComputerState {
  const screens = (db.prepare(
    'SELECT cs.bot_id, cs.screen_id FROM computer_screens cs JOIN bots b ON b.id=cs.bot_id WHERE b.user_id=?',
  ).all(userId) as { bot_id: string; screen_id: string }[]).map((s) => ({ botId: s.bot_id, screenId: s.screen_id }));
  return { status: 'running', error: null, screens, maxScreens: env.maxBots };
}

/** Put this person's running Bot computers to sleep. Each starts again on its own when it has work. */
export async function suspendUserComputers(userId: string): Promise<void> {
  const mine = new Set((db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[]).map((b) => b.id));
  for (const row of dockerComputers()) {
    if (!mine.has(row.bot_id) || row.state !== 'running') continue;
    await dockerProvider.suspend(row.bot_id).catch((e: Error) => console.warn(`[docker] could not suspend ${row.bot_id}: ${e.message}`));
  }
}

/** A deleted bot leaves nothing behind on this server: its browser profile and its Library folder go. */
export async function forgetBotFiles(botId: string): Promise<void> {
  if (!/^bot_[\w-]+$/.test(botId)) return;
  await box.bash(`rm -rf -- ${box.quote(`${env.botDataDir}/profiles/${botId}`)} ${box.quote(`${env.botDataDir}/files/${botId}`)}`, 60);
}
