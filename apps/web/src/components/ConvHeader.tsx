import { useState } from 'react';
import type { Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { configApi } from '../lib/configApi';
import { Icon } from './Icon';
import { Menu } from './Menu';

/**
 * The conversation top bar, Teams style: identity on the left, the Chat / Files tab strip,
 * then the overflow menu and the details-panel toggle on the right.
 */
export function ConvHeader({ bot, running, activeTab, onTabChange, onNotice }: {
  bot: Bot;
  running: boolean;
  activeTab: 'chat' | 'files';
  onTabChange: (tab: 'chat' | 'files') => void;
  /** Small status message shown by the view (e.g. "started a new conversation"). */
  onNotice?: (text: string) => void;
}) {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const loadBots = useStore((s) => s.loadBots);
  const [menu, setMenu] = useState(false);
  const flash = (t: string) => onNotice?.(t);

  const handleDelete = async () => {
    if (!window.confirm(`Delete ${displayName(bot)}? This cannot be undone.`)) return;
    try {
      await configApi.deleteBot(bot.id);
      await loadBots();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not delete bot');
    }
  };

  return (
    <header className="conv-header">
      <div className="conv-header__identity">
        <button
          type="button"
          className="conv-header__pill-btn"
          onClick={() => setMenu(!menu)}
          aria-haspopup="menu"
          aria-expanded={menu}
          title="Bot options"
        >
          <span className="conv-header__avatar">
            <BotAvatarFor bot={bot} size={32} />
            <span className={`conv-header__dot${running ? ' is-working' : ''}`} aria-hidden />
          </span>
          <span className="conv-header__name">{displayName(bot)}</span>
          <Icon name="chev_down" size={12} opacity={0.6} />
        </button>
        {menu && (
          <Menu
            align="left"
            onClose={() => setMenu(false)}
            items={[
              { label: 'Edit bot', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
              { label: 'Clear chat', onSelect: () => configApi.fresh(bot.id).then(() => flash('Started a new conversation')).catch((e: Error) => flash(e.message)) },
              { label: 'Delete bot', danger: true, onSelect: handleDelete },
            ]}
          />
        )}
      </div>

      <div className="conv-header__tabs" role="tablist" aria-label="Conversation views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'chat'}
          className={`conv-tab${activeTab === 'chat' ? ' is-active' : ''}`}
          onClick={() => onTabChange('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'files'}
          className={`conv-tab${activeTab === 'files' ? ' is-active' : ''}`}
          onClick={() => onTabChange('files')}
        >
          Files
        </button>
      </div>

      <div className="conv-header__spacer" />

      <div className="conv-header__actions">
        <button
          type="button"
          className="conv-header__icon-btn"
          onClick={() => useConfigUI.getState().openBotSettings(bot.id)}
          aria-label="Bot settings"
          title="Bot settings"
        >
          <Icon name="edit" size={16} />
        </button>
        <button
          type="button"
          className={`conv-header__icon-btn${detailsOpen ? ' is-active' : ''}`}
          onClick={() => set({ detailsOpen: !detailsOpen })}
          aria-label={detailsOpen ? 'Hide details' : 'Show details'}
          aria-pressed={detailsOpen}
          title={detailsOpen ? 'Hide details (⇧⌘,)' : 'Show details (⇧⌘,)'}
        >
          <Icon name="panel" size={16} />
        </button>
      </div>
    </header>
  );
}
