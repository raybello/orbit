import { useEffect, useMemo, useState } from 'react';
import { encode } from 'uqr';
import { pairLink, type PairCodeResponse } from '@orbit/contracts';
import { api } from '../../lib/api';
import { useDesktopPhoneAccess } from '../../lib/desktop';
import { PAIR_REFRESH_LEAD_MS, phoneServer, type PhoneServer } from '../../lib/phone-pairing';
import { Switch } from './ui';

/**
 * Settings → Devices → Connect your phone: a QR the iPhone Camera opens in the Orbit app, which then
 * signs in to this account. In the desktop app the phone can only reach the server once the person
 * turns on "Allow my phone to connect"; on a server already served from a reachable address, the QR
 * is there straight away.
 */
export function PhoneConnect() {
  const [access, setAccess] = useDesktopPhoneAccess();
  const [switching, setSwitching] = useState(false);
  const server = access === undefined ? null : phoneServer(window.location.origin, access);
  const pair = usePairCode(server?.kind === 'ready' ? server.url : null);
  if (!server) return null;
  const hasSwitch = access != null && access.phase !== 'unavailable';
  const on = server.kind !== 'switch-off';

  const flip = async (next: boolean) => {
    setSwitching(true);
    try {
      await setAccess(next);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Connect your phone</div>
      <div className="cfg-card">
        {hasSwitch && (
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Allow my phone to connect</div>
              <div className="cfg-row__sub">
                Lets a phone on the same Wi-Fi reach Orbit while this app is open. The connection is not encrypted, so use it on a network you trust. Off, nothing outside this computer can reach Orbit.
              </div>
            </div>
            <Switch on={on} disabled={switching} onChange={(v) => void flip(v)} label="Allow my phone to connect" />
          </div>
        )}
        <div className="cfg-row phone-connect">
          {server.kind === 'ready' && pair.code ? (
            <>
              <QrCode value={pairLink({ server: server.url, code: pair.code })} />
              <div className="cfg-row__text">
                <div className="cfg-row__title">Scan with your iPhone's Camera</div>
                <ol className="phone-connect__steps">
                  <li>Open the Camera and point it at the code.</li>
                  <li>Tap the Orbit banner. The app opens signed in to this account.</li>
                </ol>
                <div className="cfg-row__sub">
                  Your phone connects to <code>{server.url}</code>. The code works once and renews on its own.
                </div>
              </div>
            </>
          ) : (
            <div className="cfg-row__sub">{pair.error ?? blockedReason(server)}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function blockedReason(server: PhoneServer): string {
  switch (server.kind) {
    case 'switch-off': return 'Turn on “Allow my phone to connect” to show the code.';
    case 'no-network': return 'This computer is not on a network right now. Join the same Wi-Fi as your phone.';
    case 'error': return server.error;
    case 'loopback': return 'Your phone cannot reach this address. Open Orbit from an address your phone can reach to show the code.';
    case 'ready': return 'Making a code…';
  }
}

/** A live pairing code while `server` is set, swapped for a fresh one shortly before it expires. */
function usePairCode(server: string | null): { code: string | null; error: string | null } {
  const [pair, setPair] = useState<PairCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPair(null);
    setError(null);
    if (!server) return;
    let alive = true;
    let timer: number | undefined;
    const mint = () => {
      api.pairCode().then(
        (next) => {
          if (!alive) return;
          setPair(next);
          timer = window.setTimeout(mint, Math.max(5_000, next.expiresAt - Date.now() - PAIR_REFRESH_LEAD_MS));
        },
        (e: Error) => { if (alive) setError(`Could not make a code: ${e.message}`); },
      );
    };
    mint();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [server]);
  return { code: pair?.code ?? null, error };
}

/** Black on white whatever the theme: a phone camera reads that best. */
function QrCode({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <svg className="phone-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code that opens the Orbit app" shapeRendering="crispEdges" data-pair-link={value}>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
