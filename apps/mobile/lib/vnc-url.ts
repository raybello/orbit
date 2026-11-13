export type ScreenMode = 'watch' | 'control';

/**
 * The VNC viewer's WebSocket URL: same relay the web app uses, with the session token in the query
 * because a WebSocket cannot carry an Authorization header.
 */
export function vncWebSocketUrl(
  apiBase: string,
  botId: string,
  token: string,
  mode: ScreenMode = 'watch',
): string {
  const base = apiBase.replace(/\/+$/, '');
  const socketBase = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;

  const params = new URLSearchParams({ mode, token });
  return `${socketBase}/api/bots/${encodeURIComponent(botId)}/screen?${params.toString()}`;
}

export function screenModeLabel(mode: ScreenMode): string {
  return mode === 'control' ? 'You have control' : 'Watching';
}
