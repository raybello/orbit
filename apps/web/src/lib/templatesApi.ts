import type {
  DuplicateBotResponse, InstallTemplateResponse, ShareTemplateResponse, TemplateResponse, TemplatesResponse, TemplateVisibility,
} from '@orbit/contracts';
import { req } from './api';

/** The installer's own zone, so a template's "8am" routine means 8am where they are. */
const localZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
};

export const templatesApi = {
  duplicate: (botId: string) => req<DuplicateBotResponse>('POST', `/bots/${botId}/duplicate`),
  share: (botId: string, visibility?: TemplateVisibility) => req<ShareTemplateResponse>('POST', `/bots/${botId}/template`, visibility ? { visibility } : {}),
  unshare: (templateId: string) => req<{ ok: true }>('DELETE', `/templates/${encodeURIComponent(templateId)}`),
  gallery: () => req<TemplatesResponse>('GET', '/templates'),
  get: (templateId: string) => req<TemplateResponse>('GET', `/templates/${encodeURIComponent(templateId)}`),
  install: (templateId: string) => req<InstallTemplateResponse>('POST', `/templates/${encodeURIComponent(templateId)}/install`, { timezone: localZone() }),
};
