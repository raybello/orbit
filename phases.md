# Orbit — Execution Phases

> **Purpose**: Order the work from `implementation_plan.md` for maximum parallelism across subagents. Each phase declares its dependencies, the files it touches, and its validation criteria. Subagents working in the same phase must not touch the same files.
>
> **Convention**:
> - Each Phase is a self-contained unit of work for one subagent.
> - `Depends on` = prior phase IDs that must be **complete** before starting.
> - `Files` = exclusive file ownership within the phase (two phases in the same parallel group never share a file).
> - `Validation` = automated checks that must pass before the phase is considered done.

---

## Phase Map (Dependency Graph)

```
Phase 0 (Foundation)
│
├── Phase 1A  (Auth backend)          ─────┐
├── Phase 1B  (Nav shell + tokens)         │
├── Phase 1C  (Calendar backend)      ─────┤
├── Phase 1D  (Files backend)         ─────┤  all independent
├── Phase 1E  (Computers backend)     ─────┤
└── Phase 1F  (Skills backend)        ─────┘
           │
           ▼
Phase 2 (UI views — parallel, each owns its own component files)
│
├── Phase 2A  (Auth Settings UI)      depends on 1A
├── Phase 2B  (Chat list + migration) depends on 1B
├── Phase 2C  (Activity view)         depends on 1B
├── Phase 2D  (Calendar UI)           depends on 1B + 1C
├── Phase 2E  (Files UI)              depends on 1B + 1D
├── Phase 2F  (Computers UI)          depends on 1B + 1E
└── Phase 2G  (Skills UI)             depends on 1B + 1F
           │
           ▼
Phase 3 (Right panel + cross-cutting)  depends on 2A–2G
           │
           ▼
Phase 4 (Mobile parity)               depends on 1A–1F + Phase 3
           │
           ▼
Phase 5 (Integration tests + polish)  depends on all prior phases
```

---

## Phase 0 — Foundation (contracts + DB)

**Run before everything. No parallelism within this phase.**

**Goal**: Add all new types to `@orbit/contracts` and run the DB migration so all later phases can compile and query without stubs.

**Depends on**: nothing

**Subagent context**:
> You are working in `/Users/raybello/Github/Orbit/orbit-app`. Read `docs/ARCHITECTURE.md` and `packages/contracts/src/index.ts` before starting. This phase adds new shared types and a DB migration. Do not add any UI or server logic — only types and schema.

**Files owned**:
- `packages/contracts/src/index.ts`
- `apps/server/src/migrations/0012_calendar.sql` (new)

**Tasks**:

1. **`packages/contracts/src/index.ts`** — add:
   - `BotEngineAuthRow` interface
   - `EngineAuthResponse` interface
   - Extend `Routine` with: `calendarTitle`, `eventType`, `eventDate`, `assignedBotId`, `completedAt`
   - `CalendarEvent` interface
   - `FileEntry` interface
   - `FilesResponse` interface
   - `BotComputerStatus` interface
   - `ComputersResponse` interface
   - `SkillEntry` interface
   - `ActivityItem` interface
   - New SSE event union members: `activity`, `computer-status`, `files-updated`
   - `NavSection` type: `'activity' | 'chat' | 'calendar' | 'calls' | 'files' | 'computers' | 'skills'`

2. **`apps/server/src/migrations/0012_calendar.sql`** — write SQL:
   ```sql
   ALTER TABLE routines ADD COLUMN calendar_title TEXT;
   ALTER TABLE routines ADD COLUMN event_type TEXT DEFAULT 'recurring' NOT NULL;
   ALTER TABLE routines ADD COLUMN event_date TEXT;
   ALTER TABLE routines ADD COLUMN assigned_bot_id TEXT REFERENCES bots(id);
   ALTER TABLE routines ADD COLUMN completed_at TEXT;
   ```
   The server's migration runner must pick this up on next startup. Verify the runner scans `src/migrations/*.sql` ordered by filename.

3. Run `pnpm --filter @orbit/contracts build` and `pnpm typecheck` — must pass with no errors.

**Validation**:
- `pnpm --filter @orbit/contracts build` exits 0.
- `pnpm typecheck` exits 0 (types compile across all packages).
- SQL file exists and is syntactically valid (run `sqlite3 :memory: < 0012_calendar.sql` with appropriate table stubs to verify).

---

## Phase 1A — Auth Backend

**Goal**: Implement server-side Hermes auth sync and the Engine Auth API endpoints.

