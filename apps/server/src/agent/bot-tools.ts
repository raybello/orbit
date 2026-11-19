import { db } from '../db.js';
import { BotAdminError, createBotFor, deleteBotFor, setBotPrimary, teamFor, updateBotFor } from '../bot-admin.js';
import { TeamFullError } from '../core/bot-service.js';
import type { ToolCtx, ToolResult } from './tools.js';
import type { ActivityKind } from '@orbit/contracts';

/**
 * Team management as tools.
 *
 * Only a primary Bot may change the team: creating, editing, deleting and promoting are exactly the
 * actions that reshape who can coordinate. A non-primary caller gets a refusal it can relay, not a
 * silent success. Reads stay open to everyone, because knowing the roster is how a Bot addresses a
 * teammate with send_to_bot in the first place.
 *
 * Everything delegates to bot-admin.ts, so a tool and the settings UI cannot disagree about capacity,
 * teardown order or the primary set's invariants.
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (v: unknown, max = 4000) => String(v ?? '').trim().slice(0, max);

const me = (ctx: ToolCtx) => db.prepare('SELECT id, name, is_primary FROM bots WHERE id=?').get(ctx.botId) as { id: string; name: string; is_primary: number } | undefined;

/** The caller must be a primary Bot, or the tool refuses with a message it can pass on. */
function requirePrimary(ctx: ToolCtx): { ok: true; name: string } | { ok: false; result: ToolResult } {
  const bot = me(ctx);
  if (!bot) return { ok: false, result: { output: 'This agent is not bound to a Bot yet.' } };
  if (!bot.is_primary) {
    return {
      ok: false,
      result: {
        output: `Only a primary Bot can change the team. You are ${bot.name}, which is not primary. Ask a primary Bot (they carry the star) to make the change, or ask the user to promote you.`,
        summary: 'Team change refused: not primary',
      },
    };
  }
  return { ok: true, name: bot.name };
}

/** A teammate by name, or a message naming who does exist. */
function findBot(ctx: ToolCtx, name: string) {
  const target = db.prepare('SELECT id, name, kind, is_primary FROM bots WHERE user_id=? AND lower(name)=lower(?)').get(ctx.userId, name.trim()) as
    | { id: string; name: string; kind: string | null; is_primary: number }
    | undefined;
  if (target) return { target };
  const names = teamFor(ctx.userId).map((b) => b.name);
  return { missing: `No Bot named "${name}". The team is: ${names.length ? names.join(', ') : '(empty)'}.` };
}

