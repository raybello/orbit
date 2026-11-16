# Orbit × Grok Bot: Proposed Implementation Plan

**Date:** 2026-11-16  
**Scope:** Features derivable from Grok Bot's product design that Orbit can adopt, with gap analysis, prioritization, and parallel execution orchestration.

---

## 0. Executive Summary

Grok Bot is Orbit's closest public analogue: a persistent-agent product running cloud computers with per-bot memory, app connectors, voice, routines, and multi-bot orchestration. The core loop architecture is nearly identical. The gaps are mostly **product surface** (templates, bot vault, rules engine, deep links, audit logging) and **model-layer efficiency** (WebSocket mode, context compaction, reasoning effort controls). None require re-architecting the system; they extend what already exists.

Fourteen features are proposed across three tiers. Tier 1 items can be shipped independently in one or two weeks each. Tier 2 and 3 items can run as parallel tracks once their prerequisites land.

---

## 1. Gap Analysis

### 1.1 Features Grok Bot has; Orbit does not yet

| # | Grok Bot Feature | Orbit Analogue | Gap |
|---|---|---|---|
| 1 | Deep links (`grokbot://app/v1/prompt?id=&text=`) | None | No URL scheme registered; no `text` pre-fill |
| 2 | Bot templates — share, discover, clone | None | No template serialization or share flow |
| 3 | Starter use-case gallery (SDR, Inbox Manager, etc.) | None | No seeded prompt library |
| 4 | Bot duplication | None | No `POST /api/bots/:id/duplicate` |
| 5 | Proactive initiative — structured morning briefings, suggested tasks | `proactive.ts` check-ins exist | No configurable schedule or briefing type |
| 6 | Custom auto-review rules ("Ask before sending email") | Approval policies per-tool | No natural-language rule presets; no rule-matching UI |
| 7 | Teams of Bots templates (Campaign, Month-End, Support Queue) | `send_to_bot` + group chats exist | No guided multi-bot setup or preset team templates |
| 8 | Bot Vault — secure credential store for bots | Composio-managed OAuth | No vault UI; no secure-form injection for non-OAuth secrets |
| 9 | Audit log / Action Recording | `tool-call` rows in DB | No dedicated audit view or export |

### 1.2 Model-layer efficiency gaps (from xAI docs)

| # | Grok Bot / xAI Pattern | Orbit Gap |
|---|---|---|
| 10 | Reasoning effort per-bot (`low/medium/high/xhigh`) | Not surfaced in bot settings |
| 11 | Context compaction (`client.responses.compact()`) | Not called in agent loop |
| 12 | WebSocket mode for tool loops (~20% latency reduction) | Loop uses standard HTTPS streaming |
| 13 | `safety_identifier: sha256(userId)` on every Responses call | Not sent |
| 14 | US Regional API (`us.api.x.ai/v1`) for compliance | Not configurable |

### 1.3 What Orbit already does well (no action needed)

- Per-bot Docker containers with Orgo fallback — equivalent to Grok Bot's per-user Firecracker VMs  
- VNC relay (server-side filtering, no password to browser) — matches the recommended Orgo security pattern exactly  
- Composio sessions with `requireApproval` on destructive hints  
- Approval cards with Allow / Always allow / Don't allow  
- Cron + event routines, check-ins  
- `send_to_bot`, group chats for multi-bot coordination  
- xAI Realtime voice with ephemeral client secrets  
- Primary bot enforcement (`domain/primary-bots.ts`)  
- Hermes memory in `memories/MEMORY.md` and `USER.md`  

---

## 2. Proposed Features

### Tier 1 — Quick wins, 1–2 weeks each, fully independent

---

#### F1 · Deep Links

**What it is:** A `orbit://` URL scheme (desktop) and an Expo deep link (mobile) that opens a specific bot with optional pre-filled text.

**Format:**
```
orbit://app/v1/prompt?id=<botId>&text=<url-encoded-message>
```
- `text` fills the composer only if the box is empty; never auto-sends.
- Omitting `id` uses the user's primary bot.

