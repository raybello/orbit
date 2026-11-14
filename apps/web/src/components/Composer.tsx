import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot, MessageFile } from '@orbit/contracts';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';

const MAX_H = 200;
const drafts = new Map<string, string>();
const QUICK_EMOJI = ['👍', '🙂', '🎉', '✅', '👀', '🔥', '🙏', '💡'];

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<'attach' | 'emoji' | null>(null);
  const [pendingFiles, setPendingFiles] = useState<MessageFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setError(null); setPendingFiles([]); ref.current?.focus(); }, [bot.id]);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [text]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = text.trim();
    if ((!t && pendingFiles.length === 0) || sending || uploading) return;
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t || '​', pendingFiles.length > 0 ? pendingFiles : undefined);
      setText('');
      setPendingFiles([]);
      drafts.delete(bot.id);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    setMenu(null);
    setUploading(true); setError(null);
    try {
      const uploaded = await Promise.all(files.map((f) => api.uploadAttachment(bot.id, f)));
      setPendingFiles((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setError((e as Error).message || 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = () => api.fresh(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const dictation = useDictation(insertText, setError, bot.voiceLanguage);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  /** Wrap the selection in ** ** so the composer doubles as a formatting bar. */
  const toggleBold = () => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    if (start === end) { el.focus(); return; }
    const next = `${text.slice(0, start)}**${text.slice(start, end)}**${text.slice(end)}`;
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + 2, end + 2); });
  };

  const hasText = text.trim().length > 0;
  const canSend = (hasText || pendingFiles.length > 0) && !uploading;

  return (
    <div className="composer-area">
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      {pendingFiles.length > 0 && (
        <div className="composer__attachments">
          {pendingFiles.map((f, i) => (
            <div key={i} className="composer__attachment-chip">
              <Icon name="file" size={14} />
              <span className="composer__attachment-name">{f.filename}</span>
              <button type="button" className="composer__attachment-remove" aria-label={`Remove ${f.filename}`} onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        <div className="composer__toolbar">
          <button type="button" className="composer__toolbar-btn" onClick={toggleBold} aria-label="Bold" title="Bold the selection">
            <span aria-hidden style={{ fontSize: 12, fontWeight: 600, lineHeight: '18px' }}>Aa</span>
          </button>
          <span className="composer__toolbar-sep" aria-hidden />
          <span className="composer__plus-anchor">
            <button type="button" className="composer__toolbar-btn" onClick={() => setMenu(menu === 'attach' ? null : 'attach')} aria-label="More actions" aria-expanded={menu === 'attach'} title="Attach and more">
              <Icon name="paperclip" size={16} />
            </button>
            {menu === 'attach' && (
              <Menu
                placement="above"
                onClose={() => setMenu(null)}
                items={[
                  { label: 'Upload file', onSelect: () => { setMenu(null); fileInputRef.current?.click(); } },
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                ]}
              />
            )}
          </span>
          <span className="composer__plus-anchor">
            <button type="button" className="composer__toolbar-btn" onClick={() => setMenu(menu === 'emoji' ? null : 'emoji')} aria-label="Emoji" aria-expanded={menu === 'emoji'} title="Emoji">
              <Icon name="emoji" size={16} />
            </button>
            {menu === 'emoji' && (
              <Menu
                placement="above"
                onClose={() => setMenu(null)}
                items={QUICK_EMOJI.map((e) => ({ label: e, onSelect: () => insertText(e) }))}
              />
            )}
          </span>
          <button
            type="button"
            className="composer__toolbar-btn"
            onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}
            aria-label="Routines"
            title="Routines for this Bot"
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
        <div className="composer__main">
          <div className="composer__left">
            <textarea
              ref={ref}
              className="composer__input"
              rows={1}
              value={text}
              placeholder="Type a new message"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
              }}
              aria-label={`Message ${displayName(bot)}`}
            />
          </div>
          <div className="composer__right">
            <button
              type="button"
              className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
              aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
              aria-pressed={dictation.state === 'recording'}
              title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
              disabled={dictation.state === 'transcribing'}
              onPointerDown={dictation.onPointerDown}
              onPointerUp={dictation.onPointerUp}
              onKeyDown={dictation.onKeyDown}
              onContextMenu={(e) => e.preventDefault()}
            >
              <Icon name="mic" opacity={0.7} />
            </button>
            {inCall && !canSend ? (
              <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="End voice call" title="End voice call">
                <Icon name="voice_a" size={16} />
              </button>
            ) : running && !canSend ? (
              <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
                <Icon name="stop" size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="composer__cta"
                onClick={canSend ? send : () => startCall(bot.id)}
                disabled={canSend && sending}
                aria-label={canSend ? 'Send' : `Start voice chat with ${bot.name}`}
                title={canSend ? 'Send (Enter)' : 'Start voice chat'}
              >
                <Icon name={canSend ? 'arrow_up' : 'voice_a'} size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
