import type { BotRule, RuleOutcome } from '@orbit/contracts';
import { now } from '../db.js';
import { composio, composioEnabled, innerToolSlugs } from '../composio.js';
import { humanizeSlug } from '../agent/tools.js';
import { evaluateRules, hintsFromSlug, type RuleVerdict, type ToolCall } from '../domain/rules.js';
import { appendRuleLog, rulesForBot } from '../infra/rule-repository.js';

/**
 * The shell around domain/rules.ts: turns one tool call into the facts the rules look at, asks them,
 * and keeps the log of what they matched. mcp.ts calls it for every call an engine makes.
 */

/** The app tool that runs a shell command on the bot's computer. */
const SHELL_TOOL = 'computer_shell';

export interface Review {
  verdict: RuleVerdict;
  /** How the approval card and the log name this call when a rule speaks up. */
  subject: { key: string; title: string; toolkit?: string };
  detail: string;
}

/** Tags belong to a tool, not to a user, so one lookup serves every bot for the life of the process. */
const hintCache = new Map<string, readonly string[]>();

async function hintsFor(slug: string): Promise<readonly string[]> {
  const cached = hintCache.get(slug);
  if (cached) return cached;
  if (composioEnabled()) {
    try {
      const tool = await composio.tools.getRawComposioToolBySlug(slug, undefined, { signal: AbortSignal.timeout(4000) });
      // An untagged tool says nothing either way, so it is read by its name like an unreachable one.
      if (tool.tags?.length) {
        hintCache.set(slug, tool.tags);
        return tool.tags;
      }
    } catch { /* the catalog did not answer; read the slug instead */ }
  }
  return hintsFromSlug(slug);
}

async function describeCall(name: string, args: Record<string, unknown>, ownTool: boolean, needHints: boolean): Promise<ToolCall> {
  if (ownTool) return name === SHELL_TOOL ? { kind: 'shell', command: String(args.command ?? '') } : { kind: 'app', tool: name };
  const slugs = innerToolSlugs(name, args);
  return { kind: 'composio', tools: await Promise.all(slugs.map(async (slug) => ({ slug, hints: needHints ? await hintsFor(slug) : [] }))) };
}

function subjectOf(name: string, call: ToolCall, matchedTool: string | null): Review['subject'] {
  if (matchedTool) return { key: matchedTool, title: humanizeSlug(matchedTool), toolkit: matchedTool.split('_')[0].toLowerCase() };
  if (call.kind === 'shell') return { key: name, title: 'run a shell command' };
  return { key: name, title: `use ${name.replace(/_/g, ' ').toLowerCase()}` };
}

const detailOf = (call: ToolCall): string =>
  (call.kind === 'shell' ? call.command : call.kind === 'composio' ? call.tools.map((t) => t.slug).join(', ') : '').slice(0, 300);

const NOTHING_MATCHED: RuleVerdict = { decision: 'allow', decidedBy: null, matched: [] };

/** What this bot's rules say about one call. `ownTool` is whether the app itself implements `name`. */
export async function reviewToolCall(botId: string, name: string, args: Record<string, unknown>, ownTool: boolean): Promise<Review> {
  const rules = rulesForBot(botId);
  if (!rules.length) return { verdict: NOTHING_MATCHED, subject: { key: name, title: name }, detail: '' };
  const call = await describeCall(name, args, ownTool, rules.some((r) => r.pattern.kind === 'composio-hint'));
  const verdict = evaluateRules(rules, call);
  return { verdict, subject: subjectOf(name, call, verdict.decidedBy?.tool ?? null), detail: detailOf(call) };
}

/** Write one log entry per rule the call matched, once it is known what became of the call. */
export function recordReview(botId: string, review: Review, outcome: RuleOutcome): void {
  for (const rule of review.verdict.matched) {
    appendRuleLog({
      botId, ruleId: rule.id, ruleDescription: rule.description, action: rule.action,
      tool: review.subject.key, detail: review.detail, outcome, createdAt: now(),
    });
  }
}

/** What an engine is told when a rule refuses a call. */
export const blockedByRule = (rule: BotRule) =>
  `A rule the user set blocks this action ("${rule.description}"). Do not retry it or look for a way around it. Tell the user what you could not do.`;
