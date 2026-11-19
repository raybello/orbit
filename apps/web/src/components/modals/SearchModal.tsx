import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { useConfigUI, type AppSection } from '../../configStore';
import { useStore } from '../../store';
import { displayName } from '../../domain/transcript-utils';
import { Icon } from '../Icon';
import { Modal } from './Modal';

interface BotResult {
  kind: 'bot';
  id: string;
  name: string;
  label: string;
  preview: string | null;
  isPrimary: boolean;
}
interface BotScreenResult {
  kind: 'bot-screen';
  botId: string;
  botName: string;
}
interface BotSettingsResult {
  kind: 'bot-settings';
  botId: string;
  botName: string;
}
interface BotFilesResult {
  kind: 'bot-files';
  botId: string;
  botName: string;
}
interface SettingsResult {
  kind: 'settings';
  id: string;
  label: string;
  hint: string;
}

type SearchResult = BotResult | BotScreenResult | BotSettingsResult | BotFilesResult | SettingsResult;

const SETTINGS_ITEMS: { id: AppSection; label: string; hint: string; keywords: string[] }[] = [
  { id: 'account', label: 'Account', hint: 'Sign out, manage your account', keywords: ['account', 'sign out', 'logout', 'profile', 'avatar'] },
  { id: 'appearance', label: 'Appearance', hint: 'Theme, colors, font size', keywords: ['appearance', 'theme', 'dark', 'light', 'font', 'color'] },
  { id: 'engine-auth', label: 'AI Models', hint: 'Configure AI model and API keys', keywords: ['models', 'ai', 'claude', 'openai', 'api key', 'engine'] },
  { id: 'api-keys', label: 'API keys', hint: 'Edit the Hermes .env and config.yaml every Bot shares', keywords: ['api key', 'keys', 'hermes', 'env', 'config', 'yaml', 'settings', 'mcp'] },
  { id: 'computer', label: 'Computer', hint: 'Remote computer access', keywords: ['computer', 'remote', 'screen', 'vnc'] },
  { id: 'permissions', label: 'Permissions', hint: 'Data and permissions', keywords: ['permissions', 'privacy', 'security', 'data'] },
  { id: 'apps', label: 'Connect Apps', hint: 'Connect external apps and services', keywords: ['apps', 'connect', 'integrations', 'slack'] },
];

function resultLabel(r: SearchResult): string {
  switch (r.kind) {
    case 'bot': return r.name;
    case 'bot-screen': return `${r.botName} · Chat`;
    case 'bot-settings': return `${r.botName} · Settings`;
    case 'bot-files': return `${r.botName} · Files`;
    case 'settings': return r.label;
  }
}

function resultSub(r: SearchResult): string {
  switch (r.kind) {
    case 'bot': return r.preview ?? r.label ?? '';
    case 'bot-screen': return "Open this bot's chat";
    case 'bot-settings': return 'Open bot settings';
    case 'bot-files': return 'View files created by this bot';
    case 'settings': return r.hint;
  }
}

function resultSection(r: SearchResult): string {
  switch (r.kind) {
    case 'bot': return 'Bots';
    case 'bot-screen':
    case 'bot-settings':
    case 'bot-files': return 'Bot shortcuts';
    case 'settings': return 'Settings';
  }
}

