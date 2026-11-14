import { useMemo, useState } from 'react';
import type { ActivityItem } from '@orbit/contracts';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { useConfigUI } from '../configStore';
import { clock, relativeShort } from '../lib/time';
import { useStore } from '../store';
import '../styles/activity.css';

type Filter = 'all' | 'message' | 'card';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'message', label: 'Messages' },
  { id: 'card', label: 'Needs attention' },
];

/** Small right-hand label for the kinds that are not just a message. */
const TAG: Partial<Record<ActivityItem['kind'], string>> = { card: 'Needs you', working: 'Working', completed: 'Done' };

function ago(at: number): string {
  const r = relativeShort(at);
  return r === 'now' ? 'now' : r === 'Yesterday' ? 'Yesterday' : `${r} ago`;
}

/**
 * The cross-bot Activity feed (rail → Activity). Everything here comes from `recentActivity`,
 * which store.ts derives from SSE rows and live turn changes, so nothing is fetched.
 */
export function ActivityView() {
  const items = useStore((s) => s.recentActivity);
  const bots = useStore((s) => s.bots);
  const [filter, setFilter] = useState<Filter>('all');

  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);

  const shown = useMemo(() => {
    const list = filter === 'all' ? items : items.filter((a) => a.kind === filter);
    return [...list].sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0));
  }, [items, filter]);

  /** Rail first, then the bot: selecting one also lands Chat on its transcript. */
  const open = (botId: string) => {
    useConfigUI.getState().setNavSection('chat');
    useStore.getState().selectBot(botId);
  };

  return (
    <div className="activity">
      <header className="activity__header">
        <h2 className="activity__title">Activity</h2>
        {shown.length > 0 && <span className="activity__count">{shown.length}</span>}
      </header>

      <div className="activity__filters" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`activity__filter${filter === f.id ? ' is-active' : ''}`}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="activity__empty">
          {items.length === 0
            ? 'Nothing yet — messages and questions from your Bots show up here.'
            : 'Nothing matches this filter.'}
        </p>
      ) : (
        <div className="activity__list">
          {shown.map((a, i) => {
            const bot = byId.get(a.botId);
            const name = bot?.name ?? a.botName;
            const tag = TAG[a.kind];
            return (
              <button
                key={`${a.botId}:${a.kind}:${a.seq ?? a.at}:${i}`}
                type="button"
                className={`activity-item is-${a.kind}`}
                onClick={() => open(a.botId)}
                title={`Open ${name}`}
              >
                <span className="activity-item__avatar">
                  {bot ? <BotAvatarFor bot={bot} size={28} /> : <BotAvatar shape="blob" color="gray" size={28} />}
                </span>
                <span className="activity-item__text">
                  <span className="activity-item__top">
                    <span className="activity-item__name">{name}</span>
                    <span className="activity-item__time" title={clock(a.at)}>{ago(a.at)}</span>
                  </span>
                  <span className="activity-item__preview">{a.preview}</span>
                </span>
                {tag && <span className={`activity-item__tag is-${a.kind}`}>{tag}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
