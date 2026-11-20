import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Modal } from './modals/Modal';

/** The server's terminal size (domain/engine-signin.ts); this view is drawn to match. */
const COLS = 100;
const ROWS = 30;

export function engineTerminalUrl(botId: string, provider?: string, origin = window.location.origin): string {
  const u = new URL(`/api/bots/${encodeURIComponent(botId)}/engine/terminal`, origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (provider) u.searchParams.set('provider', provider);
  return u.toString();
}

/**
 * Hermes' own sign-in, in a terminal: it runs where the agent's files live (the server), for this one
 * Bot. A subscription prints a link to open and asks for the code it gives back.
 */
export function SignInTerminal({ botId, botName, provider, providerName, onClose }: {
  botId: string;
  botName: string;
  provider?: string;
  providerName?: string;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'connecting' | 'open' | 'done' | 'failed'>('connecting');

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({ cols: COLS, rows: ROWS, cursorBlink: true, convertEol: false, fontSize: 13 });
    term.open(el);
    term.focus();
    const ws = new WebSocket(engineTerminalUrl(botId, provider));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => setState('open');
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => {
      setState(e.code === 1000 && e.reason === 'done' ? 'done' : 'failed');
      if (e.code !== 1000) term.write('\r\n\x1b[2mThe sign-in could not start, or another one is already open for this Bot.\x1b[0m\r\n');
    };
    const typed = term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
    // Hermes' menus use Escape; the dialog must not take it as "close".
    const keepEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation(); };
    el.addEventListener('keydown', keepEscape);
    return () => { el.removeEventListener('keydown', keepEscape); typed.dispose(); ws.close(); term.dispose(); };
  }, [botId, provider]);

  const title = providerName ? `Sign in to ${providerName}` : 'Choose a model';
  return (
    <Modal onClose={onClose} label={`${title} for ${botName}`} className="signin-terminal">
      <div className="signin-terminal__head">
        <div>
          <div className="signin-terminal__title">{title}</div>
          <div className="signin-terminal__sub">Hermes, for {botName}. Open the link it prints, then paste the code back here.</div>
        </div>
        <button type="button" className="btn btn--sm btn--secondary" onClick={onClose}>{state === 'done' ? 'Done' : 'Close'}</button>
      </div>
      <div className="signin-terminal__screen" ref={host} aria-label="Sign-in terminal" />
      <div className="signin-terminal__status" role="status">
        {state === 'connecting' ? 'Starting…' : state === 'open' ? 'Running' : state === 'done' ? 'Finished' : 'Stopped'}
      </div>
    </Modal>
  );
}