export const BOT_TOOLS: ToolDef[] = [
  {
    name: 'list_bots',
    description: 'List every Bot on the team with its label, whether it is primary, and which computer it uses. Use it before send_to_bot so you address a real name.',
    parameters: obj({}),
    activity: 'working',
    label: 'Reading the team',
    impl: async (_a, ctx) => {
      const team = teamFor(ctx.userId);
      if (!team.length) return { output: 'There are no Bots on the team yet.' };
      return {
        output: JSON.stringify({
          bots: team.map((b) => ({ name: b.name, label: b.label || null, primary: b.primary, description: b.description || null, computer: b.computer, model: b.model })),
        }),
        summary: `${team.length} Bot(s)`,
      };
    },
  },
  {
    name: 'create_bot',
    description:
      'Add a new Bot to the team. Primary Bots only. The new Bot gets its own desktop and browser and can be messaged with send_to_bot as soon as it exists. Capacity, avatars and engine wiring are handled for you.',
    parameters: obj({
      name: { type: 'string', description: 'The Bot\'s name, e.g. "Scout"' },
      label: { type: 'string', description: 'Its job, e.g. "Research analyst"' },
      description: { type: 'string', description: 'One line about what it is for' },
      instructions: { type: 'string', description: 'Standing instructions it should follow' },
    }, ['name']),
    activity: 'working',
    label: 'Adding a Bot',
    impl: async (a, ctx) => {
      const gate = requirePrimary(ctx);
      if (!gate.ok) return gate.result;
      const name = str(a.name, 60);
      if (!name) return { output: 'A name is required.' };
      try {
        const bot = createBotFor(ctx.userId, {
          name,
          label: str(a.label, 120),
          description: str(a.description, 600),
          instructions: str(a.instructions, 8000),
        });
        return { output: JSON.stringify({ ok: true, bot: { id: bot.id, name: bot.name, label: bot.label } }), summary: `Created ${bot.name}` };
      } catch (e) {
        if (e instanceof TeamFullError) return { output: e.message };
        if (e instanceof BotAdminError) return { output: e.message };
        throw e;
      }
    },
  },
  {
    name: 'update_bot',
    description: 'Change an existing Bot\'s name, label, description, instructions or look. Primary Bots only. Pass only the fields that should change.',
    parameters: obj({
      bot_name: { type: 'string', description: 'The Bot to edit, by current name' },
      name: { type: 'string' },
      label: { type: 'string' },
      description: { type: 'string' },
      instructions: { type: 'string' },
      avatar_shape: { type: 'string', enum: ['blob', 'squircle', 'circle', 'flower', 'pill', 'hex'] },
      avatar_color: { type: 'string', enum: ['pink', 'blue', 'red', 'orange', 'yellow', 'green', 'teal', 'purple', 'brown', 'gray', 'black'] },
    }, ['bot_name']),
    activity: 'working',
    label: 'Updating a Bot',
    impl: async (a, ctx) => {
      const gate = requirePrimary(ctx);
      if (!gate.ok) return gate.result;
      const found = findBot(ctx, str(a.bot_name, 60));
      if (!found.target) return { output: found.missing! };
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'label', 'description', 'instructions'] as const) if (a[k] !== undefined) patch[k] = str(a[k], k === 'instructions' ? 8000 : 600);
      if (a.avatar_shape !== undefined) patch.avatarShape = a.avatar_shape;
      if (a.avatar_color !== undefined) patch.avatarColor = a.avatar_color;
      if (!Object.keys(patch).length) return { output: 'Nothing to change: name one of name, label, description, instructions, avatar_shape or avatar_color.' };
      try {
        const bot = updateBotFor(ctx.userId, found.target.id, patch);
        return { output: JSON.stringify({ ok: true, bot: { id: bot.id, name: bot.name, label: bot.label } }), summary: `Updated ${bot.name}` };
      } catch (e) {
        if (e instanceof BotAdminError) return { output: e.message };
        throw e;
      }
    },
  },
  {
    name: 'delete_bot',
    description: 'Remove a Bot from the team, including its computer and its Library. Primary Bots only, and a Bot cannot delete itself. Set confirm to true after you are sure it is the right one.',
    parameters: obj({ bot_name: { type: 'string' }, confirm: { type: 'boolean', description: 'Must be true; a guard against acting on a guess' } }, ['bot_name', 'confirm']),
    activity: 'working',
    label: 'Removing a Bot',
    impl: async (a, ctx) => {
      const gate = requirePrimary(ctx);
      if (!gate.ok) return gate.result;
      if (a.confirm !== true) return { output: 'Set confirm to true once you are sure this is the Bot to remove.' };
      const found = findBot(ctx, str(a.bot_name, 60));
      if (!found.target) return { output: found.missing! };
      if (found.target.id === ctx.botId) return { output: 'You cannot delete yourself. Ask the user to remove you if that is what they want.' };
      try {
        const { promoted } = await deleteBotFor(ctx.userId, found.target.id);
        return {
          output: `Removed ${found.target.name}.${promoted ? ` ${promoted} is now primary, so the team keeps a coordinator.` : ''}`,
          summary: `Removed ${found.target.name}`,
        };
      } catch (e) {
        if (e instanceof BotAdminError) return { output: e.message };
        throw e;
      }
    },
  },
  {
    name: 'set_primary_bot',
    description:
      'Promote a Bot to primary (up to 3 at once) or restore it to default. Primary Bots carry a star, and only they can change the team. Always at least one primary remains: the last one cannot be restored.',
    parameters: obj({ bot_name: { type: 'string' }, primary: { type: 'boolean', description: 'true to promote, false to restore to default' } }, ['bot_name', 'primary']),
    activity: 'working',
    label: 'Setting a primary Bot',
    impl: async (a, ctx) => {
      const gate = requirePrimary(ctx);
      if (!gate.ok) return gate.result;
      const found = findBot(ctx, str(a.bot_name, 60));
      if (!found.target) return { output: found.missing! };
      try {
        setBotPrimary(ctx.userId, found.target.id, a.primary === false ? 'restore' : 'promote');
        return {
          output: `${found.target.name} is ${a.primary === false ? 'no longer primary' : 'now primary'}. Primary Bots: ${teamFor(ctx.userId).filter((b) => b.primary).map((b) => b.name).join(', ')}.`,
          summary: a.primary === false ? `Restored ${found.target.name}` : `Promoted ${found.target.name}`,
        };
      } catch (e) {
        if (e instanceof BotAdminError) return { output: e.message };
        throw e;
      }
    },
  },
];
