import { memo } from 'react';
import type { Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName } from '../store';
import { listStamp } from '../lib/time';

/** One line of context under a bot's name: what it needs, or its last message. */
export function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return `Waiting for you: ${awaiting}`;
  if (running && !bot.lastPreview) return 'Working…';
  return bot.lastPreview ?? 'No messages yet';
}

/** A row in a bot list: avatar with a live status dot, name, preview line, time and unread count. */
export const BotRow = memo(function BotRow({ bot, selected, running, awaiting, onSelect }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-current={selected || undefined}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={32} />
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
        )}
      </span>
      <span className="bot-row__text">
        <span className="bot-row__name">{displayName(bot)}</span>
        <span className="bot-row__preview">{previewFor(bot, running, awaiting)}</span>
      </span>
      <span className="bot-row__meta">
        <span className="bot-row__time">{listStamp(bot.lastActivityAt)}</span>
        {bot.unread > 0 && <span className="bot-row__unread" aria-label={`${bot.unread} unread`}>{bot.unread > 99 ? '99+' : bot.unread}</span>}
      </span>
    </button>
  );
});
