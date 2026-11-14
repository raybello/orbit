import { NavRail } from './NavRail';
import { SectionPanel } from './SectionPanel';
import { useConfigUI } from '../configStore';

export { TrafficLights } from './NavRail';

/**
 * The old all-in-one sidebar. The shell now renders NavRail and SectionPanel itself; this stays
 * as a drop-in replacement for anything that still asks for a sidebar (and for sign-in's dots).
 */
export function Sidebar() {
  const navSection = useConfigUI((s) => s.navSection);
  const collapsed = useConfigUI((s) => s.sectionPanelCollapsed);
  const setNavSection = useConfigUI((s) => s.setNavSection);
  const toggleSectionPanel = useConfigUI((s) => s.toggleSectionPanel);
  return (
    <>
      <NavRail active={navSection} onChange={setNavSection} />
      <SectionPanel section={navSection} collapsed={collapsed} onToggleCollapsed={toggleSectionPanel} />
    </>
  );
}
