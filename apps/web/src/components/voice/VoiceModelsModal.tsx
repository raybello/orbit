import { useEffect } from 'react';
import type { VoiceModelItem } from '@orbit/contracts';
import { useConfigUI } from '../../configStore';
import { cancelVoiceModel, deleteVoiceModel, downloadVoiceModel, refreshVoiceModels, useVoiceModels } from '../../voice/models-store';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { ConfirmButton } from '../config/ui';
import { formatSize, KIND_LABEL, latencyHint } from './format';
import '../../styles/voice-models.css';

/** What one row shows and offers, by the model's state and what it holds on disk. */
function rowView(m: VoiceModelItem): { line: string; progress: boolean } {
  switch (m.state) {
    case 'ready': return { line: `Installed · ${formatSize(m.onDisk)} on disk`, progress: false };
    case 'downloading': return { line: `Downloading ${m.pct}% · ${formatSize(m.onDisk) || '0 MB'} of ${formatSize(m.size)}`, progress: true };
    case 'error': return { line: `Download failed${m.onDisk ? ` · ${formatSize(m.onDisk)} on disk` : ''}`, progress: false };
    case 'missing': return { line: m.onDisk ? `Partly downloaded · ${formatSize(m.onDisk)} of ${formatSize(m.size)}` : `Not installed · ${formatSize(m.size)}`, progress: false };
  }
}

function ModelRow({ m }: { m: VoiceModelItem }) {
  const view = rowView(m);
  const detail = [m.kind === 'tts' ? latencyHint(m) : '', m.tier === 'required' ? 'Downloads automatically' : ''].filter(Boolean).join(' · ');
  return (
    <div className="cfg-row vmodels__row" data-model-id={m.id} data-state={m.state}>
      <div className="cfg-row__text">
        <div className="cfg-row__title">{m.name}</div>
        <div className="cfg-row__sub" data-role="state">{view.line}</div>
        {detail && <div className="cfg-row__sub vmodels__detail">{detail}</div>}
        {view.progress && (
          <div className="vmodels__bar" role="progressbar" aria-label={`${m.name} download progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.pct}>
            <div style={{ width: `${m.pct}%` }} />
          </div>
        )}
      </div>
      <div className="vmodels__actions">
        {m.state === 'downloading' && (
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void cancelVoiceModel(m.id)} aria-label={`Cancel ${m.name} download`}>Cancel</button>
        )}
        {(m.state === 'missing' || m.state === 'error') && (
          <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => void downloadVoiceModel(m.id)} aria-label={`Download ${m.name}`}>
            {m.state === 'error' ? 'Retry' : m.onDisk ? 'Resume' : 'Download'}
          </button>
        )}
        {m.state === 'ready' && (
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void downloadVoiceModel(m.id, { fresh: true })} aria-label={`Redownload ${m.name}`}>Redownload</button>
        )}
        {m.state !== 'downloading' && m.onDisk > 0 && (
          <ConfirmButton onConfirm={() => deleteVoiceModel(m.id)} title={`Delete ${m.name} from this device`}>Delete</ConfirmButton>
        )}
      </div>
    </div>
  );
}

/**
 * The Voice models manager: every on-device model with its state and size on disk, and download,
 * cancel, delete and redownload. Opened from Settings, Voice settings and the call bar.
 */
export function VoiceModelsModal() {
  const close = useConfigUI((s) => s.closeVoiceModels);
  const status = useVoiceModels((s) => s.status);
  const phase = useVoiceModels((s) => s.phase);
  const error = useVoiceModels((s) => s.error);

  useEffect(() => { void refreshVoiceModels(); }, []);

  const voices = status?.voices ?? [];
  const onDisk = voices.reduce((n, m) => n + m.onDisk, 0);
  const groups = (['stt', 'vad', 'tts'] as const).map((kind) => ({ kind, items: voices.filter((m) => m.kind === kind) })).filter((g) => g.items.length);

  let body;
  if (phase === 'gone') body = <p className="vmodels__empty">This server doesn’t run on-device voice.</p>;
  else if (!status) body = <p className="vmodels__empty">Checking this device…</p>;
  else if (!status.runtime.addon) body = <p className="vmodels__empty">This build of the server can’t load the speech engine, so calls use the cloud voice.</p>;
  else body = groups.map((g) => (
    <section key={g.kind} className="cfg-section vmodels__group">
      <div className="cfg-section__label">{KIND_LABEL[g.kind]}</div>
      <div className="cfg-card">{g.items.map((m) => <ModelRow key={m.id} m={m} />)}</div>
    </section>
  ));

  return (
    <Modal onClose={close} className="vmodels" label="Voice models">
      <div className="modal__header">
        <span className="modal__title">Voice models</span>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} opacity={0.68} /></button>
      </div>
      <div className="vmodels__body">
        <p className="vmodels__intro">On-device voice runs on this machine with no cloud voice service. Remove a model to free its space; download it again any time.</p>
        {body}
        {error && <div className="voice-error" role="alert">{error}</div>}
      </div>
      <div className="modal__footer vmodels__footer">
        <span className="vmodels__total">{status ? `${formatSize(onDisk) || '0 MB'} on disk` : ''}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={close}>Done</button>
      </div>
    </Modal>
  );
}
