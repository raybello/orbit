import type { NavSection } from '@orbit/contracts';
import { ChatListView } from './ChatListView';
import { TasksIsland } from './config/TasksView';
import { Icon } from './Icon';
import { PanelResizer, usePanelWidth, type PanelBounds } from './PanelResizer';

const SECTION_BOUNDS: PanelBounds = { min: 220, max: 480, initial: 300 };

const TITLES: Record<NavSection, string> = {
  activity: 'Activity',
  chat: 'Chats',
  calendar: 'Calendar',
  calls: 'Calls',
  files: 'Files',
  computers: 'Screens',
  skills: 'Skills',
};

interface Props {
  section: NavSection;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function SectionBody({ section }: { section: NavSection }) {
  switch (section) {
    case 'activity':
      return <div className="section-panel__placeholder" data-section={section}>Coming soon</div>;
    case 'chat':
      return (
        <div className="section-panel__chat">
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

/**
 * The 280px list beside the rail: a titled header with a collapse control, then the section body.
 *
 * Collapsed, it keeps a narrow strip holding its own expand control. The panel used to slide to
 * zero width with the button inside it, which left a keyboard shortcut as the only way back — a
 * collapsed sidebar that cannot be reopened is a broken one.
 */
export function SectionPanel({ section, collapsed, onToggleCollapsed }: Props) {
  const [width, setWidth] = usePanelWidth('orbit.sectionPanelWidth', SECTION_BOUNDS);
  return (
    <aside
      className={`section-panel${collapsed ? ' is-collapsed' : ''}`}
      data-section={section}
      aria-label={`${TITLES[section]} panel`}
      style={collapsed ? undefined : { ['--section-panel-width' as string]: `${width}px` }}
    >
      {!collapsed && (
        <PanelResizer
          edge="right"
          width={width}
          bounds={SECTION_BOUNDS}
          onWidth={setWidth}
          onCollapse={onToggleCollapsed}
          label={`Resize the ${TITLES[section]} panel`}
        />
      )}
      <div className="section-panel__header">
        {!collapsed && section === 'chat' && <TasksIsland />}
        {!collapsed && section !== 'chat' && <h2 className="section-panel__title">{TITLES[section]}</h2>}
        <button
          type="button"
          className="icon-btn icon-btn--plain section-panel__collapse"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? `Expand the ${TITLES[section]} panel` : 'Collapse panel'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand panel (⌘B)' : 'Collapse panel (⌘B)'}
        >
          <Icon name={collapsed ? 'chev_right' : 'shrink'} size={16} opacity={0.66} />
        </button>
      </div>
      {!collapsed && (
        <div className="section-panel__body">
          <SectionBody section={section} />
        </div>
      )}
    </aside>
  );
}
