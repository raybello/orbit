import { useEffect, useState } from 'react';
import type { CardBody, EventEdits, EventFields, EventReview } from '@orbit/contracts';
import { api } from '../../lib/api';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';

/**
 * The Event card: a Google Calendar change waiting for the person. It shows the event as it will be
 * (and, for a change, what it was), asks which events a change to a repeating event applies to, and
 * whether guests are told. Creates and changes can be edited before allowing.
 */

type ApprovalCardBody = Extract<CardBody, { card: 'approval' }>;
const CAL_LOGO = 'https://logos.composio.dev/api/googlecalendar';
const EDIT_PING_MS = 5 * 60_000;

const ACTION_LABEL: Record<EventReview['action'], string> = {
  create: 'New event', update: 'Change to an event', delete: 'Delete an event', quick_add: 'Quick add', remove_attendee: 'Remove a guest', move: 'Move to another calendar',
};
const SCOPES: { value: 'this' | 'following' | 'all'; label: string }[] = [
  { value: 'this', label: 'This event' },
  { value: 'following', label: 'This and following' },
  { value: 'all', label: 'All events' },
];

/** "2026-11-19T15:00" read as wall-clock time (no timezone conversion: it already is the event's). */
const asDate = (local: string) => new Date(`${local.length === 10 ? `${local}T00:00` : local}:00Z`);
const day = (local: string) => asDate(local).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const time = (local: string) => asDate(local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/** "Thu, Nov 19 · 3:00 PM – 3:30 PM", "Thu, Dec 24 – Fri, Dec 25 · All day". */
export function whenOf(f: Pick<EventFields, 'start' | 'end' | 'allDay'>): string {
  if (!f.start) return 'No time set';
  if (f.allDay) return `${day(f.start)}${f.end && f.end.slice(0, 10) !== f.start.slice(0, 10) ? ` – ${day(f.end)}` : ''} · All day`;
  const sameDay = f.end.slice(0, 10) === f.start.slice(0, 10);
  return `${day(f.start)} · ${time(f.start)} – ${sameDay ? '' : `${day(f.end)} `}${time(f.end)}`;
}

const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Only what the person changed, in the shape the server checks. */
function editsOf(review: EventReview, f: EventFields | undefined, scope: string | undefined, notify: boolean): EventEdits | undefined {
  const out: EventEdits = {};
  if (f && review.fields) {
    for (const k of ['summary', 'description', 'location', 'start', 'end', 'allDay', 'timezone', 'meet'] as const) {
      if (f[k] !== review.fields[k]) (out as Record<string, unknown>)[k] = f[k];
    }
    if (f.attendees.join(',') !== review.fields.attendees.join(',')) out.attendees = f.attendees;
  }
  if (scope && review.recurring && scope !== review.recurring.scope) out.scope = scope as EventEdits['scope'];
  if (notify !== review.notifyGuests) out.notifyGuests = notify;
  return Object.keys(out).length ? out : undefined;
}

function Line({ icon, children, was }: { icon: string; children: React.ReactNode; was?: string }) {
  return (
    <div className="event-card__line">
      <span className="event-card__icon" aria-hidden="true">{icon}</span>
      <span className="event-card__value">
        {children}
        {was !== undefined && <span className="event-card__was">was {was || 'empty'}</span>}
      </span>
    </div>
  );
}

function EventView({ f, before, deleting }: { f: EventFields; before?: EventFields; deleting: boolean }) {
  const changed = (a: string, b: string | undefined) => (before && !deleting && a !== b ? b : undefined);
  const when = whenOf(f);
  return (
    <div className={`event-card__content${deleting ? ' is-deleting' : ''}`}>
      <div className="event-card__summary">{f.summary || 'Untitled event'}{before && !deleting && f.summary !== before.summary && <span className="event-card__was">was {before.summary || 'untitled'}</span>}</div>
      <Line icon="🕑" was={changed(when, before ? whenOf(before) : undefined)}>{when}{!f.allDay && f.start && <span className="event-card__tz"> {f.timezone}</span>}</Line>
      {(f.location || before?.location) && <Line icon="📍" was={changed(f.location, before?.location)}>{f.location || 'No location'}</Line>}
      {(f.attendees.length > 0 || (before?.attendees.length ?? 0) > 0) && (
        <Line icon="👥" was={changed(f.attendees.join(', '), before?.attendees.join(', '))}>{f.attendees.length ? f.attendees.join(', ') : 'No guests'}</Line>
      )}
      {f.meet && <Line icon="🎥">Google Meet link</Line>}
      {f.description && <div className="event-card__description">{f.description}</div>}
    </div>
  );
}

function EventEditor({ f, onChange, idBase }: { f: EventFields; onChange: (f: EventFields) => void; idBase: string }) {
  const put = <K extends keyof EventFields>(k: K, v: EventFields[K]) => onChange({ ...f, [k]: v });
  const setAllDay = (allDay: boolean) => onChange({ ...f, allDay, start: allDay ? f.start.slice(0, 10) : `${f.start.slice(0, 10)}T09:00`, end: allDay ? f.end.slice(0, 10) : `${f.end.slice(0, 10)}T09:30` });
  const kind = f.allDay ? 'date' : 'datetime-local';
  return (
    <div className="event-card__content is-editing">
      <label className="event-card__field" htmlFor={`${idBase}-title`}><span>Title</span>
        <input id={`${idBase}-title`} className="text-input" value={f.summary} onChange={(e) => put('summary', e.target.value)} />
      </label>
      <label className="event-card__check" htmlFor={`${idBase}-allday`}>
        <input id={`${idBase}-allday`} type="checkbox" checked={f.allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
      </label>
      <div className="event-card__times">
        <label className="event-card__field" htmlFor={`${idBase}-start`}><span>Starts</span>
          <input id={`${idBase}-start`} className="text-input" type={kind} value={f.start} onChange={(e) => put('start', e.target.value)} />
        </label>
        <label className="event-card__field" htmlFor={`${idBase}-end`}><span>Ends</span>
          <input id={`${idBase}-end`} className="text-input" type={kind} value={f.end} onChange={(e) => put('end', e.target.value)} />
        </label>
      </div>
      {!f.allDay && (
        <label className="event-card__field" htmlFor={`${idBase}-tz`}><span>Timezone</span>
          <input id={`${idBase}-tz`} className="text-input" value={f.timezone} onChange={(e) => put('timezone', e.target.value)} placeholder="America/Toronto" />
        </label>
      )}
      <label className="event-card__field" htmlFor={`${idBase}-where`}><span>Location</span>
        <input id={`${idBase}-where`} className="text-input" value={f.location} onChange={(e) => put('location', e.target.value)} />
      </label>
      <label className="event-card__field" htmlFor={`${idBase}-guests`}><span>Guests</span>
        <input id={`${idBase}-guests`} className="text-input" value={f.attendees.join(', ')} onChange={(e) => put('attendees', split(e.target.value))} placeholder="name@example.com, …" />
      </label>
      <label className="event-card__check" htmlFor={`${idBase}-meet`}>
        <input id={`${idBase}-meet`} type="checkbox" checked={f.meet} onChange={(e) => put('meet', e.target.checked)} /> Add a Google Meet link
      </label>
      <label className="event-card__field" htmlFor={`${idBase}-desc`}><span>Description</span>
        <textarea id={`${idBase}-desc`} className="text-input event-card__textarea" rows={3} value={f.description} onChange={(e) => put('description', e.target.value)} />
      </label>
    </div>
  );
}

export function ApprovalEventCard({ body }: { body: ApprovalCardBody }) {
  const review = body.review as EventReview;
  const pending = body.status === 'pending';
  const deleting = review.action === 'delete';
  const canEditFields = review.editable && (review.action === 'create' || review.action === 'update') && Boolean(review.fields);
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<EventFields | undefined>(review.fields);
  const [scope, setScope] = useState(review.recurring?.scope);
  const [notify, setNotify] = useState(review.notifyGuests);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || !pending) return;
    const touch = () => { void api.approvalEditing(body.approvalId).catch(() => {}); };
    touch();
    const t = setInterval(touch, EDIT_PING_MS);
    return () => clearInterval(t);
  }, [editing, pending, body.approvalId]);

  const edits = editsOf(review, fields, scope, notify);
  const decide = async (d: 'allow' | 'always' | 'deny') => {
    setBusy(d); setError(null);
    try { await api.approve(body.approvalId, d, d === 'deny' ? undefined : edits); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  const shown = deleting ? review.before : fields ?? review.before;
  const hasGuests = (shown?.attendees.length ?? 0) > 0 || (review.before?.attendees.length ?? 0) > 0;
  const showAlways = !body.rule && (body.alwaysFor || body.offerAlways !== false);
  const outcome: Record<string, string> = { allowed: body.edited ? 'Done, with your changes' : 'Done', always: 'Done, and always allowed', denied: 'Not done', expired: 'Expired' };

  return (
    <div className={`card event-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <ToolkitLogo name="Google Calendar" logo={CAL_LOGO} size={44} />
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          <div className="card__sub">{ACTION_LABEL[review.action]}{review.recurring ? ' · repeating event' : ''}</div>
        </div>
        {pending && canEditFields && !editing && (
          <button type="button" className="email-card__edit" onClick={() => setEditing(true)} aria-label="Edit event"><Icon name="edit" size={14} opacity={0.7} /> Edit</button>
        )}
      </div>
      {editing && pending && fields ? <EventEditor f={fields} onChange={setFields} idBase={`ev-${body.approvalId}`} /> : shown ? <EventView f={shown} before={review.action === 'update' ? review.before : undefined} deleting={deleting} /> : <div className="card__body">{body.detail || 'The event could not be read.'}</div>}
      {pending && review.recurring && review.editable && (
        <div className="event-card__scope" role="radiogroup" aria-label="Apply to">
          {SCOPES.map((s) => (
            <label key={s.value} className={`event-card__scope-option${scope === s.value ? ' is-on' : ''}`}>
              <input type="radio" name={`scope-${body.approvalId}`} value={s.value} checked={scope === s.value} onChange={() => setScope(s.value)} /> {s.label}
            </label>
          ))}
        </div>
      )}
      {pending && hasGuests && review.action !== 'remove_attendee' && review.action !== 'move' && (
        <label className="event-card__check event-card__notify" htmlFor={`notify-${body.approvalId}`}>
          <input id={`notify-${body.approvalId}`} type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email guests about this
        </label>
      )}
      {body.rule && <div className="card__rule">Asked because of your rule “{body.rule.description}”</div>}
      {pending ? (
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void decide('deny')}>Don't allow</button>
          {showAlways && (
            <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => void decide('always')}>
              {body.alwaysFor ? `Always allow for ${body.alwaysFor.botName}` : 'Always allow'}
            </button>
          )}
          <button type="button" className={`btn ${deleting ? 'btn--danger' : 'btn--primary'}`} disabled={!!busy} onClick={() => void decide('allow')}>
            {deleting ? 'Delete' : edits ? 'Allow with changes' : 'Allow'}
          </button>
        </div>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={12} opacity={0.7} />
          {outcome[body.status] ?? body.status}
        </div>
      )}
      {error && <div className="card__error" role="alert">{error}</div>}
    </div>
  );
}
