import { useCallback, useEffect, useState } from 'react';
import type { Bot, DataListing, LibraryFile } from '@orbit/contracts';
import { viewerFor } from '@orbit/domain';
import { configApi, dataFileUrl } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { Icon } from '../Icon';
import { FileViewer, type ViewedFile } from '../files/FileViewer';
import { Glyph } from './glyphs';
import { formatBytes } from './ui';

/**
 * Where a link or image in a Markdown file points, as a data-folder URL: relative to the file's own
 * folder, or an absolute path inside the data folder (the `/data/...` paths bots write). Anything
 * else (a web address, an anchor, a path outside the folder) is left as written.
 */
export function resolveDataHref(href: string, fileDir: string, root: string): string {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return href;
  const [target] = href.split(/[?#]/);
  let rel: string;
  if (target.startsWith('/')) {
    const base = root.replace(/\/+$/, '');
    if (target !== base && !target.startsWith(`${base}/`)) return href;
    rel = target.slice(base.length + 1);
  } else {
    rel = fileDir ? `${fileDir}/${target}` : target;
  }
  const parts: string[] = [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return href; parts.pop(); } else parts.push(decodeURIComponent(seg));
  }
  return dataFileUrl(parts.join('/'));
}

/**
 * The Bot's files, as a browser over the server's data folder (`/data` in the Docker stack):
 * every Bot's agent home, the screens' home folders and the Library live under it. It opens at
 * this Bot's workspace, where its agent saves what it makes, and walks anywhere in the folder.
 * Files open in the shared viewer: Markdown rendered, images in the image viewer, text as code.
 */
export function LibraryTab({ bot }: { bot: Bot }) {
  /** null until the first listing says where this Bot's workspace is. */
  const [path, setPath] = useState<string | null>(null);
  const [list, setList] = useState<DataListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewed, setViewed] = useState<ViewedFile | null>(null);
  const [broken, setBroken] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await configApi.dataFiles(path === null ? { botId: bot.id } : { path, botId: bot.id });
      setList(r);
      if (path === null) setPath(r.path);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [bot.id, path]);

  useEffect(() => { setPath(null); setList(null); setBroken({}); }, [bot.id]);
  useEffect(() => { void load(); }, [load]);

  const here = list?.path ?? '';
  const relFor = (f: LibraryFile) => (here ? `${here}/${f.name}` : f.name);
  const crumbs = here ? here.split('/') : [];
  const rootName = (list?.root ?? '/data').split('/').filter(Boolean).pop() ?? 'data';
  const kindOf = (f: LibraryFile) => (f.isDir ? null : viewerFor(f.name));

  const open = (f: LibraryFile) => {
    const rel = relFor(f);
    if (kindOf(f) === 'other') {
      const a = document.createElement('a');
      a.href = dataFileUrl(rel); a.download = f.name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      return;
    }
    setViewed({ name: f.name, url: dataFileUrl(rel), path: rel, size: f.size, resolve: (href) => resolveDataHref(href, here, list?.root ?? '/data') });
  };

  return (
    <div className="details__sections">
      <section>
        <div className="section-label section-label--row">
          <span className="lib-crumbs">
            <button type="button" className="lib-crumbs__up" onClick={() => setPath(crumbs.slice(0, -1).join('/'))} disabled={!here} aria-label="Up one folder" title="Up one folder">
              <Icon name="chev_right" size={12} opacity={here ? 0.7 : 0.3} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <button type="button" className="link-btn link-btn--small" onClick={() => setPath('')}>{rootName}</button>
            {crumbs.map((c, i) => (
              <span key={i} className="lib-crumbs__part">
                <Icon name="chev_right" size={8} opacity={0.5} />
                <button type="button" className="link-btn link-btn--small" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
              </span>
            ))}
          </span>
          <span className="lib-actions">
            {list?.workspace && here !== list.workspace && (
              <button type="button" className="link-btn link-btn--small" onClick={() => setPath(list.workspace!)} title={`${bot.name}’s workspace`}>Workspace</button>
            )}
            <button type="button" className="link-btn link-btn--small" onClick={() => void load()} disabled={loading} aria-label="Refresh files" title="Refresh">
              <Icon name="refresh" size={12} opacity={0.7} style={loading ? { animation: 'cfg-spin 0.8s linear infinite' } : undefined} />
            </button>
          </span>
        </div>
        {list && <div className="lib-root" title={`${list.root}${here ? `/${here}` : ''}`}>{list.root}{here ? `/${here}` : ''}</div>}
        <div className="panel-card">
          {!list && loading ? (
            <div className="panel-empty">Reading files…</div>
          ) : !list ? null : !list.files.length ? (
            <div className="panel-empty panel-empty--center">{here === list.workspace ? `Files ${bot.name} saves show up here.` : 'This folder is empty.'}</div>
          ) : (
            list.files.map((f) => {
              const rel = relFor(f);
              const kind = kindOf(f);
              const image = kind === 'image';
              return (
                <div key={f.name} className={`lib-row${f.isDir ? ' is-dir' : ''}`}>
                  <button
                    type="button"
                    className="lib-row__main"
                    onClick={() => (f.isDir ? setPath(rel) : open(f))}
                    title={f.isDir ? `Open ${f.name}` : kind === 'other' ? `Download ${f.name}` : `Open ${f.name}`}
                  >
                    <span className={`lib-row__icon${image ? ' lib-row__icon--image' : ''}`}>
                      {image && !broken[rel]
                        ? <img className="lib-row__thumb" src={dataFileUrl(rel)} alt="" loading="lazy" onError={() => setBroken((b) => ({ ...b, [rel]: true }))} />
                        : <Glyph name={f.isDir ? 'folder' : 'doc'} size={16} opacity={0.6} />}
                    </span>
                    <span className="panel-row__text">
                      <span className="panel-row__title">{f.name}</span>
                      <span className="panel-row__meta">{f.isDir ? 'Folder' : formatBytes(f.size)} · {relativeShort(f.modifiedAt) === 'now' ? 'just now' : relativeShort(f.modifiedAt)}</span>
                    </span>
                    {f.isDir ? <Icon name="chev_right" size={11} opacity={0.4} /> : <Icon name="expand" size={11} opacity={0.4} />}
                  </button>
                  {!f.isDir && (
                    <a className="cfg-icon-btn" href={dataFileUrl(rel)} download={f.name} aria-label={`Download ${f.name}`} title="Download">
                      <Glyph name="download" size={14} />
                    </a>
                  )}
                </div>
              );
            })
          )}
        </div>
        {error && <div className="cfg-error cfg-error--small">{error}</div>}
      </section>
      {viewed && <FileViewer file={viewed} onClose={() => setViewed(null)} />}
    </div>
  );
}
