import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent, GoogleCalendarEvent, GoogleCalendarInfo, GoogleCalendarState } from '@orbit/contracts';
import { api } from '../lib/api';
import { botVars } from '../lib/colors';
import { useStore } from '../store';
import { Icon } from './Icon';
import { PageShell } from './PageShell';
import { Segmented } from './config/ui';
import { CreateCalendarEventModal, type DuplicateFrom } from './modals/CreateCalendarEventModal';
import { GoogleEventModal, type GoogleEventIntent } from './modals/GoogleEventModal';
import { daysOf } from '../lib/eventTime';
import '../styles/calendar.css';

type Mode = 'month' | 'week' | 'day';
/** One thing on the calendar: a Bot's Orbit event (a routine), or one of the person's Google events. */
type Item = { kind: 'orbit'; ev: CalendarEvent; start: string } | { kind: 'google'; ev: GoogleCalendarEvent; start: string };
/** The filter chip for Google events; bots are filtered by their id. */
const GOOGLE = 'google';
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
  const [google, setGoogle] = useState<GoogleCalendarEvent[]>([]);
  const [googleState, setGoogleState] = useState<GoogleCalendarState | null>(null);
  const [calendars, setCalendars] = useState<GoogleCalendarInfo[]>([]);
  const [selectedGoogle, setSelectedGoogle] = useState<{ ev: GoogleCalendarEvent; x: number; y: number } | null>(null);
  const [googleIntent, setGoogleIntent] = useState<GoogleEventIntent | null>(null);
  const [choosing, setChoosing] = useState<Date | null>(null);
  const [duplicating, setDuplicating] = useState<DuplicateFrom | null>(null);
  const [dupError, setDupError] = useState<string | null>(null);
  const [showCalendars, setShowCalendars] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const calendarVersion = useStore((s) => s.calendarVersion);

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
      setGoogle(res.google ?? []);
      setGoogleState(res.googleState ?? null);
      setStatus('ready');
    }).catch((e: unknown) => {
      if (!alive) return;
      setError((e as Error)?.message || 'Could not load the calendar.');
      setStatus('error');
    });
    return () => { alive = false; };
  }, [fromIso, toIso, reload, calendarVersion]);

  // The person's Google calendars, for the calendar picker and the on/off list.
  useEffect(() => {
    if (!googleState?.connected) { setCalendars([]); return; }
    api.googleCalendars().then((r) => setCalendars(r.calendars)).catch(() => setCalendars([]));
  }, [googleState?.connected, calendarVersion]);

  const colorFor = useMemo(() => {
    const byId = new Map(bots.map((b) => [b.id, b.avatarColor]));
    return (botId: string) => byId.get(botId) ?? 'gray';
  }, [bots]);

  const byDay = useMemo(() => {
    const map = new Map<string, Item[]>();
    const add = (key: string, item: Item) => { const list = map.get(key); if (list) list.push(item); else map.set(key, [item]); };
    for (const ev of events) if (!hidden.has(ev.botId)) add(dayKey(new Date(ev.start)), { kind: 'orbit', ev, start: ev.start });
    if (!hidden.has(GOOGLE)) for (const ev of google) for (const key of daysOf(ev.start, ev.end, ev.allDay, dayKey)) add(key, { kind: 'google', ev, start: ev.allDay ? `${key}T00:00:00` : ev.start });
    for (const list of map.values()) list.sort((a, b) => {
      const allA = a.kind === 'google' && a.ev.allDay ? 0 : 1;
      const allB = b.kind === 'google' && b.ev.allDay ? 0 : 1;
      return allA - allB || new Date(a.start).getTime() - new Date(b.start).getTime();
    });
    return map;
  }, [events, google, hidden]);
  const toggleFilter = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const reloadAll = () => setReload((n) => n + 1);

  const today = new Date();
  const shift = (dir: -1 | 1) => {
    if (mode === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    else if (mode === 'week') setCursor(addDays(cursor, dir * 7));
    else setCursor(addDays(cursor, dir));
  };
  const goToday = () => setCursor(startOfDay(new Date()));

  // With Google Calendar connected, a new event can be either kind; ask which.
  const openCreate = (d: Date) => (googleState?.connected && googleState.available ? setChoosing(d) : setCreating(d));
  const openEvent = (ev: CalendarEvent, e: React.MouseEvent) => {
    const box = rootRef.current?.getBoundingClientRect();
    setSelectedGoogle(null);
    setSelected({ ev, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
  };
  const openGoogle = (ev: GoogleCalendarEvent, e: React.MouseEvent) => {
    const box = rootRef.current?.getBoundingClientRect();
    setSelected(null);
    setSelectedGoogle({ ev, x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) });
  };

  /** A Google event: outlined in its calendar's colour, with its real start and end. */
  const googlePill = (ev: GoogleCalendarEvent, compact: boolean) => (
    <button
      key={`g-${ev.key}`}
      type="button"
      className={`cal-pill cal-pill--google${compact ? ' cal-pill--compact' : ''}`}
      style={{ ['--cal-color' as string]: ev.color ?? 'var(--accent-500)' }}
      onClick={(e) => { e.stopPropagation(); openGoogle(ev, e); }}
      title={`${ev.title || 'Untitled'} · ${ev.calendarName} · ${ev.allDay ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`}`}
    >
      {!compact && <span className="cal-pill__time">{ev.allDay ? 'All day' : `${fmtTime(ev.start)}–${fmtTime(ev.end)}`}</span>}
      <span className="cal-pill__title">{ev.title || 'Untitled'}</span>
      <span className="cal-pill__badge" aria-label="Google Calendar event">G</span>
    </button>
  );
  const itemPill = (it: Item, compact: boolean) => (it.kind === 'orbit' ? pill(it.ev, compact) : googlePill(it.ev, compact));

  const pill = (ev: CalendarEvent, compact: boolean) => {
    const done = ev.eventType === 'one_time' && !!ev.completedAt;
    return (
      <button
        key={`${ev.routineId}-${ev.start}`}
        type="button"
        className={`cal-pill${done ? ' is-completed' : ''}${ev.paused ? ' is-paused' : ''}${compact ? ' cal-pill--compact' : ''}`}
        style={botVars(colorFor(ev.botId))}
        onClick={(e) => { e.stopPropagation(); openEvent(ev, e); }}
        title={`${ev.title} · ${ev.botName} · ${fmtTime(ev.start)}${ev.paused ? ' · paused' : ''}`}
      >
        <span className="cal-pill__dot" aria-hidden />
        {!compact && <span className="cal-pill__time">{fmtTime(ev.start)}</span>}
        <span className="cal-pill__title">{ev.title}</span>
        {ev.paused && <span className="cal-pill__paused">Paused</span>}
        {ev.parentTitle && <span className="cal-pill__parent" aria-label={`Made from the Google event ${ev.parentTitle}`} title={`Follows “${ev.parentTitle}”`}>↗</span>}
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
          {list.slice(0, 3).map((it) => itemPill(it, true))}
          {list.length > 3 && <span className="cal-cell__more">+{list.length - 3} more</span>}
        </div>
      </div>
    );
  };

  const selectedPrompt = selected
    ? (selected.ev as CalendarEvent & { prompt?: string }).prompt
    : undefined;

  const newEvent = (
    <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => openCreate(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 9, 0))}>
      <Icon name="plus" size={12} />
      New event
    </button>
  );

  return (
    <PageShell title="Calendar" actions={newEvent} className="cal-page">
      <div className="cal" ref={rootRef}>
        <div className="cal-toolbar">
          <div className="cal-toolbar__group">
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
          <Segmented value={mode} options={MODES} onChange={setMode} label="Calendar range" />
        </div>

        {status === 'error' && (
          <div className="cal-error" role="alert">
            <span>{error}</span>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setReload((n) => n + 1)}>Retry</button>
          </div>
        )}
        {status === 'loading' && <div className="cal-loading" role="status">Loading events…</div>}

        <div className="cal-filters" role="group" aria-label="Show on the calendar">
          {googleState?.connected && (
            <button type="button" className={`cal-chip cal-chip--google${hidden.has(GOOGLE) ? ' is-off' : ''}`} aria-pressed={!hidden.has(GOOGLE)} onClick={() => toggleFilter(GOOGLE)}>
              <span className="cal-chip__swatch" aria-hidden /> Google Calendar
            </button>
          )}
          {bots.filter((b) => b.kind !== 'room').map((b) => (
            <button key={b.id} type="button" className={`cal-chip${hidden.has(b.id) ? ' is-off' : ''}`} style={botVars(colorFor(b.id))} aria-pressed={!hidden.has(b.id)} onClick={() => toggleFilter(b.id)}>
              <span className="cal-pill__dot" aria-hidden /> {b.name}
            </button>
          ))}
          {googleState?.connected && (
            <button type="button" className="cal-chip cal-chip--settings" aria-expanded={showCalendars} onClick={() => setShowCalendars((v) => !v)}>Calendars…</button>
          )}
        </div>
        {googleState && !googleState.available && googleState.reason && <div className="cal-note" role="note">{googleState.reason}</div>}
        {googleState?.lastError && <div className="cal-note" role="note">{googleState.lastError}</div>}
        {showCalendars && (
          <div className="cal-calendars" role="dialog" aria-label="Google calendars">
            <div className="cal-calendars__head">Google calendars shown here</div>
            {calendars.map((c) => (
              <label key={c.key} className="cal-calendars__row">
                <input type="checkbox" checked={c.enabled} onChange={(e) => {
                  const enabled = e.target.checked;
                  setCalendars((list) => list.map((x) => (x.key === c.key ? { ...x, enabled } : x)));
                  void api.setGoogleCalendar(c.key, enabled).then(reloadAll).catch(() => setCalendars((list) => list.map((x) => (x.key === c.key ? { ...x, enabled: !enabled } : x))));
                }} />
                <span className="cal-chip__swatch" style={{ background: c.color ?? 'var(--accent-500)' }} aria-hidden />
                {c.name}{c.primary ? ' (main)' : ''}
              </label>
            ))}
            <div className="cal-calendars__foot">
              {googleState?.lastSyncAt ? `Synced ${new Date(googleState.lastSyncAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'Not synced yet'}
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void api.syncGoogle().then(reloadAll).catch(() => {})}>Sync now</button>
            </div>
          </div>
        )}

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
                        : list.map((it) => itemPill(it, false))}
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
              {(byDay.get(dayKey(cursor)) ?? []).some((it) => it.kind === 'google' && it.ev.allDay) && (
                <div className="cal-day__allday">
                  <span className="cal-day__hour">All day</span>
                  <div className="cal-day__slot">{(byDay.get(dayKey(cursor)) ?? []).filter((it) => it.kind === 'google' && it.ev.allDay).map((it) => itemPill(it, false))}</div>
                </div>
              )}
              <div className="cal-day__rows">
                {Array.from({ length: 24 }, (_, hour) => {
                  const at = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), hour, 0);
                  const list = (byDay.get(dayKey(at)) ?? []).filter((it) => !(it.kind === 'google' && it.ev.allDay) && new Date(it.start).getHours() === hour);
                  return (
                    <div
                      key={hour}
                      className="cal-day__row"
                      data-hour={hour}
                      onClick={() => openCreate(at)}
                    >
                      <span className="cal-day__hour">{pad2(hour)}:00</span>
                      <div className="cal-day__slot">
                        {list.map((it) => itemPill(it, false))}
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
            {selected.ev.parentTitle && <div className="cal-pop__parent">Made from your Google event “{selected.ev.parentTitle}”{selected.ev.eventType === 'one_time' ? ', and moves with it' : ''}.</div>}
            {selected.ev.completedAt && <div className="cal-pop__done">Completed</div>}
            {selectedPrompt && <div className="cal-pop__prompt">{selectedPrompt}</div>}
            <div className="cal-pop__foot">
              <span className="cal-pop__tag">{selected.ev.eventType === 'one_time' ? 'One-time' : 'Recurring'}</span>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
        )}

        {selectedGoogle && (
          <div
            className="cal-pop cal-pop--google"
            role="dialog"
            aria-label="Google event details"
            style={{ ['--cal-color' as string]: selectedGoogle.ev.color ?? 'var(--accent-500)', left: Math.max(8, Math.min(selectedGoogle.x, 320)), top: Math.max(8, Math.min(selectedGoogle.y, 240)) }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cal-pop__head">
              <span className="cal-pop__swatch" aria-hidden />
              <span className="cal-pop__title">{selectedGoogle.ev.title || 'Untitled'}</span>
              <button type="button" className="cfg-icon-btn" aria-label="Dismiss" onClick={() => setSelectedGoogle(null)}><Icon name="close" size={12} /></button>
            </div>
            <div className="cal-pop__bot">{selectedGoogle.ev.calendarName} · Google Calendar{selectedGoogle.ev.recurring ? ' · repeats' : ''}</div>
            <div className="cal-pop__when">
              {selectedGoogle.ev.allDay
                ? `${new Date(selectedGoogle.ev.start.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · All day`
                : `${new Date(selectedGoogle.ev.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${fmtTime(selectedGoogle.ev.end)}`}
            </div>
            {selectedGoogle.ev.location && <div className="cal-pop__prompt">{selectedGoogle.ev.location}</div>}
            {selectedGoogle.ev.attendees.length > 0 && <div className="cal-pop__prompt">With {selectedGoogle.ev.attendees.join(', ')}</div>}
            {dupError && <div className="card__error" role="alert">{dupError}</div>}
            {selectedGoogle.ev.meetLink && <a className="cal-pop__link" href={selectedGoogle.ev.meetLink} target="_blank" rel="noreferrer">Join Google Meet</a>}
            <div className="cal-pop__foot">
              {selectedGoogle.ev.htmlLink && <a className="cal-pop__link" href={selectedGoogle.ev.htmlLink} target="_blank" rel="noreferrer">Open in Google</a>}
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => {
                const ev = selectedGoogle.ev;
                setDupError(null);
                api.duplicateDefaults(ev.key).then((defaults) => { setDuplicating({ key: ev.key, defaults }); setSelectedGoogle(null); }).catch((e) => setDupError((e as Error).message));
              }}>Duplicate as Orbit event</button>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => { setGoogleIntent({ kind: 'delete', event: selectedGoogle.ev }); setSelectedGoogle(null); }}>Delete</button>
              <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => { setGoogleIntent({ kind: 'edit', event: selectedGoogle.ev }); setSelectedGoogle(null); }}>Edit</button>
            </div>
          </div>
        )}

        {choosing && (
          <div className="cal-chooser" role="dialog" aria-label="New event">
            <div className="cal-chooser__title">New event on {fmtLongDay(choosing)}</div>
            <button type="button" className="cal-chooser__option" onClick={() => { setCreating(choosing); setChoosing(null); }}>
              <strong>Orbit event</strong><span>A Bot does something at this time (a one-time or repeating routine).</span>
            </button>
            <button type="button" className="cal-chooser__option" onClick={() => { setGoogleIntent({ kind: 'create', date: choosing }); setChoosing(null); }}>
              <strong>Google Calendar event</strong><span>An event in your own Google Calendar. No Bot involved.</span>
            </button>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setChoosing(null)}>Cancel</button>
          </div>
        )}

        {googleIntent && (
          <GoogleEventModal intent={googleIntent} calendars={calendars.filter((c) => c.enabled)} onClose={() => setGoogleIntent(null)} onSaved={() => { setGoogleIntent(null); reloadAll(); }} />
        )}

        {duplicating && (
          <CreateCalendarEventModal
            initialDate={new Date(duplicating.defaults.start)}
            duplicate={duplicating}
            onClose={() => setDuplicating(null)}
            onSaved={() => { setDuplicating(null); reloadAll(); }}
          />
        )}

        {creating && (
          <CreateCalendarEventModal
            initialDate={creating}
            onClose={() => setCreating(null)}
            onSaved={() => { setCreating(null); setReload((n) => n + 1); }}
          />
        )}
      </div>
    </PageShell>
  );
}
