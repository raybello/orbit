import type { BotRule, CreateRuleRequest, RulesResponse, UpdateRuleRequest } from '@orbit/contracts';
import { req } from './api';

/** A bot's auto-review rules and the log of what they matched. */
export const rulesApi = {
  list: (botId: string) => req<RulesResponse>('GET', `/bots/${botId}/rules`),
  create: (botId: string, rule: CreateRuleRequest) => req<{ rule: BotRule }>('POST', `/bots/${botId}/rules`, rule),
  update: (botId: string, ruleId: string, patch: UpdateRuleRequest) => req<{ rule: BotRule }>('PATCH', `/bots/${botId}/rules/${ruleId}`, patch),
  remove: (botId: string, ruleId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}/rules/${ruleId}`),
};
