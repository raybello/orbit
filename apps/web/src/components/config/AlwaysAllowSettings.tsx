import { useEffect, useState } from 'react';
import type { Bot } from '@orbit/contracts';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';
import { humanizeToolkit } from '../cards/Cards';
import { Switch } from './ui';

/** "GMAIL_SEND_EMAIL" → "Gmail: send email". */
const actionName = (tool: string) => {
  const [app, ...rest] = tool.split('_');
  return rest.length ? `${humanizeToolkit(app.toLowerCase())}: ${rest.join(' ').toLowerCase()}` : tool;
};

/**
 * Per-bot "Always allow". Off by default. While it is on, this Bot's approval cards offer
 * "Always allow for <Bot>" on any action, sending email included, and what the person allows is
 * kept for this Bot only. Turning it off keeps the list and stops using it.
 */
export function AlwaysAllowSection({ bot, onNote }: { bot: Bot; onNote: (text: string, tone?: 'ok' | 'error') => void }) {
  const on = bot.alwaysAllow === true;
  const [policies, setPolicies] = useState<{ tool: string; createdAt: number }[] | null>(null);

  useEffect(() => {
    configApi.botPolicies(bot.id).then((r) => setPolicies(r.policies)).catch((e) => onNote((e as Error).message, 'error'));
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (alwaysAllow: boolean) => useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, alwaysAllow } : b)) }));
  const toggle = async (next: boolean) => {
    apply(next);
    try {
      await configApi.updateBot(bot.id, { alwaysAllow: next });
      onNote(next ? `${bot.name} can now be always-allowed` : `${bot.name} asks again for everything`);
    } catch (e) {
      apply(!next);
      onNote((e as Error).message, 'error');
    }
  };
  const remove = async (tool: string) => {
    try {
      await configApi.removeBotPolicy(bot.id, tool);
      setPolicies((p) => (p ?? []).filter((x) => x.tool !== tool));
      onNote('Removed');
    } catch (e) {
      onNote((e as Error).message, 'error');
    }
  };

  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Permissions</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Always allow for {bot.name}</div>
            <div className="cfg-row__sub">
              {on
                ? `${bot.name}'s approval cards offer “Always allow for ${bot.name}”, sending email included. What you allow applies to ${bot.name} only.`
                : `Off: ${bot.name} asks before every action that needs approval, and never sends email without asking.`}
            </div>
          </div>
          <Switch on={on} onChange={(v) => void toggle(v)} label={`Always allow for ${bot.name}`} />
        </div>
        {policies && policies.length > 0 && policies.map((p) => (
          <div className="cfg-row" key={p.tool}>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{actionName(p.tool)}</div>
              <div className="cfg-row__sub">{on ? 'Runs without asking' : 'Kept, not used while the setting is off'} · <code className="cfg-code">{p.tool}</code></div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void remove(p.tool)}>Remove</button>
          </div>
        ))}
      </div>
    </section>
  );
}
