import { useEffect, useState } from 'react';
import type { VoiceModelItem } from '@orbit/contracts';
import { chooseVoice, dismissVoiceSetup, refreshVoiceModels, useVoiceModels, voiceSetupDismissed, voiceSetupDue } from '../../voice/models-store';
import { Modal } from '../modals/Modal';
import { formatSize, KIND_LABEL, latencyHint } from './format';
import '../../styles/config.css';
import '../../styles/voice-models.css';

function Progress({ m }: { m: VoiceModelItem }) {
  const line = m.state === 'ready' ? 'Ready' : m.state === 'error' ? 'Download failed' : m.state === 'downloading' ? `${m.pct}%` : 'Waiting';
  return (
    <div className="vsetup__progress" data-model-id={m.id} data-state={m.state}>
      <div className="vsetup__progress-head">
        <span>{KIND_LABEL[m.kind]} · {formatSize(m.size)}</span>
        <span>{line}</span>
      </div>
      <div className="vmodels__bar" role="progressbar" aria-label={`${m.name} download progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.pct}>
        <div style={{ width: `${m.pct}%` }} />
      </div>
    </div>
  );
}

/**
 * First-run chooser, shown once on app start when this machine can run voice on-device and no voice
 * is installed. Picking one downloads it and then makes it every bot's on-device voice. Skipping
 * leaves the settings as they are; a bot set to on-device then shows "needs a model" in the call bar.
 */
export function VoiceSetupModal() {
  const status = useVoiceModels((s) => s.status);
  const pending = useVoiceModels((s) => s.pendingVoice);
  const error = useVoiceModels((s) => s.error);
  const [dismissed, setDismissed] = useState(voiceSetupDismissed);
  // Decided once per app start, so the dialog stays up through its own download.
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  // Every start reads the inventory: the call path needs it synchronously, and the read is what
  // starts the automatic speech recognition download on the server.
  useEffect(() => { void refreshVoiceModels(); }, []);
  useEffect(() => { if (voiceSetupDue(status, dismissed)) setOpen(true); }, [status, dismissed]);

  if (!open || !status) return null;

  const voices = status.voices.filter((m) => m.kind === 'tts');
  const required = status.voices.filter((m) => m.tier === 'required');
  const selected = picked ?? voices[0]?.id ?? null;
  const chosenItem = chosen ? voices.find((m) => m.id === chosen) : undefined;
  const done = chosenItem?.state === 'ready' && !pending;
  const title = done ? 'On-device voice is ready' : 'Choose an on-device voice';

  const close = () => {
    dismissVoiceSetup();
    setDismissed(true);
    setOpen(false);
  };
  const start = () => {
    if (!selected) return;
    dismissVoiceSetup();
    setChosen(selected);
    void chooseVoice(selected);
  };

  return (
    <Modal onClose={close} className="vsetup" label={title}>
      <div className="modal__header">
        <span className="modal__title">{title}</span>
      </div>
      <div className="vmodels__body">
        <p className="vmodels__intro">
          {done
            ? `Your bots now talk with ${chosenItem!.name}, on this device. Switch any bot back to Cloud in its Voice settings.`
            : 'Voice calls run on this device, with no cloud voice service. Pick a voice to download; your bots will use it. Speech recognition downloads on its own.'}
        </p>
        {!chosen && (
          <div className="cfg-card" role="radiogroup" aria-label="Voices">
            {voices.map((m) => (
              <label key={m.id} className="cfg-row vsetup__voice" data-model-id={m.id}>
                <input type="radio" name="orbit-voice-setup" value={m.id} checked={selected === m.id} onChange={() => setPicked(m.id)} aria-label={m.name} />
                <span className="cfg-row__text">
                  <span className="cfg-row__title">{m.name}</span>
                  <span className="cfg-row__sub">{[formatSize(m.size), latencyHint(m)].filter(Boolean).join(' · ')}</span>
                  <span className="cfg-row__sub">{m.note}</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="vsetup__downloads" aria-label="Downloads">
          {chosenItem && <Progress m={chosenItem} />}
          {required.map((m) => <Progress key={m.id} m={m} />)}
        </div>
        {error && <div className="voice-error" role="alert">{error}</div>}
      </div>
      <div className="modal__footer">
        {done ? (
          <button type="button" className="cfg-btn cfg-btn--primary" onClick={close}>Done</button>
        ) : chosen ? (
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={close} title="The download keeps going">Hide</button>
        ) : (
          <>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={close}>Skip for now</button>
            <button type="button" className="cfg-btn cfg-btn--primary" onClick={start} disabled={!selected}>
              Download {voices.find((m) => m.id === selected)?.name ?? 'voice'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
