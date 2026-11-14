import { useState } from 'react';
import type { NavSection } from '@orbit/contracts';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { api } from '../lib/api';
import { Icon, type IconName } from './Icon';
import { Menu } from './Menu';
import { hasNativeWindowControls } from '../lib/desktop-shell';

/** The rail's sections: id, label and glyph, in the order they appear. */
const SECTIONS: readonly { id: NavSection; label: string; icon: IconName }[] = [
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'chat', label: 'Chat', icon: 'chat_filled' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'calls', label: 'Calls', icon: 'calls' },
  { id: 'files', label: 'Files', icon: 'files_folder' },
  { id: 'computers', label: 'Computers', icon: 'computers' },
  { id: 'skills', label: 'Skills', icon: 'skills' },
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/**
 * The window dots. A browser gets our drawn ones; the desktop app already has the real
 * controls over the same corner (hidden inset title bar), so drawing ours again shows two.
 */
export function TrafficLights() {
  if (hasNativeWindowControls()) return null;
  return (
    <div className="traffic-lights" aria-hidden>
      <span style={{ background: '#FF5F57' }} />
      <span style={{ background: '#FEBC2E' }} />
      <span style={{ background: '#28C840' }} />
    </div>
  );
}

interface Props {
  active: NavSection;
  onChange: (s: NavSection) => void;
  unreadCounts?: Partial<Record<NavSection, number>>;
}

/** The 60px icon rail down the left edge: window dots, the seven sections, the account. */
export function NavRail({ active, onChange, unreadCounts }: Props) {
  const user = useStore((s) => s.user);
  const setModal = useStore((s) => s.setModal);
  const [accountMenu, setAccountMenu] = useState(false);
  const logout = async () => { await api.logout().catch(() => {}); location.reload(); };

  return (
    <nav className="nav-rail" aria-label="Sections">
      <div className="nav-rail__titlebar">
        <TrafficLights />
      </div>

      <div className="nav-rail__items">
        {SECTIONS.map((s) => {
          const isActive = s.id === active;
          const count = unreadCounts?.[s.id] ?? 0;
          return (
            <button
              key={s.id}
              type="button"
              className={`nav-rail__item${isActive ? ' is-active' : ''}`}
              onClick={() => onChange(s.id)}
              aria-label={count > 0 ? `${s.label}, ${count} unread` : s.label}
              aria-current={isActive ? 'page' : undefined}
              title={s.label}
            >
              <Icon name={s.icon} size={20} />
              <span className="nav-rail__label">{s.label}</span>
              {count > 0 && <span className="nav-rail__badge" aria-hidden>{count > 99 ? '99+' : count}</span>}
            </button>
          );
        })}
      </div>

      <div className="nav-rail__footer">
        <div className="account">
          <button
            type="button"
            className="account__btn account__btn--rail"
            onClick={() => setAccountMenu(!accountMenu)}
            aria-haspopup="menu"
            aria-expanded={accountMenu}
            aria-label="Account menu"
            title={user?.email ?? 'Account'}
          >
            <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>
          </button>
          {accountMenu && (
            <Menu
              align="left"
              placement="above"
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
        <button type="button" className="icon-btn icon-btn--rail" onClick={() => setModal('apps')} aria-label="Connect apps" title="Connect apps">
          <Icon name="apps" size={16} />
        </button>
      </div>
    </nav>
  );
}
