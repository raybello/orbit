import type { NavSection } from '@orbit/contracts';
import { Icon, type IconName } from './Icon';

const SECTIONS: readonly { id: NavSection; label: string; icon: IconName }[] = [
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'chat', label: 'Chat', icon: 'chat_filled' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'calls', label: 'Calls', icon: 'calls' },
  { id: 'files', label: 'Files', icon: 'files_folder' },
  { id: 'computers', label: 'Screens', icon: 'computers' },
  { id: 'skills', label: 'Skills', icon: 'skills' },
];

interface Props {
  active: NavSection;
  onChange: (s: NavSection) => void;
  unreadCounts?: Partial<Record<NavSection, number>>;
}

/**
 * The icon strip beside the section list. Account and Connect apps live in the title bar, so the
 * rail holds nothing but the sections themselves, as Teams' rail does.
 */
export function NavRail({ active, onChange, unreadCounts }: Props) {
  return (
    <nav className="nav-rail" aria-label="Sections">
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
    </nav>
  );
}
