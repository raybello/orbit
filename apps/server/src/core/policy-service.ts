import { db } from '../db.js';
import { innerToolCalls } from '../composio.js';
import { classifyGoogleCall, isReadOnlySlug, type ReviewCard } from '../domain/google-actions.js';
import { toolMap, humanizeSlug, type Decision, type PolicyVerdict } from '../agent/tools.js';
import { applyPolicy } from '../domain/approval-policy.js';

type ToolArgs = Record<string, unknown>;

const storedMode = (userId: string, tool: string) =>
  (db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, tool) as { mode: string } | undefined)?.mode as 'blocked' | 'always_allow' | undefined;

function trustedBot(botId: string | undefined): { botId: string; botName: string } | undefined {
  if (!botId) return undefined;
  const b = db.prepare('SELECT id, name, always_allow FROM bots WHERE id=?').get(botId) as { id: string; name: string; always_allow: number | null } | undefined;
  return b?.always_allow ? { botId: b.id, botName: b.name } : undefined;
}

const botAllows = (botId: string, tool: string) =>
  !!db.prepare('SELECT 1 FROM bot_policies WHERE bot_id=? AND tool=? COLLATE NOCASE').get(botId, tool);

export function policyFor(userId: string, toolName: string, args: ToolArgs, botId?: string): PolicyVerdict {
  const trusted = trustedBot(botId);
  const asked = (v: Omit<PolicyVerdict, 'decision'> & { decision: Decision }): PolicyVerdict =>
    v.decision === 'ask' && trusted ? { ...v, offerAlways: true, alwaysFor: trusted } : v;

  const simple = (key: string, title: string): PolicyVerdict => {
    const ruling = applyPolicy({
      storedMode: storedMode(userId, key),
      botTrusted: !!trusted,
      botPolicyAllows: trusted ? botAllows(trusted.botId, key) : false,
      googleAction: null,
      isReadOnly: false,
    });
    if (ruling.run === 'deny') return { decision: 'block', key, title };
    if (ruling.run === 'allow') return { decision: 'allow', key, title };
    return asked({ decision: 'ask', key, title });
  };

  const ownTool = toolMap.get(toolName);
  if (ownTool) {
    if (ownTool.policy !== 'needs_approval') return { decision: 'allow', key: toolName, title: toolName };
    return simple(toolName, ownTool.label);
  }

  const calls = innerToolCalls(toolName, args);
  if (!calls.length) {
    if (/^COMPOSIO_REMOTE_(WORKBENCH|BASH_TOOL)$/.test(toolName) && /run_composio_tool|proxy_execute|execute_tool|composio/i.test(JSON.stringify(args ?? {}))) {
      return simple(toolName, 'Run code that uses your connected apps');
    }
    return { decision: 'allow', key: toolName, title: toolName };
  }

  let decision: Decision = 'allow';
  let key = calls[0].slug;
  let offerAlways = true;
  let card: ReviewCard | undefined;

  for (const { slug, args: inner } of calls) {
    const action = classifyGoogleCall(slug, inner) ?? null;
    const ruling = applyPolicy({
      storedMode: storedMode(userId, slug),
      botTrusted: !!trusted,
      botPolicyAllows: trusted ? botAllows(trusted.botId, slug) : false,
      googleAction: action,
      isReadOnly: isReadOnlySlug(slug),
    });
    if (ruling.run === 'deny') return { decision: 'block', key: slug, title: humanizeSlug(slug) };
    if (ruling.run === 'allow') continue;
    decision = 'ask';
    key = slug;
    card = action?.card;
    if (action && !action.allowAlways) offerAlways = false;
  }

  return asked({
    decision,
    key,
    toolkit: key.split('_')[0].toLowerCase(),
    title: humanizeSlug(key),
    ...(decision === 'ask' ? { offerAlways, ...(card ? { card } : {}) } : {}),
  });
}

export const mayAlwaysAllow = (tool: string): boolean => classifyGoogleCall(tool, {})?.allowAlways ?? true;

export function rememberAlwaysAllow(userId: string, botId: string, tool: string): 'bot' | 'user' | null {
  if (trustedBot(botId)) {
    db.prepare('INSERT OR REPLACE INTO bot_policies(bot_id, tool, created_at) VALUES (?,?,?)').run(botId, tool, Date.now());
    return 'bot';
  }
  if (!mayAlwaysAllow(tool)) return null;
  db.prepare("INSERT OR REPLACE INTO policies(user_id,tool,mode) VALUES (?,?,'always_allow')").run(userId, tool);
  return 'user';
}
