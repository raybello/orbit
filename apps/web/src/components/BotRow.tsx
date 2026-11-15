import { memo } from 'react';
import type { Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName } from '../domain/transcript-utils';
import { PrimaryStar } from './PrimaryStar';
import { listStamp } from '../lib/time';

export function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return `Waiting for you: ${awaiting}`;
  if (running && !bot.lastPreview) return 'Working…';
  return bot.lastPreview ?? 'No messages yet';
}

export const BotRow = memo(function BotRow({ bot, selected, running, awaiting, onSelect }: { bot: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-current={selected || undefined}>
      <span className="bot-row__avatar">
        <BotAvatarFor bot={bot} size={32} />
        {bot.isPrimary && <PrimaryStar />}
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
