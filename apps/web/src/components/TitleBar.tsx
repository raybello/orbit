import { useState } from 'react';
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
  const [accountMenu, setAccountMenu] = useState(false);
  const nativeControls = hasNativeWindowControls();
  const logout = async () => { await api.logout().catch(() => {}); location.reload(); };

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
            onClick={() => setAccountMenu(!accountMenu)}
            aria-haspopup="menu"
            aria-expanded={accountMenu}
            aria-label="Account menu"
            title={user?.email ?? 'Account'}
          >
            <span className="titlebar__initials">{initials(user?.name ?? user?.email ?? '')}</span>
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
