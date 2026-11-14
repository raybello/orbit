import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent } from '@orbit/contracts';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Segmented } from './config/ui';
import { CreateCalendarEventModal } from './modals/CreateCalendarEventModal';
import '../styles/calendar.css';

type Mode = 'month' | 'week' | 'day';
type Status = 'loading' | 'ready' | 'error';

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d: Date) => addDays(startOfDay(d), -d.getDay());
const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

/** Local calendar day key, e.g. 2026-11-04. */
const dayKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const sameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtLongDay = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

interface Range { start: Date; end: Date; days: Date[] }

function rangeFor(mode: Mode, cursor: Date): Range {
  if (mode === 'day') {
    const start = startOfDay(cursor);
    return { start, end: addDays(start, 1), days: [start] };
  }
  if (mode === 'week') {
    const start = startOfWeek(cursor);
    return { start, end: addDays(start, 7), days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
  }
  // Month: always six weeks so the grid height never jumps between months.
  const start = startOfWeek(startOfMonth(cursor));
  return { start, end: addDays(start, 42), days: Array.from({ length: 42 }, (_, i) => addDays(start, i)) };
}

/** "November 2026", "Nov 8 – 14, 2026", "Saturday, November 14, 2026". */
function rangeLabel(mode: Mode, range: Range, cursor: Date): string {
  if (mode === 'day') return cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (mode === 'week') {
    const last = addDays(range.end, -1);
    const head = range.start.toLocaleDateString('en-US', { month: 'short' });
    const tail = last.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${head} ${range.start.getDate()} – ${tail}, ${last.getFullYear()}`;
  }
  return cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MODES: { value: Mode; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
];

/**
 * Month / week / day calendar over GET /api/calendar. Every cell is a click target that opens
 * the create-event modal for that day; events open a small details popover.
 */
export function CalendarView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const bots = useStore((s) => s.bots);
  const [mode, setMode] = useState<Mode>('month');
  const [cursor, setCursor] = useState<Date>(() => startOfDay(new Date()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState<Date | null>(null);
  const [selected, setSelected] = useState<{ ev: CalendarEvent; x: number; y: number } | null>(null);

  const range = useMemo(() => rangeFor(mode, cursor), [mode, cursor]);
  const fromIso = range.start.toISOString();
  const toIso = range.end.toISOString();

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setError(null);
    api.calendar(fromIso, toIso).then((res) => {
      if (!alive) return;
      setEvents([...res.events].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)));
      setStatus('ready');
    }).catch((e: unknown) => {
      if (!alive) return;
      setError((e as Error)?.message || 'Could not load the calendar.');
      setStatus('error');
    });
    return () => { alive = false; };
  }, [fromIso, toIso, reload]);

  const colorFor = useMemo(() => {
    const byId = new Map(bots.map((b) => [b.id, b.avatarColor]));
    return (botId: string) => byId.get(botId) ?? 'gray';
  }, [bots]);

  /** Events grouped by local day, each list already in start order. */
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const key = dayKey(new Date(ev.start));
      const list = map.get(key);
      if (list) list.push(ev); else map.set(key, [ev]);
    }
    return map;
  }, [events]);

  const today = new Date();
  const shift = (dir: -1 | 1) => {
    if (mode === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    else if (mode === 'week') setCursor(addDays(cursor, dir * 7));
    else setCursor(addDays(cursor, dir));
  };
  const goToday = () => setCursor(startOfDay(new Date()));

  const openCreate = (d: Date) => setCreating(d);
  const openEvent = (ev: CalendarEvent, e: React.MouseEvent) => {
    const box = rootRef.current?.getBoundingClientRect();
    setSelected({ ev, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
  };

  const pill = (ev: CalendarEvent, compact: boolean) => {
    const done = ev.eventType === 'one_time' && !!ev.completedAt;
    return (
      <button
        key={`${ev.routineId}-${ev.start}`}
        type="button"
        className={`cal-pill${done ? ' is-completed' : ''}${compact ? ' cal-pill--compact' : ''}`}
        style={botVars(colorFor(ev.botId))}
        onClick={(e) => { e.stopPropagation(); openEvent(ev, e); }}
        title={`${ev.title} · ${ev.botName} · ${fmtTime(ev.start)}`}
      >
        <span className="cal-pill__dot" aria-hidden />
        {!compact && <span className="cal-pill__time">{fmtTime(ev.start)}</span>}
        <span className="cal-pill__title">{ev.title}</span>
        {ev.eventType === 'one_time'
          ? <span className="cal-pill__badge" aria-label="One-time event"><Icon name="clock" size={10} /></span>
          : <span className="cal-pill__badge" aria-label="Recurring event">↻</span>}
      </button>
    );
  };

  const dayCell = (d: Date) => {
    const key = dayKey(d);
    const list = byDay.get(key) ?? [];
    const outside = d.getMonth() !== cursor.getMonth() && mode === 'month';
    return (
      <div
        key={key}
        className={`cal-cell${outside ? ' is-outside' : ''}${sameDay(d, today) ? ' is-today' : ''}`}
        data-date={key}
        onClick={() => openCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0))}
      >
        <div className="cal-cell__head">
          <span className="cal-cell__num">{d.getDate()}</span>
          <button
            type="button"
            className="cal-cell__add"
            aria-label={`New event on ${fmtLongDay(d)}`}
            onClick={(e) => { e.stopPropagation(); openCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0)); }}
          >
            <Icon name="plus" size={11} />
          </button>
        </div>
        <div className="cal-cell__events">
          {list.slice(0, 3).map((ev) => pill(ev, true))}
          {list.length > 3 && <span className="cal-cell__more">+{list.length - 3} more</span>}
        </div>
      </div>
    );
  };

  const selectedPrompt = selected
    ? (selected.ev as CalendarEvent & { prompt?: string }).prompt
    : undefined;

  return (
    <div className="cal" ref={rootRef}>
      <header className="cal-header">
        <div className="cal-header__group">
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={goToday}>Today</button>
          <div className="cal-nav">
            <button type="button" className="cfg-icon-btn" aria-label="Previous" onClick={() => shift(-1)}>
              <Icon name="chev_right" size={14} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <button type="button" className="cfg-icon-btn" aria-label="Next" onClick={() => shift(1)}>
              <Icon name="chev_right" size={14} />
            </button>
          </div>
          <div className="cal-range" aria-live="polite">{rangeLabel(mode, range, cursor)}</div>
        </div>
        <div className="cal-header__group">
          <Segmented value={mode} options={MODES} onChange={setMode} label="Calendar range" />
          <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => openCreate(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 9, 0))}>
            <Icon name="plus" size={12} />
            New event
          </button>
        </div>
      </header>

      {status === 'error' && (
        <div className="cal-error" role="alert">
          <span>{error}</span>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setReload((n) => n + 1)}>Retry</button>
        </div>
      )}
      {status === 'loading' && <div className="cal-loading" role="status">Loading events…</div>}

      <div className={`cal-body is-${mode}`}>
        {mode === 'month' && (
          <div className="cal-month" aria-label="Month view">
            <div className="cal-month__dow">
              {DOW.map((d) => <div key={d} className="cal-month__dow-cell">{d}</div>)}
            </div>
            <div className="cal-month__grid">{range.days.map(dayCell)}</div>
          </div>
        )}

        {mode === 'week' && (
          <div className="cal-week" aria-label="Week view">
            {range.days.map((d) => {
              const key = dayKey(d);
              const list = byDay.get(key) ?? [];
              return (
                <div
                  key={key}
                  className={`cal-week__col${sameDay(d, today) ? ' is-today' : ''}`}
                  data-date={key}
                  onClick={() => openCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0))}
                >
                  <div className="cal-week__head">
                    <span className="cal-week__dow">{DOW[d.getDay()]}</span>
                    <span className="cal-week__num">{d.getDate()}</span>
                    <button
                      type="button"
                      className="cal-cell__add"
                      aria-label={`New event on ${fmtLongDay(d)}`}
                      onClick={(e) => { e.stopPropagation(); openCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0)); }}
                    >
                      <Icon name="plus" size={11} />
                    </button>
                  </div>
                  <div className="cal-week__events">
                    {list.length === 0
                      ? <span className="cal-week__empty">—</span>
                      : list.map((ev) => pill(ev, false))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {mode === 'day' && (
          <div className="cal-day" aria-label="Day view">
            <div className="cal-day__head">
              <span className="cal-week__dow">{DOW[cursor.getDay()]}</span>
              <span className="cal-week__num">{cursor.getDate()}</span>
            </div>
            <div className="cal-day__rows">
              {Array.from({ length: 24 }, (_, hour) => {
                const at = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hour, 0);
                const list = (byDay.get(dayKey(at)) ?? []).filter((ev) => new Date(ev.start).getHours() === hour);
                return (
                  <div
                    key={hour}
                    className="cal-day__row"
                    data-hour={hour}
                    onClick={() => openCreate(at)}
                  >
                    <span className="cal-day__hour">{pad2(hour)}:00</span>
                    <div className="cal-day__slot">
                      {list.map((ev) => pill(ev, false))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {selected && (
        <div
          className="cal-pop"
          role="dialog"
          aria-label="Event details"
          style={{ ...botVars(colorFor(selected.ev.botId)), left: Math.max(8, Math.min(selected.x, 320)), top: Math.max(8, Math.min(selected.y, 240)) }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="cal-pop__head">
            <span className="cal-pill__dot cal-pop__dot" aria-hidden />
            <span className="cal-pop__title">{selected.ev.title}</span>
            <button type="button" className="cfg-icon-btn" aria-label="Dismiss" onClick={() => setSelected(null)}>
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="cal-pop__bot">
            <span className="cal-pill__dot" aria-hidden />
            {selected.ev.botName}
          </div>
          <div className="cal-pop__when">
            {selected.ev.eventType === 'one_time'
              ? new Date(selected.ev.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
              : `Repeats · ${selected.ev.recurrenceRule ?? 'scheduled'}`}
          </div>
          {selected.ev.completedAt && <div className="cal-pop__done">Completed</div>}
          {selectedPrompt && <div className="cal-pop__prompt">{selectedPrompt}</div>}
          <div className="cal-pop__foot">
            <span className="cal-pop__tag">{selected.ev.eventType === 'one_time' ? 'One-time' : 'Recurring'}</span>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}

      {creating && (
        <CreateCalendarEventModal
          initialDate={creating}
          onClose={() => setCreating(null)}
          onSaved={() => { setCreating(null); setReload((n) => n + 1); }}
        />
      )}
    </div>
  );
}
