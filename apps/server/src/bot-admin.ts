import { asUserId } from '@orbit/contracts';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { emitBot, getBot, listBots, listRoutines } from './store.js';
import { interrupt } from './agent/loop.js';
import { forgetBotFiles, releaseScreen } from './computer.js';
import { computerKindFor, providerFor, registerBotComputer, releaseBotComputer } from './computer-provider-registry.js';
import { assignEngine, provisionEngine, removeEngine, syncPersona } from './engine.js';
import { pickAvatar } from './core/avatar.js';
import { beginProvisioning, planBotCreation, type BotCreationInput } from './core/bot-service.js';
import { unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { insertBot, botRow, botRowsForUser } from './infra/bot-repository.js';
import { planPrimaryChange, type PrimaryAction } from './domain/primary-bots.js';
import type { Bot } from '@orbit/contracts';

/**
 * The team's admin operations, in one place.
 *
 * Both HTTP routes and the primary Bot's MCP tools create, edit, delete and re-rank Bots, and both
 * must apply the same rules in the same order: capacity before allocation, engine and computer
 * wiring after the row exists, one primary set that never breaks its two invariants. Keeping a copy
 * in each caller is how those rules drift, so callers stay thin and this file owns the sequence.
 *
 * The return values are plain data; the only errors thrown are BotAdminError, whose message is safe
 * to show a person (and to hand back to an agent as a tool result).
 */

export class BotAdminError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'BotAdminError';
    this.status = status;
  }
}

/** Every agent that counts against the computer's capacity (group chats and hidden sub-bots do not). */
const agentCount = () => (db.prepare("SELECT COUNT(*) n FROM bots WHERE COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").get() as { n: number }).n;

/** The primary set for one owner, as the policy module wants it: creation order, with the flag. */
function primaryFlags(userId: string) {
  return (db.prepare('SELECT id, is_primary FROM bots WHERE user_id=? ORDER BY is_primary DESC, created_at ASC').all(userId) as { id: string; is_primary: number }[])
    .map((r) => ({ id: r.id, isPrimary: Boolean(r.is_primary) }));
}

function writePrimaries(userId: string, primaries: readonly string[]) {
  const set = new Set(primaries);
  const rows = db.prepare('SELECT id FROM bots WHERE user_id=?').all(userId) as { id: string }[];
  const update = db.prepare('UPDATE bots SET is_primary=?, updated_at=? WHERE id=? AND user_id=?');
  const at = now();
  for (const r of rows) update.run(set.has(r.id) ? 1 : 0, at, r.id, userId);
  hub.emit(userId, { type: 'roster' });
}

/**
 * Create a bot and wire everything it needs: plan the row (core/bot-service.ts decides the rules),
 * insert it (infra/bot-repository.ts owns the SQL), assign its engine, start that engine when it is
 * a managed one, register its computer, tell the roster.
 */
export function createBotFor(userId: string, input: Omit<BotCreationInput, 'userId'>): Bot {
  const plan = planBotCreation({ ...input, userId: asUserId(userId) }, {
    // Capacity is about this computer's screens, not this account: the count is global.
    canAddBot: () => agentCount() < env.maxBots,
    maxBots: env.maxBots,
    newBotId: () => newId('bot'),
    pickAvatar: (id, shape, color) => pickAvatar(id, shape, color),
  });
  insertBot({
    id: plan.botId,
    userId,
    name: plan.name,
    label: plan.label,
    description: plan.description,
    instructions: plan.instructions,
    avatarShape: plan.avatar.shape,
    avatarColor: plan.avatar.color,
    mode: plan.mode,
    isPrimary: plan.isPrimary,
    voiceProvider: plan.voiceProvider,
    voiceModel: plan.voiceModel,
    createdAt: now(),
    updatedAt: now(),
  });
  const engineKind = assignEngine(plan.botId);
  const state = beginProvisioning(plan.state, engineKind);
  if (state.status === 'provisioning' && engineKind === 'managed') provisionEngine(plan.botId);
  registerBotComputer(plan.botId);
  hub.emit(userId, { type: 'roster' });
  return getBot(plan.botId)!;
}

const PATCH_COLUMNS: Record<string, string> = {
  name: 'name',
  label: 'label',
  description: 'description',
  instructions: 'instructions',
  avatarShape: 'avatar_shape',
  avatarColor: 'avatar_color',
  mode: 'mode',
  effort: 'effort',
  pinned: 'pinned',
  voice: 'voice',
  voiceSpeed: 'voice_speed',
  voiceLanguage: 'voice_language',
  voiceProvider: 'voice_provider',
  voiceModel: 'voice_model',
  initiative: 'initiative',
};

/** One bot of this owner's, or null. */
export function ownedBot(userId: string, botId: string) {
  const b = botRow(botId);
  return b && b.user_id === userId ? b : null;
}

