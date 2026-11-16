import { useMemo, useState } from 'react';
import type { ActivityItem, Bot } from '@orbit/contracts';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { useConfigUI } from '../configStore';
import { groupActivity, type ActivityGroup } from '../domain/activity-feed';
import { clock, relativeShort } from '../lib/time';
import { useStore } from '../store';
import { Icon } from './Icon';
import { PageShell } from './PageShell';
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

/** Rail first, then the bot: selecting one also lands Chat on its transcript. */
function openChat(botId: string) {
  useConfigUI.getState().setNavSection('chat');
  useStore.getState().selectBot(botId);
}

/** One feed entry. A nested one sits under its group's latest entry, so it drops the bot's face and name. */
function ActivityRow({ item, bot, nested = false }: { item: ActivityItem; bot: Bot | undefined; nested?: boolean }) {
  const name = bot?.name ?? item.botName;
  const tag = TAG[item.kind];
  const time = <span className="activity-item__time" title={clock(item.at)}>{ago(item.at)}</span>;
  return (
    <button
      type="button"
      className={`activity-item is-${item.kind}${nested ? ' activity-item--nested' : ''}`}
      onClick={() => openChat(item.botId)}
      title={`Open ${name}`}
    >
      {!nested && (
        <span className="activity-item__avatar">
          {bot ? <BotAvatarFor bot={bot} size={28} /> : <BotAvatar shape="blob" color="gray" size={28} />}
        </span>
      )}
      <span className="activity-item__text">
        {!nested && (
          <span className="activity-item__top">
            <span className="activity-item__name">{name}</span>
            {time}
          </span>
        )}
        <span className="activity-item__preview">{item.preview}</span>
      </span>
      {nested && time}
      {tag && <span className={`activity-item__tag is-${item.kind}`}>{tag}</span>}
    </button>
  );
}

/** A run from one bot: its latest entry, and a toggle that shows the earlier ones. */
function ActivityRun({ group, bot, open, onToggle }: { group: ActivityGroup; bot: Bot | undefined; open: boolean; onToggle: () => void }) {
  const [latest, ...earlier] = group.items;
  if (!earlier.length) return <ActivityRow item={latest} bot={bot} />;
  const name = bot?.name ?? latest.botName;
  const listId = `activity-run-${group.key}`;
  return (
    <div className={`activity-group${open ? ' is-open' : ''}`}>
      <div className="activity-group__head">
        <ActivityRow item={latest} bot={bot} />
        <button
          type="button"
          className="activity-group__toggle"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${open ? 'Hide' : 'Show'} ${earlier.length} earlier from ${name}`}
          onClick={onToggle}
        >
          <span className="activity-group__count">{group.items.length}</span>
          <Icon name="chev_down" size={12} opacity={0.7} />
        </button>
      </div>
      {open && (
        <div className="activity-group__items" id={listId} role="group" aria-label={`Earlier from ${name}`}>
          {earlier.map((item) => <ActivityRow key={`${item.kind}:${item.seq ?? item.at}`} item={item} bot={bot} nested />)}
        </div>
      )}
    </div>
  );
}

/**
 * The cross-bot Activity feed (rail → Activity). Everything here comes from `recentActivity`,
 * which store.ts derives from SSE rows and live turn changes, so nothing is fetched. Consecutive
 * entries from one bot fold into a run that starts collapsed.
 */
export function ActivityView() {
  const items = useStore((s) => s.recentActivity);
  const bots = useStore((s) => s.bots);
  const [filter, setFilter] = useState<Filter>('all');
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());

  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);

  const shown = useMemo(() => {
    const list = filter === 'all' ? items : items.filter((a) => a.kind === filter);
    return [...list].sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0));
  }, [items, filter]);
  const runs = useMemo(() => groupActivity(shown), [shown]);

  const toggle = (key: string) => setOpenRuns((cur) => {
    const next = new Set(cur);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <PageShell title="Activity" meta={shown.length > 0 ? shown.length : undefined}>
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
          {runs.map((g) => (
            <ActivityRun key={g.key} group={g} bot={byId.get(g.botId)} open={openRuns.has(g.key)} onToggle={() => toggle(g.key)} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