**Why:** Enables shortcuts, automation, and cross-app flows (Raycast, Shortcuts app, iMessage tap-backs). Grok Bot treats this as a first-class integration surface for power users.

**Files:**
- `apps/desktop/src/main.ts` — register `orbit://` with `app.setAsDefaultProtocolClient('orbit')`, handle `open-url` / `second-instance` events, parse URL, send to renderer via IPC
- `apps/desktop/src/preload.cjs` — add `onDeepLink(cb)` to `OrbitDesktopAPI`
- `apps/web/src/App.tsx` (or router) — listen for deep-link IPC, route to correct bot thread and set composer text
- `apps/mobile/app/_layout.tsx` — add Expo `Linking.addEventListener('url', ...)`, parse and route
- `apps/mobile/app/thread/[botId].tsx` — accept `initialText` search param, populate `TextInput`

**Non-goals:** Auto-sending, authentication through the deep link, sharing bot conversations.

---

#### F2 · Bot Duplication

**What it is:** `POST /api/bots/:id/duplicate` creates a copy of a bot with its profile, system prompt, skills, routines, and avatar, but without history, memory, or Composio connections.

**Why:** Grok Bot lists this as a core management feature (iPhone-side). Useful for creating role variants from a known-good bot configuration.

**Files:**
- `apps/server/src/routes.ts` — add `POST /api/bots/:id/duplicate`
- `apps/server/src/bot-admin.ts` — `duplicateBot(sourceId, userId)`: read source bot, generate new id/name ("Copy of …"), copy skills and routines rows, create new Hermes engine home, write avatar; return new bot
- `apps/web/src/components/BotMenu.tsx` (or wherever the bot context menu lives) — add "Duplicate" menu item

**Edge cases:** Duplicate cannot be a primary bot (requires explicit promotion). Routines on the duplicate start disabled so they don't double-fire.

---

#### F3 · Safety Identifier + US Regional API

**Two small wiring changes in the agent loop, shipped together.**

**F3a — Safety identifier:**
Every call to `xai.responses.create(...)` in `apps/server/src/agent/loop.ts` should include:
```ts
safety_identifier: createHash('sha256').update(userId).digest('hex'),
```
This routes policy attribution to the user rather than the account key. Already recommended in `docs/xai-and-composio.md`.

**F3b — US Regional API:**
Add `XAI_BASE_URL` to `.env.example` (default `https://api.x.ai/v1`).  
Let a team setting override to `https://us.api.x.ai/v1` for US-only data processing compliance (1.1× token price, documented trade-off).

**Files:** `apps/server/src/engine.ts`, `apps/server/src/.env.example`, future team settings schema.

---

#### F4 · Context Compaction

**What it is:** When a bot's conversation exceeds a token budget, call `client.responses.compact()` to replace the history with an opaque compaction item, preserving context without ballooning cost.

**Why:** Long-running bots (routines that persist for hours or days) will eventually hit the 500k context window. Grok Bot manages this explicitly. xAI documents `compact()` as the right tool.

**Implementation:**
In `apps/server/src/agent/loop.ts`, after each turn:
1. Read `usage.input_tokens + usage.output_tokens` from the response.
2. If total context exceeds a configurable threshold (default: 350k tokens), call `xai.responses.compact({ model: 'grok-4.7', input: history })`.
3. Replace `history` with the returned compaction item. Store the compacted history in the bot's Hermes home alongside the existing session so it survives restarts.
4. Emit a `notice` row of kind `context-compacted` so the user sees "Conversation summarized to save context."

**Files:** `apps/server/src/agent/loop.ts`, `apps/server/src/engine.ts` (add `CONTEXT_COMPACTION_THRESHOLD` env var).

---

#### F5 · Reasoning Effort: Medium Default, Low for Tool Loops

**What it is:** Every bot uses `medium` reasoning effort for chat turns. The agent loop automatically drops to `low` for the duration of a tool-call sub-loop (computer-use steps, Composio execution rounds), then returns to `medium` when it surfaces a reply to the user.

No per-bot selector is exposed — this is a fixed policy. The two levels cover the full cost/quality range for Orbit's workloads:
- `medium` — chat, planning, drafting (default for all bots, all turns)
- `low` — tool-call rounds within a turn (computer-use step loop, shell commands, Composio calls)