**Depends on**: Phase 0

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/server/src/engine.ts` (all of it), `apps/server/src/routes-config.ts` (or whichever file contains `/api/config/*` routes), and `docs/ARCHITECTURE.md`. Phase 0 added `BotEngineAuthRow` and `EngineAuthResponse` to `packages/contracts/src/index.ts`. The goal is to add auth sync logic to `engine.ts` and three new API endpoints. Do not touch the UI.

**Files owned**:
- `apps/server/src/engine.ts`
- `apps/server/src/routes-config.ts` (or the file containing config API routes)
- `apps/server/src/__tests__/engine-auth.test.ts` (new)
- `apps/server/src/app.ts` (startup call only — add `syncAllManagedAuth()` call)

**Tasks**:

1. **`engine.ts`**: Add `syncManagedAuth(botId)`:
   - Reads primary's `.env` and managed bot's `.env`.
   - For each key in `SHARED_ENV`: if primary has non-empty value → write to managed `.env`.
   - For each key in `SHARED_CONFIG`: if key absent in managed `config.yaml` → copy from primary.
   - Write files with mode `0o600`.
   - Log each change.

2. **`engine.ts`**: Add `syncAllManagedAuth()`:
   - Queries DB for all managed bot IDs.
   - Calls `syncManagedAuth` for each.

3. **`engine.ts`**: Update `writeHome()`:
   - Remove the `fresh` guard from the env-copying block.
   - After home is written, call `syncManagedAuth(botId)`.

4. **`app.ts`**: Call `await syncAllManagedAuth()` during startup (after DB migrations).

5. **Config routes file**: Add three endpoints:
   - `GET /api/config/engine-auth`: query all bots, for each call `engineKind()`, read provider/model from DB, read `keysPresent` from that bot's `.env` (which keys in `SHARED_ENV` are non-empty), return `BotEngineAuthRow[]`.
   - `PUT /api/config/engine-auth/:botId`: validate body `{ provider?, model? }`, call existing `configApi.setEngine` logic or write directly to managed config, return updated row.
   - `POST /api/config/engine-auth/sync`: call `syncAllManagedAuth()`, return `{ synced: number }`.

6. **`engine-auth.test.ts`**: Write unit tests:
   - `syncManagedAuth` with empty primary key → managed key unchanged.
   - `syncManagedAuth` with non-empty primary key → managed key set to same value.
   - `syncManagedAuth` when managed already has a key → env key overwritten; config key preserved.
   - `syncManagedAuth` for primary bot → no-op.
   - `syncAllManagedAuth` calls `syncManagedAuth` for each managed bot.

**Validation**:
- `pnpm --filter @orbit/server test` passes (all existing + new tests).
- `pnpm typecheck` passes.
- Manual: `curl -s http://localhost:8787/api/config/engine-auth` returns a JSON object with a `bots` array.
- Manual: `curl -s -X POST http://localhost:8787/api/config/engine-auth/sync` returns `{ synced: N }`.

---

## Phase 1B — Navigation Shell + Design Tokens

**Goal**: Restructure the web app's layout to the Teams-style two-column left side (NavRail + SectionPanel). This phase delivers the shell only — section views render placeholder content. All other Phase 1 and Phase 2 subagents depend on this being done first for the UI side.

**Depends on**: Phase 0

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/web/src/App.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/styles/shell.css`, `apps/web/src/configStore.ts`, `packages/ui-tokens/src/index.ts`, `packages/ui-tokens/tokens.css`. Phase 0 added `NavSection` type to contracts. Restructure the layout to have a NavRail + SectionPanel architecture. Do not implement section content — render placeholder `<div>` elements per section.

**Files owned**:
- `apps/web/src/components/NavRail.tsx` (new)
- `apps/web/src/components/SectionPanel.tsx` (new)
- `apps/web/src/components/BotRow.tsx` (extracted from Sidebar)
- `apps/web/src/components/Sidebar.tsx` (refactored to thin wrapper)
- `apps/web/src/App.tsx`
- `apps/web/src/configStore.ts`
- `apps/web/src/store.ts` (remove `sidebarCollapsed`, add `navSection`)
- `apps/web/src/styles/shell.css`
- `apps/web/src/styles/tokens.css`
- `packages/ui-tokens/src/index.ts`
- `packages/ui-tokens/tokens.css`
- `apps/web/src/__tests__/NavRail.test.tsx` (new)

**Tasks**:

1. **`packages/ui-tokens`**: Add new design tokens:
   - `navRailBg`, `navRailWidth` (48px, Fluent 2 rail), `navRailSelected`, `navRailIcon`, `navRailIconSelected`
   - `sectionPanelBg`, `sectionPanelWidth` (280px), `sectionPanelBorder`

2. **`apps/web/src/styles/tokens.css`**: Add CSS custom properties matching new tokens. Add dark mode variants.

3. **`apps/web/src/components/BotRow.tsx`**: Extract `BotRow` and `previewFor` from `Sidebar.tsx`. Keep existing `Sidebar.tsx` importing `BotRow` from new file (backward compatible).

4. **`apps/web/src/configStore.ts`**: Add `navSection: NavSection` (default `'chat'`), `sectionPanelCollapsed: boolean` (default `false`). Remove `sidebarCollapsed` state if present here.

5. **`apps/web/src/store.ts`**: Remove `sidebarCollapsed`. (Sidebar collapse is replaced by section panel collapse in configStore.)

6. **`apps/web/src/components/NavRail.tsx`**: Implement:
   - 7 nav buttons: activity, chat, calendar, calls, files, computers, skills.
   - Each: icon (via `Icon` component — add missing icon names as needed), 10px label below.
   - Selected state: white icon + 3px left border in accent color.
   - Unread badge (small dot) on activity and chat.
   - TrafficLights at the very top (macOS only, using existing `hasNativeWindowControls()` check).
   - Account avatar button at bottom (opens account menu matching current Sidebar footer).
   - Add required icon names to `apps/web/src/components/Icon.tsx`.

7. **`apps/web/src/components/SectionPanel.tsx`**: Container with collapse button at top. Routes to placeholder `<div data-section={section}>Coming soon</div>` for all sections. Passes `selectedBotId` setter down.

8. **`apps/web/src/App.tsx`**: Replace `<Sidebar>` with `<NavRail> + <SectionPanel>`. Adjust grid/flex layout: `[NavRail 60px] [SectionPanel 0–280px] [Main flex-1] [DetailsPanel]`.

9. **`apps/web/src/styles/shell.css`**: Replace `.sidebar` rules with `.nav-rail`, `.section-panel`, `.section-panel.is-collapsed`. Preserve all `.bot-row*`, `.panel-card*`, `.panel-row*` rules unchanged.

10. **`NavRail.test.tsx`**: Test renders all 7 items; click changes active section; badge shows count.

**Validation**:
- `pnpm dev` starts without errors.
- Browser shows NavRail on the left with 7 icons.
- Clicking each icon changes the highlighted section.
- Existing ChatView still renders when Chat is selected.
- `pnpm --filter @orbit/web test` passes.
- `pnpm typecheck` passes.

---

## Phase 1C — Calendar Backend

**Goal**: Extend the routines system with calendar fields and implement the `/api/calendar` endpoint.

**Depends on**: Phase 0

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/server/src/routines.ts`, `apps/server/src/db.ts` (to understand migration runner), `packages/contracts/src/index.ts` (Phase 0 already added `Routine` extensions and `CalendarEvent` type). Implement the extended routine creation/listing and the calendar query endpoint. The DB migration SQL is in `apps/server/src/migrations/0012_calendar.sql` (written in Phase 0) — do not modify it, just ensure the server picks it up.

**Files owned**:
- `apps/server/src/routines.ts`
- `apps/server/src/routes.ts` (calendar endpoint only — add `GET /api/calendar`)
- `apps/server/src/__tests__/routines-calendar.test.ts` (new)

**Tasks**:

1. **`routines.ts`**: Update `createRoutine()` to accept and persist `calendarTitle`, `eventType`, `eventDate`, `assignedBotId`.
   - For `one_time` with `eventDate`: generate a one-shot cron string from the date (e.g. `"30 9 14 11 *"` for Nov 14 at 09:30) and set `enabled=true`.
   - For `recurring`: use the provided `schedule` cron string as today.

2. **`routines.ts`**: Update `runRoutine()`: after a `one_time` routine completes successfully, `UPDATE routines SET completed_at=?, enabled=0 WHERE id=?`.

3. **`routines.ts`**: Update `listRoutines()`: include new columns in SELECT.

4. **`routes.ts`**: Add `GET /api/calendar?from=&to=` endpoint:
   - Parse `from` and `to` as ISO date strings.
   - Fetch all routines (across all bots).
   - For recurring routines: use a lightweight cron expansion (implement a small utility — no library dependency — that given a cron expression and a date range produces at most 200 occurrences). Map each occurrence to a `CalendarEvent`.
   - For one-time routines: include once if `eventDate` is within the window.
   - Return `{ events: CalendarEvent[] }` sorted by `start`.

5. **`routines-calendar.test.ts`**: Tests:
   - One-time routine created with `eventDate` → has correct cron, `enabled=true`.
   - After `runRoutine()` on one-time → `completed_at` set, `enabled=false`.
   - `GET /api/calendar` returns events for recurring routine within date window.
   - `GET /api/calendar` excludes events outside window.
   - `GET /api/calendar` includes one-time event when `eventDate` within window.

**Validation**:
- `pnpm --filter @orbit/server test` passes (new + existing).
- `pnpm typecheck` passes.
- Manual: `curl "http://localhost:8787/api/calendar?from=2026-11-01&to=2026-11-30"` returns JSON with an `events` array.

---

## Phase 1D — Files Backend

**Goal**: Implement the `/api/files` aggregation endpoint and `/api/files/:fileId/download`.

**Depends on**: Phase 0

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/server/src/routes.ts`, `apps/server/src/env.ts`, `docs/ARCHITECTURE.md`. Phase 0 added `FileEntry` and `FilesResponse` to contracts. Implement two new API endpoints that aggregate files from three sources: bot Library files on disk, message attachment records in the DB, and workspace files on disk. No UI changes.

**Files owned**:
- `apps/server/src/files.ts` (new module)
- `apps/server/src/routes.ts` (add `/api/files` routes)
- `apps/server/src/__tests__/files.test.ts` (new)

**Tasks**:

1. **`files.ts`**: New module with:
   - `listLibraryFiles(botId, dataDir)`: reads `BOT_DATA_DIR/files/<botId>` recursively, returns `FileEntry[]` with `type='library'`.
   - `listAttachmentFiles(botId, db)`: queries rows table for `kind='message'` rows where body has non-empty `files` array for the given botId; returns `FileEntry[]` with `type='attachment'` and `downloadUrl` pointing to existing `/api/files/<botId>/library/<path>` or similar.
   - `listWorkspaceFiles(botId, enginesDir)`: reads `ENGINES_DIR/<botId>/workspace` recursively; returns `FileEntry[]` with `type='workspace'`.
   - `aggregateFiles(opts: { botId?, type?, search?, page, pageSize })`: combines all three sources for all (or one) bot(s), applies filters, paginates.

2. **`routes.ts`**: Add:
   - `GET /api/files`: calls `aggregateFiles` with query params, returns `FilesResponse`.
   - `GET /api/files/:fileId/download`: parses fileId to resolve to a disk path (use a signed path approach — encode botId + relative path as a base64 blob, verify on download). Stream file with correct `Content-Type`.

3. **`files.test.ts`**: Tests:
   - `listLibraryFiles` with a mock directory returns correct entries.
   - `aggregateFiles` with `type='library'` returns only library files.
   - `aggregateFiles` with `search='report'` filters by filename substring.
   - Pagination: page 2 of 10-item list with pageSize=5 returns items 6–10.

**Validation**:
- `pnpm --filter @orbit/server test` passes.
- `pnpm typecheck` passes.
- Manual: `curl http://localhost:8787/api/files` returns `{ files: [...], total: N }`.

---

## Phase 1E — Computers Backend

**Goal**: Implement `GET /api/computers` returning live computer status for all bots.

**Depends on**: Phase 0

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/server/src/computer-store.ts`, `apps/server/src/computer-provider-registry.ts`, `apps/server/src/computer.ts`, `apps/server/src/routes.ts`. Phase 0 added `BotComputerStatus` and `ComputersResponse` to contracts. Implement one new read-only API endpoint. No UI changes, no DB changes.

**Files owned**:
- `apps/server/src/routes.ts` (add `/api/computers` route)
- `apps/server/src/__tests__/computers.test.ts` (new)

**Tasks**:

1. **`routes.ts`**: Add `GET /api/computers`:
   - Query all bots from DB.
   - For each bot: call `computerKindFor(botId)` and `providerFor(botId).status()` (or equivalent existing method) to get `status`.
   - Check `live` store for `isRunning`.
   - Check `vncAvailable` by confirming a VNC connection can be established (use existing `vnc.ts` helpers — do not open a connection; check that the port/socket is reachable with a quick connect-and-close).
   - Return `ComputersResponse`.

2. **`computers.test.ts`**:
   - Mocked bot list returns correct computer statuses.
   - Bot with `kind='docker'` returns `kind='docker'`.
   - Bot with no computer returns `kind='none'`, `status='unknown'`.

**Validation**:
- `pnpm --filter @orbit/server test` passes.
- `pnpm typecheck` passes.
- Manual: `curl http://localhost:8787/api/computers` returns `{ computers: [...] }`.

---

## Phase 1F — Skills Backend

**Goal**: Implement the Skills API — read MCP servers from primary Hermes config, and toggle per-bot skill access.

**Depends on**: Phase 0

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/server/src/engine.ts` (specifically the `readYaml` and `writePrivate` helpers and `SHARED_CONFIG`), `apps/server/src/routes.ts`. Phase 0 added `SkillEntry` to contracts. Add `'mcp_servers'` to `SHARED_CONFIG` in `engine.ts`, implement `getMcpServers` and `setMcpServerEnabled`, and add two API endpoints.

**Files owned**:
- `apps/server/src/engine.ts` (add skills functions only — do not modify auth sync logic)
- `apps/server/src/routes.ts` (add `/api/skills` routes)
- `apps/server/src/__tests__/skills.test.ts` (new)

**Tasks**:

1. **`engine.ts`**:
   - Add `'mcp_servers'` to `SHARED_CONFIG` array.
   - Add `getMcpServers(botId: string): SkillEntry[]`:
     - Reads that bot's `config.yaml`.
     - Reads primary's `config.yaml`.
     - For each server in primary's `mcp_servers`: check if it exists in this bot's `mcp_servers`.
     - Returns `SkillEntry[]` with `primaryEnabled: true` for all and `enabled: boolean` per bot.
   - Add `setMcpServerEnabled(botId: string, serverName: string, enabled: boolean)`:
     - If `engineKind(botId) === 'primary'` → throw (read-only).
     - Reads managed bot's `config.yaml`.
     - If `enabled=false`: removes the named entry from `mcp_servers`.
     - If `enabled=true`: copies the entry back from primary's `config.yaml`.
     - Writes updated config with `writePrivate`.

2. **`routes.ts`**: Add:
   - `GET /api/skills`: calls `getMcpServers` for all bots, aggregates into `SkillEntry[]` with per-bot enabled status, returns `{ skills }`.
   - `PUT /api/skills/:botId/:skillName`: calls `setMcpServerEnabled`, returns updated `SkillEntry`.

3. **`skills.test.ts`**:
   - `getMcpServers` returns all primary servers with correct `enabled` per bot.
   - `setMcpServerEnabled(botId, name, false)` removes entry from managed config file.
   - `setMcpServerEnabled(botId, name, true)` restores entry from primary.
   - `setMcpServerEnabled` on primary bot throws.

**Validation**:
- `pnpm --filter @orbit/server test` passes.
- `pnpm typecheck` passes.
- Manual: `curl http://localhost:8787/api/skills` returns `{ skills: [...] }`.

---

## Phase 2A — Auth Settings UI

**Goal**: Build the `EngineAuthPanel` component and wire it into App Settings.

**Depends on**: Phase 0, Phase 1A, Phase 1B

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Phase 1A added the Engine Auth API endpoints. Phase 1B added the NavRail/SectionPanel shell. Read `apps/web/src/components/config/AppSettings.tsx`, `apps/web/src/components/EngineSettings.tsx`, `apps/web/src/lib/configApi.ts`. Build the `EngineAuthPanel` component and add it to App Settings. Do not modify NavRail or SectionPanel.

**Files owned**:
- `apps/web/src/components/config/EngineAuthPanel.tsx` (new)
- `apps/web/src/components/config/AppSettings.tsx`
- `apps/web/src/lib/configApi.ts`
- `apps/web/src/__tests__/EngineAuthPanel.test.tsx` (new)

**Tasks**:

1. **`configApi.ts`**: Add `engineAuth()`, `setEngineAuth(botId, patch)`, `syncEngineAuth()`.

2. **`EngineAuthPanel.tsx`**: Build the per-bot table component (see implementation_plan.md §1.6 for full spec). Handle loading/error/empty states.

3. **`AppSettings.tsx`**: Add "Engine Auth" section rendering `<EngineAuthPanel />`. Place after existing Engine section.

4. **`EngineAuthPanel.test.tsx`**: Test renders table, warning badge for no-key rows, Sync All calls API.

5. **`CreateBotModal.tsx`** update: after bot creation succeeds, call `configApi.syncEngineAuth()` in background (fire-and-forget, do not block the modal close).

**Validation**:
- `pnpm --filter @orbit/web test` passes.
- `pnpm typecheck` passes.
- Manual: Open App Settings → Engine Auth section shows all bots with provider/model/credential status.

---

## Phase 2B — Chat List View + Bot-to-Bot Cascade

**Goal**: Two parallel sub-tasks — (1) the `ChatListView` UI with New Bot and New Group buttons, and (2) the server-side bot-to-bot @mention cascade in group chats. These two sub-tasks own completely different files and can be assigned to two subagents within the same phase.

**Depends on**: Phase 0, Phase 1B (for UI sub-task)

---

### Phase 2B-UI — ChatListView

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Phase 1B extracted `BotRow` to `BotRow.tsx` and created the `SectionPanel` shell with placeholder content. Build `ChatListView`. It reuses existing `BotRow`, `useStore` data, and existing modals — no new API needed. See implementation_plan.md §2c-i and §2c-ii for full spec.

**Files owned**:
- `apps/web/src/components/ChatListView.tsx` (new)
- `apps/web/src/components/modals/CreateGroupModal.tsx` (enhance — add model labels, update subtitle)
- `apps/web/src/components/SectionPanel.tsx` (update chat case only)
- `apps/web/src/__tests__/ChatListView.test.tsx` (new)

**Tasks**:

1. **`ChatListView.tsx`**: Combined bot + group list sorted by `lastActivityAt`. Groups display overlapping bot avatars. Inline search filter. Header action bar: "New Bot" button (opens `CreateBotModal`) and "New Group" button (opens `CreateGroupModal`). Primary bot pinned at top with separator.

2. **`CreateGroupModal.tsx`**: Add explanatory subtitle about bot collaboration. Show each bot's `model`/`provider` label beneath their name in the picker. Update @mention hint in `MembersCard` footer text.

3. **`SectionPanel.tsx`**: Replace chat section placeholder with `<ChatListView />`.

4. **`ChatListView.test.tsx`**: Combined list renders bots + groups sorted by recency. Group rows show group avatar. Search filters by name. "New Bot" and "New Group" buttons trigger correct modals.

**Validation**:
- Clicking Chat in nav rail shows combined list with groups and bots.
- "New Group" button opens CreateGroupModal with updated subtitle and model labels.
- Creating a group immediately selects it.
- Search input filters in real time.
- `pnpm --filter @orbit/web test` passes.

---

### Phase 2B-Server — Bot-to-Bot Cascade

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/server/src/agent/rooms.ts` in full — this is the only file you'll heavily edit. Also read `apps/server/src/mcp.ts` (or `agent/tools.ts`) to find where `post_to_group` and `postToRoom` are called, so you can update that call site. See implementation_plan.md §2c-iii for the complete design spec including the depth-limiting table and loop-prevention rules.

**Files owned**:
- `apps/server/src/agent/rooms.ts`
- `apps/server/src/mcp.ts` or `apps/server/src/agent/tools.ts` (update `post_to_group` call site only)
- `apps/server/src/__tests__/rooms-cascade.test.ts` (new)

**Tasks**:

1. **`rooms.ts`**: Add `MAX_BOT_CHAIN_DEPTH = 3` constant.

2. **`rooms.ts`**: Add `dispatchBotMentions(roomId, fromBotId, text, depth, enqueue)`:
   - If `depth >= MAX_BOT_CHAIN_DEPTH` → return immediately.
   - Load room members excluding `fromBotId`.
   - Parse `text` for `@BotName` patterns (case-insensitive) matching any member name.
   - For each uniquely matched member: call `enqueue(botId, buildGroupTurn(roomId, depth + 1, { mentioned: true }))`.
   - Multiple @mentions in one message → all dispatched simultaneously (not sequentially).

3. **`rooms.ts`**: Add `buildGroupTurn(roomId, depth, opts)` helper that produces the system turn object:
   - Includes group name, full member list, recent 20 messages (up from current 12).
   - Instructs bot to call `post_to_group` to reply or `stay_silent` to skip.
   - If `depth >= MAX_BOT_CHAIN_DEPTH - 1`: adds "near chain limit — wrap up your contribution" instruction.
   - Passes `_groupDepth: depth` in turn metadata.

4. **`rooms.ts`**: Update `postToRoom()` signature to accept `depth` and `enqueue`. After `appendRow`, call `dispatchBotMentions(roomId, fromBotId, text, depth, enqueue)`.

5. **`rooms.ts`**: Update `dispatchRoomMessage()` to use `buildGroupTurn` for consistency and pass `depth=0`.

6. **MCP / tools call site**: Update the `post_to_group` tool handler to pass `depth` (read from `_groupDepth` in turn metadata, default `0`) and `enqueue` to `postToRoom`.

7. **`rooms-cascade.test.ts`**:
   - `dispatchBotMentions` with `@BotName` matching a member → enqueue called with that bot.
   - `depth >= MAX_BOT_CHAIN_DEPTH` → enqueue never called.
   - Self-mention (`@fromBotName`) → ignored.
   - @mention of non-member → ignored.
   - Multiple @mentions → all dispatched.
   - Duplicate @mentions of same bot → dispatched only once.

**Validation**:
- `pnpm --filter @orbit/server test` passes (new + existing room tests).
- `pnpm typecheck` passes.
- Manual: Create a 2-bot group. User sends "What's the weather?". Bot A replies "@BotB what do you think?". Bot B automatically responds in the same thread without another user message.
- Manual: Bot-to-bot chain stops after 3 hops.

---

## Phase 2C — Activity View

**Goal**: Implement the Activity section showing a cross-bot activity feed.

**Depends on**: Phase 0, Phase 1B

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Phase 1B created the SectionPanel shell. Read `apps/web/src/store.ts` and `apps/web/src/lib/events.ts` to understand the SSE event handling. Add `recentActivity: ActivityItem[]` to the store, populate it from SSE, and build `ActivityView`.

**Files owned**:
- `apps/web/src/components/ActivityView.tsx` (new)
- `apps/web/src/store.ts` (add `recentActivity` state + SSE handler)
- `apps/web/src/components/SectionPanel.tsx` (update activity case only)
- `apps/web/src/__tests__/ActivityView.test.tsx` (new)

**Tasks**:

1. **`store.ts`**: Add `recentActivity: ActivityItem[]` (max 200). In SSE event handler: on `message` row creation for any bot → prepend to `recentActivity`; on `card` row → prepend with `kind='card'`. Deduplicate by `botId+seq`.

2. **`ActivityView.tsx`**: Renders activity items sorted by recency. Clicking item selects bot and switches to chat nav section. Unread count badge on NavRail Activity icon = `bots.reduce((n, b) => n + b.unread, 0)`.

3. **`SectionPanel.tsx`**: Update activity case to render `<ActivityView />`.

4. **`ActivityView.test.tsx`**: Items sorted by time. Clicking item calls selectBot and sets navSection to 'chat'.

**Validation**:
- Clicking Activity in nav rail shows cross-bot feed.
- New messages appear in real time.
- `pnpm --filter @orbit/web test` passes.

---

## Phase 2D — Calendar UI

**Goal**: Build the full calendar view using FullCalendar, wired to the Phase 1C API.

**Depends on**: Phase 0, Phase 1B, Phase 1C

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Phase 1C added `GET /api/calendar` and extended routines. Phase 1B created SectionPanel. Install `@fullcalendar/react`, `@fullcalendar/daygrid`, `@fullcalendar/timegrid`, `@fullcalendar/interaction` as dependencies of `@orbit/web`. Build the CalendarView component.

**Files owned**:
- `apps/web/src/components/CalendarView.tsx` (new)
- `apps/web/src/components/modals/CreateCalendarEventModal.tsx` (new)
- `apps/web/src/lib/api.ts` (add `getCalendar`, `createRoutine` calendar overload)
- `apps/web/src/components/SectionPanel.tsx` (update calendar case only)
- `apps/web/src/__tests__/CalendarView.test.tsx` (new)
- `apps/web/package.json` (add fullcalendar deps)

**Tasks**:

1. **`package.json`**: Add `@fullcalendar/react`, `@fullcalendar/daygrid`, `@fullcalendar/timegrid`, `@fullcalendar/interaction` as dependencies.

2. **`api.ts`**: Add `getCalendar(from: string, to: string)` → `GET /api/calendar?from=&to=`.

3. **`CalendarView.tsx`**: FullCalendar component:
   - Month / Week / Day view toggle.
   - Events colored by bot (use `botVars` from `lib/colors.ts`).
   - Event click → popover with event title, bot name, prompt preview, edit/delete buttons.
   - Date slot click → opens `CreateCalendarEventModal` with the clicked date pre-filled.
   - Completed one-time events rendered in grey.

4. **`CreateCalendarEventModal.tsx`**: Form with title, assigned bot dropdown, prompt textarea, event type radio (One-time / Recurring), date/time picker (one-time) or cron preset selector (recurring). Submit calls `POST /api/routines`.

5. **`SectionPanel.tsx`**: Update calendar case to render `<CalendarView />`.

6. **`CalendarView.test.tsx`**: Renders without crash with mocked API data. Create event modal opens on slot click. Month/week/day toggle changes view.

**Validation**:
- Clicking Calendar in nav rail shows the FullCalendar UI.
- Creating a one-time event appears on the calendar on the correct date.
- Creating a recurring event appears on correct days.
- `pnpm --filter @orbit/web test` passes.

---

## Phase 2E — Files UI

**Goal**: Build the Files section view wired to the Phase 1D API.

**Depends on**: Phase 0, Phase 1B, Phase 1D

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Phase 1D added `GET /api/files`. Phase 1B created SectionPanel. Build `FilesView`. Reuse the existing `ImageViewer` component for image preview.

**Files owned**:
- `apps/web/src/components/FilesView.tsx` (new)
- `apps/web/src/lib/api.ts` (add `getFiles` function)
- `apps/web/src/components/SectionPanel.tsx` (update files case only)
- `apps/web/src/__tests__/FilesView.test.tsx` (new)

**Tasks**:

1. **`api.ts`**: Add `getFiles(opts?)` → `GET /api/files`.

2. **`FilesView.tsx`**: Filter bar (search, bot dropdown, type tabs: All/Library/Attachments/Workspace), file grid/list, pagination (load more). File item: icon by mediaType, filename, bot avatar, size, date. Click image → `ImageViewer`. Click other → download. Grid/list toggle.

3. **`SectionPanel.tsx`**: Update files case to `<FilesView />`.

4. **`FilesView.test.tsx`**: Renders files from mocked API. Type filter tab updates displayed files. Search input filters.

**Validation**:
- Clicking Files in nav rail shows aggregated file browser.
- Filter tabs work correctly.
- Image files open in ImageViewer.
- `pnpm --filter @orbit/web test` passes.

---

## Phase 2F — Computers UI

**Goal**: Build the Computers section view wired to the Phase 1E API.

**Depends on**: Phase 0, Phase 1B, Phase 1E

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Phase 1E added `GET /api/computers`. Phase 1B created SectionPanel. Reuse the existing `ComputerViewer` / `ComputerScreen` component for mini VNC previews. Build `ComputersView` and `ComputerCard`.

**Files owned**:
- `apps/web/src/components/ComputersView.tsx` (new)
- `apps/web/src/components/ComputerCard.tsx` (new)
- `apps/web/src/lib/api.ts` (add `getComputers` function)
- `apps/web/src/components/SectionPanel.tsx` (update computers case only)
- `apps/web/src/__tests__/ComputersView.test.tsx` (new)

**Tasks**:

1. **`api.ts`**: Add `getComputers()` → `GET /api/computers`.

2. **`ComputerCard.tsx`**: Bot avatar + name, status badge (colour-coded), mini `<ComputerScreen>` in `watch` mode, "Open" button (sets `viewerOpen` for that bot), "Wake"/"Sleep" button for Docker computers.

3. **`ComputersView.tsx`**: Responsive grid of `ComputerCard` components. Empty state when no computers are running.

4. **`SectionPanel.tsx`**: Update computers case to `<ComputersView />`.

5. **`ComputersView.test.tsx`**: Renders cards from mocked API. Empty state renders when list is empty. Open button sets viewerOpen.

**Validation**:
- Clicking Computers in nav rail shows a grid of bot computer cards.
- Cards show correct status badges.
- Open button opens the VNC viewer for that bot.
- `pnpm --filter @orbit/web test` passes.

---

## Phase 2G — Skills UI

**Goal**: Build the Skills section view wired to the Phase 1F API.

**Depends on**: Phase 0, Phase 1B, Phase 1F

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Phase 1F added the Skills API endpoints. Phase 1B created SectionPanel. Build `SkillsView` with a list + detail panel layout.

**Files owned**:
- `apps/web/src/components/SkillsView.tsx` (new)
- `apps/web/src/lib/api.ts` (add `getSkills`, `setSkillEnabled` functions)
- `apps/web/src/components/SectionPanel.tsx` (update skills case only)
- `apps/web/src/__tests__/SkillsView.test.tsx` (new)

**Tasks**:

1. **`api.ts`**: Add `getSkills()` → `GET /api/skills`. Add `setSkillEnabled(botId, skillName, enabled)` → `PUT /api/skills/:botId/:skillName`.

2. **`SkillsView.tsx`**: Two-panel layout: skill list on left, detail panel on right. List: skill name, type badge, bot-enabled count. Detail: skill metadata, per-bot toggle list (primary always enabled, non-editable). Optimistic UI updates on toggle.

3. **`SectionPanel.tsx`**: Update skills case to `<SkillsView />`.

4. **`SkillsView.test.tsx`**: Renders skill list. Clicking skill shows detail. Toggle calls API. Primary bot shown as non-editable.

**Validation**:
- Clicking Skills shows skill list.
- Toggling a skill for a managed bot calls the API and updates UI optimistically.
- Primary bot entry is not editable.
- `pnpm --filter @orbit/web test` passes.

---

## Phase 3 — Right Panel Enhancement + Calls Placeholder

**Goal**: Restyle the DetailsPanel to match the Teams design language. Add Engine as a dedicated tab. Add Calls placeholder. This phase is the last web-only phase.

**Depends on**: Phase 2A through Phase 2G (all UI phases complete)

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `apps/web/src/components/DetailsPanel.tsx` and `apps/web/src/styles/details.css`. All section views are now complete. Restyle the DetailsPanel and add the Calls placeholder. Do not break any existing functionality.

**Files owned**:
- `apps/web/src/components/DetailsPanel.tsx`
- `apps/web/src/components/CallsView.tsx` (new placeholder)
- `apps/web/src/components/config/BotSettingsModal.tsx`
- `apps/web/src/styles/details.css`
- `apps/web/src/components/SectionPanel.tsx` (update calls case only)

**Tasks**:

1. **`DetailsPanel.tsx`**: Add "Engine" tab. Tabs are now: Screen, Activity, Tasks, Library, Engine. Move `EngineSettings` out of the footer scrollable area into the Engine tab content. Restyle tab bar: underline indicator style.

2. **`BotSettingsModal.tsx`**: Add "Manage Credentials →" link in the Engine section that programmatically opens App Settings and navigates to Engine Auth panel.

3. **`details.css`**: Add `.details-tabs`, `.details-tab`, `.details-tab.is-active` (underline indicator), `.engine-tab-panel`.

4. **`CallsView.tsx`**: Placeholder with descriptive text and voice button instructions.

5. **`SectionPanel.tsx`**: Update calls case to `<CallsView />`.

**Validation**:
- DetailsPanel shows 5 tabs: Screen, Activity, Tasks, Library, Engine.
- Clicking Engine tab shows EngineSettings content.
- Clicking Calls in nav rail shows the placeholder.
- No regression in existing bot management flows.
- `pnpm typecheck` passes.

---

## Phase 4 — Mobile App Parity

**Goal**: Add equivalent Expo screens for Activity, Calendar, Files, Computers, Skills in the mobile app. Bottom-tab navigation matches Teams sections.

**Depends on**: Phase 1A through Phase 1F (all server APIs done), Phase 3 (design decisions finalised)

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app/apps/mobile`. Read `app.json`, `app.config.ts`, the existing screen files in `app/`, and `apps/mobile/package.json`. All required server endpoints already exist. Build Expo screens using the same API endpoints. Use `react-native-calendars` for the Calendar screen and `expo-sharing` for file sharing. The mobile app uses Expo Router with file-based routing.

**Files owned**:
- `apps/mobile/app/(tabs)/activity.tsx` (new)
- `apps/mobile/app/(tabs)/calendar.tsx` (new)
- `apps/mobile/app/(tabs)/files.tsx` (new)
- `apps/mobile/app/(tabs)/computers.tsx` (new)
- `apps/mobile/app/(tabs)/more.tsx` (new — Skills + Settings)
- `apps/mobile/app/skills/index.tsx` (new)
- `apps/mobile/components/CalendarEventModal.tsx` (new)
- `apps/mobile/components/FileRow.tsx` (new)
- `apps/mobile/components/ComputerCard.native.tsx` (new)
- `apps/mobile/package.json` (add react-native-calendars, expo-sharing)

**Tasks**:

1. **`package.json`**: Add `react-native-calendars`, `expo-sharing`.

2. Restructure existing `app/` into `app/(tabs)/` layout (Expo Router tab group) if not already done. Add tab bar with icons for Activity, Chat, Calendar, Files, Computers, More.

3. **`activity.tsx`**: FlatList of ActivityItem (fetched from `GET /api/events` SSE stream — reuse existing SSE hook). Tap → navigate to bot chat.

4. **`calendar.tsx`**: `react-native-calendars` month view. Fetch from `GET /api/calendar`. Tap event → event detail bottom sheet. Tap empty day → `CalendarEventModal`.

5. **`files.tsx`**: FlatList with `FileRow` component. Filter tabs (All/Library/Attachments/Workspace). Tap image → full screen. Tap other → `expo-sharing`.

6. **`computers.tsx`**: ScrollView of `ComputerCard.native.tsx`. Tap → full-screen WebView VNC viewer (existing mobile VNC pattern).

7. **`more.tsx`**: Settings link, Skills link, Calls placeholder.

8. **`skills/index.tsx`**: List of skills. Toggle per managed bot (same API).

**Validation**:
- `cd apps/mobile && npx expo start` starts without errors.
- All 5 new tab screens navigate and render basic content.
- `pnpm typecheck` passes for mobile.
- Calendar: creating an event from mobile appears in the web Calendar view.

---

## Phase 5 — Integration Tests + Polish

**Goal**: Write end-to-end API tests, verify the full user flows, fix any regressions, and document the e2e checklist.

**Depends on**: All prior phases

**Subagent context**:
> Working directory: `/Users/raybello/Github/Orbit/orbit-app`. Read `tests/e2e.mjs` and `scripts/smoke-server.mjs`. All features are now implemented. Add API smoke tests for each new endpoint, run the full test suite, and fix any failures.

**Files owned**:
- `tests/e2e.mjs`
- `docs/e2e-checklist.md` (new)

**Tasks**:

1. **`tests/e2e.mjs`**: Add smoke checks for:
   - `GET /api/config/engine-auth` → 200, `bots` array non-empty.
   - `POST /api/config/engine-auth/sync` → 200, `synced` ≥ 0.
   - `GET /api/calendar?from=2026-01-01&to=2026-12-31` → 200, `events` array.
   - `GET /api/files` → 200, `files` array, `total` ≥ 0.
   - `GET /api/computers` → 200, `computers` array.
   - `GET /api/skills` → 200, `skills` array.
   - `PUT /api/skills/:managedBotId/:skillName` with `{ enabled: false }` → 200.
   - Group chat bot-to-bot cascade: create a 2-bot room, mock a `post_to_group` call with `@BotName` → verify second bot is enqueued at depth 1.

2. Run `pnpm smoke` — fix any failures.

3. Run `pnpm test` across all packages — fix any failures.

4. Run `pnpm typecheck` — fix any failures.

5. **`docs/e2e-checklist.md`**: Document the 6 manual verification flows from implementation_plan.md §Test Strategy.

**Validation**:
- `pnpm smoke` exits 0.
- `pnpm test` exits 0 (all packages).
- `pnpm typecheck` exits 0.
- e2e-checklist.md exists and covers all 6 flows.

---

## Parallel Execution Summary

| Group | Phases | Can run simultaneously |
|-------|--------|----------------------|
| Foundation | 0 | — |
| Backend | 1A, 1B, 1C, 1D, 1E, 1F | All 6 in parallel |
| UI + Server | 2A, 2B-UI, 2B-Server, 2C, 2D, 2E, 2F, 2G | All 8 in parallel (each owns distinct files) |
| Polish | 3 | After all Phase 2 |
| Mobile | 4 | After all Phase 1 + Phase 3 |
| QA | 5 | After Phase 4 |

**Maximum concurrency**: 8 subagents in Phase 2 — Phase 2B is split into a UI sub-task and a server sub-task that share no files and can run in parallel.

**Critical path**: Phase 0 → Phase 1B → Phase 2B-UI/2C → Phase 3 → Phase 4 → Phase 5 (longest chain, ~6 sequential steps).
