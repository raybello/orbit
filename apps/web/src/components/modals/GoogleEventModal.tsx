import { useMemo, useState } from 'react';
import type { EventEdits, EventFields, GoogleCalendarEvent, GoogleCalendarInfo } from '@orbit/contracts';
import { api } from '../../lib/api';
import { fieldsOfGoogle } from '../../lib/eventTime';
import { whenOf } from '@orbit/domain';
import { EventEditor } from '../cards/EventCard';
import { Modal } from './Modal';

/**
 * Creating, changing or deleting one of the person's own Google Calendar events from the Orbit
 * calendar. No bot is involved. Every change ends on a confirm step that says exactly what will
 * happen in Google Calendar, which is the "confirm card" for actions the person takes themselves.
 */

export type GoogleEventIntent =
  | { kind: 'create'; date: Date }
  | { kind: 'edit'; event: GoogleCalendarEvent }
  | { kind: 'delete'; event: GoogleCalendarEvent };

const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const SCOPES = [
  { value: 'this' as const, label: 'This event' },
  { value: 'following' as const, label: 'This and following events' },
  { value: 'all' as const, label: 'All events in the series' },
];

function blank(date: Date): EventFields {
  const end = new Date(date.getTime() + 30 * 60_000);
  return { summary: '', description: '', location: '', start: local(date), end: local(end), allDay: false, timezone: browserZone(), attendees: [], meet: false };
}

/** What changes, in sentences, for the confirm step. */
function changesOf(before: EventFields, after: EventFields): string[] {
  const out: string[] = [];
  if (before.summary !== after.summary) out.push(`Title: “${after.summary || 'Untitled'}”`);
  if (before.start !== after.start || before.end !== after.end || before.allDay !== after.allDay || before.timezone !== after.timezone) out.push(`When: ${whenOf(after)}${after.allDay ? '' : ` (${after.timezone})`}`);
  if (before.location !== after.location) out.push(after.location ? `Where: ${after.location}` : 'Location removed');
  const was = new Set(before.attendees.map((a) => a.toLowerCase()));
  const now = new Set(after.attendees.map((a) => a.toLowerCase()));
  const added = after.attendees.filter((a) => !was.has(a.toLowerCase()));
  const removed = before.attendees.filter((a) => !now.has(a.toLowerCase()));
  if (added.length) out.push(`Invite: ${added.join(', ')}`);
  if (removed.length) out.push(`Remove guests: ${removed.join(', ')}`);
  if (before.meet !== after.meet) out.push(after.meet ? 'Add a Google Meet link' : 'Remove the Google Meet link');
  if (before.description !== after.description) out.push('Description changed');
  return out;
}

function editsOf(before: EventFields, after: EventFields): EventEdits {
  const out: EventEdits = {};
  for (const k of ['summary', 'description', 'location', 'start', 'end', 'allDay', 'timezone', 'meet'] as const) if (before[k] !== after[k]) (out as Record<string, unknown>)[k] = after[k];
  if (before.attendees.join(',') !== after.attendees.join(',')) out.attendees = after.attendees;
  return out;
}

