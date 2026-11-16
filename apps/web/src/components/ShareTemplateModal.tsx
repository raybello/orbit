import { useEffect, useRef, useState } from 'react';
import type { ShareTemplateResponse } from '@orbit/contracts';
import { templatesApi } from '../lib/templatesApi';
import { useStore } from '../store';
import { useTemplatesUI } from '../templatesStore';
import { Icon } from './Icon';
import { Modal } from './modals/Modal';
import '../styles/templates.css';

/**
 * "Share as template": opening it saves the Bot as a template (or refreshes the one it already has,
 * so an old link keeps working) and hands back a link to copy.
 */
export function ShareTemplateModal({ botId }: { botId: string }) {
  const close = useTemplatesUI((s) => s.close);
  const name = useStore((s) => s.bots.find((b) => b.id === botId)?.name ?? 'this Bot');
  const [share, setShare] = useState<ShareTemplateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    templatesApi.share(botId).then(setShare).catch((e: Error) => setError(e.message));
  }, [botId]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.shareUrl);
      setCopied(true);
    } catch {
      linkRef.current?.select();
    }
  };

  const isPublic = share?.template.visibility === 'public';

  return (
    <Modal onClose={close} className="share-template-modal" label="Share as template">
      <div className="modal__header">
        <div className="modal__title">Share {name} as a template</div>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={14} opacity={0.68} /></button>
      </div>
      <div className="share-template__body">
        <p className="share-template__lede">
          Anyone with this link can install their own copy of {name}: its instructions, skills and routines. Never its chats, memories or connected apps.
        </p>
        <div className="share-template__link">
          <input ref={linkRef} className="text-input" readOnly value={share?.shareUrl ?? 'Creating link…'} aria-label="Template link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn btn--secondary btn--sm" onClick={copy} disabled={!share}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            <span>{copied ? 'Copied' : 'Copy link'}</span>
          </button>
        </div>
        <label className="share-template__toggle">
          <input
            type="checkbox"
            checked={isPublic}
            disabled={!share || busy}
            onChange={(e) => {
              const visibility = e.target.checked ? 'public' : 'link';
              void run(async () => setShare(await templatesApi.share(botId, visibility)));
            }}
          />
          <span>List it in the public template gallery</span>
        </label>
        {error && <div className="card__error share-template__error">{error}</div>}
      </div>
      <div className="modal__footer">
        <button
          type="button"
          className="link-btn link-btn--small share-template__stop"
          disabled={!share || busy}
          onClick={() => void run(async () => { await templatesApi.unshare(share!.template.id); close(); })}
        >
          Stop sharing
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={close}>Done</button>
      </div>
    </Modal>
  );
}
