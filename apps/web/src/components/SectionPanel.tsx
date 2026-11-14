import type { NavSection } from '@orbit/contracts';
import { ChatListView } from './ChatListView';
import { TasksIsland } from './config/TasksView';
import { Icon } from './Icon';

/** Panel titles, one per rail section. */
const TITLES: Record<NavSection, string> = {
  activity: 'Activity',
  chat: 'Chats',
  calendar: 'Calendar',
  calls: 'Calls',
  files: 'Files',
  computers: 'Computers',
  skills: 'Skills',
};

interface Props {
  section: NavSection;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * The body of a section. One branch per section — everything is a placeholder until that
 * section ships, so replacing a body means replacing exactly one branch below.
 */
function SectionBody({ section }: { section: NavSection }) {
  switch (section) {
    case 'activity':
      return <div className="section-panel__placeholder" data-section={section}>Coming soon</div>;
    case 'chat':
      return (
        <div className="section-panel__chat">
          <TasksIsland />
          <ChatListView />
        </div>
      );
    case 'calendar':
      return <div className="section-panel__placeholder" data-section={section}>Coming soon</div>;
    case 'calls':
      return <div className="section-panel__placeholder" data-section={section}>Coming soon</div>;
    case 'files':
      return <div className="section-panel__placeholder" data-section={section}>Coming soon</div>;
    case 'computers':
      return <div className="section-panel__placeholder" data-section={section}>Coming soon</div>;
    case 'skills':
      return <div className="section-panel__placeholder" data-section={section}>Coming soon</div>;
  }
}

/** The 280px list beside the rail: a titled header with a collapse control, then the section body. */
export function SectionPanel({ section, collapsed, onToggleCollapsed }: Props) {
  return (
    <aside
      className={`section-panel${collapsed ? ' is-collapsed' : ''}`}
      data-section={section}
      aria-label={`${TITLES[section]} panel`}
      aria-hidden={collapsed || undefined}
    >
      <div className="section-panel__header">
        <h2 className="section-panel__title">{TITLES[section]}</h2>
        <button
          type="button"
          className="icon-btn icon-btn--plain section-panel__collapse"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
          title={collapsed ? 'Expand panel (⌘B)' : 'Collapse panel (⌘B)'}
        >
          <Icon name={collapsed ? 'expand' : 'shrink'} size={16} opacity={0.66} />
        </button>
      </div>
      <div className="section-panel__body">
        <SectionBody section={section} />
      </div>
    </aside>
  );
}
