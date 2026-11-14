import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bot } from '@orbit/contracts';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { api, type RoomMember } from '../lib/api';
import { useStore } from '../store';
import { BotRow, previewFor } from './BotRow';
import { Icon } from './Icon';
import { listStamp } from '../lib/time';
import '../styles/chatlist.css';

/** Row status, shared by agent rows and group rows. */
function statusOf(botId: string, live: ReturnType<typeof useStore.getState>['live'], selectedBotId: string | null) {
  const l = live[botId];
  return { selected: botId === selectedBotId, running: !!l?.isRunning, awaiting: l?.awaiting?.reason ?? null };
}

/**
 * A group chat row: overlapping member avatars, the group name, a preview line and a
 * person-count badge. Shares the `.bot-row` markup/classes with agent rows so the list
 * reads as one thing.
 */
function GroupRow({ bot, members, selected, running, awaiting, onSelect }: {
  bot: Bot;
  /** null while loading or when the member fetch failed — falls back to the group's own avatar. */
  members: RoomMember[] | null;
  selected: boolean;
  running: boolean;
  awaiting: string | null;
  onSelect: (id: string) => void;
}) {
  const shown = members?.slice(0, 3) ?? [];
  return (
    <button
      type="button"
      className={`bot-row group-row${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(bot.id)}
      aria-current={selected || undefined}
    >
      <span className="bot-row__avatar group-avatars">
        {shown.length ? shown.map((m) => (
          <span key={m.id} className="group-avatars__item">
            <BotAvatar shape={m.avatarShape} color={m.avatarColor} size={20} title={m.name} />
          </span>
        )) : <BotAvatarFor bot={bot} size={32} />}
        {running && <span className="status-dot is-working" aria-label="Working" />}
      </span>
      <span className="bot-row__text">
        <span className="bot-row__name">{bot.name}</span>
        <span className="bot-row__preview">{previewFor(bot, running, awaiting)}</span>
      </span>
      <span className="bot-row__meta">
        <span className="bot-row__time">{listStamp(bot.lastActivityAt)}</span>
        {members && members.length > 0 && (
          <span className="group-row__count" title={`${members.length} Bots`} aria-label={`${members.length} Bots in this group`}>
            {members.length}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The Chat section body: every Bot and group chat in one recency-sorted list, with a
 * search filter and the two create actions. The primary Bot is pinned above the rest.
 */
export function ChatListView() {
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => s.live);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const selectBot = useStore((s) => s.selectBot);
  const setModal = useStore((s) => s.setModal);
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<Record<string, RoomMember[]>>({});
  const [memberErrors, setMemberErrors] = useState<Record<string, boolean>>({});
  const requested = useRef<Set<string>>(new Set());

  const rooms = useMemo(() => bots.filter((b) => b.kind === 'room'), [bots]);
  const roomKey = rooms.map((r) => r.id).join(',');

  // Member lists are only needed for the avatar stack; fetch each room once, lazily.
  useEffect(() => {
    for (const id of roomKey ? roomKey.split(',') : []) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      api.roomMembers(id)
        .then((r) => setMembers((prev) => ({ ...prev, [id]: r.members })))
        .catch(() => setMemberErrors((prev) => ({ ...prev, [id]: true })));
    }
  }, [roomKey]);

  const filter = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const matched = bots.filter((b) => !filter || b.name.toLowerCase().includes(filter));
    return matched.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }, [bots, filter]);

  const primary = visible.find((b) => b.isPrimary);
  const rest = primary ? visible.filter((b) => b.id !== primary.id) : visible;

  const row = (bot: Bot) => {
    const { selected, running, awaiting } = statusOf(bot.id, live, selectedBotId);
    if (bot.kind === 'room') {
      return (
        <GroupRow
          key={bot.id}
          bot={bot}
          members={memberErrors[bot.id] ? null : members[bot.id] ?? null}
          selected={selected}
          running={running}
          awaiting={awaiting}
          onSelect={selectBot}
        />
      );
    }
    return <BotRow key={bot.id} bot={bot} selected={selected} running={running} awaiting={awaiting} onSelect={selectBot} />;
  };

  return (
    <div className="chat-list">
      <div className="chat-list__header">
        <h2 className="chat-list__title">Chat</h2>
        <div className="chat-list__actions">
          <button type="button" className="chat-list__action" onClick={() => setModal('create')} aria-label="New Bot" title="New Bot">
            <Icon name="plus" size={12} />
            <span>New Bot</span>
          </button>
          <button type="button" className="chat-list__action" onClick={() => setModal('group')} aria-label="New Group" title="New group chat">
            <Icon name="apps" size={12} />
            <span>Group</span>
          </button>
        </div>
      </div>

      <div className="chat-list__search">
        <Icon name="search" size={12} opacity={0.5} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search chats"
          spellCheck={false}
        />
        {query && (
          <button type="button" className="chat-list__clear" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="close" size={9} opacity={0.6} />
          </button>
        )}
      </div>

      <div className="chat-list__rows">
        {primary && (
          <>
            {row(primary)}
            <div className="chat-list__sep" role="separator" />
          </>
        )}
        {rest.map(row)}
      </div>

      {visible.length === 0 && (
        <div className="chat-list__empty">
          {filter ? `No chats match “${query.trim()}”.` : 'No chats yet. Start a Bot or a group.'}
        </div>
      )}
    </div>
  );
}
