import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toolkit } from '@orbit/contracts';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import {
  audioContextCtor,
  canPlayAudio,
  canShareScreen,
  describeDisplaySurface,
  deviceLabel,
  devicesForKind,
  errorToMessage,
  listDevices,
  mediaDevices,
  queryDevicePermission,
  readDeviceSelection,
  statusForError,
  statusForPermission,
  statusLabel,
  writeDeviceSelection,
  type DeviceKind,
  type DeviceSelection,
  type DeviceStatus,
  type PermissionStateName,
} from '../../lib/device-permissions';
import { relativeShort } from '../../lib/time';
import { presets } from '@orbit/ui-tokens';
import { useConfigUI, type AppSection, type Preset, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { ToolkitLogo } from '../ToolkitLogo';
import { EngineAuthPanel } from './EngineAuthPanel';
import { Glyph } from './glyphs';
import { ConfirmButton } from './ui';

const SECTIONS: { id: AppSection; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'engine-auth', label: 'Engine Auth' },
  { id: 'computer', label: 'Computer' },
  { id: 'devices', label: 'Devices & permissions' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'apps', label: 'Connected apps' },
  { id: 'account', label: 'Account' },
];

export function AppSettings() {
  const section = useConfigUI((s) => s.appSettings);
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-root')) { e.preventDefault(); close(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);
  if (!section) return null;
  return createPortal(
    <div className="app-settings" role="dialog" aria-modal="true" aria-label="Settings">
      <aside className="app-settings__nav">
        <button type="button" className="app-settings__back" onClick={close}><Glyph name="arrow_left" size={14} /> Back to Bots</button>
        <div className="app-settings__heading">Settings</div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
            {s.label}
          </button>
        ))}
      </aside>
      <div className="app-settings__main">
        <button type="button" className="app-settings__close icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" opacity={0.8} /></button>
        <div className="app-settings__page">
          {section === 'general' && <GeneralSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'engine-auth' && <EngineAuthSection />}
          {section === 'computer' && <ComputerSection />}
          {section === 'devices' && <DevicesSection />}
          {section === 'permissions' && <PermissionsSection />}
          {section === 'apps' && <AppsSection />}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="app-settings__head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function ThemeTile({ value, label, current, onPick }: { value: Theme; label: string; current: Theme; onPick: (t: Theme) => void }) {
  return (
    <button type="button" role="radio" aria-checked={current === value} className={`theme-tile${current === value ? ' is-active' : ''}`} onClick={() => onPick(value)}>
      <span className={`theme-tile__art is-${value}`} aria-hidden>
        <span className="theme-tile__side" />
        <span className="theme-tile__pane"><i /><i /><b /></span>
      </span>
      <span className="theme-tile__label">{label}</span>
    </button>
  );
}

function GeneralSection() {
  const open = useConfigUI((s) => s.openAppSettings);
  const theme = useConfigUI((s) => s.theme);
  const preset = useConfigUI((s) => s.preset);
  const label = preset === 'custom' ? 'Custom accent' : presets.find((p) => p.id === preset)?.label ?? 'Orbit Purple';
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-card">
          <button type="button" className="cfg-row cfg-row--button" onClick={() => open('appearance')}>
            <div className="cfg-row__text">
              <div className="cfg-row__title">Appearance</div>
              <div className="cfg-row__sub">{theme === 'system' ? 'System theme' : theme === 'hc' ? 'High contrast' : `${theme[0].toUpperCase()}${theme.slice(1)} theme`} · {label}</div>
            </div>
            <Glyph name="arrow_left" size={14} style={{ transform: 'rotate(180deg)', opacity: 0.6 }} />
          </button>
        </div>
      </section>
    </>
  );
}

function AppearanceSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  const preset = useConfigUI((s) => s.preset);
  const setPreset = useConfigUI((s) => s.setPreset);
  const accent = useConfigUI((s) => s.accentColor);
  const setAccentColor = useConfigUI((s) => s.setAccentColor);
  const presetAccent = presets.find((p) => p.id === preset)?.accent ?? '#5B5FC7';
  const swatch = accent ?? presetAccent;

  return (
    <>
      <PageHead title="Appearance" sub="Light or dark, a colour theme, and the accent every control uses." />

      <section className="cfg-section">
        <div className="cfg-section__label">Theme</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme">
          <ThemeTile value="light" label="Light" current={theme} onPick={setTheme} />
          <ThemeTile value="dark" label="Dark" current={theme} onPick={setTheme} />
          <ThemeTile value="hc" label="High contrast" current={theme} onPick={setTheme} />
          <ThemeTile value="system" label="System" current={theme} onPick={setTheme} />
        </div>
        <div className="cfg-field__hint">System follows your device’s light or dark setting. High contrast uses pure black and white.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Colour theme</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="appearance__swatch" style={{ background: swatch }} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Accent preset</div>
              <div className="cfg-row__sub">Sets the accent ramp and the nav rail colour.</div>
            </div>
            <select
              className="text-input appearance__select"
              value={preset}
              aria-label="Colour theme"
              onChange={(e) => setPreset(e.target.value as Preset)}
            >
              {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="cfg-row">
            <span className="appearance__swatch" style={{ background: swatch }} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Accent colour</div>
              <div className="cfg-row__sub">{accent ? 'A custom accent is in use.' : 'Follows the preset.'}</div>
            </div>
            <input
              type="color"
              className="appearance__color"
              value={swatch}
              aria-label="Accent colour"
              onChange={(e) => setAccentColor(e.target.value.toUpperCase())}
            />
            <code className="appearance__hex">{swatch.toUpperCase()}</code>
            {accent && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPreset('default')}>Reset</button>}
          </div>
        </div>
      </section>
    </>
  );
}

function EngineAuthSection() {
  return (
    <>
      <PageHead title="Engine Auth" sub="Which provider and model runs each Bot, and whether it has the credentials to reach them." />
      <section className="cfg-section">
        <EngineAuthPanel />
      </section>
    </>
  );
}

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);

function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [busy, setBusy] = useState<'wake' | 'sleep' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

  const status = computer?.status ?? details?.computer.status;
  const running = status === 'running';
  const transitioning = status === 'starting' || status === 'resuming' || status === 'creating' || status === 'suspending';
  const act = async (kind: 'wake' | 'sleep') => {
    setBusy(kind); setNote(null);
    try { kind === 'wake' ? await configApi.wake() : await configApi.sleep(); }
    catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  };
  const byId = new Map(bots.map((b) => [b.id, b]));
  // The server says how many screens the computer can hold; 4 until it does.
  const maxScreens = computer?.maxScreens ?? details?.computer.maxScreens ?? 4;

  return (
    <>
      <PageHead title="Computer" sub="Your Bots share one cloud computer. Each Bot works on its own screen." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${running ? 'on' : transitioning ? 'busy' : 'off'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Bots’ computer · {computerStatusText(computer ?? null)}</div>
              <div className="cfg-row__sub">
                {details ? `Goes to sleep after ${details.hibernation.idleMinutes} idle minutes when nobody is watching. Starts again on its own once a Bot has work.` : 'Checking…'}
              </div>
            </div>
            {running || status === 'suspending' ? (
              <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!running || !!busy} onClick={() => act('sleep')}>{busy === 'sleep' || status === 'suspending' ? 'Going to sleep…' : 'Sleep'}</button>
            ) : (
              <button type="button" className="cfg-btn cfg-btn--primary" disabled={transitioning || !!busy} onClick={() => act('wake')}>{busy === 'wake' || transitioning ? 'Waking…' : 'Wake'}</button>
            )}
          </div>
          {computer?.error && status === 'error' && <div className="cfg-error cfg-error--inset">{computer.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Screens in use{details && maxScreens ? ` · ${details.screens.length} of ${maxScreens}` : ''}</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No Bot has used the computer yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed Bot'}</div>
                  <div className="cfg-row__sub">{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--secondary"
                  confirmLabel="Reset screen"
                  disabled={!running}
                  title={running ? 'Closes everything open on this screen' : 'Wake the computer first'}
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Reset closes every window on that Bot’s screen, so it starts clean next time.{maxScreens ? ` Up to ${maxScreens} Bots can have a screen at once${details && details.screens.length >= maxScreens ? '; reset one to free it for another Bot' : ''}.` : ''}</div>
      </section>
    </>
  );
}

/** One frame later, via rAF where it exists (jsdom has it, a few embedded webviews do not). */
const nextFrame: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => { requestAnimationFrame(() => cb()); }
    : (cb) => { window.setTimeout(cb, 16); };

/**
 * Play the microphone into an analyser for `ms` and report a 0..1 peak while it runs.
 * A browser without Web Audio has already been shown as Unsupported, so this is best-effort.
 */
async function sampleInputLevel(stream: MediaStream, ms: number, onLevel: (level: number) => void): Promise<void> {
  const Ctx = audioContextCtor();
  if (!Ctx) return;
  const ctx = new Ctx();
  try {
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
        onLevel(Math.min(1, peak * 2.5));
        if (performance.now() - started >= ms) resolve();
        else nextFrame(tick);
      };
      nextFrame(tick);
    });
  } catch {
    /* the mic itself worked; only the meter is missing */
  } finally {
    onLevel(0);
    await ctx.close().catch(() => {});
  }
}