`high` and `xhigh` are not exposed; they add cost without meaningful benefit for the agentic loop patterns Orbit uses.

**Files:**
- `apps/server/src/agent/loop.ts` — pass `reasoning: { effort: 'medium' }` at turn start; switch to `{ effort: 'low' }` when entering a tool-call step loop; restore `'medium'` before the final reply step

---

### Tier 2 — Medium effort, 2–4 weeks each, mostly independent

---

#### F6 · Bot Templates: Create, Share, Discover

**What it is:** Any bot can be saved as a template. The owner gets a shareable link. Anyone with the link gets a copy of the bot (profile + system prompt + skills + routines + avatar), not access to the owner's history or memory.

**Grok Bot parallel:**
- Personal templates → public or team-limited share link
- Recipients get a copy, not access
- Template sharing can be restricted by admins (future team feature)

**Data model:**
```sql
CREATE TABLE bot_templates (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  source_bot_id TEXT,                 -- nullable: source may be deleted
  title TEXT NOT NULL,
  description TEXT,
  avatar_shape TEXT,
  avatar_color TEXT,
  system_prompt TEXT,
  visibility TEXT NOT NULL DEFAULT 'link',  -- 'link' | 'public'
  slug TEXT UNIQUE,                   -- for public gallery: /templates/:slug
  install_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bot_template_skills (
  template_id TEXT REFERENCES bot_templates(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  skill_body TEXT NOT NULL
);

CREATE TABLE bot_template_routines (
  template_id TEXT REFERENCES bot_templates(id) ON DELETE CASCADE,
  routine_data TEXT NOT NULL   -- JSON blob, starts disabled
);
```

**API:**
- `POST /api/bots/:id/template` — serialize bot to template, return `{ templateId, shareUrl }`
- `GET /api/templates/:id` — read template metadata (no auth required for `link` visibility)
- `POST /api/templates/:id/install` — create a new bot from the template for the signed-in user
- `GET /api/templates?visibility=public` — public gallery listing

**UI:**
- Bot context menu → "Share as template" → copy link sheet
- `/templates` gallery page (or modal) with search and category filters
- Install button on template detail view

**Subagent parallelism opportunity:** The DB schema + server routes and the UI can be built in parallel once the schema is finalized.

---

#### F7 · Starter Use-Case Gallery

**What it is:** A curated set of bot templates (seeded in the DB at startup) covering common roles, shown to users who have only the primary bot or on the new-bot creation flow.

**Proposed starters (drawn from Grok Bot use cases):**

| Name | Role | Cadence |
|---|---|---|
| Morning Briefing | Daily digest from calendar + email + Slack | Routine: weekdays 8am |
| Inbox Manager | Triage email, draft replies, unsubscribe | Event: new email trigger |
| Competitive Intelligence | Monitor competitor news + X | Routine: daily |
| Travel Coordinator | Research flights/hotels, hold for approval | On-demand |
| Sales Dev Rep | Research leads, draft outreach | On-demand + routine |
| Invoice Coordinator | Match POs, flag discrepancies, log to sheet | Event: new email |
| Content Marketer | Draft posts, schedule via Buffer/Hootsuite | Routine: weekly |
| Expense Manager | Categorize expenses, log to spreadsheet | Event: receipt email |
| Bug Reproducer | Reproduce reported bugs on bot's computer | On-demand |

**Implementation:**
- Seed file `apps/server/src/seeds/starter-templates.ts` — array of `BotTemplateSeed` objects with system prompt, suggested apps (Composio toolkit slugs), and routine config
- Run seeds in `apps/server/src/db.ts` migration at startup if the `bot_templates` table is empty
- "Explore templates" CTA on empty-state bot list and new-bot creation flow

**Non-goals:** These templates are not user-editable; they're fixed system seeds. Users install a copy and customize from there.

---

#### F8 · Proactive Initiative: Structured Check-ins and Briefings

**What it is:** The primary bot proactively offers tasks, flags items needing attention, and delivers configurable morning briefings — without the user explicitly asking.

