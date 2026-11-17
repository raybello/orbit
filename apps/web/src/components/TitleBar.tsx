import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useConfigUI } from '../configStore';
import { hasNativeWindowControls } from '../lib/desktop-shell';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/**
 * The window-wide title bar: search in the middle, the account and Connect apps at the right.
 *
 * On macOS the desktop app hides its own title bar (`titleBarStyle: 'hiddenInset'`), so the real
 * traffic lights sit over this strip. That is the only place they may appear: a browser has no
 * window controls, and drawing lookalikes there was mistaken for a working close button.
 */
export function TitleBar() {
  const user = useStore((s) => s.user);
  const setModal = useStore((s) => s.setModal);
  const goBack = useStore((s) => s.goBack);
  const goForward = useStore((s) => s.goForward);
  const canBack = useStore((s) => s.navHistory.length > 0);
  const canForward = useStore((s) => s.navFuture.length > 0);
  const [accountMenu, setAccountMenu] = useState(false);
  const nativeControls = hasNativeWindowControls();
  const logout = async () => { await api.logout().catch(() => {}); location.reload(); };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    };
    const handleMouse = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); goBack(); }
      else if (e.button === 4) { e.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('mousedown', handleMouse);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('mousedown', handleMouse);
    };
  }, [goBack, goForward]);

  return (
    <header className={`titlebar${nativeControls ? ' has-native-controls' : ''}`}>
      <div className="titlebar__lead">
        <span className="titlebar__brand" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="18.6" cy="6.4" r="2.8" fill="currentColor" />
          </svg>
          <span className="titlebar__brand-name">Orbit</span>
        </span>
      </div>

      <div className="titlebar__nav" aria-label="Navigation history">
        <button
          type="button"
          className="titlebar__nav-btn"
          disabled={!canBack}
          onClick={goBack}
          aria-label="Go back"
          title="Back (Alt+←)"
        >
          <Icon name="chev_left" size={16} />
        </button>
        <button
          type="button"
          className="titlebar__nav-btn"
          disabled={!canForward}
          onClick={goForward}
          aria-label="Go forward"
          title="Forward (Alt+→)"
        >
          <Icon name="chev_right" size={16} />
        </button>
      </div>

      <button
        type="button"
        className="titlebar__search"
        onClick={() => setModal('search')}
        aria-label="Search Orbit"
        title="Search (⌘K)"
      >
        <Icon name="search" size={14} opacity={0.6} />
        <span className="titlebar__search-label">Search</span>
        <kbd className="titlebar__search-kbd">⌘K</kbd>
      </button>

      <div className="titlebar__actions">
        <button
          type="button"
          className="titlebar__btn"
          onClick={() => setModal('apps')}
          aria-label="Connect apps"
          title="Connect apps"
        >
          <Icon name="apps" size={16} />
        </button>
        <div className="titlebar__account">
          <button
            type="button"
            className="titlebar__avatar"
            onMouseDown={(e) => { e.stopPropagation(); setAccountMenu((v) => !v); }}
            aria-haspopup="menu"
            aria-expanded={accountMenu}
            aria-label="Account menu"
            title={user?.email ?? 'Account'}
          >
            {user?.avatarUrl ? (
              <img className="titlebar__avatar-img" src={user.avatarUrl} alt={user.name} />
            ) : (
              <span className="titlebar__initials">{initials(user?.name ?? user?.email ?? '')}</span>
            )}
          </button>
          {accountMenu && (
            <Menu
              align="right"
              onClose={() => setAccountMenu(false)}
              items={[
                { label: 'Settings', hint: '⌘,', onSelect: () => useConfigUI.getState().openAppSettings() },
                { label: 'Connect apps', onSelect: () => setModal('apps') },
                { label: 'Log out', danger: true, onSelect: logout },
              ]}
            >
              <div className="menu__header">{user?.email}</div>
            </Menu>
          )}
        </div>
      </div>
    </header>
  );
}