const DEVICE_KINDS: DeviceKind[] = ['microphone', 'camera', 'screen', 'speaker'];

const DEVICE_COPY: Record<DeviceKind, { title: string; blurb: string; action: string; busy: string }> = {
  microphone: {
    title: 'Microphone',
    blurb: 'Lets your Bots hear you during a voice call. The test below listens for two seconds so you can see it working.',
    action: 'Allow microphone',
    busy: 'Listening…',
  },
  camera: {
    title: 'Camera',
    blurb: 'Turns your video on in a call. The preview is local — Orbit never uploads it outside the call.',
    action: 'Allow camera',
    busy: 'Camera on…',
  },
  screen: {
    title: 'Screen sharing',
    blurb: 'Shows a Bot one of your windows or your whole screen while you are in a call. You pick the surface each time.',
    action: 'Allow screen share',
    busy: 'Waiting for the picker…',
  },
  speaker: {
    title: 'Speaker',
    blurb: 'Plays spoken replies out loud. The short test tone also unlocks audio so a Bot can speak straight away.',
    action: 'Play test sound',
    busy: 'Playing…',
  },
};

interface DeviceCardState {
  status: DeviceStatus;
  busy: boolean;
  /** What the last successful test did, e.g. the shared surface label. */
  note: string | null;
  error: string | null;
}

/** The honest starting point: only the hardware the browser exposes gets a button. */
function initialStatus(kind: DeviceKind): DeviceStatus {
  if (kind === 'speaker') return canPlayAudio() ? 'not-requested' : 'unsupported';
  if (!mediaDevices()) return 'unsupported';
  if (kind === 'screen' && !canShareScreen()) return 'unsupported';
  return 'not-requested';
}

function initialCards(): Record<DeviceKind, DeviceCardState> {
  const state = (kind: DeviceKind): DeviceCardState => ({ status: initialStatus(kind), busy: false, note: null, error: null });
  return { microphone: state('microphone'), camera: state('camera'), screen: state('screen'), speaker: state('speaker') };
}

/**
 * Devices & permissions: what this computer may give Orbit, one card per capability.
 *
 * Every capture path stops its tracks in a `finally`, so a rejected dialog, a thrown
 * NotReadableError and a finished test all leave the hardware released.
 */
