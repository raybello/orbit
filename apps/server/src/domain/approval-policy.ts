/**
 * Pure precedence logic for the approval gate. No DB access, no imports from outside the domain.
 * The service layer (core/policy-service.ts) supplies the facts and translates the ruling back to
 * a PolicyVerdict.
 *
 * Precedence, strongest first:
 *   1. policies row "blocked" → deny
 *   2. bot_policies row (per-bot always-allow for this action) → allow
 *   3. policies row "always_allow" (unless the action never allows blanket permission) → allow
 *   4. catalogue default (Google action kind / isReadOnly) → allow or ask
 */

export interface PolicyFacts {
  storedMode: 'blocked' | 'always_allow' | undefined;
  botTrusted: boolean;
  botPolicyAllows: boolean;
  googleAction: { kind: string; allowAlways: boolean } | null;
  isReadOnly: boolean;
}

export interface Decision {
  run: 'allow' | 'ask' | 'deny';
  source: string;
}

export function applyPolicy(facts: PolicyFacts): Decision {
  if (facts.storedMode === 'blocked') return { run: 'deny', source: 'policies.blocked' };
  if (facts.botTrusted && facts.botPolicyAllows) return { run: 'allow', source: 'bot_policies' };

  const mode = resolveMode(facts);
  if (mode === 'allow') {
    return { run: 'allow', source: facts.storedMode === 'always_allow' ? 'policies.always_allow' : 'catalogue' };
  }
  return { run: 'ask', source: 'default' };
}

function resolveMode(facts: PolicyFacts): 'allow' | 'ask' {
  if (facts.storedMode === 'always_allow') {
    return facts.googleAction?.allowAlways === false ? 'ask' : 'allow';
  }
  if (facts.googleAction) return facts.googleAction.kind === 'review' ? 'ask' : 'allow';
  return facts.isReadOnly ? 'allow' : 'ask';
}
