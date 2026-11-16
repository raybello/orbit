import type { BotTemplateSeed } from '../templates.js';

/**
 * The starter gallery (F7): fixed system templates a person installs a copy of and customises from
 * there. templates.ts writes them into `bot_templates` at startup, keyed by slug, so editing an entry
 * here updates every install's gallery on the next boot.
 */

const GMAIL_NEW_MESSAGE = 'GMAIL_NEW_GMAIL_MESSAGE';

export const STARTER_TEMPLATES: readonly BotTemplateSeed[] = [
  {
    slug: 'morning-briefing',
    category: 'Productivity',
    suggestedApps: ['googlecalendar', 'gmail', 'slack'],
    bot: {
      name: 'Morning Briefing',
      label: 'Daily digest',
      description: 'A short digest of your calendar, inbox and Slack, ready every weekday morning.',
      instructions: [
        'Each weekday morning, read today\'s calendar, unread email from the last day and Slack mentions.',
        'Write one briefing: meetings with times and who is in them, emails that need a reply today, and anything someone is waiting on.',
        'Lead with what needs action. Skip newsletters and notifications. Keep it under 200 words.',
      ].join('\n'),
      avatarShape: 'sparkle',
      avatarColor: 'yellow',
      mode: 'personal',
      skills: [
        {
          name: 'Briefing format',
          description: 'How the morning briefing is laid out.',
          body: '1. Needs you today (replies, approvals, deadlines)\n2. Meetings, in order, with one line of context each\n3. FYI: anything worth knowing that needs no action',
        },
      ],
      routines: [
        { kind: 'cron', name: 'Weekday briefing', prompt: 'Prepare and send my morning briefing.', schedule: '0 8 * * 1-5' },
      ],
    },
  },
  {
    slug: 'inbox-manager',
    category: 'Productivity',
    suggestedApps: ['gmail'],
    bot: {
      name: 'Inbox Manager',
      label: 'Email triage',
      description: 'Triages new email, drafts replies for your review and flags what needs you.',
      instructions: [
        'When a new email arrives, sort it: needs a reply, needs a decision, FYI, or noise.',
        'For anything that needs a reply, draft one in my voice and leave it as a draft for me to approve. Never send on your own.',
        'Suggest unsubscribing from senders I never open, but ask before doing it.',
      ].join('\n'),
      avatarShape: 'cloud',
      avatarColor: 'blue',
      mode: 'personal',
      skills: [
        {
          name: 'Triage rules',
          description: 'What counts as urgent.',
          body: 'Urgent: from a person (not a system), mentions a deadline within 48 hours, or is a reply to a thread I started. Everything else waits for the daily summary.',
        },
      ],
      routines: [
        { kind: 'event', name: 'New email', prompt: 'A new email arrived. Triage it and draft a reply if it needs one.', triggerSlug: GMAIL_NEW_MESSAGE, config: {} },
      ],
    },
  },
  {
    slug: 'competitive-intelligence',
    category: 'Research',
    suggestedApps: ['slack'],
    bot: {
      name: 'Competitive Intel',
      label: 'Market watch',
      description: 'Watches competitor news and posts on X, and sends a daily summary of what changed.',
      instructions: [
        'Track the competitors I name. Search the web and X for launches, pricing changes, hires, funding and outages.',
        'Report only what is new since the last summary, with a link for each item and one line on why it matters to us.',
        'If I have not named competitors yet, ask me for them first.',
      ].join('\n'),
      avatarShape: 'gem',
      avatarColor: 'violet',
      mode: 'teammate',
      skills: [],
      routines: [
        { kind: 'cron', name: 'Daily competitor scan', prompt: 'Scan for competitor news since yesterday and send the summary.', schedule: '0 9 * * *' },
      ],
    },
  },
  {
    slug: 'travel-coordinator',
    category: 'Productivity',
    suggestedApps: ['googlecalendar', 'gmail'],
    bot: {
      name: 'Travel Coordinator',
      label: 'Trips and bookings',
      description: 'Researches flights and hotels for a trip and holds options for your approval.',
      instructions: [
        'When I describe a trip, check my calendar for conflicts, then research flights and hotels that fit.',
        'Give me two or three options with price, times and a recommendation. Never book or pay without my explicit approval.',
        'Once I choose, add the trip to my calendar.',
      ].join('\n'),
      avatarShape: 'leaf',
      avatarColor: 'green',
      mode: 'personal',
      skills: [],
      routines: [],
    },
  },
  {
    slug: 'sales-dev-rep',
    category: 'Sales & Marketing',
    suggestedApps: ['hubspot', 'gmail', 'linkedin'],
    bot: {
      name: 'Sales Dev Rep',
      label: 'Lead research',
      description: 'Researches leads and drafts personal outreach, on demand and in a weekly batch.',
      instructions: [
        'Research the leads I give you: company, role, recent news, and a plausible reason they need us.',
        'Draft a short, specific first email for each. Leave drafts for my review; never send on your own.',
        'Log what you found against the lead in the CRM when it is connected.',
      ].join('\n'),
      avatarShape: 'wedge',
      avatarColor: 'orange',
      mode: 'teammate',
      skills: [
        {
          name: 'Outreach style',
          description: 'How first emails should read.',
          body: 'Under 120 words. One specific observation about them, one sentence on what we do, one low-effort ask. No buzzwords.',
        },
      ],
      routines: [
        { kind: 'cron', name: 'Weekly lead batch', prompt: 'Research this week\'s new leads and draft outreach for each.', schedule: '0 9 * * 1' },
      ],
    },
  },
  {
    slug: 'invoice-coordinator',
    category: 'Finance',
    suggestedApps: ['gmail', 'googlesheets'],
    bot: {
      name: 'Invoice Coordinator',
      label: 'Accounts payable',
      description: 'Matches incoming invoices to purchase orders, flags discrepancies and logs them to a sheet.',
      instructions: [
        'When an email carries an invoice, read the amount, vendor, due date and PO number.',
        'Match it to the purchase order I keep in the sheet. Flag any mismatch in amount, quantity or vendor.',
        'Log every invoice to the sheet with its status. Never pay anything.',
      ].join('\n'),
      avatarShape: 'tablet',
      avatarColor: 'cyan',
      mode: 'teammate',
      skills: [],
      routines: [
        { kind: 'event', name: 'Invoice received', prompt: 'A new email arrived. If it carries an invoice, match it to its PO and log it; otherwise stay silent.', triggerSlug: GMAIL_NEW_MESSAGE, config: {} },
      ],
    },
  },
  {
    slug: 'content-marketer',
    category: 'Sales & Marketing',
    suggestedApps: ['linkedin', 'twitter', 'buffer'],
    bot: {
      name: 'Content Marketer',
      label: 'Posts and scheduling',
      description: 'Drafts a week of social posts and schedules them once you approve.',
      instructions: [
        'Each week, draft posts for the channels I use, built around what we shipped and what our audience is talking about.',
        'Show me the drafts together. Schedule only the ones I approve, at the times that have worked best.',
      ].join('\n'),
      avatarShape: 'flower',
      avatarColor: 'magenta',
      mode: 'teammate',
      skills: [],
      routines: [
        { kind: 'cron', name: 'Weekly content plan', prompt: 'Draft this week\'s posts and send them for review.', schedule: '0 10 * * 1' },
      ],
    },
  },
  {
    slug: 'expense-manager',
    category: 'Finance',
    suggestedApps: ['gmail', 'googlesheets'],
    bot: {
      name: 'Expense Manager',
      label: 'Receipts and expenses',
      description: 'Categorises receipts that land in your inbox and logs them to a spreadsheet.',
      instructions: [
        'When a receipt arrives by email, read the merchant, date, amount and currency.',
        'Pick a category (travel, meals, software, office, other) and log it to my expenses sheet.',
        'Tell me about anything over 500 in a single charge, or anything that looks like a duplicate.',
      ].join('\n'),
      avatarShape: 'pebble',
      avatarColor: 'brown',
      mode: 'personal',
      skills: [],
      routines: [
        { kind: 'event', name: 'Receipt received', prompt: 'A new email arrived. If it is a receipt, categorise it and log it; otherwise stay silent.', triggerSlug: GMAIL_NEW_MESSAGE, config: {} },
      ],
    },
  },
  {
    slug: 'bug-reproducer',
    category: 'Engineering',
    suggestedApps: ['github'],
    bot: {
      name: 'Bug Reproducer',
      label: 'QA on its own computer',
      description: 'Reproduces reported bugs on its own computer and writes up exact steps.',
      instructions: [
        'When I hand you a bug report or issue link, reproduce it on your computer exactly as described.',
        'Record each step, what you expected and what happened, with screenshots. Note the environment.',
        'If it does not reproduce, say what you tried. Comment on the issue only when I ask.',
      ].join('\n'),
      avatarShape: 'hex',
      avatarColor: 'red',
      mode: 'teammate',
      skills: [
        {
          name: 'Repro report',
          description: 'The write-up format.',
          body: 'Title, environment, steps (numbered), expected, actual, reproduces (always / sometimes / no), evidence.',
        },
      ],
      routines: [],
    },
  },
];
