import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Routine } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api, openPopup } from '../lib/api';
import { botVars } from '../lib/colors';
import { computerStatusText } from '../lib/computer';
import { displayName, useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { ToolkitLogo } from './ToolkitLogo';
import { VoiceSettings } from './VoiceSettings';
import { ComputerScreen, type ScreenMode } from './ComputerViewer';
import { EngineSettings } from './EngineSettings';
import { MembersCard } from './MembersCard';
import { useConfigUI } from '../configStore';
import { Glyph } from './config/glyphs';
import { LibraryTab } from './config/LibraryTab';
import { BotTasks } from './config/TasksView';

// Other files import this from here; it lives in lib/computer so the viewer can use it too.
export { computerStatusText };

type DetailsTab = 'screen' | 'activity' | 'tasks' | 'library' | 'engine';

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' is-on' : ''}`} onClick={() => onChange(!on)}>
      <span className="toggle__knob" />
    </button>
  );
}

function RoutineRow({ r }: { r: Routine }) {
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try { await api.setRoutine(r.id, v); } catch { setEnabled(!v); }
  };
  return (
    <div className="panel-row panel-row--routine" title={r.prompt}>
      <span className="panel-row__icon"><Icon name="clock" opacity={0.52} /></span>
      <span className="panel-row__text">
        <span className="panel-row__title">{r.name}</span>
        <span className="panel-row__sub">{enabled ? r.description || r.schedule : 'Paused'}</span>
      </span>
      <Toggle on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'off'}`} />
    </div>
  );
}

export function DetailsPanel() {
  const bot = useSelectedBot();
  const routines = useStore((s) => (bot ? s.routines[bot.id] : undefined));
  const computer = useStore((s) => s.computer);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const open = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const [tab, setTab] = useState<DetailsTab>('screen');
  const [hideSuggested, setHideSuggested] = useState(() => { try { return localStorage.getItem('grokbot.hideSuggested') === '1'; } catch { return false; } });
  const barRef = useRef<HTMLDivElement>(null);
  if (!bot) return null;

  // Rooms are group chats: they have no engine of their own, so no Engine tab.
  const isRoom = bot.kind === 'room';
  const tabs: { id: DetailsTab; label: string }[] = [
    { id: 'screen', label: 'Screen' },
    { id: 'activity', label: 'Activity' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'library', label: 'Library' },
    ...(isRoom ? [] : [{ id: 'engine' as DetailsTab, label: 'Engine' }]),
  ];
  // Switching from a bot on Engine to a room (or a vanished tab) lands back on the first tab.
  const shown: DetailsTab = tabs.some((t) => t.id === tab) ? tab : 'screen';

  const openComputer = (mode: ScreenMode) => set({ viewerOpen: true, viewerMode: mode, viewerHint: null });
  const addSlack = async () => {
    const popup = openPopup('about:blank');
    try { const { redirectUrl } = await api.connect('slack'); if (popup) popup.location.href = redirectUrl; } catch { popup?.close(); }
  };

  // Arrow keys move between tabs, as a tablist should.
  const onTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const ids = tabs.map((t) => t.id);
    const at = ids.indexOf(shown);
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % ids.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = ids[next];
    setTab(id);
    barRef.current?.querySelector<HTMLButtonElement>(`#details-tab-${id}`)?.focus();
  };

  return (
    <aside
      className={`details${open ? '' : ' is-closed'}`}
      style={botVars(bot.avatarColor)}
      aria-label="Conversation details"
      aria-hidden={open ? undefined : true}
    >
      {open && (<>
      <div className="details__top">
        <button type="button" className="icon-btn icon-btn--bordered details__gear" onClick={() => useConfigUI.getState().openBotSettings(bot.id)} aria-label="Bot settings" title="Bot settings">
          <Glyph name="gear" size={16} opacity={0.7} />
        </button>
        <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: false })} aria-label="Close details">
          <Icon name="close" opacity={0.92} />
        </button>
      </div>
      <div className="details-tabs" role="tablist" aria-label="Conversation details sections" ref={barRef} onKeyDown={onTabKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`details-tab-${t.id}`}
            aria-selected={shown === t.id}
            aria-controls="details-tabpanel"
            tabIndex={shown === t.id ? 0 : -1}
            className={`details-tab${shown === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="details__scroll" id="details-tabpanel" role="tabpanel" aria-labelledby={`details-tab-${shown}`}>
        {shown === 'screen' && (
          isRoom ? (
            <div className="details__identity">
              <BotAvatarFor bot={bot} size={64} />
              <div className="details__name" title={displayName(bot)}>{displayName(bot)}</div>
            </div>
          ) : (
            <div className="details__hero">
              <ComputerScreen key={bot.id} bot={bot} variant="panel" paused={viewerOpen} onExpand={openComputer} />
              <div className="details__who">
                <BotAvatarFor bot={bot} size={36} />
                <div className="details__who-text">
                  <div className="details__who-head">
                    <span className="details__who-name" title={displayName(bot)}>{displayName(bot)}</span>
                    {bot.model && <span className="details__model" title={bot.provider ? `${bot.provider} · ${bot.model}` : bot.model}>{bot.model}</span>}
                  </div>
                  <div className="details__who-sub">Computer {computerStatusText(computer).toLowerCase()}</div>
                </div>
                <button type="button" className="btn btn--sm btn--secondary details__open" onClick={() => openComputer('watch')}>Open</button>
              </div>
            </div>
          )
        )}
        {shown === 'activity' && (
          <div className="details__sections">
            {isRoom && (
              <section>
                <div className="section-label">Members</div>
                <MembersCard room={bot} />
              </section>
            )}
            <section>
              <div className="section-label section-label--row">
                <span>Upcoming</span>
                <button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}>Manage</button>
              </div>
              <div className="panel-card">
                {routines?.length ? routines.map((r) => <RoutineRow key={r.id} r={r} />) : (
                  <div className="panel-empty">Nothing scheduled. Try asking in chat, for example “send me a summary every weekday at 8am”.</div>
                )}
              </div>
            </section>
            {!isRoom && !hideSuggested && (
              <section>
                <div className="section-label section-label--row">
                  <span>Suggested</span>
                  <button type="button" className="link-btn link-btn--small" onClick={() => { setHideSuggested(true); try { localStorage.setItem('grokbot.hideSuggested', '1'); } catch { /* ignore */ } }}>Hide</button>
                </div>
                <div className="panel-card">
                  <button type="button" className="panel-row panel-row--link" onClick={addSlack}>
                    <span className="panel-row__glyph"><ToolkitLogo name="Slack" logo="/assets/icons/slack.svg" size={16} radius={4} /></span>
                    <span className="panel-row__title" style={{ flex: 1 }}>Add to Slack</span>
                    <Icon name="chev_right" size={12} opacity={0.56} />
                  </button>
                </div>
              </section>
            )}
            {!isRoom && (
              <section>
                <div className="section-label">Voice chat</div>
                <VoiceSettings bot={bot} />
              </section>
            )}
          </div>
        )}
        {shown === 'tasks' && <BotTasks bot={bot} />}
        {shown === 'library' && <LibraryTab bot={bot} />}
        {shown === 'engine' && !isRoom && (
          <div className="engine-tab-panel">
            <div className="section-label">Engine</div>
            <EngineSettings bot={bot} />
          </div>
        )}
      </div>
      </>)}
    </aside>
  );
}
