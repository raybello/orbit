import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, EngineInfo } from '@orbit/contracts';

// jsdom cannot draw a terminal; what matters here is what it is wired to.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    open() {}
    focus() {}
    write() {}
    dispose() {}
    onData() { return { dispose() {} }; }
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const engine: EngineInfo = {
  botId: 'b1', profile: 'default', status: 'ready', error: null, model: 'claude-sonnet-4-6', provider: 'anthropic', version: '0.23.1', ownScreen: false,
  providers: [
    { id: 'anthropic', name: 'Claude', kind: 'subscription', connected: false, models: ['claude-sonnet-4-6'] },
    { id: 'openrouter', name: 'OpenRouter', kind: 'api_key', connected: true, models: [] },
  ],
};
vi.mock('../lib/configApi', () => ({ configApi: { engine: vi.fn(async () => ({ engine })) } }));

import { configApi } from '../lib/configApi';
import { EngineSettings } from '../components/EngineSettings';
import { engineTerminalUrl } from '../components/SignInTerminal';

const sockets: string[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) { sockets.push(url); }
  send() {}
  close() {}
}

const bot = { id: 'b1', name: 'Atlas' } as Bot;

beforeEach(() => { sockets.length = 0; vi.stubGlobal('WebSocket', FakeSocket); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('the sign-in terminal', () => {
  it('speaks WebSocket on the page origin, ws for http and wss for https', () => {
    expect(engineTerminalUrl('b1', 'anthropic', 'http://127.0.0.1:59297')).toBe('ws://127.0.0.1:59297/api/bots/b1/engine/terminal?provider=anthropic');
    expect(engineTerminalUrl('b1', undefined, 'https://orbit.example.com')).toBe('wss://orbit.example.com/api/bots/b1/engine/terminal');
  });

  it("opens from the Engine tab on that Bot's Hermes sign-in, and the tab reloads when it closes", async () => {
    render(<EngineSettings bot={bot} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude…' }));

    expect(screen.getByRole('dialog', { name: 'Sign in to Claude for Atlas' })).toBeTruthy();
    expect(sockets).toEqual([`ws://${location.host}/api/bots/b1/engine/terminal?provider=anthropic`]);
    const loads = vi.mocked(configApi.engine).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(vi.mocked(configApi.engine).mock.calls.length).toBe(loads + 1));
  });
});
