import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DetailsTab } from '../store';
import { fitTabs } from '../domain/tab-fit';
import { Icon } from './Icon';
import { Menu } from './Menu';

/**
 * The details panel's tabs at their natural width. Tabs that do not fit go into a "More" menu at the
 * end, in order, and the selected tab always stays in the bar. A hidden copy of the bar measures
 * each label, so the fit never depends on what is currently showing.
 */
export function DetailsTabBar({ tabs, shown, onSelect }: {
  tabs: { id: DetailsTab; label: string }[];
  shown: DetailsTab;
  onSelect: (id: DetailsTab) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [moreWidth, setMoreWidth] = useState(0);
  const [available, setAvailable] = useState(Infinity);
  const [menu, setMenu] = useState(false);
  const labels = tabs.map((t) => t.label).join('|');

  useLayoutEffect(() => {
    const cells = [...(measureRef.current?.children ?? [])] as HTMLElement[];
    setWidths(cells.slice(0, -1).map((c) => c.offsetWidth));
    setMoreWidth(cells[cells.length - 1]?.offsetWidth ?? 0);
  }, [labels]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const read = () => {
      const s = getComputedStyle(bar);
      setAvailable(bar.clientWidth - parseFloat(s.paddingLeft || '0') - parseFloat(s.paddingRight || '0'));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  const active = tabs.findIndex((t) => t.id === shown);
  const fit = widths.length === tabs.length ? fitTabs(widths, available, moreWidth, active) : { visible: tabs.map((_, i) => i), overflow: [] };
  const visible = fit.visible.map((i) => tabs[i]);
  const overflow = fit.overflow.map((i) => tabs[i]);

  const select = (id: DetailsTab, focus: boolean) => {
    onSelect(id);
    if (focus) requestAnimationFrame(() => barRef.current?.querySelector<HTMLButtonElement>(`#details-tab-${id}`)?.focus());
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).getAttribute('role') !== 'tab') return;
    const ids = tabs.map((t) => t.id);
    let next = -1;
    if (e.key === 'ArrowRight') next = (active + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (active - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(ids[next], true);
  };

  return (
    <div className="details-tabs" role="tablist" aria-label="Conversation details sections" ref={barRef} onKeyDown={onKeyDown}>
      {visible.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`details-tab-${t.id}`}
          aria-selected={shown === t.id}
          aria-controls="details-tabpanel"
          tabIndex={shown === t.id ? 0 : -1}
          className={`details-tab${shown === t.id ? ' is-active' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
      {overflow.length > 0 && (
        <span className="details-tabs__more-anchor">
          <button type="button" className="details-tab details-tabs__more" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            More <Icon name="chev_down" size={10} opacity={0.7} />
          </button>
          {menu && <Menu align="right" onClose={() => setMenu(false)} items={overflow.map((t) => ({ label: t.label, onSelect: () => select(t.id, true) }))} />}
        </span>
      )}
      <div className="details-tabs__measure" ref={measureRef} aria-hidden>
        {tabs.map((t) => <span key={t.id} className="details-tab">{t.label}</span>)}
        <span className="details-tab details-tabs__more">More <Icon name="chev_down" size={10} opacity={0.7} /></span>
      </div>
    </div>
  );
}
