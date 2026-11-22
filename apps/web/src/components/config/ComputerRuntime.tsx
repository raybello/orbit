import { useComputerRuntime } from '../../lib/computerRuntime';

/**
 * What Bots' computers run on. Both runtimes use the same image and the same home folders, so
 * switching keeps each Bot's files and logins; the computers restart on the new runtime the next
 * time they are opened.
 */
export function ComputerRuntimeCard() {
  const { info, busy, error, choose, installApple } = useComputerRuntime();
  if (!info) return null;
  const canInstall = typeof window !== 'undefined' && !!window.orbitDesktop?.computers;
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Runs on</div>
      <div className="cfg-card">
        {info.options.map((o) => {
          const active = o.name === info.active;
          return (
            <div className="cfg-row" key={o.name}>
              <div className="cfg-row__text">
                <div className="cfg-row__title">{o.label}{active ? ' · in use' : ''}</div>
                <div className="cfg-row__sub">
                  {o.note ?? (o.name === 'apple' ? 'Each Bot’s computer is its own small VM. Mac with Apple silicon.' : 'Each Bot’s computer is a container.')}
                </div>
              </div>
              {active ? null : o.installable && canInstall ? (
                <button type="button" className="cfg-btn cfg-btn--primary" disabled={busy !== null} onClick={() => void installApple()}>
                  {busy === 'install' ? 'Installing…' : 'Install'}
                </button>
              ) : (
                <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!o.available || busy !== null} onClick={() => void choose(o.name)}>
                  {busy === o.name ? 'Switching…' : 'Switch'}
                </button>
              )}
            </div>
          );
        })}
        {error && <div className="cfg-error cfg-error--inset">{error}</div>}
      </div>
    </section>
  );
}
