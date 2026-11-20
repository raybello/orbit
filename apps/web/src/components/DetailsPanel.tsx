import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Bot, Routine } from '@orbit/contracts';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { PrimaryStar } from './PrimaryStar';
import { api, openPopup } from '../lib/api';
import { botVars } from '../lib/colors';
import { computerStatusText } from '../lib/computer';
import { useSelectedBot, useStore, type DetailsTab } from '../store';
import { artifactsOf } from '../domain/artifacts';
import { ArtifactPanel } from './ArtifactPanel';
import { displayName } from '../domain/transcript-utils';
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

const TAB_LABELS: Record<DetailsTab, string> = {
  screen: 'Screen', activity: 'Activity', tasks: 'Tasks', library: 'Library', engine: 'Engine', artifact: 'Artifact',
};

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

/**
 * A group chat's right panel, as Teams arranges it: the group at the top, the people in it, then
 * the options that only exist inside a group. A one-to-one chat has none of these.
 */
function GroupDetails({ bot, open }: { bot: Bot; open: boolean }) {
  const [people, setPeople] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const muted = useStore((s) => s.mutedRooms.includes(bot.id));
  const toggleMute = useStore((s) => s.toggleMuteRoom);
  const loadBots = useStore((s) => s.loadBots);
  const set = useStore((s) => s.set);

  const leave = async () => {
    if (!window.confirm(`Leave "${bot.name}"? The group and its messages are deleted for everyone. Its Bots stay on your team.`)) return;
    setLeaving(true); setError(null);
    try {
      await api.deleteRoom(bot.id);
      set({ detailsOpen: false });
      // The group is gone from the roster, so loadBots moves the selection to another chat.
      await loadBots();
    } catch (e) {
      setError((e as Error).message || 'Could not leave the group');
      setLeaving(false);
    }
  };

  return (
    <aside className={`details details--group${open ? '' : ' is-closed'}`} style={botVars(bot.avatarColor)} aria-label="Group details" aria-hidden={open ? undefined : true}>
      {open && (<>
        <div className="details__top">
          <button type="button" className="icon-btn icon-btn--bordered" onClick={() => set({ detailsOpen: false })} aria-label="Close details">
            <Icon name="close" opacity={0.92} />
          </button>
        </div>
        <div className="details__scroll">
          <div className="group-hero">
            <BotAvatarFor bot={bot} size={56} />
            <div className="group-hero__text">
              <div className="group-hero__name" title={displayName(bot)}>{displayName(bot)}</div>
              <div className="group-hero__sub">Group chat{people === null ? '' : ` · ${people} ${people === 1 ? 'bot' : 'bots'}`}</div>
            </div>
          </div>

          <div className="details__sections">
            <section>
              <div className="section-label">People</div>
              <MembersCard room={bot} onCount={setPeople} />
              <div className="group-hint">@mention a Bot to ask just them; Bots can also @mention each other to collaborate.</div>
            </section>

            <section>
              <div className="section-label">Options</div>
              <div className="panel-card">
                <div className="panel-row panel-row--setting">
                  <span className="panel-row__lead">
                    <Icon name={muted ? 'bell_off' : 'bell'} size={16} opacity={0.6} />
                    <span>{muted ? 'Unmute chat' : 'Mute chat'}</span>
                  </span>
                  <Toggle on={muted} onChange={() => toggleMute(bot.id)} label={muted ? 'Unmute chat' : 'Mute chat'} />
                </div>
                <button type="button" className="panel-row panel-row--action is-danger" onClick={leave} disabled={leaving}>
                  <Icon name="leave" size={16} opacity={0.7} />
                  <span>{leaving ? 'Leaving…' : 'Leave'}</span>
                </button>
              </div>
              {error && <div className="cfg-error cfg-error--small">{error}</div>}
            </section>
          </div>
        </div>
      </>)}
    </aside>
  );
}

export function DetailsPanel() {
  const bot = useSelectedBot();
  const routines = useStore((s) => (bot ? s.routines[bot.id] : undefined));
  const computer = useStore((s) => s.computer);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const open = useStore((s) => s.detailsOpen);
  const set = useStore((s) => s.set);
  const tab = useStore((s) => s.detailsTab);
  const setTab = (detailsTab: DetailsTab) => set({ detailsTab });
  const bySeq = useStore((s) => (bot ? s.transcripts[bot.id]?.bySeq : undefined));
  const artifacts = useMemo(() => artifactsOf(bySeq ? Object.values(bySeq) : []), [bySeq]);
  const [hideSuggested, setHideSuggested] = useState(() => { try { return localStorage.getItem('grokbot.hideSuggested') === '1'; } catch { return false; } });
  const barRef = useRef<HTMLDivElement>(null);
  if (!bot) return null;

  // Rooms are group chats: no computer, no engine and no routines of their own, so their panel is
  // the people and the group options instead of the tabs a Bot has.
  if (bot.kind === 'room') return <GroupDetails bot={bot} open={open} />;

  const ids: DetailsTab[] = artifacts.size ? ['artifact', 'screen', 'activity', 'tasks', 'library', 'engine'] : ['screen', 'activity', 'tasks', 'library', 'engine'];
  const tabs = ids.map((id) => ({ id, label: TAB_LABELS[id] }));
  // Switching from a bot on Engine to a room (or a vanished tab) lands back on the first tab.
  const shown: DetailsTab = tabs.some((t) => t.id === tab) ? tab : 'screen';

  const openComputer = (mode: ScreenMode) => set({ viewerOpen: true, viewerMode: mode, viewerHint: null });
  const addSlack = async () => {
    const popup = openPopup('about:blank');
    try { const { redirectUrl } = await api.connect('slack'); if (popup) popup.location.href = redirectUrl; } catch { popup?.close(); }
  };

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
      className={`details${open ? '' : ' is-closed'}${open && shown === 'artifact' ? ' is-wide' : ''}`}
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
          <div className="details__hero">
            <ComputerScreen key={bot.id} bot={bot} variant="panel" paused={viewerOpen} onExpand={openComputer} />
            <div className="details__who">
              <span className="details__avatar">
                <BotAvatarFor bot={bot} size={36} />
                {bot.isPrimary && <PrimaryStar size={14} />}
              </span>
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
        )}
        {shown === 'activity' && (
          <div className="details__sections">
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
            {!hideSuggested && (
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
            <section>
              <div className="section-label">Voice chat</div>
              <VoiceSettings bot={bot} />
            </section>
          </div>
        )}
        {shown === 'artifact' && <ArtifactPanel key={bot.id} botId={bot.id} artifacts={artifacts} />}
        {shown === 'tasks' && <BotTasks bot={bot} />}
        {shown === 'library' && <LibraryTab bot={bot} />}
        {shown === 'engine' && (
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