/** Apply the editable fields a caller named, then re-dress what the change affects. */
export function updateBotFor(userId: string, botId: string, patch: Record<string, unknown>): Bot {
  const b = ownedBot(userId, botId);
  if (!b) throw new BotAdminError(404, 'No such bot.');
  for (const [k, col] of Object.entries(PATCH_COLUMNS)) {
    const value = patch[k];
    if (value !== undefined) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(typeof value === 'boolean' ? (value ? 1 : 0) : value, now(), b.id);
  }
  if (b.kind !== 'room') {
    if (['name', 'label', 'description'].some((k) => patch[k] !== undefined)) syncPersona(b.id);
    // Its desktop carries its name and colour: dress the screen again, if it has one.
    const looks = ['name', 'label', 'avatarShape', 'avatarColor'].some((k) => patch[k] !== undefined);
    if (looks) {
      const provider = providerFor(b.id);
      const hasComputer = computerKindFor(b.id) === 'docker'
        ? Boolean(db.prepare('SELECT 1 FROM computer_screens WHERE bot_id=?').get(b.id))
        : Boolean(db.prepare('SELECT 1 FROM screens WHERE bot_id=?').get(b.id));
      if (hasComputer) provider.readyScreen(b.user_id, b.id, { redress: true }).catch((e) => console.warn('[computer] redress failed', e?.message ?? e));
    }
  }
  emitBot(b.id);
  return getBot(b.id)!;
}

/**
 * Remove a bot and everything it kept on the computer.
 *
 * The primary set must not be emptied by a deletion, so when the removed bot was the only primary
 * the oldest remaining agent takes over. Callers are told which one, because an agent that deleted
 * its own team-mate should be able to say what happened next.
 */
export async function deleteBotFor(userId: string, botId: string): Promise<{ promoted: string | null }> {
  const b = ownedBot(userId, botId);
  if (!b) throw new BotAdminError(404, 'No such bot.');
  if (b.kind === 'room') throw new BotAdminError(400, `"${b.name}" is a group chat, not a Bot.`);
  // A team with no Bots has no primary, and nothing would ever make one again. Refuse the last one;
  // the person can create its replacement first.
  const agents = botRowsForUser(userId).filter((r) => r.kind !== 'room' && !r.hidden);
  if (agents.length <= 1) throw new BotAdminError(400, 'A team needs at least one Bot. Create another Bot before removing this one.');

  interrupt(b.id);
  for (const r of listRoutines(b.id)) {
    unscheduleRoutine(r.id);
    await deleteEventTrigger(r.id).catch(() => {});
  }
  await removeEngine(b.id).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
  if (computerKindFor(b.id) === 'docker') {
    await releaseBotComputer(b.id).catch((e) => console.warn('[computer] container cleanup failed', e?.message ?? e));
  } else {
    await releaseScreen(b.id).catch((e) => console.warn('[computer] release failed', e?.message ?? e));
    await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
  }
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(b.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);

  let promoted: string | null = null;
  const remaining = botRowsForUser(userId).filter((r) => r.kind !== 'room' && !r.hidden);
  if (b.is_primary && !remaining.some((r) => r.is_primary) && remaining.length) {
    const next = remaining.slice().sort((a, z) => a.created_at - z.created_at)[0];
    db.prepare('UPDATE bots SET is_primary=1, updated_at=? WHERE id=?').run(now(), next.id);
    promoted = next.name;
  }
  hub.emit(userId, { type: 'roster' });
  return { promoted };
}

/** Promote or restore one bot's primary status under the team's two invariants. */
export function setBotPrimary(userId: string, botId: string, action: PrimaryAction): { primaries: string[] } {
  const bot = ownedBot(userId, botId);
  if (!bot) throw new BotAdminError(404, 'No such bot.');
  if (bot.kind === 'room') throw new BotAdminError(400, `"${bot.name}" is a group chat, not a Bot, so it cannot be primary.`);
  if (bot.hidden) throw new BotAdminError(400, 'A hidden helper Bot cannot be primary.');
  const plan = planPrimaryChange(primaryFlags(userId), botId, action);
  if (!plan.ok) throw new BotAdminError(plan.status, plan.message);
  if (plan.changed) writePrimaries(userId, plan.primaries);
  return { primaries: plan.primaries };
}

/**
 * Give an install created before the rename its coordinator name.
 *
 * Matching on the primary flag AND the seed label keeps this from touching a Bot the user named
 * "Doug" themselves. Runs once at boot; idempotent.
 */
export function renameLegacyPrimary(to: string = env.primaryBotName): number {
  if (!to || to === 'Doug') return 0;
  const r = db.prepare("UPDATE bots SET name=?, updated_at=? WHERE lower(name)='doug' AND label='Chief of Staff' AND is_primary=1").run(to, now());
  if (r.changes) console.log(`[bots] renamed the legacy primary Bot (Doug) to ${to}`);
  return r.changes;
}

/** The team as an agent should see it: no group chats, no hidden sub-bots. */
export function teamFor(userId: string) {
  return listBots(userId)
    .filter((b) => b.kind !== 'room')
    .map((b) => ({
      id: b.id,
      name: b.name,
      label: b.label,
      description: b.description,
      primary: b.isPrimary,
      model: b.model,
      provider: b.provider,
      computer: computerKindFor(b.id),
    }));
}