**Grok Bot design principles:**
- The bot offers first, then asks before acting
- Initiative is scoped to the primary bot
- Notifications control alerts; check-ins are separate from notification frequency
- Primary bot can tag the user in a Slack thread (team bots)

**Orbit already has:** `proactive.ts` with check-in logic, `routines.ts` with cron scheduling.

**What to add:**

1. **Morning Briefing routine template** — a seeded routine on the primary bot that runs at a configurable time (default 8am, user timezone). The brief covers:
   - Calendar events today (via Composio Google Calendar)
   - Unread email summary (via Composio Gmail)
   - Open tasks from the bot's task list
   - Any unresolved approval cards from yesterday

2. **Initiative signals** — the primary bot loop emits `check-in` events when it notices:
   - A Composio connection has expired (`composio.connected_account.expired` webhook)
   - An approval card has been waiting > 1 hour
   - A routine failed on its last run
   - The user has not interacted in > 24 hours (configurable threshold)

3. **Configurable initiative level** — bot setting: `initiative: 'proactive' | 'reactive' | 'off'`
   - `proactive`: check-ins + briefings + signals (default for primary bot)
   - `reactive`: only signals (expired connection, failed routine)
   - `off`: no unsolicited messages

**Files:**
- `packages/contracts/src/index.ts` — add `initiative` to `Bot` type
- `apps/server/src/db.ts` — migration: add `initiative` column
- `apps/server/src/proactive.ts` — extend with signal detection (expired connections, stale approvals, routine failures)
- `apps/server/src/seeds/starter-templates.ts` — include Morning Briefing routine in primary bot seed
- `apps/web/src/components/BotSettings.tsx` — initiative level selector

---

#### F9 · Custom Auto-Review Rules Engine

**What it is:** Users define simple natural-language rules that the bot checks before executing certain categories of actions. The rule engine intercepts tool calls matching a pattern and either blocks, requires approval, or logs them.

**Grok Bot parallel:**
- "Always ask before sending an email"
- "Ask before posting to social media"
- "Never delete files without asking"
- Custom Auto-review rules (enterprise: regex/model-based)

**Implementation for Orbit:**

Rule schema:
```ts
interface BotRule {
  id: string;
  botId: string;
  description: string;        // natural language, shown in UI
  pattern: RulePattern;       // what to match
  action: 'ask' | 'block' | 'log';
  createdAt: number;
}

type RulePattern =
  | { kind: 'composio-hint'; hints: ('createHint' | 'updateHint' | 'destructiveHint')[] }
  | { kind: 'composio-tool'; tools: string[] }   // e.g. ['GMAIL_SEND_EMAIL']
  | { kind: 'computer-shell'; matchRegex: string }  // matches shell commands
  | { kind: 'always' };
```

