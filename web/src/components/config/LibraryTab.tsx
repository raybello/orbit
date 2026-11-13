import { useCallback, useEffect, useState } from 'react';
import type { Bot, LibraryFile } from '@shared/types';
import { configApi, type LibraryListing } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { ImageViewer } from '../ImageViewer';
import { Glyph } from './glyphs';
import { formatBytes } from './ui';

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** Files the bot saved under /root/grokbot/files/<botId> on its computer. */
export function LibraryTab({ bot }: { bot: Bot }) {
  const awake = useStore((s) => s.computer?.status === 'running');
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

  useEffect(() => { setPath(''); setList(null); }, [bot.id]);
  useEffect(() => { load(); }, [load, awake]);

  const relFor = (f: LibraryFile) => (path ? `${path}/${f.name}` : f.name);
  const rawUrl = (rel: string) => `/api/bots/${bot.id}/files/raw?path=${encodeURIComponent(rel)}`;
  const isImage = (f: LibraryFile) => !f.isDir && IMAGE.test(f.name);

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

  /** Images open in the zoomable viewer; everything else keeps downloading as before. */
  const open = async (f: LibraryFile) => {
    if (!isImage(f)) return download(f);
    setOpening(f.name); setError(null);
    try {
      const { url } = await configApi.downloadFile(bot.id, relFor(f));
      setPreview({ url, name: f.name });
    } catch (e) { setError(`Couldn’t open ${f.name}: ${(e as Error).message}`); }
    finally { setOpening(null); }
  };

  const crumbs = path ? path.split('/') : [];

  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span className="lib-crumbs">
            {crumbs.length ? (
              <>
                <button type="button" className="link-btn link-btn--small" onClick={() => setPath('')}>Files</button>
                {crumbs.map((c, i) => (
                  <span key={i} className="lib-crumbs__part">
                    <Icon name="chev_right" size={8} opacity={0.5} />
                    <button type="button" className="link-btn link-btn--small" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                  </span>
                ))}
              </>
            ) : 'Files'}
          </span>
          <button type="button" className="link-btn link-btn--small" onClick={() => load()} disabled={loading} aria-label="Refresh files" title="Refresh">
            <Icon name="refresh" size={12} opacity={0.7} style={loading ? { animation: 'cfg-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
        <div className="panel-card">
          {list?.status === 'asleep' ? (
            <div className="lib-empty">
              <div>{bot.name}’s computer is asleep. Wake it to see saved files.</div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => load(true)} disabled={loading}>{loading ? 'Waking…' : 'Wake and show files'}</button>
            </div>
          ) : !list && loading ? (
            <div className="panel-empty">Looking for files…</div>
          ) : list?.status === 'error' ? (
            <div className="panel-empty">Couldn’t reach the computer. {list.error ? <span className="lib-err">{list.error}</span> : null}</div>
          ) : !list?.files.length ? (
            <div className="panel-empty panel-empty--center">{path ? 'This folder is empty.' : `Files that ${bot.name} creates, like reports and notes, are kept here.`}</div>
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
                    {opening === f.name ? <span className="cfg-spinner" /> : image ? <Icon name="expand" size={11} opacity={0.4} /> : null}
                  </button>
                  {f.isDir ? <Icon name="chev_right" size={12} opacity={0.5} /> : (
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
