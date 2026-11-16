import { useEffect, useState } from 'react';
import type { Bot, InitiativeLevel, InitiativeSettings, InitiativeSettingsPatch } from '@orbit/contracts';
import { configApi } from '../../lib/configApi';
import { useStore } from '../../store';
import { Field, Segmented, Switch } from './ui';

const LEVELS: { value: InitiativeLevel; label: string }[] = [
  { value: 'proactive', label: 'Proactive' },
  { value: 'reactive', label: 'Reactive' },
  { value: 'off', label: 'Off' },
];

const LEVEL_HINT: Record<InitiativeLevel, (name: string) => string> = {
  proactive: (name) => `${name} checks in, sends the morning briefing, and tells you when something needs you.`,
  reactive: (name) => `${name} only speaks up when something broke: a routine failed or an app needs reconnecting.`,
  off: (name) => `${name} never messages you first.`,
};

const IDLE_OPTIONS: { value: number; label: string }[] = [
  { value: 12, label: '12 hours' },
  { value: 24, label: '1 day' },
  { value: 48, label: '2 days' },
  { value: 72, label: '3 days' },
  { value: 168, label: '1 week' },
  { value: 0, label: 'Never' },
];

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** How much the person's first primary Bot reaches out unasked. Every control saves as it changes. */
export function InitiativeSection({ bot, onNote }: { bot: Bot; onNote: (text: string, tone?: 'ok' | 'error') => void }) {
  const [settings, setSettings] = useState<InitiativeSettings | null>(null);
  const [time, setTime] = useState('');

  useEffect(() => {
    configApi.initiative().then((s) => { setSettings(s); setTime(s.briefing.time ?? ''); }).catch((e) => onNote((e as Error).message, 'error'));
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const level: InitiativeLevel = bot.initiative ?? 'reactive';

  const setLevel = async (initiative: InitiativeLevel) => {
    const before = level;
    const apply = (level: InitiativeLevel) => useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, initiative: level } : b)) }));
    apply(initiative);
    try {
      await configApi.updateBot(bot.id, { initiative });
    } catch (e) {
      apply(before);
      onNote((e as Error).message, 'error');
    }
  };

  const save = async (patch: InitiativeSettingsPatch, done: string) => {
    try {
      const next = await configApi.setInitiative(patch);
      setSettings(next);
      setTime(next.briefing.time ?? '');
      onNote(done);
    } catch (e) {
      onNote((e as Error).message, 'error');
    }
  };

  const briefing = settings?.briefing;
  const quiet = level !== 'proactive';
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Initiative</div>
      <Field label="Reaches out" hint={LEVEL_HINT[level](bot.name)}>
        <Segmented label="Initiative" value={level} options={LEVELS} onChange={(v) => { if (v !== level) void setLevel(v); }} />
      </Field>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Morning briefing</div>
            <div className="cfg-row__sub">
              {quiet
                ? 'Paused while initiative is not Proactive.'
                : briefing?.time === null
                  ? 'Runs on a custom schedule. Pick a time to go back to weekday mornings.'
                  : 'Weekdays: today’s calendar, unread email, open tasks and anything waiting on you.'}
            </div>
          </div>
          <input
            type="time"
            className="text-input cfg-initiative__input"
            aria-label="Briefing time"
            value={time}
            disabled={!settings}
            onChange={(e) => setTime(e.target.value)}
            onBlur={() => { if (time && time !== briefing?.time) void save({ briefing: { time, timezone: browserTimezone() } }, `Briefing at ${time}`); }}
          />
          <Switch
            on={!!briefing?.enabled}
            disabled={!settings}
            label={`Morning briefing ${briefing?.enabled ? 'on' : 'off'}`}
            onChange={(enabled) => void save({ briefing: { enabled, timezone: browserTimezone() } }, enabled ? 'Briefing on' : 'Briefing off')}
          />
        </div>
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Check on me after</div>
            <div className="cfg-row__sub">When you have been quiet this long, {bot.name} may check in once.</div>
          </div>
          <select
            className="text-input cfg-initiative__input"
            aria-label="Check on me after"
            value={settings ? String(settings.idleHours) : ''}
            disabled={!settings}
            onChange={(e) => void save({ idleHours: Number(e.target.value) }, 'Saved')}
          >
            {IDLE_OPTIONS.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
            {settings && !IDLE_OPTIONS.some((o) => o.value === settings.idleHours) && (
              <option value={String(settings.idleHours)}>{settings.idleHours} hours</option>
            )}
          </select>
        </div>
      </div>
    </section>
  );
}
