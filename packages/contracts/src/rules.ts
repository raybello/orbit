// Auto-review rules: standing instructions a person gives one bot about which tool calls to stop
// and ask about, refuse, or record. Shared by the server (which enforces them) and the clients
// (which edit them).

/** What happens to a tool call a rule matches. `log` records the call and lets it run. */
export type RuleAction = 'ask' | 'block' | 'log';

/** The Composio tool tags a rule can match on. */
export type ComposioHint = 'createHint' | 'updateHint' | 'destructiveHint';

export type RulePattern =
  /** Connected-app tools carrying any of these tags, optionally only in these toolkits. */
  | { kind: 'composio-hint'; hints: ComposioHint[]; toolkits?: string[] }
  /** Connected-app tools by slug. `*` stands for any run of characters: `*_SEND*`. */
  | { kind: 'composio-tool'; tools: string[] }
  /** Shell commands on the bot's computer whose text matches this regular expression. */
  | { kind: 'computer-shell'; matchRegex: string }
  /** Every tool call the app serves. */
  | { kind: 'always' };

export type RulePresetId =
  | 'ask-before-sending'
  | 'ask-before-posting'
  | 'ask-before-deleting'
  | 'log-file-writes'
  | 'ask-before-shell';

export interface BotRule {
  id: string;
  botId: string;
  /** Plain words, shown in the settings list and on the approval card the rule raises. */
  description: string;
  pattern: RulePattern;
  action: RuleAction;
  /** The preset this rule was added from, or null for a rule the person wrote. */
  preset: RulePresetId | null;
  createdAt: number;
}

export interface RulePreset {
  id: RulePresetId;
  description: string;
  pattern: RulePattern;
  action: RuleAction;
}

export const RULE_PRESETS: readonly RulePreset[] = [
  {
    id: 'ask-before-sending',
    description: 'Ask before sending messages',
    pattern: { kind: 'composio-tool', tools: ['*_SEND*', '*_REPLY_*', '*_POST_MESSAGE*'] },
    action: 'ask',
  },
  {
    id: 'ask-before-posting',
    description: 'Ask before posting publicly',
    pattern: {
      kind: 'composio-hint',
      hints: ['createHint'],
      toolkits: ['twitter', 'linkedin', 'facebook', 'instagram', 'reddit', 'tiktok', 'youtube', 'threads', 'bluesky', 'mastodon', 'pinterest', 'medium'],
    },
    action: 'ask',
  },
  {
    id: 'ask-before-deleting',
    description: 'Ask before deleting anything',
    pattern: { kind: 'composio-hint', hints: ['destructiveHint'] },
    action: 'ask',
  },
  {
    id: 'log-file-writes',
    description: 'Log all file writes',
    pattern: { kind: 'composio-hint', hints: ['updateHint'] },
    action: 'log',
  },
  {
    id: 'ask-before-shell',
    description: 'Ask before running shell commands',
    pattern: { kind: 'computer-shell', matchRegex: '.*' },
    action: 'ask',
  },
];

/** One entry of a bot's rule log: a tool call some rule matched, and what became of it. */
export interface RuleLogEntry {
  id: number;
  botId: string;
  ruleId: string;
  ruleDescription: string;
  action: RuleAction;
  /** The tool the bot called, as the approval card names it. */
  tool: string;
  /** A short reading of the call: the command, or the app tools it would run. */
  detail: string;
  /** What became of the call: it ran, a rule or policy blocked it, or the person said no or never answered. */
  outcome: RuleOutcome;
  createdAt: number;
}

export type RuleOutcome = 'ran' | 'blocked' | 'denied' | 'expired';

/** GET /api/bots/:id/rules */
export interface RulesResponse { rules: BotRule[]; log: RuleLogEntry[] }

/** POST /api/bots/:id/rules: a preset by id, or a rule the person wrote. */
export type CreateRuleRequest =
  | { preset: RulePresetId; action?: RuleAction }
  | { description: string; pattern: RulePattern; action: RuleAction };

/** PATCH /api/bots/:id/rules/:ruleId */
export interface UpdateRuleRequest { description?: string; pattern?: RulePattern; action?: RuleAction }
