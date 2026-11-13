import { useState } from 'react';
import type { MessageFile } from '@shared/types';
import { Icon } from './Icon';
import { ImageViewer } from './ImageViewer';

function fileUrl(botId: string, file: MessageFile): string {
  return `/api/bots/${botId}/files/raw?path=${encodeURIComponent(file.path)}`;
}

function isImage(mediaType: string): boolean {
  return mediaType.startsWith('image/');
}

function fileIcon(_mediaType: string): 'file' {
  return 'file';
}

/** Defensive UI guard for historical or externally-created rows with duplicate files. */
function uniqueFiles(files: MessageFile[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = file.filename.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ImagePreview({ file, botId }: { file: MessageFile; botId: string }) {
  const [lightbox, setLightbox] = useState(false);
  const url = fileUrl(botId, file);
  return (
    <>
      <button
        type="button"
        className="file-part file-part--image"
        onClick={() => setLightbox(true)}
        aria-label={`View ${file.filename}`}
        title={file.filename}
      >
        <img src={url} alt={file.filename} className="file-part__img" loading="lazy" />
        <div className="file-part__img-caption">
          <span className="file-part__name">{file.filename}</span>
          <Icon name="expand" size={11} opacity={0.5} />
        </div>
      </button>
      {lightbox && <ImageViewer url={url} name={file.filename} onClose={() => setLightbox(false)} />}
    </>
  );
}

function FileChip({ file, botId }: { file: MessageFile; botId: string }) {
  const url = fileUrl(botId, file);
  const icon = fileIcon(file.mediaType);
  return (
    <a href={url} download={file.filename} className="file-part file-part--chip" title={`Download ${file.filename}`}>
      <span className="file-part__icon"><Icon name={icon} size={16} opacity={0.7} /></span>
      <span className="file-part__name">{file.filename}</span>
      <Icon name="arrow_down" size={12} opacity={0.45} className="file-part__dl" />
    </a>
  );
}

export function FileParts({ files, botId }: { files: MessageFile[]; botId: string }) {
  const unique = uniqueFiles(files);
  if (!unique.length) return null;
  return (
    <div className="file-parts">
      {unique.map((f) =>
        isImage(f.mediaType)
          ? <ImagePreview key={f.path} file={f} botId={botId} />
          : <FileChip key={f.path} file={f} botId={botId} />
      )}
    </div>
  );
}
