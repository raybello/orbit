import { useEffect } from 'react';
import { takePendingTemplate, useTemplatesUI } from '../templatesStore';
import { Icon } from './Icon';
import { ShareTemplateModal } from './ShareTemplateModal';
import { TemplateDetail, TemplateGallery } from './TemplateGallery';
import '../styles/templates.css';

/** Hosts whichever templates surface is open, and opens a share link the person arrived with. */
export function TemplatesLayer() {
  const view = useTemplatesUI((s) => s.view);

  useEffect(() => {
    const id = takePendingTemplate();
    if (id) useTemplatesUI.getState().open({ kind: 'detail', templateId: id, from: 'link' });
  }, []);

  if (!view) return null;
  switch (view.kind) {
    case 'gallery': return <TemplateGallery />;
    case 'detail': return <TemplateDetail key={view.templateId} templateId={view.templateId} from={view.from} />;
    case 'share': return <ShareTemplateModal botId={view.botId} />;
  }
}

/** The way into the starter gallery for someone whose team is still just the primary Bot. */
export function ExploreTemplatesCta() {
  return (
    <button type="button" className="explore-templates" onClick={() => useTemplatesUI.getState().open({ kind: 'gallery' })}>
      <span className="explore-templates__icon"><Icon name="grid" size={14} /></span>
      <span className="explore-templates__text">
        <span className="explore-templates__title">Explore templates</span>
        <span className="explore-templates__sub">Start a Bot from a ready-made role: briefings, inbox triage, research and more.</span>
      </span>
    </button>
  );
}
