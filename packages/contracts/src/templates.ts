import type { AvatarColor, AvatarShape, Bot } from './index.js';

// ------------------------------------------------------------------ bot templates (F6, F7)

/** `link`: anyone holding the id can install it. `public`: also listed in the gallery. */
export type TemplateVisibility = 'link' | 'public';
/** `starter`: a fixed system seed. `user`: shared from someone's Bot. */
export type TemplateOrigin = 'user' | 'starter';

/**
 * A routine as a template carries it: no owner, no Composio trigger, no run history. Every installed
 * or duplicated copy starts paused. A cron routine without a timezone runs in the installer's zone.
 */
export type TemplateRoutine =
  | { kind: 'cron'; name: string; prompt: string; schedule: string; timezone?: string }
  | { kind: 'event'; name: string; prompt: string; triggerSlug: string; config: Record<string, unknown> };

export interface TemplateSkill { name: string; description: string; body: string }

export interface BotTemplateSummary {
  id: string;
  slug: string | null;
  title: string;
  label: string;
  description: string;
  category: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  visibility: TemplateVisibility;
  origin: TemplateOrigin;
  /** Composio toolkit slugs the Bot works best with. */
  suggestedApps: string[];
  /** When it works, in words: "Weekdays at 8:00 AM", "When Gmail: new gmail message", "On demand". */
  cadence: string;
  installCount: number;
  ownerName: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotTemplate extends BotTemplateSummary {
  instructions: string;
  mode: 'personal' | 'teammate';
  skills: TemplateSkill[];
  routines: TemplateRoutine[];
}

export interface TemplatesResponse { templates: BotTemplateSummary[]; categories: string[] }
export interface TemplateResponse { template: BotTemplate }
export interface ShareTemplateRequest { visibility?: TemplateVisibility }
export interface ShareTemplateResponse { template: BotTemplate; shareUrl: string }
export interface InstallTemplateRequest { name?: string; timezone?: string }
export interface InstallTemplateResponse { bot: Bot }
export interface DuplicateBotResponse { bot: Bot }