export function SearchModal() {
  const bots = useStore((s) => s.bots);
  const setModal = useStore((s) => s.setModal);
  const selectBot = useStore((s) => s.selectBot);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const openSettings = useConfigUI((s) => s.openAppSettings);
  const openBotSettings = useConfigUI((s) => s.openBotSettings);

  const results: SearchResult[] = useMemo(() => {
    const needle = q.trim().toLowerCase();

    if (!needle) {
      // No query: show bots sorted by recency
      return [...bots]
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt)
        .map((b) => ({
          kind: 'bot' as const,
          id: b.id,
          name: displayName(b),
          label: b.label,
          preview: b.lastPreview,
          isPrimary: b.isPrimary,
        }));
    }

    const out: SearchResult[] = [];

    // Check if query ends with a bot shortcut keyword
    const shortcutMatch = needle.match(/^(.+?)\s+(screen|settings|files)$/i);
    if (shortcutMatch) {
      const [, botPart, action] = shortcutMatch;
      const matched = bots.filter((b) => displayName(b).toLowerCase().includes(botPart.toLowerCase()));
      for (const b of matched) {
        const bn = displayName(b);
        if (action.toLowerCase() === 'screen') out.push({ kind: 'bot-screen', botId: b.id, botName: bn });
        else if (action.toLowerCase() === 'settings') out.push({ kind: 'bot-settings', botId: b.id, botName: bn });
        else if (action.toLowerCase() === 'files') out.push({ kind: 'bot-files', botId: b.id, botName: bn });
      }
    }

    // Settings items
    const settingsHits = SETTINGS_ITEMS.filter((s) =>
      s.label.toLowerCase().includes(needle) ||
      s.keywords.some((k) => k.includes(needle))
    );
    for (const s of settingsHits) {
      out.push({ kind: 'settings', id: s.id, label: s.label, hint: s.hint });
    }

    // Bot name matches
    const botHits = [...bots]
      .filter((b) => `${displayName(b)} ${b.label} ${b.description}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
    for (const b of botHits) {
      out.push({
        kind: 'bot',
        id: b.id,
        name: displayName(b),
        label: b.label,
        preview: b.lastPreview,
        isPrimary: b.isPrimary,
      });
    }

    return out;
  }, [bots, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const open = useCallback((r: SearchResult) => {
    close();
    switch (r.kind) {
      case 'bot':
        selectBot(r.id);
        break;
      case 'bot-screen':
        selectBot(r.botId);
        break;
      case 'bot-settings':
        openBotSettings(r.botId);
        break;
      case 'bot-files':
        selectBot(r.botId);
        break;
      case 'settings':
        openSettings(r.id as AppSection);
        break;
    }
  }, [bots, close, openSettings, openBotSettings, selectBot]);

  // Group results into sections
  const sections = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const r of results) {
      const s = resultSection(r);
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(r);
    }
    return [...map.entries()];
  }, [results]);

  return (
    <Modal onClose={close} className="search-modal" label="Search">
      <div className="search-modal__field">
        <span className="search-modal__icon"><Icon name="search" size={18} opacity={0.56} /></span>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search bots, settings, files…"
          aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && results[active]) { e.preventDefault(); open(results[active]); }
          }}
        />
      </div>
      <div className="search-modal__results" ref={listRef} role="listbox">
        {sections.map(([sectionLabel, items]) => (
          <div key={sectionLabel}>
            {q.trim() && <div className="search-modal__section">{sectionLabel}</div>}
            {items.map((r, _) => {
              const globalIdx = results.indexOf(r);
              return (
                <button
                  key={`${r.kind}-${r.kind === 'bot' ? r.id : r.kind === 'settings' ? r.id : r.botId + r.kind}`}
                  type="button"
                  role="option"
                  aria-selected={globalIdx === active}
                  data-idx={globalIdx}
                  className={`search-row${globalIdx === active ? ' is-active' : ''}`}
                  onMouseMove={() => setActive(globalIdx)}
                  onClick={() => open(r)}
                >
                  {r.kind === 'bot' ? (
                    <BotAvatarFor bot={bots.find((b) => b.id === r.id)!} size={28} />
                  ) : (
                    <span className="search-row__icon">
                      <Icon
                        name={r.kind === 'settings' ? 'sliders' : r.kind === 'bot-files' ? 'files_folder' : r.kind === 'bot-settings' ? 'sliders' : 'chat_filled'}
                        size={18}
                        opacity={0.7}
                      />
                    </span>
                  )}
                  <span className="search-row__text">
                    <span className="search-row__name">{resultLabel(r)}</span>
                    <span className="search-row__sub">{resultSub(r)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {results.length === 0 && q.trim() && (
          <div className="search-modal__empty">No results for "{q.trim()}"</div>
        )}
      </div>
      {!q.trim() && (
        <div className="search-modal__tips">
          <span>Type a bot name, or try <kbd>Settings</kbd>, <kbd>Atlas Screen</kbd>, <kbd>Atlas Files</kbd></span>
        </div>
      )}
    </Modal>
  );
}
