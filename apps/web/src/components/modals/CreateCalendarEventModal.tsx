import { useMemo, useState } from 'react';
import type { CreateRoutineRequest, DuplicateDefaults } from '@orbit/contracts';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Field, Segmented } from '../config/ui';
import { Icon } from '../Icon';
import { Modal } from './Modal';

type EventType = 'one_time' | 'recurring';

interface CronPreset { value: string; label: string; cron: string }

const PRESETS: CronPreset[] = [
  { value: 'daily', label: 'Daily 09:00', cron: '0 9 * * *' },
  { value: 'weekly', label: 'Weekly Mon 09:00', cron: '0 9 * * 1' },
  { value: 'weekdays', label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { value: 'custom', label: 'Custom', cron: '' },
];

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** `yyyy-mm-ddThh:mm` for a datetime-local input, in local time. */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Cron needs five (or six) whitespace-separated fields. */
const looksLikeCron = (s: string) => /^\s*\S+(\s+\S+){4,5}\s*$/.test(s);

/** Made from a Google event: its key and the defaults the server suggested. */
export interface DuplicateFrom { key: string; defaults: DuplicateDefaults }

interface Props { initialDate: Date; onClose: () => void; onSaved: () => void; duplicate?: DuplicateFrom }

/** When the Orbit event runs, relative to the Google event it was made from. */
const TIMINGS: { value: string; label: string; at: (start: Date) => Date }[] = [
  { value: 'same', label: 'Same time', at: (s) => s },
  { value: '15m', label: '15 min before', at: (s) => new Date(s.getTime() - 15 * 60_000) },
  { value: '1h', label: '1 hour before', at: (s) => new Date(s.getTime() - 60 * 60_000) },
  { value: 'eve', label: '9:00 the day before', at: (s) => new Date(s.getFullYear(), s.getMonth(), s.getDate() - 1, 9, 0) },
];

export function CreateCalendarEventModal({ initialDate, onClose, onSaved, duplicate }: Props) {
  const bots = useStore((s) => s.bots);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const agents = useMemo(() => bots.filter((b) => b.kind !== 'room'), [bots]);

  const parentStart = duplicate ? new Date(duplicate.defaults.start) : null;
  const [title, setTitle] = useState(duplicate?.defaults.title ?? '');
  const [timing, setTiming] = useState('same');
  const [botId, setBotId] = useState(() => {
    const preferred = agents.find((b) => b.id === selectedBotId) ?? agents.find((b) => b.isPrimary) ?? agents[0];
    return preferred?.id ?? '';
  });
  const [prompt, setPrompt] = useState(duplicate?.defaults.prompt ?? '');
  const [eventType, setEventType] = useState<EventType>('one_time');
  const [dateLocal, setDateLocal] = useState(() => toLocalInput(parentStart ?? initialDate));
  const [preset, setPreset] = useState('daily');
  const [cron, setCron] = useState(PRESETS[0].cron);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const clear = (field: string) => setErrors((prev) => {
    if (!prev[field]) return prev;
    const next = { ...prev };
    delete next[field];
    return next;
  });

  const pickPreset = (value: string) => {
    setPreset(value);
    const found = PRESETS.find((p) => p.value === value);
    if (found && value !== 'custom') setCron(found.cron);
    clear('cron');
  };

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = 'Give the event a title.';
    if (!botId) next.botId = 'Pick the bot that should run this.';
    if (!prompt.trim()) next.prompt = 'Describe what the bot should do.';
    if (eventType === 'one_time') {
      if (!dateLocal || Number.isNaN(new Date(dateLocal).getTime())) next.dateLocal = 'Pick a date and time.';
    } else if (!looksLikeCron(cron)) {
      next.cron = 'Enter a cron expression, e.g. 0 9 * * 1.';
    }
    return next;
  };

  const save = async () => {
    if (busy) return;
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const request: CreateRoutineRequest = {
      botId,
      title: title.trim(),
      prompt: prompt.trim(),
      eventType,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    if (eventType === 'one_time') request.eventDate = new Date(dateLocal).toISOString();
    else request.schedule = cron.trim();
    if (duplicate) {
      request.parentEventKey = duplicate.key;
      // A repeat taken from Google is at the event's own wall-clock time.
      if (eventType === 'recurring' && duplicate.defaults.cron && cron.trim() === duplicate.defaults.cron) request.timezone = duplicate.defaults.timezone;
    }

    setBusy(true);
    try {
      await api.createRoutine(request);
      onSaved();
    } catch (e) {
      setErrors({ form: (e as Error)?.message || 'Could not create the event.' });
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} className="cal-modal" label="New Event">
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="modal__header">
          <div className="modal__title">{duplicate ? 'Duplicate as Orbit event' : 'New event'}</div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} opacity={0.68} />
          </button>
        </div>

        <div className="cal-modal__body">
          {duplicate && (
            <div className="cal-modal__parent">
              Made from your Google event “{duplicate.defaults.title}”. A one-time Orbit event moves when it moves, and pauses if it is cancelled.
            </div>
          )}
          <Field label="Title" htmlFor="cal-title">
            <input
              id="cal-title"
              className="text-input"
              value={title}
              maxLength={120}
              placeholder="Quarterly report"
              aria-invalid={!!errors.title}
              onChange={(e) => { setTitle(e.target.value); clear('title'); }}
              autoFocus
            />
            {errors.title && <span className="cal-modal__error">{errors.title}</span>}
          </Field>

          <Field label="Assigned bot" htmlFor="cal-bot">
            <select
              id="cal-bot"
              className="text-input cal-select"
              value={botId}
              aria-invalid={!!errors.botId}
              onChange={(e) => { setBotId(e.target.value); clear('botId'); }}
            >
              {agents.length === 0 && <option value="">No bots yet</option>}
              {agents.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            {errors.botId && <span className="cal-modal__error">{errors.botId}</span>}
          </Field>

          <Field label="Task / prompt" htmlFor="cal-prompt" hint="What the bot should do when this event runs.">
            <textarea
              id="cal-prompt"
              className="text-input cfg-textarea"
              value={prompt}
              placeholder="Draft this week's status update and post it to the team channel."
              aria-invalid={!!errors.prompt}
              onChange={(e) => { setPrompt(e.target.value); clear('prompt'); }}
            />
            {errors.prompt && <span className="cal-modal__error">{errors.prompt}</span>}
          </Field>

          <Field label="Event type" hint={duplicate && !duplicate.defaults.cron && duplicate.defaults.recurring ? duplicate.defaults.cronReason : undefined}>
            <Segmented
              value={eventType}
              options={duplicate && !duplicate.defaults.cron ? [{ value: 'one_time', label: 'One-time' }] : [{ value: 'one_time', label: 'One-time' }, { value: 'recurring', label: 'Recurring' }]}
              onChange={(v) => {
                setEventType(v); clear('dateLocal'); clear('cron');
                if (v === 'recurring' && duplicate?.defaults.cron) { setCron(duplicate.defaults.cron); setPreset('custom'); }
              }}
              label="Event type"
            />
          </Field>

          {duplicate && parentStart && eventType === 'one_time' && (
            <Field label="Runs">
              <div className="cal-modal__timings" role="radiogroup" aria-label="When it runs">
                {TIMINGS.map((t) => (
                  <button key={t.value} type="button" role="radio" aria-checked={timing === t.value} className={`cal-chip${timing === t.value ? ' is-on' : ''}`}
                    onClick={() => { setTiming(t.value); setDateLocal(toLocalInput(t.at(parentStart))); clear('dateLocal'); }}>
                    {t.label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {eventType === 'one_time' ? (
            <Field label="Date and time" htmlFor="cal-date">
              <input
                id="cal-date"
                type="datetime-local"
                className="text-input"
                value={dateLocal}
                aria-invalid={!!errors.dateLocal}
                onChange={(e) => { setDateLocal(e.target.value); clear('dateLocal'); }}
              />
              {errors.dateLocal && <span className="cal-modal__error">{errors.dateLocal}</span>}
            </Field>
          ) : (
            <>
              <Field label="Repeats" htmlFor="cal-preset">
                <select
                  id="cal-preset"
                  className="text-input cal-select"
                  value={preset}
                  onChange={(e) => pickPreset(e.target.value)}
                >
                  {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </Field>
              <Field label="Cron expression" htmlFor="cal-cron" hint="minute hour day-of-month month day-of-week">
                <input
                  id="cal-cron"
                  className="text-input cal-mono"
                  value={cron}
                  placeholder="0 9 * * 1"
                  aria-invalid={!!errors.cron}
                  onChange={(e) => { setCron(e.target.value); setPreset('custom'); clear('cron'); }}
                />
                {errors.cron && <span className="cal-modal__error">{errors.cron}</span>}
              </Field>
            </>
          )}

          {errors.form && <div className="cfg-error">{errors.form}</div>}
        </div>

        <div className="modal__footer">
          <button type="button" className="btn btn--secondary btn--sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Creating…' : 'Create event'}</button>
        </div>
      </form>
    </Modal>
  );
}