**Preset rules offered in UI (covering Grok Bot's most common patterns):**

| Preset | Pattern | Default action |
|---|---|---|
| Ask before sending messages | `composio-tool: [GMAIL_SEND_EMAIL, SLACK_SEND_MESSAGE, ...]` | `ask` |
| Ask before posting publicly | `composio-hint: [createHint]` on social toolkits | `ask` |
| Ask before deleting anything | `composio-hint: [destructiveHint]` | `ask` |
| Log all file writes | `composio-hint: [updateHint]` | `log` |
| Ask before running shell commands | `computer-shell: .*` | `ask` |

The rule check runs inside `apps/server/src/mcp.ts` before executing any tool, alongside the existing `Always allow` policy check.

**Files:**
- DB migration: `CREATE TABLE bot_rules (...)`
- `apps/server/src/mcp.ts` — rule-check middleware before tool execution
- `apps/server/src/routes.ts` — CRUD for `/api/bots/:id/rules`
- `apps/web/src/components/RulesPanel.tsx` — rules list + preset picker

---

#### F10 · WebSocket Mode for Agent Loop

**What it is:** Replace the per-turn HTTPS `responses.create()` in `loop.ts` with a persistent WebSocket connection to `wss://api.x.ai/v1/responses`, keeping the connection open for the duration of a multi-step tool loop.

**Why:** xAI documents ~20% lower latency for long tool loops. A bot doing 10+ computer-use steps in a turn benefits materially. The WebSocket protocol is identical to the Responses API; the event stream is the same.

**Constraints:**
- One turn at a time per connection (xAI enforces this)
- Max 59-minute connection lifetime — reconnect for long routines
- Use `store: false` (we own history, as already implemented)
- Keep existing HTTPS path as fallback when WebSocket fails

**Implementation:**
Add `WebSocketAgent` class in `apps/server/src/agent/ws-agent.ts`:
- Opens a WebSocket on first turn, keeps it alive between tool-call steps within one turn
- Closes and re-opens between user turns (the 59-min limit makes per-turn connections safe)
- Identical event handling as the existing SSE path

Feature-flagged via `XAI_USE_WEBSOCKET=1` env var initially.

---

### Tier 3 — Complex, 4–8 weeks, requires earlier tiers or new infrastructure

---

#### F11 · Teams of Bots: Preset Multi-Bot Workflow Templates

**What it is:** A guided setup that creates a coordinated team of 2–4 bots with complementary roles and a shared routine. Each bot has one job. The primary bot orchestrates.

**Grok Bot examples:**
- **Campaign Team** (Mondays 9am): Research Bot → Outline Bot → Copy Bot
- **Month-End Close** (1st of month): Data Bot → Review Bot → Report Bot  
- **Support Queue** (Weekdays 9am): Triage Bot → Response Bot → Escalation Bot

**Orbit implementation approach:**
Teams of Bots are assembled from:
1. A set of bot templates (from F6/F7) with compatible roles
2. A shared routine that triggers in sequence using `send_to_bot`
3. A group chat room for the team's shared workspace

**Setup wizard (3 steps):**
1. Pick a team template from the gallery
2. Name the team and configure the schedule/trigger
3. Review bots and their app connections → Create

Under the hood, the wizard calls:
- `POST /api/bots` for each member bot (from templates)
- `POST /api/rooms` to create a group chat linking them
- `POST /api/bots/:primaryId/routines` to create the orchestrating routine

**Files:**
- `apps/server/src/routes.ts` — `POST /api/teams` (creates all bots + room + routine atomically)
- `apps/server/src/seeds/team-templates.ts` — Campaign, Month-End, Support Queue definitions
- `apps/web/src/components/TeamWizard.tsx` — 3-step setup flow
- `apps/web/src/pages/Teams.tsx` — team management view

**Requires:** F6 (templates), F7 (starter gallery), F8 (routines).

---

#### F12 · Bot Vault

**What it is:** A secure per-user credential store where bots can retrieve API keys, passwords, and secrets without the user pasting them into chat. Equivalent to Grok Bot's Vault and 1Password integration.

**Grok Bot design:**
- Vault stores credentials used by bots for site sign-in
- Credentials fill form fields without the bot seeing the plaintext value (a secure proxy fills the form)
- Cards from the bot surface a "Secure Form" for one-time credential entry

**Orbit implementation:**

1. **Server-side Vault table** (encrypted at rest using `DB_ENCRYPTION_KEY`):
   ```sql
   CREATE TABLE vault_entries (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     label TEXT NOT NULL,          -- e.g. "AWS Console"
     username TEXT,
     secret_encrypted TEXT NOT NULL,  -- AES-256-GCM encrypted
     url_pattern TEXT,             -- optional: auto-match by URL
     created_at INTEGER NOT NULL
   );
   ```

2. **Secure form flow** (for one-off credentials a bot needs):
   - Bot emits a `card` row of kind `secure-form` with a list of fields (username, password)
   - User fills in the browser (fields are `type="password"`, never sent to AI)
   - Server receives the values, encrypts and stores in Vault or passes directly to the bot's computer screen via `computer_shell`/`xdotool` without exposing them in the agent history

3. **Vault manager UI** — `/settings/vault` — CRUD for saved entries, show by label + URL pattern

4. **Bot access** — a `vault_lookup` MCP tool that the bot calls with `label` or `url`; the server injects the credential into the bot's computer session directly (never returning plaintext to the model)

**Files:**
- DB migration: `vault_entries` table + encryption helpers in `apps/server/src/crypto.ts`
- `apps/server/src/mcp.ts` — add `vault_lookup` tool (credential injection, no plaintext return)
- `apps/server/src/routes.ts` — Vault CRUD endpoints
- `apps/web/src/pages/VaultSettings.tsx` — Vault management UI
- `apps/web/src/components/SecureFormCard.tsx` — one-time credential card in chat

---

#### F13 · Audit Log and Action Recording

**What it is:** A filterable, exportable log of every action a bot took, with timestamps, tool names, arguments, and outcomes. Equivalent to Grok Bot's enterprise Action Recording and audit logs.

**Why:** Already has all the data (`tool-call` rows in SQLite). What's missing is the UI and export.

**Implementation:**

1. **Audit view** in the bot detail panel (new "Audit" tab alongside Screen, Tasks, Library, Engine):
   - Filterable by date range, tool name, outcome (allowed/denied/auto-allowed)
   - Searchable by argument content (e.g. "show me all emails the bot sent")

2. **Export endpoint:**
   - `GET /api/bots/:id/audit?from=&to=&format=json|csv`
   - Returns `tool-call` rows with their approval decisions

3. **Retention policy** (future):
   - `AUDIT_RETENTION_DAYS` env var (default: 90)
   - Migration: add index on `rows.kind` + `rows.created_at` for query performance

**Files:**
- `apps/server/src/routes.ts` — audit export endpoint
- `apps/web/src/components/AuditPanel.tsx` — audit tab UI with filtering
- DB: index migration `CREATE INDEX rows_kind_seq ON rows(bot_id, kind, seq)`

---

## 3. What to Improve (not from Grok Bot, surfaced by review)

These are gaps in Orbit's current design that become visible when compared against Grok Bot's production system:

### I1 · Screen Lease Pool for >4 Bots
Orgo caps at 4 screens per VM. Orbit's `computer.ts` / `OrgoComputerProvider` doesn't yet implement a borrow/release pool. When a 5th bot needs a screen, it currently fails. Implement an LRU lease pool: idle bots (no viewer, no active turn for N minutes) release their screen back to a pool; the next bot that needs one borrows it. Browser state persists on disk (Chrome profiles in `/root/grokbot/profiles/`).

### I2 · VNC Password Rotation Handling
Orgo rotates the VNC password on restart, start, and RAM resize. Orbit's `vnc.ts` likely caches the password at connection setup. Add a re-fetch-on-`4001` / `4003` close-code path with exponential backoff so the viewer auto-reconnects after a password rotation without user action.

### I3 · Composio `connected_account.expired` Card
When a Composio connection expires, Orbit should surface a reconnect approval card in the affected bot's chat rather than silently failing tool calls. Grok Bot does this explicitly. Wire `composio.connected_account.expired` webhook events into the bot's turn queue as a system message with a "Reconnect [App]" action card.

### I4 · Bot-Level Composio Session Reuse
The `xai-and-composio.md` reference recommends storing `sessionId` on the bot row and calling `composio.use(sessionId)` rather than `composio.create(userId, ...)` on every turn. Confirm this is implemented; if sessions are recreated per-turn, it's an unnecessary cost and latency hit.

### I5 · `store: false` + Encrypted Reasoning Pass-Through
The xAI docs are explicit: use `store: false` and keep `reasoning.encrypted_content` in history unchanged, passing it back on the next turn. Confirm `loop.ts` does not filter out reasoning items or convert them to Chat Completions format. Filtering breaks the prompt cache prefix and reasoning continuity.

---

## 4. Parallelization Map

```
Tier 1 (all independent, run any order):
  F1  Deep Links         ──── 1 week  ──── desktop + mobile, independent
  F2  Bot Duplication    ──── 3 days  ──── server + UI
  F3  Safety ID + US API ──── 1 day   ──── 2-line changes in loop.ts
  F4  Context Compaction ──── 3 days  ──── loop.ts
  F5  Reasoning Effort   ──── 3 days  ──── bot settings + loop.ts

Tier 2 (each independent of the others; F7 depends on F6's DB schema):
  F6  Bot Templates      ──── 2 weeks ──── DB + server + UI
        └── F7 Starter Gallery ──── 1 week (seeds only, needs F6 schema)
  F8  Proactive Initiative ── 2 weeks ──── proactive.ts + settings
  F9  Auto-Review Rules  ──── 2 weeks ──── mcp.ts + DB + UI
  F10 WebSocket Mode     ──── 1 week  ──── loop.ts, feature-flagged

Tier 3 (each requires Tier 2 items as noted):
  F11 Teams of Bots      ──── 4 weeks ──── requires F6, F7, F8
  F12 Bot Vault          ──── 4 weeks ──── independent
  F13 Audit Log          ──── 2 weeks ──── independent (data exists)

Improvements (independent, can run alongside any tier):
  I1  Screen Lease Pool  ──── 2 weeks ──── computer.ts / OrgoComputerProvider
  I2  VNC Password Rotation ─ 2 days  ──── vnc.ts
  I3  Composio Expired Card ─ 1 week  ──── triggers.ts + mcp.ts
  I4  Session Reuse Check ─── 1 day   ──── audit engine.ts / composio.ts
  I5  Reasoning Pass-Through ─ 1 day  ──── audit loop.ts
```

**Suggested sprint packaging (4 parallel tracks after Tier 1):**

| Track | Owner area | Work |
|---|---|---|
| **A — Agent loop** | `server/src/agent/` | F3, F4, F5, F10, I4, I5 |
| **B — Bot management** | `server/src/routes.ts` + DB | F2, F6, F7, F9 |
| **C — Client surfaces** | `web/src/`, `mobile/`, `desktop/src/` | F1, F8 UI, F9 UI, F13 |
| **D — Infrastructure** | `computer.ts`, `vnc.ts`, `triggers.ts` | I1, I2, I3 |

Tracks A and D have no file overlap. Tracks B and C share the contracts package but different files.

---

## 5. Subagent Orchestration Recommendation

For the larger Tier 2/3 items, the following work can be delegated to parallel subagents without file conflicts:

| Subagent | Scope | Branch |
|---|---|---|
| `templates-server` | F6 DB migration + server routes | `feat/bot-templates-server` |
| `templates-ui` | F6 UI + F7 gallery | `feat/bot-templates-ui` |
| `rules-engine` | F9 DB + mcp.ts rule check | `feat/rules-engine` |
| `vault` | F12 encryption + routes + UI | `feat/bot-vault` |
| `loop-efficiency` | F3 + F4 + F5 + F10 + I4 + I5 | `feat/loop-efficiency` |

Each subagent gets its own worktree. The `loop-efficiency` agent touches only `apps/server/src/agent/` and `apps/server/src/engine.ts`. The `templates-server` and `templates-ui` agents touch different directories entirely and can run simultaneously.

---

## 6. Prioritized Delivery Order

If capacity allows only one item at a time:

1. **F3** (safety identifier) — 1 day, zero risk, compliance improvement
2. **F5** (reasoning effort) — 3 days, directly reduces cost on computer-use loops
3. **F4** (context compaction) — 3 days, prevents long-running bot failures
4. **F2** (bot duplication) — 3 days, high UX value, minimal code
5. **I5** (reasoning pass-through audit) — 1 day, verify correctness
6. **I3** (Composio expired card) — 1 week, reduces silent failures
7. **F9** (auto-review rules) — 2 weeks, closes the biggest product gap vs. Grok Bot
8. **F6 + F7** (templates + gallery) — 3 weeks, enables F11 and onboarding
9. **F1** (deep links) — 1 week, power-user surface
10. **F8** (proactive initiative) — 2 weeks, differentiated engagement feature
11. **F10** (WebSocket mode) — 1 week, latency improvement
12. **F12** (Vault) — 4 weeks, security and usability
13. **F11** (Teams of Bots) — 4 weeks, requires F6+F7+F8
14. **F13** (Audit log) — 2 weeks, compliance

---

*End of plan.*