export function GoogleEventModal({ intent, calendars, onClose, onSaved }: { intent: GoogleEventIntent; calendars: GoogleCalendarInfo[]; onClose: () => void; onSaved: () => void }) {
  const original = useMemo(() => (intent.kind === 'create' ? blank(intent.date) : fieldsOfGoogle(intent.event)), [intent]);
  const [fields, setFields] = useState<EventFields>(original);
  const [calendarKey, setCalendarKey] = useState(() => calendars.find((c) => c.primary)?.key ?? calendars[0]?.key ?? '');
  const [scope, setScope] = useState<'this' | 'following' | 'all'>('this');
  const [notify, setNotify] = useState(true);
  const [step, setStep] = useState<'edit' | 'confirm'>(intent.kind === 'delete' ? 'confirm' : 'edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const event = intent.kind === 'create' ? null : intent.event;
  const recurring = !!event?.recurring;
  const hasGuests = fields.attendees.length > 0 || original.attendees.length > 0;
  const changes = intent.kind === 'edit' ? changesOf(original, fields) : [];
  const calendarName = intent.kind === 'create' ? calendars.find((c) => c.key === calendarKey)?.name : event?.calendarName;
  const ready = intent.kind === 'delete' || (fields.start && fields.end && (intent.kind === 'create' ? fields.summary.trim() : changes.length > 0));

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (intent.kind === 'create') await api.createGoogleEvent({ calendarKey, fields: { ...fields, summary: fields.summary.trim() }, notifyGuests: notify });
      else if (intent.kind === 'edit') await api.updateGoogleEvent(intent.event.key, { ...editsOf(original, fields), ...(recurring ? { scope } : {}), ...(hasGuests ? { notifyGuests: notify } : {}) });
      else await api.deleteGoogleEvent(intent.event.key, { ...(recurring ? { scope } : {}), ...(hasGuests ? { notify } : {}) });
      onSaved();
    } catch (e) {
      setError((e as Error).message || 'Google Calendar did not accept it.');
      setStep(intent.kind === 'delete' ? 'confirm' : 'edit');
    } finally {
      setBusy(false);
    }
  };

  const title = intent.kind === 'create' ? 'New Google event' : intent.kind === 'edit' ? 'Change Google event' : 'Delete Google event';
  const verb = intent.kind === 'create' ? 'Create event' : intent.kind === 'edit' ? 'Save change' : 'Delete';

  return (
    <Modal onClose={onClose} label={title} className="gev-modal">
      <div className="gev">
        <div className="gev__head">
          <div className="gev__title">{title}</div>
          <div className="gev__sub">{calendarName ? `In ${calendarName}` : 'Google Calendar'} · no bot involved</div>
        </div>

        {step === 'edit' && (
          <>
            {intent.kind === 'create' && calendars.length > 1 && (
              <label className="event-card__field gev__calendar" htmlFor="gev-cal"><span>Calendar</span>
                <select id="gev-cal" className="text-input" value={calendarKey} onChange={(e) => setCalendarKey(e.target.value)}>
                  {calendars.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
                </select>
              </label>
            )}
            <EventEditor f={fields} onChange={setFields} idBase="gev" />
          </>
        )}

        {step === 'confirm' && (
          <div className="gev__confirm" role="status">
            {intent.kind === 'create' && <p>Create “{fields.summary.trim()}” · {whenOf(fields)}{fields.location ? ` · ${fields.location}` : ''}{fields.attendees.length ? ` · invites ${fields.attendees.join(', ')}` : ''}.</p>}
            {intent.kind === 'edit' && (<><p>Change “{original.summary || 'Untitled'}”:</p><ul>{changes.map((c) => <li key={c}>{c}</li>)}</ul></>)}
            {intent.kind === 'delete' && <p>Delete “{original.summary || 'Untitled'}” · {whenOf(original)}. This cannot be undone from Orbit.</p>}
          </div>
        )}

        {recurring && (step === 'confirm' || intent.kind === 'edit') && (
          <fieldset className="gev__scope">
            <legend>This event repeats. Apply to</legend>
            {SCOPES.map((s) => (
              <label key={s.value}><input type="radio" name="gev-scope" value={s.value} checked={scope === s.value} onChange={() => setScope(s.value)} /> {s.label}</label>
            ))}
          </fieldset>
        )}
        {hasGuests && (
          <label className="event-card__check gev__notify" htmlFor="gev-notify">
            <input id="gev-notify" type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email guests about this
          </label>
        )}
        {error && <div className="card__error gev__error" role="alert">{error}</div>}

        <div className="gev__actions">
          {step === 'confirm' && intent.kind !== 'delete'
            ? <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={() => setStep('edit')}>Back</button>
            : <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={onClose}>Cancel</button>}
          {step === 'edit'
            ? <button type="button" className="cfg-btn cfg-btn--primary" disabled={!ready} onClick={() => setStep('confirm')}>Review</button>
            : <button type="button" className={`cfg-btn ${intent.kind === 'delete' ? 'cfg-btn--danger' : 'cfg-btn--primary'}`} disabled={busy || !ready} onClick={() => void save()}>{busy ? 'Saving…' : verb}</button>}
        </div>
      </div>
    </Modal>
  );
}