export function DevicesSection() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selection, setSelection] = useState<DeviceSelection>(readDeviceSelection);
  const [cards, setCards] = useState<Record<DeviceKind, DeviceCardState>>(initialCards);
  const [level, setLevel] = useState(0);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Streams a test is still holding, so unmounting the page mid-test does not leave a device open. */
  const liveStreams = useRef<Set<MediaStream>>(new Set());

  const patch = useCallback((kind: DeviceKind, next: Partial<DeviceCardState>) => {
    setCards((prev) => ({ ...prev, [kind]: { ...prev[kind], ...next } }));
  }, []);

  const refreshDevices = useCallback(async () => {
    const listed = await listDevices();
    if (listed.supported) setDevices(listed.devices);
  }, []);

  // Capability detection first: a browser that cannot enumerate has nothing to offer, and the
  // page must say so rather than throw when the permission prompt is opened.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const listed = await listDevices();
      if (!alive) return;
      if (!listed.supported) {
        setCards((prev) => {
          const next = { ...prev };
          for (const kind of DEVICE_KINDS) next[kind] = { ...next[kind], status: 'unsupported' };
          return next;
        });
        return;
      }
      setDevices(listed.devices);
      const [mic, camera] = await Promise.all([queryDevicePermission('microphone'), queryDevicePermission('camera')]);
      if (!alive) return;
      // A browser that already decided is worth showing; one that cannot answer keeps the pill.
      const reflect = (current: DeviceStatus, state: PermissionStateName | null): DeviceStatus =>
        current === 'unsupported' || state === null ? current : statusForPermission(state);
      setCards((prev) => ({
        ...prev,
        microphone: { ...prev.microphone, status: reflect(prev.microphone.status, mic) },
        camera: { ...prev.camera, status: reflect(prev.camera.status, camera) },
      }));
    })();
    return () => { alive = false; };
  }, []);

  // The preview element takes the stream by ref: React never guarantees one on a plain prop.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !preview) return;
    el.srcObject = preview;
    void el.play().catch(() => {});
  }, [preview]);

  useEffect(
    () => () => {
      for (const stream of liveStreams.current) stream.getTracks().forEach((track) => track.stop());
      liveStreams.current.clear();
    },
    [],
  );

  const pick = (kind: DeviceKind, id: string) => {
    const next: DeviceSelection =
      kind === 'microphone' ? { ...selection, microphoneId: id }
        : kind === 'camera' ? { ...selection, cameraId: id }
          : { ...selection, speakerId: id };
    setSelection(next);
    writeDeviceSelection(next);
  };

  const allowMicrophone = async () => {
    patch('microphone', { busy: true, note: null, error: null });
    let stream: MediaStream | null = null;
    try {
      const md = mediaDevices();
      if (!md) throw new DOMException('No media devices', 'NotSupportedError');
      stream = await md.getUserMedia({ audio: selection.microphoneId ? { deviceId: { exact: selection.microphoneId } } : true });
      liveStreams.current.add(stream);
      patch('microphone', { status: 'allowed', note: 'Listening for a moment — speak and the bar below should move.' });
      await sampleInputLevel(stream, 2000, setLevel);
      await refreshDevices();
    } catch (err) {
      patch('microphone', { status: statusForError(err), error: errorToMessage(err), note: null });
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (stream) liveStreams.current.delete(stream);
      setLevel(0);
      patch('microphone', { busy: false });
    }
  };

  const allowCamera = async () => {
    patch('camera', { busy: true, note: null, error: null });
    let stream: MediaStream | null = null;
    try {
      const md = mediaDevices();
      if (!md) throw new DOMException('No media devices', 'NotSupportedError');
      stream = await md.getUserMedia({ video: selection.cameraId ? { deviceId: { exact: selection.cameraId } } : true });
      liveStreams.current.add(stream);
      setPreview(stream);
      patch('camera', { status: 'allowed', note: 'That is the live preview — it stops on its own in a moment.' });
      await new Promise<void>((resolve) => { window.setTimeout(resolve, 3000); });
      await refreshDevices();
    } catch (err) {
      patch('camera', { status: statusForError(err), error: errorToMessage(err), note: null });
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (stream) liveStreams.current.delete(stream);
      setPreview(null);
      patch('camera', { busy: false });
    }
  };

  const allowScreen = async () => {
    patch('screen', { busy: true, note: null, error: null });
    let stream: MediaStream | null = null;
    try {
      const md = mediaDevices();
      if (!md || typeof md.getDisplayMedia !== 'function') throw new DOMException('No screen capture', 'NotSupportedError');
      stream = await md.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const surface = track ? describeDisplaySurface(track) : null;
      patch('screen', {
        status: 'allowed',
        note: surface ? `${surface} — released straight away, nothing is being recorded.` : 'Screen capture is available.',
      });
    } catch (err) {
      patch('screen', { status: statusForError(err), error: errorToMessage(err), note: null });
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      patch('screen', { busy: false });
    }
  };

  const playTestSound = async () => {
    patch('speaker', { busy: true, note: null, error: null });
    let ctx: AudioContext | null = null;
    try {
      const Ctx = audioContextCtor();
      if (!Ctx) throw new DOMException('No Web Audio', 'NotSupportedError');
      ctx = new Ctx();
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      await new Promise<void>((resolve) => { window.setTimeout(resolve, 350); });
      patch('speaker', { status: 'allowed', note: 'That was the test tone. Spoken replies will play out loud now.' });
    } catch (err) {
      patch('speaker', { status: statusForError(err), error: errorToMessage(err), note: null });
    } finally {
      if (ctx) await ctx.close().catch(() => {});
      patch('speaker', { busy: false });
    }
  };

  const run = (kind: DeviceKind): Promise<void> =>
    kind === 'microphone' ? allowMicrophone()
      : kind === 'camera' ? allowCamera()
        : kind === 'screen' ? allowScreen()
          : playTestSound();

  return (
    <>
      <PageHead
        title="Devices & permissions"
        sub="What Orbit may use on this computer, and which device it should use. Nothing is captured unless a call is open."
      />
      <section className="cfg-section">
        <div className="device-grid">
          {DEVICE_KINDS.map((kind) => {
            const copy = DEVICE_COPY[kind];
            const state = cards[kind];
            const list = devicesForKind(devices, kind);
            const chosen = kind === 'microphone' ? selection.microphoneId : kind === 'camera' ? selection.cameraId : selection.speakerId;
            const unsupported = state.status === 'unsupported';
            return (
              <div className="cfg-card device-card" key={kind}>
                <div className="device-card__head">
                  <div className="cfg-row__text">
                    <div className="cfg-row__title">{copy.title}</div>
                    <div className="cfg-row__sub">{copy.blurb}</div>
                  </div>
                  <span className={`device-pill is-${state.status}`}>{statusLabel(state.status)}</span>
                </div>
                <div className="device-card__controls">
                  {kind !== 'screen' && (
                    <select
                      className="text-input device-card__select"
                      aria-label={`${copy.title} device`}
                      value={chosen}
                      disabled={unsupported}
                      onChange={(e) => pick(kind, e.target.value)}
                    >
                      <option value="">System default</option>
                      {list.map((device, i) => (
                        <option key={device.deviceId || `${kind}-${i}`} value={device.deviceId}>{deviceLabel(device, i, kind)}</option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="cfg-btn cfg-btn--primary"
                    disabled={state.busy || unsupported}
                    onClick={() => { void run(kind); }}
                  >
                    {state.busy ? copy.busy : copy.action}
                  </button>
                </div>
                {kind === 'microphone' && (state.busy || level > 0) && (
                  <div className="cfg-meter">
                    <div className="cfg-meter__label"><span>Input level</span><span>{Math.round(level * 100)}%</span></div>
                    <div className="cfg-meter__track"><span style={{ width: `${Math.round(level * 100)}%` }} /></div>
                  </div>
                )}
                {kind === 'camera' && preview && (
                  <video ref={videoRef} className="device-card__preview" autoPlay muted playsInline />
                )}
                {state.error
                  ? <div className="cfg-error cfg-error--small">{state.error}</div>
                  : state.note && <div className="device-card__note">{state.note}</div>}
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">
          The system dialog is what actually grants access. If you denied something, change it in System Settings → Privacy &amp; Security, then try again here.
        </div>
      </section>
    </>
  );
}

function humanizeTool(slug: string): { app: string; action: string } {
  const parts = slug.split(/[_:]/).filter(Boolean);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (parts.length < 2) return { app: cap(slug), action: '' };
  return { app: cap(parts[0]), action: cap(parts.slice(1).join(' ')) };
}

function PermissionsSection() {
  const [policies, setPolicies] = useState<{ tool: string; mode: string }[] | null>(null);
  const load = useCallback(() => { configApi.policies().then((r) => setPolicies(r.policies)).catch(() => setPolicies([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageHead title="Permissions" sub="Actions your Bots can take without asking first. Remove one and they’ll ask again next time." />
      <section className="cfg-section">
        <div className="cfg-card">
          {policies === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : policies.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">Nothing here yet. When you choose “Always allow” on an approval, it shows up here.</div>
          ) : policies.map((p) => {
            const h = humanizeTool(p.tool);
            return (
              <div key={p.tool} className="cfg-row">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{h.app}{h.action ? ` · ${h.action}` : ''}</div>
                  <div className="cfg-row__sub">{p.mode === 'always_allow' ? 'Always allowed' : p.mode === 'blocked' ? 'Never allowed' : 'Asks first'} · <code className="cfg-code">{p.tool}</code></div>
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.deletePolicy(p.tool).then(load).catch(() => {})}>Ask again</button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function AppsSection() {
  const version = useStore((s) => s.connectionsVersion);
  const [apps, setApps] = useState<Toolkit[] | null>(null);
  useEffect(() => { configApi.connectedApps().then((r) => setApps(r.connectedApps ?? [])).catch(() => setApps([])); }, [version]);
  const openApps = () => { useConfigUI.getState().closeAppSettings(); useStore.getState().setModal('apps'); };
  return (
    <>
      <PageHead title="Connected apps" sub="Apps your Bots can use for you, like email, calendar and docs." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">{apps === null ? 'Checking…' : apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} connected` : 'No apps connected yet'}</div>
              <div className="cfg-row__sub">Bots ask before doing anything that changes data in an app.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={openApps}>{apps?.length ? 'Manage apps' : 'Connect apps'}</button>
          </div>
          {apps?.map((a) => (
            <div key={a.slug} className="cfg-row">
              <ToolkitLogo name={a.name} logo={a.logo} size={28} radius={7} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">{a.name}</div>
                {a.description && <div className="cfg-row__sub">{a.description}</div>}
              </div>
              <span className="cfg-chip">Connected</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function AccountSection() {
  const user = useStore((s) => s.user);
  const [busy, setBusy] = useState(false);
  const initials = (user?.name ?? user?.email ?? '?').trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <>
      <PageHead title="Account" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <span className="account__initials">{initials}</span>
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.name}</div>
              <div className="cfg-row__sub">{user?.email}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" disabled={busy} onClick={async () => { setBusy(true); await configApi.logout().catch(() => {}); location.reload(); }}>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
