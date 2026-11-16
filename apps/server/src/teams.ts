import { db } from './db.js';
import { createRoom } from './agent/rooms.js';
import { createRoutine } from './routines.js';
import { templateIdForSlug, installTemplate } from './templates.js';
import { primaryBotOf } from './initiative-store.js';
import type { Bot } from '@orbit/contracts';

/**
 * Teams of Bots (F11).
 *
 * A team is a named set of bots assembled from template slugs plus a group room and an orchestrating
 * routine on the user's primary bot. Each member bot gets its own agent and screen. The primary bot
 * drives the team by sending messages to the room on the routine's trigger.
 *
 * Data model: teams are transient – they are just the bots they create and the room that links them.
 * This module does not own a `teams` table because the room row already names the members, and the
 * orchestrating routine already belongs to the primary bot. A `teamId` label on the room row lets
 * the UI group the members.
 */

/** One preset team template. Members reference template slugs from the starter gallery. */
export interface TeamTemplateSeed {
  slug: string;
  name: string;
  description: string;
  /** Short summary shown in the gallery. */
  tagline: string;
  /** BCP-47 schedule: a cron expression for the orchestrating routine's default cadence. */
  schedule: string;
  /** Members in execution order. The primary bot orchestrates; these are the workers. */
  members: TeamMemberSeed[];
  /** System prompt injected into the orchestrating routine on the primary bot. */
  orchestratorPrompt: string;
}

export interface TeamMemberSeed {
  /** Must match a BotTemplateSeed slug in the starter gallery. */
  templateSlug: string;
  /** Override the installed bot's name within this team (optional). */
  name?: string;
}

export const TEAM_TEMPLATES: readonly TeamTemplateSeed[] = [
  {
    slug: 'campaign-team',
    name: 'Campaign Team',
    description: 'Research, outline and copy in sequence. The team drafts one piece of marketing content per run.',
    tagline: 'Research → Outline → Copy every Monday',
    schedule: '0 9 * * 1',
    members: [
      { templateSlug: 'competitive-intelligence', name: 'Research Bot' },
      { templateSlug: 'content-marketer', name: 'Copy Bot' },
    ],
    orchestratorPrompt: [
      'You are running the weekly Campaign Team. Work through these steps in order:',
      '1. Send Research Bot the topic for this week\'s content.',
      '2. Wait for Research Bot to reply with the research brief.',
      '3. Send Copy Bot the brief and ask it to write a 300-word post.',
      '4. When Copy Bot replies, present the finished post to the user and ask for approval before publishing.',
    ].join('\n'),
  },
  {
    slug: 'month-end-close',
    name: 'Month-End Close',
    description: 'Data collection, review and report writing run in sequence on the first of each month.',
    tagline: 'Data → Review → Report on the 1st',
    schedule: '0 9 1 * *',
    members: [
      { templateSlug: 'expense-manager', name: 'Data Bot' },
      { templateSlug: 'invoice-coordinator', name: 'Review Bot' },
    ],
    orchestratorPrompt: [
      'You are running the Month-End Close. Work through these steps in order:',
      '1. Tell Data Bot to collect and categorise last month\'s expenses.',
      '2. Tell Review Bot to check the figures, flag any missing receipts and prepare a summary.',
      '3. Present the summary to the user and ask them to approve it before filing.',
    ].join('\n'),
  },
  {
    slug: 'support-queue',
    name: 'Support Queue',
    description: 'Triage, draft and escalate incoming support requests every weekday morning.',
    tagline: 'Triage → Draft → Escalate weekday mornings',
    schedule: '0 9 * * 1-5',
    members: [
      { templateSlug: 'inbox-manager', name: 'Triage Bot' },
      { templateSlug: 'sales-dev-rep', name: 'Response Bot' },
    ],
    orchestratorPrompt: [
      'You are running the Support Queue. Work through these steps in order:',
      '1. Tell Triage Bot to read the support inbox and produce a prioritised list of open tickets.',
      '2. For each ticket, tell Response Bot to draft a reply.',
      '3. Present the drafts to the user and ask for approval before sending.',
    ].join('\n'),
  },
];

/** The in-memory index built once from TEAM_TEMPLATES. */
const BY_SLUG = new Map(TEAM_TEMPLATES.map((t) => [t.slug, t]));

/** All team template slugs (for the gallery). */
export function listTeamTemplates(): readonly TeamTemplateSeed[] { return TEAM_TEMPLATES; }

/** One team template by slug. */
export function getTeamTemplate(slug: string): TeamTemplateSeed | undefined { return BY_SLUG.get(slug); }

export interface CreateTeamResult {
  bots: Bot[];
  roomId: string;
  routineId: string;
}

/**
 * Atomically create a team: install each member bot, create the group room, and add the
 * orchestrating routine to the user's primary bot.
 *
 * All database writes are wrapped in a transaction so a partial failure leaves nothing behind.
 */
export function createTeam(userId: string, teamSlug: string, opts: { schedule?: string; timezone?: string; name?: string } = {}): CreateTeamResult {
  const seed = BY_SLUG.get(teamSlug);
  if (!seed) throw new Error(`Unknown team template: ${teamSlug}`);

  const tz = opts.timezone ?? 'UTC';
  const schedule = opts.schedule ?? seed.schedule;
  const teamName = opts.name ?? seed.name;

  const primaryBot = primaryBotOf(userId);
  if (!primaryBot) throw new Error('You must have a primary bot to create a team.');

  return db.transaction((): CreateTeamResult => {
    const bots: Bot[] = [];
    for (const member of seed!.members) {
      const tid = templateIdForSlug(member.templateSlug);
      const bot = installTemplate(tid, userId, { name: member.name, timezone: tz });
      bots.push(bot);
    }

    const roomId = createRoom(userId, teamName, bots.map((b) => b.id));

    const routine = createRoutine({
      botId: primaryBot.id,
      title: `${teamName} orchestration`,
      prompt: seed!.orchestratorPrompt,
      eventType: 'recurring',
      schedule,
      timezone: tz,
      enabled: false,
    });

    return { bots, roomId, routineId: routine.id };
  })();
}
