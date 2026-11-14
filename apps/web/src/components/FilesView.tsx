import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, FileEntry } from '@orbit/contracts';
import { api } from '../lib/api';
import { useStore } from '../store';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { Icon, type IconName } from './Icon';
import { ImageViewer } from './ImageViewer';
import { Modal } from './modals/Modal';
import { formatBytes, shortDate } from './config/ui';
import '../styles/files.css';

type FileType = 'all' | 'library' | 'attachment' | 'workspace';
type ViewMode = 'grid' | 'list';
type FileKind = 'image' | 'audio' | 'video' | 'pdf' | 'code' | 'other';

const PAGE_SIZE = 50;
/** Text previews stop at 200 KB; bigger files keep downloading instead of hanging the tab. */
const TEXT_CAP = 200_000;
const LS_VIEW = 'grokbot.filesView';

const TABS: { value: FileType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'library', label: 'Library' },
  { value: 'attachment', label: 'Attachments' },
  { value: 'workspace', label: 'Workspace' },
];

const KIND_ICON: Record<FileKind, IconName> = {
  image: 'eye',
  audio: 'mic',
  video: 'calls',
  pdf: 'file',
  code: 'edit',
  other: 'paperclip',
};

/** Extensions worth showing as text even when the server reports application/octet-stream. */
const TEXT_EXT = /\.(?:txt|md|markdown|mdx|log|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|jsx?|mjs|cjs|tsx?|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|sh|bash|zsh|fish|sql|graphql|gql|tex|lua|r|dart|vue|svelte)$/i;

function kindOf(entry: FileEntry): FileKind {
  const media = (entry.mediaType || '').toLowerCase();
  if (media.startsWith('image/')) return 'image';
  if (media.startsWith('audio/')) return 'audio';
  if (media.startsWith('video/')) return 'video';
  if (media === 'application/pdf') return 'pdf';
  if (media.startsWith('text/') || /(?:json|javascript|typescript|xml|yaml|x-sh|x-python|sql)/.test(media) || TEXT_EXT.test(entry.filename)) return 'code';
  return 'other';
}

function readView(): ViewMode {
  try { return localStorage.getItem(LS_VIEW) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}

function writeView(view: ViewMode) {
  try { localStorage.setItem(LS_VIEW, view); } catch { /* storage can be unavailable */ }
}

/** Hand the file to the browser's downloader; `download` keeps the original filename. */
function download(entry: FileEntry) {
  const a = document.createElement('a');
  a.href = api.fileUrl(entry);
  a.download = entry.filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function TextPreview({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const url = api.fileUrl(entry);

  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    setCapped(false);
    fetch(url, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        return res.text();
      })
      .then((body) => {
        if (!alive) return;
        if (body.length > TEXT_CAP) { setText(body.slice(0, TEXT_CAP)); setCapped(true); }
        else setText(body);
      })
      .catch((err: Error) => { if (alive) setError(err.message || 'Could not load the file'); });
    return () => { alive = false; };
  }, [url]);

  return (
    <Modal onClose={onClose} label={`Preview of ${entry.filename}`} className="files-preview">
      <div className="files-preview__head">
        <span className="files-preview__name" title={entry.filename}>{entry.filename}</span>
        <div className="files-preview__tools">
          <a className="btn btn--sm btn--secondary" href={url} download={entry.filename} title={`Download ${entry.filename}`}>
            <Icon name="arrow_down" size={12} /> Download
          </a>
          <button type="button" className="icon-btn icon-btn--plain" onClick={onClose} aria-label="Close preview" title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      {error ? (
        <div className="files-preview__error" role="alert">Couldn’t preview this file. {error}</div>
      ) : text === null ? (
        <div className="files-preview__loading" role="status">Loading preview…</div>
      ) : (
        <pre className="files-preview__code">{text}</pre>
      )}
      {capped && <div className="files-preview__cut">Showing the first 200 KB.</div>}
    </Modal>
  );
}

