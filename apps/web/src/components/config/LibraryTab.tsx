import { useCallback, useEffect, useState } from 'react';
import type { Bot, LibraryFile } from '@orbit/contracts';
import { configApi, type LibraryListing } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { Icon } from '../Icon';
import { ImageViewer } from '../ImageViewer';
import { Glyph } from './glyphs';
import { formatBytes } from './ui';

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/**
 * A directory explorer over the bot computer's own filesystem.
 *
 * The listing is the folder the computer keeps its work in (a Docker bot's /home/bot, the shared
 * computer's Library), one directory at a time, with folders to walk into. It reads the disk even
 * while the computer sleeps, so a stopped container still shows what the bot saved.
 */
export function LibraryTab({ bot }: { bot: Bot }) {
  const [path, setPath] = useState('');
  const [list, setList] = useState<LibraryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [broken, setBroken] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (wake = false) => {
    setLoading(true); setError(null);
    try { setList(await configApi.files(bot.id, path, wake)); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [bot.id, path]);

  useEffect(() => { setPath(''); setList(null); setBroken({}); }, [bot.id]);
  useEffect(() => { load(); }, [load]);

  const relFor = (f: LibraryFile) => (path ? `${path}/${f.name}` : f.name);
  const rawUrl = (rel: string) => `/api/bots/${bot.id}/files/raw?path=${encodeURIComponent(rel)}`;
  const isImage = (f: LibraryFile) => !f.isDir && IMAGE.test(f.name);
  const crumbs = path ? path.split('/') : [];
  const up = () => setPath(crumbs.slice(0, -1).join('/'));

  const download = async (f: LibraryFile) => {
    setBusyFile(f.name); setError(null);
    try {
      const { url } = await configApi.downloadFile(bot.id, relFor(f));
      const a = document.createElement('a');
      a.href = url; a.download = f.name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setError(`Couldn’t download ${f.name}: ${(e as Error).message}`); }
    finally { setBusyFile(null); }
  };

  const open = async (f: LibraryFile) => {
    if (!isImage(f)) return download(f);
    setOpening(f.name); setError(null);
    try {
      const { url } = await configApi.downloadFile(bot.id, relFor(f));
      setPreview({ url, name: f.name });
    } catch (e) { setError(`Couldn’t open ${f.name}: ${(e as Error).message}`); }
    finally { setOpening(null); }
  };

  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span className="lib-crumbs">
            <button
              type="button"
              className="lib-crumbs__up"
              onClick={up}
              disabled={!path}
              aria-label="Up one folder"
              title="Up one folder"
            >
              <Icon name="chev_right" size={12} opacity={path ? 0.7 : 0.3} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <button type="button" className="link-btn link-btn--small" onClick={() => setPath('')}>Home</button>
            {crumbs.map((c, i) => (
              <span key={i} className="lib-crumbs__part">
                <Icon name="chev_right" size={8} opacity={0.5} />
                <button type="button" className="link-btn link-btn--small" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
          </span>
          <button type="button" className="link-btn link-btn--small" onClick={() => load()} disabled={loading} aria-label="Refresh files" title="Refresh">
            <Icon name="refresh" size={12} opacity={0.7} style={loading ? { animation: 'cfg-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
        {list?.root && <div className="lib-root" title={`The bot computer’s filesystem, ${list.root}`}>{list.root}</div>}
        <div className="panel-card">
          {list?.status === 'asleep' ? (
            <div className="lib-empty">
              <div>{bot.name}’s computer is asleep, so its files can’t be read. Start it to browse them.</div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => load(true)} disabled={loading}>{loading ? 'Starting…' : 'Start its computer'}</button>
            </div>
          ) : !list && loading ? (
            <div className="panel-empty">Reading the computer’s files…</div>
          ) : list?.status === 'error' ? (
            <div className="panel-empty">Couldn’t read this folder. {list.error ? <span className="lib-err">{list.error}</span> : null}</div>
          ) : !list?.files.length ? (
            <div className="panel-empty panel-empty--center">{path ? 'This folder is empty.' : `Files ${bot.name} saves on its computer show up here.`}</div>
          ) : (
            list.files.map((f) => {
              const rel = relFor(f);
              const image = isImage(f);
              return (
                <div key={f.name} className={`lib-row${f.isDir ? ' is-dir' : ''}`}>
                  <button
                    type="button"
                    className="lib-row__main"
                    onClick={() => (f.isDir ? setPath(rel) : void open(f))}
                    title={f.isDir ? `Open ${f.name}` : image ? `Preview ${f.name}` : `Download ${f.name}`}
                  >
                    <span className={`lib-row__icon${image ? ' lib-row__icon--image' : ''}`}>
                      {image && !broken[rel]
                        ? <img className="lib-row__thumb" src={rawUrl(rel)} alt="" loading="lazy" onError={() => setBroken((b) => ({ ...b, [rel]: true }))} />
                        : <Glyph name={f.isDir ? 'folder' : 'doc'} size={16} opacity={0.6} />}
                    </span>
                    <span className="panel-row__text">
                      <span className="panel-row__title">{f.name}</span>
                      <span className="panel-row__meta">{f.isDir ? 'Folder' : formatBytes(f.size)} · {relativeShort(f.modifiedAt) === 'now' ? 'just now' : relativeShort(f.modifiedAt)}</span>
                    </span>
                    {opening === f.name ? <span className="cfg-spinner" /> : f.isDir ? <Icon name="chev_right" size={11} opacity={0.4} /> : image ? <Icon name="expand" size={11} opacity={0.4} /> : null}
                  </button>
                  {f.isDir ? null : (
                    <button type="button" className="cfg-icon-btn" onClick={() => download(f)} disabled={busyFile === f.name} aria-label={`Download ${f.name}`} title="Download">
                      {busyFile === f.name ? <span className="cfg-spinner" /> : <Glyph name="download" size={14} />}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
        {error && <div className="cfg-error cfg-error--small">{error}</div>}
      </section>
      {preview && <ImageViewer url={preview.url} name={preview.name} onClose={() => setPreview(null)} />}
    </div>
  );
}
