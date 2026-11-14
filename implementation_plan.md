# Orbit — Implementation Plan

> **Date**: 2026-11-14  
> **Scope**: Two major feature areas — (1) Hermes auth sharing for managed bots, and (2) a full Microsoft Teams-style UI redesign with Activity, Chat, Calendar, Files, Computers, and Skills sections.  
> **Target platforms**: React web app (rendered by Electron desktop) **and** Expo mobile app, delivered together.

---

## Table of Contents

1. [Feature 1 — Hermes Auth Sharing](#feature-1--hermes-auth-sharing)
2. [Feature 2 — Teams-style UI Redesign](#feature-2--teams-style-ui-redesign)
   - [2a. Navigation Shell Restructure](#2a-navigation-shell-restructure)
   - [2b. Activity View](#2b-activity-view)
   - [2c. Chat View](#2c-chat-view)
   - [2d. Calendar View](#2d-calendar-view)
   - [2e. Calls View](#2e-calls-view-placeholder)
   - [2f. Files View](#2f-files-view)
   - [2g. Computers View](#2g-computers-view)
   - [2h. Skills View](#2h-skills-view)
   - [2i. Right Panel Enhancement](#2i-right-panel-enhancement)
3. [Mobile App Parity](#mobile-app-parity)
4. [Cross-cutting Concerns](#cross-cutting-concerns)
5. [Test Strategy](#test-strategy)

---

## Feature 1 — Hermes Auth Sharing

### Goal

New managed bots created on the desktop dev target cannot connect to AI model providers because they do not receive auth credentials. Auth should be automatically inherited from the primary bot's Hermes configuration, kept in sync whenever it changes, and manageable via a per-bot table in App Settings.

### Problem Analysis

**Root cause**: `writeHome()` in `apps/server/src/engine.ts` copies `SHARED_ENV` keys from the primary's `.env` **only on first home creation** (the `const fresh = !fs.existsSync(cfgFile)` guard). If the primary's keys change after the managed bot is created, the managed bot loses access. Additionally, the current `SHARED_ENV` list covers API keys but not Hermes subscription tokens, and there is no UI to inspect or repair per-bot auth.

**Current `SHARED_ENV`** (already defined in `engine.ts`):
```
ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_TOKEN, CLAUDE_CODE_OAUTH_TOKEN,
OPENAI_API_KEY, OPENAI_BASE_URL, OPENROUTER_API_KEY, XAI_API_KEY, GEMINI_API_KEY,
GOOGLE_API_KEY, NOUS_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY,
PARALLEL_API_KEY, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL
```

**Current `SHARED_CONFIG`** (config.yaml keys copied on first creation):
```
model, providers, custom_providers, auxiliary, fallback_model, fallback_providers
```

### Prerequisites

- Working Orbit monorepo at `orbit-app/` with `pnpm dev` running.
- Primary bot exists and has at least one provider configured.

### Backend Changes

#### 1.1 — `apps/server/src/engine.ts`

**New exported function: `syncManagedAuth(botId: string)`**

Purpose: Bring a managed bot's `.env` and `config.yaml` into alignment with the primary's current credentials. Safe to call at any time (idempotent).

```typescript
export function syncManagedAuth(botId: string): void
```

Logic:
1. Confirm `engineKind(botId) === 'managed'`. No-op for primary.
2. Read primary's `.env` at `path.join(env.hermesHome, '.env')`.
3. Read managed bot's `.env` at `path.join(homeFor(botId), '.env')`.
4. For each key in `SHARED_ENV`: if primary has a non-empty value, write it into managed `.env` (overwrite); if primary is empty/missing, leave managed unchanged (do not delete existing key the user may have set manually).
5. Read primary's `config.yaml`. Read managed bot's `config.yaml`.
6. For each key in `SHARED_CONFIG`: if primary value exists and managed value is **absent** (never set), write it. If managed already has a value the user customised, leave it. *(Config is only patched for keys the managed bot has never had; this preserves intentional per-bot model divergence.)*
7. Write updated files with `0o600` mode.
8. Log each key synced.

**Update `writeHome()`**

After creating/refreshing a managed home, always call `syncManagedAuth(botId)` unconditionally (remove the `fresh` guard from the env-copying block). This means every `startManaged()` call brings credentials up to date.

**New exported function: `syncAllManagedAuth()`**

Calls `syncManagedAuth` for every managed bot in the DB. Called at server startup and whenever the primary's engine credentials are updated via the new API.

```typescript
export async function syncAllManagedAuth(): Promise<void>
```

#### 1.2 — `apps/server/src/routes-config.ts` (or equivalent config routes file)

**New endpoints:**

```
GET  /api/config/engine-auth
     Returns: { bots: BotEngineAuthRow[] }
     BotEngineAuthRow: { botId, name, engine: 'primary' | 'managed', provider, model, status, keysPresent: string[] }

PUT  /api/config/engine-auth/:botId
     Body: { provider?: string; model?: string }
     Returns: { bot: BotEngineAuthRow }
     Side-effect: writes config.yaml for managed bots; calls configApi.setEngine for primary

POST /api/config/engine-auth/sync
     Triggers syncAllManagedAuth() on the server.
     Returns: { synced: number }  — count of bots synced
```

**`keysPresent`**: a list of which `SHARED_ENV` keys have non-empty values in that bot's `.env`. Used by the UI to show a "Credentials" column without exposing values.

#### 1.3 — `packages/contracts/src/index.ts`

Add:
```typescript
export interface BotEngineAuthRow {
  botId: string;
  name: string;
  engine: 'primary' | 'managed';
  provider: string | null;
  model: string | null;
  status: 'ready' | 'starting' | 'stopped' | 'error' | 'unknown';
  keysPresent: string[];  // which SHARED_ENV keys are non-empty
}

export interface EngineAuthResponse {
  bots: BotEngineAuthRow[];
}
```

#### 1.4 — `apps/server/src/app.ts` (startup)

Call `syncAllManagedAuth()` during server startup, after migrations.

### Frontend Changes

#### 1.5 — `apps/web/src/lib/configApi.ts`

Add:
```typescript
engineAuth(): Promise<EngineAuthResponse>
setEngineAuth(botId: string, patch: { provider?: string; model?: string }): Promise<{ bot: BotEngineAuthRow }>
syncEngineAuth(): Promise<{ synced: number }>
```

#### 1.6 — New component: `apps/web/src/components/config/EngineAuthPanel.tsx`

A panel inside App Settings that renders a per-bot table:

| Bot | Engine | Provider | Model | Credentials |
|-----|--------|----------|-------|-------------|
| Doug (primary) | primary | Anthropic | claude-sonnet... | ✓ 3 keys |
| Scout | managed | deepseek | deepseek-chat | ✓ 2 keys |
| Barbie | managed | — | — | ✗ No keys |

Interactions:
- Each managed bot row is editable inline (provider dropdown + model text input matching the existing `EngineSettings` component).
- "Sync all" button at top right calls `POST /api/config/engine-auth/sync` and refreshes the table.
- Rows with `keysPresent.length === 0` are highlighted with a warning badge.
- Primary bot row is read-only (links to engine panel).

#### 1.7 — `apps/web/src/components/config/AppSettings.tsx`

Add a new "Engine Auth" tab (or section) that renders `<EngineAuthPanel />`. Place it between the existing settings sections.

#### 1.8 — `apps/web/src/components/modals/CreateBotModal.tsx`

After a managed bot is created (server call succeeds), immediately trigger `POST /api/config/engine-auth/sync` in the background, so the new bot's credentials are populated before the user opens its Engine panel.

### Success Criteria — Feature 1

- A newly created managed bot immediately has the same AI provider credentials as the primary.
- If the primary's API key is updated, calling "Sync all" propagates it to all managed bots without restarting them.
- The App Settings Engine Auth panel shows all bots with their current provider, model, and credential status.
- Rows with no credentials are visually flagged.
- Unit tests cover: `syncManagedAuth` for empty-primary-key (no-op), populated-primary-key (copy), already-set managed key (preserve for config, overwrite for env).
- API tests cover all three endpoints.

---

## Feature 2 — Teams-style UI Redesign

### Goal

Replace the current sidebar (a simple bot list) with a full Microsoft Teams-style navigation shell. The left side gains a narrow icon rail with seven sections: Activity, Chat, Calendar, Calls, Files, Computers, Skills. Each section has its own full-height content panel. The right panel (screen preview + bot details) is retained and enhanced.

### Design Principles

- **Language**: Teams-style dark sidebar rail (#1a1a2e or current token), white/light content area, purple accent for selected state.
- **Consistency**: New sections reuse existing primitives (`panel-card`, `panel-row`, `icon-btn`, `toggle`) and tokens from `packages/ui-tokens`.
- **Additive**: The existing `DetailsPanel` (right panel) is kept and enhanced; no functionality is removed.
- **Mobile**: Expo app gets equivalent bottom-tab navigation and stack screens for each section.

---

### 2a. Navigation Shell Restructure

#### Scope

Restructure `apps/web/src/App.tsx`, `Sidebar.tsx`, and `apps/web/src/styles/shell.css` to introduce a two-column left side: a narrow icon rail (60px) + a wider content panel (280px default, collapsible).

#### Current layout

```
[Sidebar 240px] [ChatView + DetailsPanel]
```

#### Target layout

```
[NavRail 60px] [SectionPanel 280px] [Main content] [DetailsPanel]
```

#### Components

**New: `apps/web/src/components/NavRail.tsx`**

```tsx
type NavSection = 'activity' | 'chat' | 'calendar' | 'calls' | 'files' | 'computers' | 'skills';

interface NavRailProps {
  active: NavSection;
  onChange: (s: NavSection) => void;
  unreadCounts: Partial<Record<NavSection, number>>;
}
```

Renders 7 icon buttons vertically. Each shows:
- Icon (from existing `Icon` component, new icons added for calendar, files, computers, skills).
- Label below icon (10px, truncated).
- Badge overlay for unread count (Activity, Chat).
- Selected state: white icon + accent left border.

Traffic lights / window controls move to the top of the NavRail on macOS (above the first icon).

The account avatar / account menu moves to the bottom of the NavRail.

**New: `apps/web/src/components/SectionPanel.tsx`**

A container that renders the correct section view based on `active`:
- `'activity'` → `<ActivityView />`
- `'chat'` → `<ChatListView />` (refactored from current sidebar bot list)
- `'calendar'` → `<CalendarView />`
- `'calls'` → `<CallsView />` (placeholder)
- `'files'` → `<FilesView />`
- `'computers'` → `<ComputersView />`
- `'skills'` → `<SkillsView />`

Has its own collapse button at the top right (hides panel, leaving only the rail).

**Update: `apps/web/src/configStore.ts`**

Add `navSection: NavSection` to config store, persisted to `localStorage`.

**Update: `apps/web/src/store.ts`**

Remove `sidebarCollapsed` (replaced by section panel collapse state in config store).

**Update: `apps/web/src/styles/shell.css`**

Replace `.sidebar` rules with `.nav-rail`, `.section-panel`, `.section-panel.is-collapsed`. Maintain all existing `.bot-row`, `.panel-card`, etc. rules.

#### New icons needed (add to `Icon.tsx` and icon sprite)

`activity`, `calendar`, `calls`, `files_folder`, `computers`, `skills`, `grid`

---

### 2b. Activity View

#### Scope

A unified activity feed across all bots, ordered by recency. Equivalent to Teams' Activity tab.

#### Components

**New: `apps/web/src/components/ActivityView.tsx`**

Displays a filtered, merged list of recent events across all bots:
- Unread messages (kind=`message`, role=`assistant`).
- Cards needing attention (kind=`card`, not yet answered).
- Running status changes (from `live` state).

Data source: existing `useStore` state — `bots`, `live`, and a cross-bot `rows` map (needs to be extended — see below).

**Update: `apps/web/src/store.ts`**

Add `recentActivity: ActivityItem[]` to store state, populated from SSE events.

```typescript
interface ActivityItem {
  botId: string;
  botName: string;
  kind: 'message' | 'card' | 'working' | 'completed';
  preview: string;
  at: number;
  seq?: number;
}
```

The SSE handler already receives row updates — extend it to push to `recentActivity` (capped at 200 items, deduplicated by `botId+seq`).

**UI:**

Each row: Bot avatar (small, 28px) | Bot name | Preview text | Timestamp.  
Clicking a row: sets `selectedBotId`, switches nav section to `'chat'`, scrolls to that row in the transcript.

Unread badge on the Activity icon in the rail = `bots.reduce((n, b) => n + b.unread, 0)`.

---

### 2c. Chat View

#### Scope

Refactor the current bot list sidebar into a `ChatListView` that lives inside the section panel. Combined list of individual bots and group chats, sorted by last activity. Users can create new bots and new group chats directly from the Chat section. Group chats support seamless multi-bot + user conversations where bots can @mention each other, respond to each other's messages, and ask for clarification from peers — all within a single group chat thread.

---

#### 2c-i. ChatListView UI

**New: `apps/web/src/components/ChatListView.tsx`**

Reuses `BotRow` component from current `Sidebar.tsx`. Features:

- **Search/filter input** at the top of the panel for quick inline filtering by bot or group name.
- **Combined list** of all bots and group chats (rooms with `kind === 'room'`), sorted by `lastActivityAt` descending.
- Group rows use a group avatar (overlapping bot avatars) rather than a single bot avatar, plus a person-count badge.
- Primary bot pinned at top with a visual separator below it.
- **Header action bar** with two buttons:
  - "New Bot" (pencil/plus icon) → opens existing `CreateBotModal`.
  - "New Group" (people/plus icon) → opens the enhanced `CreateGroupModal` (see §2c-ii).

**Migration**: Extract `BotRow` from `Sidebar.tsx` into `apps/web/src/components/BotRow.tsx`. Both files import from there.

---

#### 2c-ii. Enhanced CreateGroupModal

The existing `CreateGroupModal` is extended to be more discoverable and informative:

- Explain in a subtitle: *"Bots in this group can talk to each other and to you. @mention a specific bot to address them directly."*
- Show each bot's model/provider label beneath their name in the picker so users can compose groups with complementary models.
- Minimum 2 bots enforced (unchanged).
- After creation, the new group is immediately selected and the right panel opens to its transcript with the MembersCard visible.

No backend changes — `POST /api/rooms` is unchanged.

---

#### 2c-iii. Seamless Multi-Bot + User Group Conversations

**Goal**: When the user sends a message in a group chat, the right bots reply. When a bot's reply @mentions another group member, that member is automatically dispatched to respond — creating a back-and-forth without requiring another user message. This repeats up to a configurable depth limit to prevent loops.

**Mental model**: Think of it like a Slack thread where tagging a colleague pulls them in. The user sends one message; the bots hand off to each other naturally until the question is resolved.

##### How it currently works (baseline)

`dispatchRoomMessage()` in `apps/server/src/agent/rooms.ts`:
1. User sends a message → all @mentioned members (or all members up to `MAX_RESPONDERS=3`) are enqueued.
2. Each enqueued bot gets recent group history as context and is told to call `post_to_group` to reply or `stay_silent` to skip.
3. `postToRoom()` appends the bot's message to the room transcript.

There is **no mechanism** for a bot's reply to trigger further bot responses.

##### New mechanism: cascading @mention dispatch

**Server changes — `apps/server/src/agent/rooms.ts`**:

```typescript
const MAX_BOT_CHAIN_DEPTH = 3;  // max hops in a bot-to-bot chain within one user turn

/**
 * Called by the post_to_group MCP tool handler after a bot posts to the room.
 * Scans the posted text for @mentions of other room members and, if within the
 * depth limit, enqueues those members so they can respond.
 */
export function dispatchBotMentions(
  roomId: string,
  fromBotId: string,
  text: string,
  depth: number,
  enqueue: (botId: string, turn: any) => void,
): void
```

Logic:
1. If `depth >= MAX_BOT_CHAIN_DEPTH` → no-op (prevents infinite loops).
2. Load room members excluding `fromBotId` (a bot should not trigger itself).
3. Parse `text` for `@BotName` patterns matching any member's name (case-insensitive).
4. For each matched bot: call `enqueue(botId, buildGroupTurn(roomId, depth + 1, mentioned: true))`.
5. If no @mentions are found: no additional dispatches (the chain ends naturally when bots stop mentioning each other).

**New helper: `buildGroupTurn(roomId, depth, mentioned)`**

Produces the system message passed to each enqueued bot. Includes:
- The group name and full current member list.
- Whether the bot was @mentioned or is responding to a general message.
- Recent group transcript (last 20 messages including bot-to-bot exchanges, expanded from the current 12 to capture chained responses).
- The chain depth, so bots can be instructed to wrap up if `depth >= MAX_BOT_CHAIN_DEPTH - 1`:
  ```
  [Group chat "Research Team"] Members: Scout, Barbie, Doug. You were @mentioned by Scout.
  Recent messages:
  User: Can you all figure out the Q3 revenue trend?
  Scout: I'll handle the data pull. @Barbie can you check the narrative from last quarter?
  
  Reply by calling post_to_group. If you need another Bot's input, @mention them.
  Depth: 2 of 3 — this is near the chain limit; aim to wrap up your contribution.
  ```

**Updated `postToRoom()` signature**:

```typescript
export function postToRoom(
  fromBotId: string,
  roomName: string,
  text: string,
  depth: number,
  enqueue: (botId: string, turn: any) => void,
): string
```

After appending the message, calls `dispatchBotMentions(roomId, fromBotId, text, depth, enqueue)`.

**MCP tool handler** (`apps/server/src/mcp.ts` or `agent/tools.ts`):

The `post_to_group` tool currently calls `postToRoom(fromBotId, roomName, text)`. Update the call signature to pass `depth` and `enqueue`. The `depth` is threaded through from the enqueued turn's metadata.

**Turn metadata**: add `_groupDepth: number` to the turn object passed to each enqueued bot. The agent loop reads this and passes it through to the tool handler. Default is `0` (user-initiated).

##### Bot clarification requests (without blocking)

Bots already have `send_to_bot` for direct 1:1 delegation. In a group context the simpler pattern — @mentioning a peer in a `post_to_group` reply — is preferred because it keeps the conversation visible to everyone. The instructions passed to each bot explicitly say:

> *If you need input from another Bot before you can answer, @mention them in your reply to the group. They will be automatically dispatched to respond.*

This means no new tool is needed. The existing `stay_silent` tool lets a bot explicitly opt out when it has nothing to contribute.

##### Depth limit and loop prevention

| Scenario | Behaviour |
|----------|-----------|
| Bot A @mentions Bot B, B @mentions C, C mentions A | A is skipped at depth 3 (depth limit reached) |
| Bot A @mentions itself | Self-mentions are filtered out |
| Bot mentions a non-member | Mention is ignored (not in member list) |
| Bot calls `stay_silent` | No dispatch, chain ends at that node |
| User sends another message mid-chain | New user message starts a fresh chain at depth 0 |

##### Transcript rendering

No changes needed to `Transcript.tsx` — bot messages already show `from.name` when `from.kind === 'bot'`. The cascading replies appear as a natural message thread.

Optionally: add a subtle chain indicator (a thin left border in the bot's color) to visually group bot-to-bot exchanges within a single user turn. This is a CSS-only enhancement — add a `data-chain-depth` attribute to message elements and style in `chat.css`.

---

#### 2c-iv. Right Panel for Group Chats

When a group chat is selected:
- The right panel always shows the **MembersCard** (existing, unchanged) pinned at the top of the Activity tab.
- The @mention hint in `MembersCard` is updated: *"@mention a Bot to ask just them; Bots can also @mention each other to collaborate."*
- The Engine tab is hidden for rooms (rooms have no engine of their own).

---

#### Success Criteria — 2c

- ChatListView shows all bots and groups in a combined list sorted by recency.
- "New Bot" and "New Group" buttons both work from the Chat section header.
- Creating a group selects it immediately.
- User sends a message to a group → all non-@mentioned bots or all members respond (existing behaviour, unchanged).
- A bot @mentions a peer in its reply → that peer is automatically enqueued and responds in the same thread (new behaviour).
- A bot-to-bot chain stops at depth 3.
- Bots calling `stay_silent` terminate their branch of the chain.
- Self-mentions are silently ignored.
- `MAX_BOT_CHAIN_DEPTH` is a named constant, easy to tune.

---

### 2d. Calendar View

#### Scope

A full calendar UI that creates and displays scheduled tasks (routines) across all bots. Supports one-time events and recurring events. Routines are extended with calendar-specific metadata.

#### Prerequisites

The existing `Routine` type and `routines` table need new fields. This is a **backward-compatible migration**: old routines without the new fields continue to work as recurring cron routines; new fields default to null.

#### Database Migration

**New migration file** (e.g. `apps/server/src/migrations/0012_calendar.sql`):

```sql
ALTER TABLE routines ADD COLUMN calendar_title TEXT;
ALTER TABLE routines ADD COLUMN event_type TEXT DEFAULT 'recurring';  -- 'recurring' | 'one_time'
ALTER TABLE routines ADD COLUMN event_date TEXT;  -- ISO 8601 date, only for one_time
ALTER TABLE routines ADD COLUMN assigned_bot_id TEXT REFERENCES bots(id);
ALTER TABLE routines ADD COLUMN completed_at TEXT;  -- ISO 8601, set when one_time event runs
```

#### Contracts Update

Extend `Routine` in `packages/contracts/src/index.ts`:

```typescript
export interface Routine {
  // existing fields ...
  calendarTitle: string | null;
  eventType: 'recurring' | 'one_time';
  eventDate: string | null;       // ISO date for one_time events
  assignedBotId: string | null;   // null = use the routine's native bot
  completedAt: string | null;     // set after a one_time event runs
}
```

#### Server Changes

**`apps/server/src/routines.ts`**:
- `createRoutine()`: accept new fields in the input; for `one_time` events set `enabled=true` and `schedule` to a one-shot cron matching `eventDate`.
- `runRoutine()`: after a `one_time` routine runs successfully, set `completedAt = new Date().toISOString()` and `enabled = false`.
- `listRoutines()`: include new fields in SELECT.

**New endpoint**: `GET /api/calendar?from=&to=` — returns routines in a date window (for month/week view rendering). For recurring routines, expands occurrences within the window using a lightweight cron-expansion utility. For one-time routines, returns single events.

```typescript
interface CalendarEvent {
  routineId: string;
  botId: string;
  botName: string;
  title: string;
  start: string;         // ISO datetime
  end: string;           // ISO datetime (start + 30 min default)
  recurrenceRule: string | null;  // cron expression or null
  eventType: 'recurring' | 'one_time';
  completedAt: string | null;
}
```

#### Components

**New: `apps/web/src/components/CalendarView.tsx`**

Main calendar component. Uses a lightweight custom or library-based month/week/day grid.

Calendar library choice: **`@fullcalendar/react`** (MIT, well-maintained) with `@fullcalendar/daygrid`, `@fullcalendar/timegrid`, `@fullcalendar/interaction` packages.

Features:
- Month / Week / Day view toggle (top right of calendar area).
- Events rendered per bot with bot's avatar color.
- Click on empty slot → "New Event" modal.
- Click on event → "Edit Event" modal / popover.
- "Today" button, prev/next navigation.
- Cross-bot: shows all bots' events on one calendar. Bot name shown in event pill.
- One-time events: shown with a clock badge; grey out after `completedAt` is set.
- Recurring events: shown with a repeat badge.

**New: `apps/web/src/components/modals/CreateCalendarEventModal.tsx`**

Fields:
- Title (required)
- Assigned Bot (dropdown of all bots)
- Task / Prompt (what the bot should do — this becomes the routine's `prompt`)
- Event type: One-time / Recurring
  - One-time: Date + Time picker
  - Recurring: Cron preset selector (Daily 9am, Weekly Mon 9am, Weekdays 9am, Custom) + cron input
- Description (optional, becomes routine `name`)

On submit: `POST /api/routines` with new fields.

---

### 2e. Calls View (Placeholder)

#### Scope

A placeholder screen that communicates the feature is coming. No backend changes.

**New: `apps/web/src/components/CallsView.tsx`**

Simple centered message: "Calls — Coming soon. Voice calls with your bots are available via the voice button in each chat." with a link to open the primary bot chat and a visual of the VoiceCallBar.

---

### 2f. Files View

#### Scope

A unified file browser showing files from all bots: Library files, message attachments, and computer workspace files.

#### Server Changes

**New endpoint**: `GET /api/files?botId=&type=&search=&page=&pageSize=`

Returns a paginated list of `FileEntry` records aggregated across bots:

```typescript
interface FileEntry {
  id: string;
  botId: string;
  botName: string;
  type: 'library' | 'attachment' | 'workspace';
  filename: string;
  path: string;         // relative path within its type root
  size: number;         // bytes
  mediaType: string;
  createdAt: number;    // unix ms
  downloadUrl: string;  // proxied download URL
}

interface FilesResponse {
  files: FileEntry[];
  total: number;
  page: number;
  pageSize: number;
}
```

Data sources:
- **Library files**: `fs.readdirSync` over `BOT_DATA_DIR/files/<botId>` for each bot.
- **Attachments**: Query `rows` table for `kind='message'` rows with `body.files` non-empty; extract file entries.
- **Workspace files**: `fs.readdirSync` over `ENGINES_DIR/<botId>/workspace` for managed bots; `BOT_DATA_DIR/files/<botId>` for primary (same as library but filtered to non-library subdirs).

**New endpoint**: `GET /api/files/:fileId/download` — streams the file from disk.

**Contracts**:
```typescript
export interface FileEntry { ... }  // as above
export interface FilesResponse { ... }
```

#### Components

**New: `apps/web/src/components/FilesView.tsx`**

Layout: Filter bar at top (search input, bot filter dropdown, type filter tabs: All / Library / Attachments / Workspace), then a file grid/list below.

File item shows: file icon (by mediaType), filename, bot avatar + name, size, date.

Clicking a file:
- Images: open in existing `ImageViewer` component.
- Text/code: open in a simple modal viewer.
- Other: download.

Grid vs list toggle (persisted to `localStorage`).

---

### 2g. Computers View

#### Scope

A centralized grid showing the live screen of every bot that has an active computer. Shows status (awake, sleeping, working).

#### Server Changes

**New endpoint**: `GET /api/computers`

Returns current computer state for all bots:

```typescript
interface BotComputerStatus {
  botId: string;
  botName: string;
  kind: 'docker' | 'orgo' | 'none';
  status: 'awake' | 'sleeping' | 'starting' | 'unknown';
  isRunning: boolean;      // agent currently running a turn
  vncAvailable: boolean;   // VNC stream can be opened
  screenId: string | null;
}

interface ComputersResponse {
  computers: BotComputerStatus[];
}
```

Data source: existing `computer-store.ts`, `computer-provider-registry.ts`, and `live` state from `store.ts`.

#### Components

**New: `apps/web/src/components/ComputersView.tsx`**

Renders a responsive grid of `ComputerCard` components, one per bot with a computer.

**New: `apps/web/src/components/ComputerCard.tsx`**

Each card shows:
- Bot avatar + name.
- Status badge (Awake / Sleeping / Starting).
- Mini VNC preview (a small `<ComputerScreen>` in `watch` mode — reuses existing `ComputerViewer` component at reduced size).
- "Open" button → expands to full viewer (sets `viewerOpen: true` for that bot).
- "Wake" / "Sleep" button for Docker computers.

Grid: 2 columns on wide screens, 1 column on narrow.

---

### 2h. Skills View

#### Scope

Shows all skills/MCP servers configured in the primary Hermes agent. Users can toggle which skills are available to each managed bot. When a new bot is created all skills are inherited; skills can be removed per-bot.

#### Mental Model

Skills in Hermes are configured in `~/.hermes/config.yaml` under `mcp_servers`. The primary bot has the full set. Each managed bot's `config.yaml` also has an `mcp_servers` section (initially copied from primary via `SHARED_CONFIG` → `custom_providers`, but *not* `mcp_servers` currently).

**This feature extends `SHARED_CONFIG` to include `mcp_servers`** and adds per-bot override storage.

#### Server Changes

**`apps/server/src/engine.ts`**:
- Add `'mcp_servers'` to `SHARED_CONFIG`.
- New function `getMcpServers(botId: string)`: reads that bot's `config.yaml` and returns `mcp_servers` entries.
- New function `setMcpServerEnabled(botId: string, serverName: string, enabled: boolean)`: for managed bots, removes or restores an MCP server entry in the bot's `config.yaml`. For primary bot, read-only (always enabled).

**New endpoints**:

```
GET  /api/skills
     Returns: { skills: SkillEntry[] }
     SkillEntry: { name, type, url, primaryEnabled: true, bots: { botId, enabled }[] }

PUT  /api/skills/:botId/:skillName
     Body: { enabled: boolean }
     Returns: { skill: SkillEntry }
```

**Contracts**:
```typescript
export interface SkillEntry {
  name: string;
  type: 'http' | 'stdio' | string;
  url: string | null;
  description: string | null;
  primaryEnabled: boolean;
  bots: { botId: string; botName: string; enabled: boolean }[];
}
```

#### Components

**New: `apps/web/src/components/SkillsView.tsx`**

Layout: list of skills on the left; on click, a detail panel on the right shows which bots have it enabled with toggle switches.

Each skill row: skill name, type badge (HTTP / stdio), description (truncated), number of bots enabled.

Detail panel: skill metadata at top, then a list of all bots with a toggle for each managed bot (primary always shown as enabled, non-editable).

Changes propagate immediately (no Save button) with optimistic UI updates.

---

### 2i. Right Panel Enhancement

#### Scope

The existing right panel (`DetailsPanel.tsx`) is kept but restyled to match the Teams design language. Tabs are enhanced. No capabilities are removed.

#### Changes

**`apps/web/src/components/DetailsPanel.tsx`**:
- Rename tabs: **Screen** (was unlabeled preview), **Activity**, **Tasks**, **Library**.
- Add tab: **Engine** (move `EngineSettings` out of the footer scrollable area into a dedicated tab).
- Keep: Upcoming routines, Voice Chat controls, Members card for group bots.
- Restyling: match tab bar to Teams style (underline indicator, not pill), panel cards get subtle border, engine section gets its own card.

**`apps/web/src/styles/details.css`**:
- Add `.details-tabs`, `.details-tab`, `.details-tab.is-active` rules.
- Add `.engine-tab-panel` for the new Engine tab.

**`apps/web/src/components/config/BotSettingsModal.tsx`**:
- Add a "Credentials" link in the bot settings that navigates to the Engine Auth panel in App Settings, pre-filtered to that bot.

---

## Mobile App Parity

### Goal

The Expo mobile app (`apps/mobile`) gains equivalent screens for all new sections, using bottom-tab navigation matching the Teams-style sections.

### Current mobile structure

The mobile app uses Expo Router. Current screens: chat, approvals, bot roster, live screen (noVNC WebView).

### Target mobile structure

**Bottom tab bar** (Expo Router `tabs` layout):
1. Activity
2. Chat (bot list → bot chat)
3. Calendar
4. Files
5. Computers

Skills and Calls are accessible from a "More" tab or a drawer.

### Component plan

All new mobile screens consume the **same server API endpoints** defined in Feature 1 and Feature 2. No new server endpoints are needed for mobile.

**New files in `apps/mobile/`**:

```
app/(tabs)/activity.tsx       -- ActivityFeed screen
app/(tabs)/calendar.tsx       -- CalendarScreen (uses react-native-calendars)
app/(tabs)/files.tsx          -- FilesScreen
app/(tabs)/computers.tsx      -- ComputersScreen
app/(tabs)/more.tsx           -- Skills, Settings, Calls placeholder
app/bot/[id]/chat.tsx         -- (existing, enhanced)
app/skills/index.tsx          -- SkillsScreen
components/CalendarEventModal.tsx
components/FileRow.tsx
components/ComputerCard.native.tsx
```

**Calendar library for mobile**: `react-native-calendars` (MIT).

**Files**: render as a `FlatList` matching the web files view. Tap to preview (images via built-in `Image`, others open with `expo-sharing`).

**Computers**: render as a scrollable list of `ComputerCard` items. VNC view opens as a full-screen WebView (existing pattern from current mobile noVNC screen).

---

## Cross-cutting Concerns

### Design Tokens

Add to `packages/ui-tokens/src/index.ts`:
```typescript
navRailBg, navRailSelected, navRailIcon, navRailIconSelected,
sectionPanelBg, sectionPanelBorder,
calendarEventPrimary, calendarEventSecondary,
skillsBadgeBg
```

Add matching CSS variables to `packages/ui-tokens/tokens.css`.

### SSE Events

Add new event types to `ServerEvent` in contracts:
```typescript
| { type: 'activity'; payload: ActivityItem }
| { type: 'computer-status'; payload: BotComputerStatus }
| { type: 'files-updated'; botId: string }
```

The activity event is emitted whenever a message row or card row is created for any bot.  
The computer-status event is emitted when a bot's computer changes state.

### Auth / Security

All new endpoints follow the existing pattern: `requireAuth` middleware, session cookie / Bearer token. No new auth mechanism.

### Error Handling

- All new API endpoints return `{ error: string }` on failure with appropriate HTTP status.
- All new UI components follow existing pattern: show loading state → content → error with retry.
- File reads that fail (bot's workspace missing) return empty arrays, not errors.

---

## Test Strategy

### Unit Tests

**Location pattern**: co-located `__tests__` directories matching the existing convention.

| Area | File | What to test |
|------|------|-------------|
| Auth sync | `apps/server/src/__tests__/engine-auth.test.ts` | `syncManagedAuth`: empty primary (no-op), populated primary (copy), already-set managed key (overwrite for env, preserve for config), idempotency |
| Calendar routines | `apps/server/src/__tests__/routines-calendar.test.ts` | One-time routine: runs once then marks completed. Recurring routine: schedule unchanged. `GET /api/calendar` date expansion. |
| Files aggregation | `apps/server/src/__tests__/files.test.ts` | `GET /api/files` returns entries from all three sources; pagination works; type filter works. |
| Skills config | `apps/server/src/__tests__/skills.test.ts` | `setMcpServerEnabled(botId, name, false)` removes entry from managed config. Re-enabling restores it. Primary bot entries are read-only. |
| NavRail | `apps/web/src/__tests__/NavRail.test.tsx` | Renders all 7 sections. Clicking changes active section. Badge shows unread count. |
| ActivityView | `apps/web/src/__tests__/ActivityView.test.tsx` | Renders activity items sorted by recency. Clicking item selects bot and switches to chat. |
| ChatListView | `apps/web/src/__tests__/ChatListView.test.tsx` | Renders all bots + groups sorted by recency. Groups show group avatar. Search filters. New Bot and New Group buttons open correct modals. |
| Bot-to-bot cascade | `apps/server/src/__tests__/rooms-cascade.test.ts` | `dispatchBotMentions` with valid @mention → enqueues mentioned bot. `depth >= MAX_BOT_CHAIN_DEPTH` → no dispatch. Self-mention → ignored. Non-member mention → ignored. `stay_silent` path → chain terminates. Multiple @mentions in one message → all dispatched simultaneously. |
| CalendarView | `apps/web/src/__tests__/CalendarView.test.tsx` | Renders events from API. Month/week/day view toggle. Create event modal opens on slot click. |
| FilesView | `apps/web/src/__tests__/FilesView.test.tsx` | Renders files from API. Filter by type. Search filters results. |
| SkillsView | `apps/web/src/__tests__/SkillsView.test.tsx` | Renders skill list. Toggle updates bot skill assignment optimistically. Primary bot shows as non-editable. |
| EngineAuthPanel | `apps/web/src/__tests__/EngineAuthPanel.test.tsx` | Renders per-bot table. Rows with no keys show warning. Sync All button calls API. |

### Integration / API Tests

Extend `apps/server/tests/e2e.mjs` (the existing smoke tests) with:
- `GET /api/config/engine-auth` → 200, returns bot rows.
- `POST /api/config/engine-auth/sync` → 200, returns synced count.
- `GET /api/calendar?from=...&to=...` → 200, returns events array.
- `GET /api/files` → 200, returns files array.
- `GET /api/computers` → 200, returns computer statuses.
- `GET /api/skills` → 200, returns skill entries.
- `PUT /api/skills/:botId/:skillName` → 200, reflects change.

### Desktop Tests

Extend `apps/desktop/src/__tests__/` with:
- `hermes-auth-sync.test.ts`: Tests that after `writeHome()`, managed bot's `.env` has the same AI keys as primary.

### End-to-End Flow Tests

Manual verification checklist (documented in `docs/e2e-checklist.md`):
1. Create a new managed bot → bot immediately has credentials → Engine panel shows "Connected".
2. Create a one-time calendar event for a bot → event appears on calendar → bot runs the task → event greys out.
3. Create a recurring calendar event → appears every week → can be edited/deleted.
4. Upload a file through chat → appears in Files view under Attachments.
5. Toggle a skill off for one managed bot → bot's config updated → skill no longer appears in that bot's MCP list.
6. Computers view shows all awake bots with live previews.
