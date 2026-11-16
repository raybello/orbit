import type { BotRule, RuleAction, RuleLogEntry, RuleOutcome, RulePattern, RulePresetId } from '@orbit/contracts';
import { db } from '../db.js';
import { RuleActionSchema, RulePatternSchema } from '../domain/rules.js';

/**
 * The `bot_rules` and `bot_rule_log` tables: their schema and every statement that touches them.
 * The schema lives here instead of db.ts because it is idempotent and only this module reads it.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS bot_rules (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  pattern TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ask', 'block', 'log')),
  preset TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_rules_bot ON bot_rules(bot_id, created_at);
-- A preset is on or off for a bot, so adding it twice lands on the same row.
CREATE UNIQUE INDEX IF NOT EXISTS bot_rules_preset ON bot_rules(bot_id, preset) WHERE preset IS NOT NULL;
CREATE TABLE IF NOT EXISTS bot_rule_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  rule_description TEXT NOT NULL,
  action TEXT NOT NULL,
  tool TEXT NOT NULL,
  detail TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_rule_log_bot ON bot_rule_log(bot_id, id);
`);

interface RuleRow {
  id: string;
  bot_id: string;
  description: string;
  pattern: string;
  action: string;
  preset: string | null;
  created_at: number;
}

interface RuleLogRow {
  id: number;
  bot_id: string;
  rule_id: string;
  rule_description: string;
  action: RuleAction;
  tool: string;
  detail: string;
  outcome: RuleOutcome;
  created_at: number;
}

/** A stored row as a rule, or null when it no longer reads as one (a pattern kind this build dropped). */
function toRule(r: RuleRow): BotRule | null {
  let raw: unknown;
  try { raw = JSON.parse(r.pattern); } catch { raw = null; }
  const pattern = RulePatternSchema.safeParse(raw);
  const action = RuleActionSchema.safeParse(r.action);
  if (!pattern.success || !action.success) {
    console.warn(`[rules] ignoring unreadable rule ${r.id} of ${r.bot_id}`);
    return null;
  }
  return { id: r.id, botId: r.bot_id, description: r.description, pattern: pattern.data, action: action.data, preset: r.preset as RulePresetId | null, createdAt: r.created_at };
}

/** A bot's rules, oldest first: the order the evaluator breaks ties in. */
export function rulesForBot(botId: string): BotRule[] {
  return (db.prepare('SELECT * FROM bot_rules WHERE bot_id=? ORDER BY created_at ASC, id ASC').all(botId) as RuleRow[])
    .map(toRule)
    .filter((r): r is BotRule => r !== null);
}

export function ruleOfBot(botId: string, ruleId: string): BotRule | null {
  const row = db.prepare('SELECT * FROM bot_rules WHERE id=? AND bot_id=?').get(ruleId, botId) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

export function presetRuleOfBot(botId: string, preset: RulePresetId): BotRule | null {
  const row = db.prepare('SELECT * FROM bot_rules WHERE bot_id=? AND preset=?').get(botId, preset) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

export function insertRule(rule: BotRule): void {
  db.prepare('INSERT INTO bot_rules(id,bot_id,description,pattern,action,preset,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(rule.id, rule.botId, rule.description, JSON.stringify(rule.pattern), rule.action, rule.preset, rule.createdAt);
}

export function updateRule(ruleId: string, next: { description: string; pattern: RulePattern; action: RuleAction }): void {
  db.prepare('UPDATE bot_rules SET description=?, pattern=?, action=? WHERE id=?').run(next.description, JSON.stringify(next.pattern), next.action, ruleId);
}

export function deleteRule(botId: string, ruleId: string): boolean {
  return db.prepare('DELETE FROM bot_rules WHERE id=? AND bot_id=?').run(ruleId, botId).changes > 0;
}

/** How many log entries a bot keeps. The log is a recent-activity view, not an archive. */
const LOG_KEPT = 200;

export function appendRuleLog(entry: Omit<RuleLogEntry, 'id'>): void {
  db.prepare('INSERT INTO bot_rule_log(bot_id,rule_id,rule_description,action,tool,detail,outcome,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(entry.botId, entry.ruleId, entry.ruleDescription, entry.action, entry.tool, entry.detail, entry.outcome, entry.createdAt);
  db.prepare('DELETE FROM bot_rule_log WHERE bot_id=? AND id <= (SELECT id FROM bot_rule_log WHERE bot_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)')
    .run(entry.botId, entry.botId, LOG_KEPT);
}

/** The newest log entries first. */
export function ruleLogForBot(botId: string, limit = 50): RuleLogEntry[] {
  return (db.prepare('SELECT * FROM bot_rule_log WHERE bot_id=? ORDER BY id DESC LIMIT ?').all(botId, limit) as RuleLogRow[]).map((r) => ({
    id: r.id, botId: r.bot_id, ruleId: r.rule_id, ruleDescription: r.rule_description, action: r.action,
    tool: r.tool, detail: r.detail, outcome: r.outcome, createdAt: r.created_at,
  }));
}
