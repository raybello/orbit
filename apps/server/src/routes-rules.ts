import { Hono } from 'hono';
import { z } from 'zod';
import { RULE_PRESETS, type BotRule, type CreateRuleRequest, type RulePresetId, type RulesResponse, type UpdateRuleRequest } from '@orbit/contracts';
import { now } from './db.js';
import { newId } from './lib/ids.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { requireBody } from './api/schemas.js';
import { botRow, type BotRow } from './infra/bot-repository.js';
import { RuleActionSchema, RulePatternSchema } from './domain/rules.js';
import { deleteRule, insertRule, presetRuleOfBot, ruleLogForBot, ruleOfBot, rulesForBot, updateRule } from './infra/rule-repository.js';

/** /api/bots/:id/rules: one bot's auto-review rules and the log of what they matched. */
export const rulesApi = new Hono<AuthVars>();
rulesApi.use('/bots/*', requireUser);

/** Enough for every preset and a long list of the person's own; keeps one tool call's review cheap. */
const MAX_RULES = 50;

const presetIds = RULE_PRESETS.map((p) => p.id) as [RulePresetId, ...RulePresetId[]];
const Description = z.string().trim().min(1).max(200);

const CreateRuleSchema = z.union([
  z.strictObject({ preset: z.enum(presetIds), action: RuleActionSchema.optional() }),
  z.strictObject({ description: Description, pattern: RulePatternSchema, action: RuleActionSchema }),
]) satisfies z.ZodType<CreateRuleRequest>;

const UpdateRuleSchema = z.strictObject({
  description: Description.optional(),
  pattern: RulePatternSchema.optional(),
  action: RuleActionSchema.optional(),
}) satisfies z.ZodType<UpdateRuleRequest>;

/** The caller's own bot, when it is one that makes tool calls. A group chat dispatches to its members and has no rules. */
const ruledBot = (userId: string, id: string): BotRow | null => {
  const b = botRow(id);
  return b && b.user_id === userId && b.kind !== 'room' ? b : null;
};

rulesApi.get('/bots/:id/rules', (c) => {
  const b = ruledBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ rules: rulesForBot(b.id), log: ruleLogForBot(b.id) } satisfies RulesResponse);
});

rulesApi.post('/bots/:id/rules', async (c) => {
  const b = ruledBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await requireBody(c, CreateRuleSchema);

  let draft: Pick<BotRule, 'description' | 'pattern' | 'action' | 'preset'>;
  if ('preset' in body) {
    // Turning a preset on twice is one rule: a second request answers with the first one's row.
    const existing = presetRuleOfBot(b.id, body.preset);
    if (existing) return c.json({ rule: existing });
    const preset = RULE_PRESETS.find((p) => p.id === body.preset)!;
    draft = { description: preset.description, pattern: preset.pattern, action: body.action ?? preset.action, preset: preset.id };
  } else {
    draft = { description: body.description, pattern: body.pattern, action: body.action, preset: null };
  }
  if (rulesForBot(b.id).length >= MAX_RULES) return c.json({ error: `A Bot can have at most ${MAX_RULES} rules.` }, 409);

  const rule: BotRule = { id: newId('rule'), botId: b.id, createdAt: now(), ...draft };
  insertRule(rule);
  return c.json({ rule });
});

rulesApi.patch('/bots/:id/rules/:ruleId', async (c) => {
  const b = ruledBot(c.get('user').id, c.req.param('id'));
  const current = b ? ruleOfBot(b.id, c.req.param('ruleId')) : null;
  if (!b || !current) return c.json({ error: 'not found' }, 404);
  const patch = await requireBody(c, UpdateRuleSchema);
  // A preset keeps its meaning; what it does about a match is the part a person may change.
  if (current.preset && (patch.description !== undefined || patch.pattern !== undefined)) {
    return c.json({ error: 'A preset rule can only change what it does. Add a rule of your own to change what it matches.' }, 400);
  }
  updateRule(current.id, {
    description: patch.description ?? current.description,
    pattern: patch.pattern ?? current.pattern,
    action: patch.action ?? current.action,
  });
  return c.json({ rule: ruleOfBot(b.id, current.id) });
});

rulesApi.delete('/bots/:id/rules/:ruleId', (c) => {
  const b = ruledBot(c.get('user').id, c.req.param('id'));
  if (!b || !deleteRule(b.id, c.req.param('ruleId'))) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
