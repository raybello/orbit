import { useEffect } from 'react';
import type { NavSection } from '@orbit/contracts';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { DetailsPanel } from './components/DetailsPanel';
import { NavRail } from './components/NavRail';
import { SectionPanel } from './components/SectionPanel';
import { ActivityView } from './components/ActivityView';
import { CalendarView } from './components/CalendarView';
import { CallsView } from './components/CallsView';
import { FilesView } from './components/FilesView';
import { ComputersView } from './components/ComputersView';
import { SkillsView } from './components/SkillsView';
import { SignIn } from './components/SignIn';
import { ConnectAppsModal } from './components/modals/ConnectAppsModal';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { TasksView } from './components/config/TasksView';
import { useConfigUI } from './configStore';

/**
 * The main-area view for each rail section. Chat is the exception: its list lives in the 280px
 * SectionPanel and this area holds the open transcript, so it is rendered by Shell directly.
 */
function SectionView({ section }: { section: NavSection }) {
  switch (section) {
    case 'chat': return null;
    case 'activity': return <ActivityView />;
    case 'calendar': return <CalendarView />;
    case 'calls': return <CallsView />;
    case 'files': return <FilesView />;
    case 'computers': return <ComputersView />;
    case 'skills': return <SkillsView />;
  }
}

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const hasBot = useStore((s) => !!s.selectedBotId);
  const unreadChat = useStore((s) => s.bots.reduce((n, b) => n + (b.unread || 0), 0));
  const view = useConfigUI((s) => s.view);
  const navSection = useConfigUI((s) => s.navSection);
  const sectionPanelCollapsed = useConfigUI((s) => s.sectionPanelCollapsed);
  const setNavSection = useConfigUI((s) => s.setNavSection);
  const toggleSectionPanel = useConfigUI((s) => s.toggleSectionPanel);
  const inChat = navSection === 'chat';
  // The panel stays mounted so it can slide shut; it renders its body only while open.
  const showDetails = hasBot && inChat && view === 'chat';

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    const stop = startEvents();
    // OAuth popups post back here; refresh connection-dependent views and the open transcript.
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type !== 'grokbot-connected') return;
      const s = useStore.getState();
      s.set({ connectionsVersion: s.connectionsVersion + 1 });
      if (s.selectedBotId) s.loadRows(s.selectedBotId).catch(() => {});
    };
    window.addEventListener('message', onMsg);
    return () => { stop(); window.removeEventListener('message', onMsg); };
  }, []);

  // Global shortcuts: ⌘K search, ⌘B section panel, ⇧⌘, details, ⌘, app settings.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') { e.preventDefault(); useConfigUI.getState().toggleSectionPanel(); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.set({ detailsOpen: !st.detailsOpen }); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <div className={`app${showDetails && detailsOpen ? ' has-details' : ''}`}>
      <NavRail
        active={navSection}
        onChange={setNavSection}
        unreadCounts={unreadChat > 0 ? { chat: unreadChat } : undefined}
      />
      {inChat && <SectionPanel section={navSection} collapsed={sectionPanelCollapsed} onToggleCollapsed={toggleSectionPanel} />}
      <div className="app__main">
        {inChat
          ? view === 'tasks' ? <TasksView /> : <ChatView />
          : <SectionView section={navSection} />}
      </div>
      {showDetails && <DetailsPanel />}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'apps' && <ConnectAppsModal />}
      {viewerOpen && <ComputerViewer />}
      <ConfigLayer />
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  if (!authChecked) return <div className="boot" />;
  return user ? <Shell /> : <SignIn />;
}
