import { z } from 'zod';
import type { BotRule, ComposioHint, RuleAction, RulePattern } from '@orbit/contracts';
import type { Decision } from '../agent/tools.js';
import { slugInToolkit } from './connections.js';

/**
 * Auto-review rules as a pure function: the rules a person gave a bot, one tool call, and what the
 * rules say about it. Nothing here reads the database or the network. core/rule-service.ts gathers
 * the facts and mcp.ts acts on the verdict.
 */

/** One connected-app tool a call would run, with the tags Composio gives it. */
export interface ComposioToolRef {
  slug: string;
  hints: readonly string[];
}

/** What a rule can see of a tool call. A call is exactly one of these, so no pattern has to guess. */
export type ToolCall =
  | { kind: 'composio'; tools: readonly ComposioToolRef[] }
  | { kind: 'shell'; command: string }
  | { kind: 'app'; tool: string };

export interface RuleVerdict {
  decision: Decision;
  /** The rule behind a decision that is not 'allow': the strictest match, and the first given on a tie. */
  decidedBy: { rule: BotRule; tool: string | null } | null;
  /** Every rule that matched, `log` rules included, in the order given. */
  matched: BotRule[];
}

const SEVERITY: Record<Decision, number> = { allow: 0, ask: 1, block: 2 };
const DECISION_OF: Record<RuleAction, Decision> = { log: 'allow', ask: 'ask', block: 'block' };

/** Of two decisions about one call, the one that holds: block beats ask, and both beat allow. */
export const strictest = (a: Decision, b: Decision): Decision => (SEVERITY[b] > SEVERITY[a] ? b : a);

/**
 * How a bot reaches the person. Putting an approval card in front of them would ask permission to
 * ask, so no rule covers these, `always` included.
 */
const CONVERSATION_TOOLS: ReadonlySet<string> = new Set(['ask_user', 'stay_silent', 'request_app_connection']);

const globMatches = (glob: string, slug: string) => new RegExp(`^${glob.replace(/\*/g, '.*')}$`, 'i').test(slug);

const inToolkits = (slug: string, toolkits: readonly string[] | undefined) =>
  !toolkits?.length || toolkits.some((t) => slugInToolkit(slug, t));

/** A match names the connected-app tool that triggered it, when the pattern looks at one. */
type Match = { tool: string | null } | null;
type Matcher<K extends RulePattern['kind']> = (pattern: Extract<RulePattern, { kind: K }>, call: ToolCall) => Match;

const firstTool = (call: ToolCall, test: (t: ComposioToolRef) => boolean): Match => {
  if (call.kind !== 'composio') return null;
  const hit = call.tools.find(test);
  return hit ? { tool: hit.slug } : null;
};

const MATCHERS: { [K in RulePattern['kind']]: Matcher<K> } = {
  'composio-hint': (p, call) => firstTool(call, (t) => inToolkits(t.slug, p.toolkits) && p.hints.some((h) => t.hints.includes(h))),
  'composio-tool': (p, call) => firstTool(call, (t) => p.tools.some((glob) => globMatches(glob, t.slug))),
  'computer-shell': (p, call) => (call.kind === 'shell' && new RegExp(p.matchRegex).test(call.command) ? { tool: null } : null),
  always: (_p, call) => (call.kind === 'app' && CONVERSATION_TOOLS.has(call.tool) ? null : { tool: null }),
};

const match = (pattern: RulePattern, call: ToolCall): Match =>
  (MATCHERS[pattern.kind] as Matcher<RulePattern['kind']>)(pattern, call);

export function evaluateRules(rules: readonly BotRule[], call: ToolCall): RuleVerdict {
  const matched: BotRule[] = [];
  let decidedBy: RuleVerdict['decidedBy'] = null;
  for (const rule of rules) {
    const hit = match(rule.pattern, call);
    if (!hit) continue;
    matched.push(rule);
    const current: Decision = decidedBy ? DECISION_OF[decidedBy.rule.action] : 'allow';
    if (SEVERITY[DECISION_OF[rule.action]] > SEVERITY[current]) decidedBy = { rule, tool: hit.tool };
  }
  return { decision: decidedBy ? DECISION_OF[decidedBy.rule.action] : 'allow', decidedBy, matched };
}

/**
 * A guess at a tool's tags from its slug, for when Composio's catalog cannot be asked. Wrong in the
 * direction of matching too much: a rule that asks once too often costs a click, one that misses a
 * delete costs the data.
 */
const SLUG_HINTS: readonly (readonly [ComposioHint, RegExp])[] = [
  ['destructiveHint', /_(DELETE|REMOVE|TRASH|PURGE|DESTROY|ERASE|CLEAR|EMPTY|REVOKE)(_|$)/],
  ['updateHint', /_(UPDATE|EDIT|PATCH|MODIFY|RENAME|MOVE|REPLACE|SET|WRITE|UPLOAD|APPEND)(_|$)/],
  ['createHint', /_(CREATE|ADD|SEND|POST|INSERT|PUBLISH|REPLY|INVITE|SHARE|COMMENT|COPY)(_|$)/],
];

export const hintsFromSlug = (slug: string): ComposioHint[] =>
  SLUG_HINTS.filter(([, re]) => re.test(slug.toUpperCase())).map(([hint]) => hint);

const compiles = (source: string) => {
  try { new RegExp(source); return true; } catch { return false; }
};

/** The shape of a stored or submitted pattern. Rows and request bodies both come through here. */
export const RulePatternSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('composio-hint'),
    hints: z.array(z.enum(['createHint', 'updateHint', 'destructiveHint'])).min(1).max(3),
    toolkits: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/).max(60)).max(60).optional(),
  }),
  z.strictObject({
    kind: z.literal('composio-tool'),
    tools: z.array(z.string().regex(/^[A-Za-z0-9_*]+$/).max(120)).min(1).max(60),
  }),
  z.strictObject({
    kind: z.literal('computer-shell'),
    matchRegex: z.string().min(1).max(300).refine(compiles, 'not a valid regular expression'),
  }),
  z.strictObject({ kind: z.literal('always') }),
]) satisfies z.ZodType<RulePattern>;

export const RuleActionSchema = z.enum(['ask', 'block', 'log']) satisfies z.ZodType<RuleAction>;