function FileItem({
  entry,
  bots,
  onOpen,
  mode,
  selected,
  onSelect,
}: {
  entry: FileEntry;
  bots: Bot[];
  onOpen: (e: FileEntry) => void;
  mode: ViewMode;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const kind = kindOf(entry);
  const bot = bots.find((b) => b.id === entry.botId);
  const label = entry.path || entry.filename;

  const thumb = (
    <span className="file-item__thumb">
      {kind === 'image'
        ? <img className="file-item__img" src={api.fileUrl(entry)} alt="" loading="lazy" />
        : <Icon name={KIND_ICON[kind]} size={18} opacity={0.55} />}
    </span>
  );
  const name = <span className="file-item__name">{entry.filename}</span>;
  const size = <span className="file-item__size">{formatBytes(entry.size)}</span>;
  const modified = (
    <span className="file-item__date" title={new Date(entry.createdAt).toLocaleString()}>
      {shortDate(entry.createdAt)}
    </span>
  );
  const owner = (
    <span className="file-item__bot">
      <BotAvatarFor
        bot={bot ?? { name: entry.botName, avatarShape: 'blob', avatarColor: 'gray' }}
        size={13}
      />
      <span className="file-item__bot-name">{entry.botName}</span>
    </span>
  );

  // List mode is a flat table row: clicking anywhere selects it, the name opens the file.
  if (mode === 'list') {
    return (
      <div
        className={`file-item${selected ? ' is-selected' : ''}`}
        data-kind={kind}
        data-selected={selected || undefined}
        aria-current={selected ? 'true' : undefined}
        title={label}
        onClick={() => onSelect(entry.id)}
      >
        {thumb}
        <button
          type="button"
          className="file-item__open"
          onClick={(e) => { e.stopPropagation(); onSelect(entry.id); onOpen(entry); }}
          title={label}
        >
          {name}
        </button>
        {size}
        {modified}
        {owner}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="file-item"
      data-kind={kind}
      onClick={() => onOpen(entry)}
      title={label}
    >
      {thumb}
      <span className="file-item__text">
        {name}
        <span className="file-item__meta">
          {size}
          <span className="file-item__dot" aria-hidden>·</span>
          {modified}
        </span>
      </span>
      {owner}
    </button>
  );
}

/**
 * One browser for every file the bots own: library saves, message attachments and workspace output.
 * Filter by bot, type and name; previews stay in-app for images and text, everything else downloads.
 */
export function FilesView() {
  const bots = useStore((s) => s.bots);
  const [view, setView] = useState<ViewMode>(readView);
  const [rawSearch, setRawSearch] = useState('');
  const [query, setQuery] = useState({ botId: '', type: 'all' as FileType, search: '', page: 1 });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [image, setImage] = useState<FileEntry | null>(null);
  const [text, setText] = useState<FileEntry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const request = useRef(0);

  // Typing settles before the request: one fetch per pause, not one per keystroke.
  useEffect(() => {
    const term = rawSearch.trim();
    if (term === query.search) return;
    const t = setTimeout(() => {
      setQuery((q) => (q.search === term ? q : { ...q, search: term, page: 1 }));
    }, 250);
    return () => clearTimeout(t);
  }, [rawSearch, query.search]);

  useEffect(() => {
    const id = ++request.current;
    const first = query.page === 1;
    setLoading(true);
    setError(null);
    if (first) { setFiles([]); setTotal(0); }
    api.files({
      botId: query.botId || undefined,
      type: query.type,
      search: query.search || undefined,
      page: query.page,
      pageSize: PAGE_SIZE,
    })
      .then((res) => {
        if (id !== request.current) return;
        setFiles((prev) => (first ? res.files : [...prev, ...res.files]));
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        if (id !== request.current) return;
        setError(err instanceof Error && err.message ? err.message : 'Could not load files');
      })
      .finally(() => { if (id === request.current) setLoading(false); });
  }, [query, nonce]);

  const pick = (next: Partial<typeof query>) => setQuery((q) => ({ ...q, ...next, page: 1 }));

  const changeView = (next: ViewMode) => { setView(next); writeView(next); };

  const open = (entry: FileEntry) => {
    const kind = kindOf(entry);
    if (kind === 'image') setImage(entry);
    else if (kind === 'code') setText(entry);
    else download(entry);
  };

  const loadMore = () => setQuery((q) => ({ ...q, page: q.page + 1 }));
  const retry = () => setNonce((n) => n + 1);
  const closeImage = useCallback(() => setImage(null), []);
  const closeText = useCallback(() => setText(null), []);
  const selectFile = useCallback((id: string) => setSelectedId((cur) => (cur === id ? null : id)), []);

  const hasMore = files.length < total;

  return (
    <div className={`files-view is-${view}`}>
      <div className="files-view__bar">
        <div className="files-view__search">
          <Icon name="search" size={13} opacity={0.5} />
          <input
            className="files-view__search-input"
            type="search"
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            placeholder="Search files"
            aria-label="Search files"
          />
          {rawSearch && (
            <button type="button" className="files-view__clear" onClick={() => setRawSearch('')} aria-label="Clear search" title="Clear search">
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
        <div className="files-view__controls">
          <select
            className="files-view__bot"
            aria-label="Filter by bot"
            value={query.botId}
            onChange={(e) => pick({ botId: e.target.value })}
            disabled={!bots.length}
          >
            <option value="">All bots</option>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <div className="files-view__views" role="group" aria-label="Layout">
            <button
              type="button"
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
              onClick={() => changeView('grid')}
              title="Grid"
            >
              <Icon name="grid" size={13} />
            </button>
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => changeView('list')}
              title="List"
            >
              <Icon name="sidebar" size={13} />
            </button>
          </div>
        </div>
        <div className="files-view__tabs" role="group" aria-label="Filter by type">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              className="files-view__tab"
              aria-pressed={query.type === t.value}
              onClick={() => pick({ type: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="files-view__body">
        {error && files.length === 0 ? (
          <div className="files-view__state" role="alert">
            <div className="files-view__state-title">Couldn’t load files</div>
            <div className="files-view__state-sub">{error}</div>
            <button type="button" className="btn btn--sm btn--secondary files-view__retry" onClick={retry}>Retry</button>
          </div>
        ) : loading && files.length === 0 ? (
          <div className="files-view__skeleton" role="status" aria-label="Loading files">
            {Array.from({ length: 6 }, (_, i) => <div key={i} className="files-view__ghost" />)}
          </div>
        ) : files.length === 0 ? (
          <div className="files-view__state">
            <div className="files-view__state-title">No files yet</div>
            <div className="files-view__state-sub">
              {query.search || query.botId || query.type !== 'all'
                ? 'Nothing matches these filters.'
                : 'Files your bots save, attach or create in their workspace show up here.'}
            </div>
          </div>
        ) : (
          <>
            {error && (
              <div className="files-view__error" role="alert">
                <Icon name="refresh" size={12} />
                <span className="files-view__error-text">{error}</span>
                <button type="button" className="link-btn link-btn--small" onClick={retry}>Retry</button>
              </div>
            )}
            <div className="files-view__table">
              {view === 'list' && (
                <div className="files-view__thead">
                  <span className="files-view__th" aria-hidden />
                  <span className="files-view__th">Name</span>
                  <span className="files-view__th">Size</span>
                  <span className="files-view__th">Modified</span>
                  <span className="files-view__th">Bot</span>
                </div>
              )}
              <div className={`files-view__items${view === 'grid' ? ' files-view__items--grid' : ' files-view__items--list'}`}>
                {files.map((f) => (
                  <FileItem
                    key={f.id}
                    entry={f}
                    bots={bots}
                    onOpen={open}
                    mode={view}
                    selected={selectedId === f.id}
                    onSelect={selectFile}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {files.length > 0 && (
        <div className="files-view__foot">
          {hasMore ? (
            <button type="button" className="btn btn--sm btn--secondary files-view__more" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          ) : (
            <span className="files-view__end">End of list · {total} {total === 1 ? 'file' : 'files'}</span>
          )}
        </div>
      )}

      {image && <ImageViewer url={api.fileUrl(image)} name={image.filename} onClose={closeImage} />}
      {text && <TextPreview entry={text} onClose={closeText} />}
    </div>
  );
}
