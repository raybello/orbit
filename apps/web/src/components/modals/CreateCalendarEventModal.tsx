import { useMemo, useState } from 'react';
import type { CreateRoutineRequest } from '@orbit/contracts';
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

interface Props { initialDate: Date; onClose: () => void; onSaved: () => void }

/** Create one calendar event: a one-time routine at a datetime, or a recurring cron routine. */
export function CreateCalendarEventModal({ initialDate, onClose, onSaved }: Props) {
  const bots = useStore((s) => s.bots);
  const selectedBotId = useStore((s) => s.selectedBotId);
  const agents = useMemo(() => bots.filter((b) => b.kind !== 'room'), [bots]);

  const [title, setTitle] = useState('');
  const [botId, setBotId] = useState(() => {
    const preferred = agents.find((b) => b.id === selectedBotId) ?? agents.find((b) => b.isPrimary) ?? agents[0];
    return preferred?.id ?? '';
  });
  const [prompt, setPrompt] = useState('');
  const [eventType, setEventType] = useState<EventType>('one_time');
  const [dateLocal, setDateLocal] = useState(() => toLocalInput(initialDate));
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
          <div className="modal__title">New event</div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} opacity={0.68} />
          </button>
        </div>

        <div className="cal-modal__body">
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

          <Field label="Event type">
            <Segmented
              value={eventType}
              options={[{ value: 'one_time', label: 'One-time' }, { value: 'recurring', label: 'Recurring' }]}
              onChange={(v) => { setEventType(v); clear('dateLocal'); clear('cron'); }}
              label="Event type"
            />
          </Field>

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
