# Workspace approvals, Google Calendar sync and bot capability context

Branch: `feat/workspace-approvals` (cut from `main` at `7268fab`). One PR at the end.
Scope decisions: the answers to the 27 scoping questions (2026-11-17), summarised in the table below.

## Decisions this plan builds on

| Area | Decision |
|---|---|
| Google backend | Composio only. `google-oauth.ts` and everything that serves it is deleted (Q1). |
| Clients | Web, desktop (same renderer) and mobile all get the new cards and calendar features (Q2). |
| Email | Draft first: the bot creates a real Gmail draft without asking; the Email card edits it inline and sends it. Every send asks; no "Always allow" for sends. Reads stay as activity lines (Q4–Q7). |
| Calendar actions | Event card edits title, date, start/end, all-day, timezone, location, description, attendees, Meet link. Recurring events ask "this event / this and following / all". "Notify guests" toggle, on by default (Q8–Q10). |
| Sync | Stored mirror of the calendars you pick (primary on by default), refreshed every 5 min and when the calendar opens; window 30 days back, 90 ahead; `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS`. **Encrypted at rest** (Q11–Q12). |
| Two-way | Google events can be created, edited and deleted from the Orbit calendar through the same event editor and a confirm step. "New event" offers Google event (no bot) or Orbit event (bound to a bot) (Q13). |
| Bot access | `calendar_list` app tool returns Google and Orbit events merged (Q14). |
| Display | Google: outlined, true duration, calendar colour. Orbit: filled, bot colour. Linked Orbit events show a chip naming the parent. Filters for Google and each bot (Q15). |
| Duplicate | Bot picker (primary preselected); prefilled editable prompt; same time by default plus presets (15 min before, 1 h before, 9:00 the day before); one-time follows the parent's moves, a cancel pauses it with a notice; a recurring parent duplicates its clicked occurrence, with a switch to recurring when the RRULE maps to cron (Q16–Q20). |
| Sheets and Docs | Approval cards with previews (cell before → after grid; doc text inserted/replaced) and a result card (title, link, short preview). New files run without asking; edits and deletes to existing files ask (Q21–Q22). |
| Context | App prompt rewritten as a capability manifest; a short version in the `hq` MCP server's `instructions` so the primary Hermes bot sees it on every channel (Q23–Q24). |
| Validation | Mocked-Composio tests (server: the repo's `tsx --test` runner; web: vitest) plus a live scripted eval on a dedicated test Google account, covering the primary Hermes bot and one managed bot on its default model (Q25–Q27). |

## How every phase ends (the checkpoint)

A phase is committed only when all of these pass, in this order. A failure stops the phase; it is fixed in the same phase, never carried forward.

1. `pnpm typecheck` at the repo root.
2. `pnpm --filter @orbit/server test` and `pnpm --filter @orbit/web test` (plus the mobile typecheck once mobile is touched).
3. The phase's own gate (listed per phase): new tests named, and any live check against the test Google account.
4. `pnpm build && pnpm smoke` from phase 3 on (anything that changes routes).
5. A review pass of the phase's diff (`/code-review` at medium) with findings fixed or explicitly recorded in the PR body.
6. One commit per phase, message `feat(workspace): <phase title>`. Nothing is pushed until phase 12.

Live checks never touch your main Google account. They use the dedicated test account, connected to a separate Orbit user on the dev stack.

---

## Phase 0: Ground truth from Composio (no product code)

Learn the real request and response shapes before writing code that depends on them.

- Connect the test Google account (Gmail, Calendar, Sheets, Docs) to a dev Orbit user.
- Script `scripts/composio-shapes.mjs`: calls each slug the plan relies on with safe inputs against the test account and writes the redacted responses to `apps/server/src/__tests__/fixtures/composio/*.json`. Writes are made only on throwaway items it creates and then deletes.
- Slugs: `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_GET_DRAFT`, `GMAIL_UPDATE_DRAFT`, `GMAIL_SEND_DRAFT`, `GMAIL_DELETE_DRAFT`, `GMAIL_SEND_EMAIL`, `GMAIL_REPLY_TO_THREAD`; `GOOGLECALENDAR_LIST_CALENDARS`, `EVENTS_LIST_ALL_CALENDARS`, `EVENTS_GET`, `EVENTS_INSTANCES`, `CREATE_EVENT`, `UPDATE_EVENT`, `PATCH_EVENT`, `DELETE_EVENT`, `QUICK_ADD`, `REMOVE_ATTENDEE`; `GOOGLESHEETS_CREATE_GOOGLE_SHEET1`, `VALUES_GET`, `VALUES_UPDATE`, `SPREADSHEETS_VALUES_APPEND`, `UPDATE_VALUES_BATCH`, `BATCH_UPDATE`; `GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN`, `GET_DOCUMENT_PLAINTEXT`, `INSERT_TEXT_ACTION`, `REPLACE_ALL_TEXT`, `UPDATE_DOCUMENT_MARKDOWN`.
- Also confirm: how `COMPOSIO_MULTI_EXECUTE_TOOL` nests args (`tools[].tool_slug` / `tool_params`); whether the server can run one slug directly for a user (`composio.tools.execute`) outside the tool-router session; how `sendUpdates`, recurring-instance ids and Meet `conferenceData` are passed.

**Gate:** fixtures exist for every slug above; a short `docs/plans/composio-shapes.md` records anything that differs from this plan, and the plan is amended before phase 1.

**Done 2026-11-18.** 38/39 calls succeeded; findings in [composio-shapes.md](composio-shapes.md). The amendments are marked *(phase 0)* in the phases below.

## Phase 1: Remove the direct Google OAuth path

- Delete `apps/server/src/google-oauth.ts`; remove `/api/google/*` in `routes.ts`, `googleClientId`/`googleClientSecret` in `env.ts`, `googleStatus`/`googleConnect` in `web/src/lib/api.ts`, `GOOGLE_CLIENT_*` from `.env.example` and both compose env examples, and the setup steps in `docs/setup.html`, `guide.html`, `source.html`.
- Migration in `db.ts`: for every stored row, try Google's revoke endpoint once (best effort, logged), then drop `google_oauth_states` and the token table.
- Sign-in through Composio (`/auth/google/*`) is unchanged.

**Gate:** `grep -ri 'google-oauth\|GOOGLE_CLIENT\|googleConnect'` finds nothing outside the changelog; a test opens a database that has the old tables and checks they are gone after migration; sign-in smoke still passes.

## Phase 2: Action catalogue and policy

Replace the name regex with an explicit table for the four Google toolkits.

- New `apps/server/src/domain/google-actions.ts`: for each slug, its toolkit, kind (`read`, `auto`, `review`) and review card (`email`, `event`, `sheet`, `doc`). `auto` = runs without a card: `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_UPDATE_DRAFT`, `GMAIL_WHO_AM_I`, `GOOGLESHEETS_CREATE_GOOGLE_SHEET1`, `GOOGLEDOCS_CREATE_DOCUMENT*`. Sends, every calendar write, every edit or delete of an existing sheet or doc are `review`. `GOOGLESHEETS_EXECUTE_SQL`: a single `SELECT` runs, anything else is `review` *(phase 0)*. *(Done in phase 2 as a strict static check, so the approval gate makes no network call; phase 6 uses `dry_run` only to describe the change on the card.)* Sheets and Docs have no file delete, so "delete" means content: `DELETE_SHEET`, `DELETE_DIMENSION`, `CLEAR_VALUES`, `DELETE_CONTENT_RANGE`, `DELETE_TAB` and the like are `review` *(phase 0)*. Each entry records the action's exact argument names, since casing varies (`spreadsheetId` vs `spreadsheet_id`).
- `policyFor` (`agent/tools.ts`) consults the table first and falls back to the regex for other toolkits. Send-type slugs refuse `always_allow`: the stored policy is ignored and the card hides the button.
- Rules (`rule-service.ts`) keep working: the stricter of rule and table wins, as today.

**Gate:** table-driven unit tests over every slug in the catalogue (kind, card, and that `always_allow` on `GMAIL_SEND_DRAFT` still asks); the existing `rules*.test.ts` pass unchanged.

## Phase 3: Review cards that can edit what runs

The core mechanism every custom card uses.

- Contracts (`packages/contracts`): new card bodies `email`, `event`, `sheet`, `doc`. Each carries `approvalId`, the editable fields, read-only context (for example the current event before a change), and status `pending | approved | declined | expired | failed`. The unused `draft` card is replaced by `email`; the dev fixtures move with it.
- `requestApproval` grows a review path: for a `review` slug it builds the card from the args (plus a read of current state where the card shows "before": `EVENTS_GET`, `GET_DRAFT`, `VALUES_GET`, `GET_DOCUMENT_PLAINTEXT`).
- `POST /api/approvals/:id` accepts `{ decision, edits? }`. Edits are validated against a zod schema per card kind and merged into the inner `tool_params` of that one call in the `MULTI_EXECUTE` args. The result the bot gets says what changed ("Sent with your edits: subject changed to …").
- Patching reads and writes either `arguments` (the documented key) or `tool_params` (accepted by the router), whichever the bot sent *(phase 0)*.
- `runComposioTool` checks each inner result's `successful` flag; today a router call with failed inner calls is reported as done and the connection watch never hears about it *(phase 0)*.
- `composio.ts` gains `runAction(userId, slug, args)` for calls the server makes itself, with toolkit versions pinned to `20261116_00` in one constant *(phase 0)*.
- A `MULTI_EXECUTE` call that holds several review slugs gets one card per slug, shown together; each is decided on its own, and only the approved ones run.
- Editing extends the wait: the card reports "editing" and the 25-minute timer restarts on each save, capped at 2 hours.
- `card-workflow.ts` gains the new kinds and transitions; `card-service.ts` maps them.

**Gate:** card-workflow tests for every legal and illegal move of the four kinds; an API test that approves with edits and asserts the exact args handed to a mocked `executeComposio`; a test that a malformed edit is a 400 and nothing runs.

## Phase 4: Email, draft first

- After `GMAIL_CREATE_EMAIL_DRAFT` (or `UPDATE_DRAFT`) runs, the server posts an Email card in `pending` with the draft's id, to, cc, bcc, subject and body (from the result, or `GET_DRAFT`). The tool result tells the bot: the draft is in front of the user; do not send it yourself.
- Send from the card: `GMAIL_UPDATE_DRAFT` with the edits when there are any, then `GMAIL_SEND_DRAFT`, run by the server. The bot is told the outcome through its queue as a short system line, the way card answers are today. Discard runs `GMAIL_DELETE_DRAFT`.
- If the bot calls `GMAIL_SEND_EMAIL`, `REPLY_TO_THREAD` or `SEND_DRAFT` itself, the same Email card intercepts the call (phase 3 path).
- Web: `EmailCard` in `Cards.tsx` with read and edit modes (recipient chips, subject, body textarea with plain/HTML indicator), Send, Discard, Save draft.

**Gate:** server tests with mocked Composio for: create → card → edit → send; create → discard; direct `SEND_EMAIL` intercepted; a declined send returns the refusal text. Web vitest for the card's edit/send/discard states. Live: on the test account, draft → edit → send lands in the test inbox with the edited subject.

## Phase 5: Calendar event cards

- Event card for `CREATE_EVENT`, `QUICK_ADD`, `UPDATE_EVENT`, `PATCH_EVENT`, `DELETE_EVENT`, `REMOVE_ATTENDEE`. Fields as decided; delete shows the event read-only with a destructive button.
- *(phase 0)* `UPDATE_EVENT` replaces the whole event and drops attendees, location and description. Every change runs as `PATCH_EVENT` with only the changed fields; a bot's `UPDATE_EVENT` is shown as the current event plus its changes and run as a patch.
- *(phase 0)* One field model, mapped per action: create uses `start_datetime` + `event_duration_minutes`/`end_datetime` and `create_meeting_room`; patch uses `start_time`/`end_time` and `conference_data`. A `readEvent(data)` normaliser handles the four response wrappers (`data.response_data`, `data`, `data.event`, `data.items[]`).
- Recurring scope: "this event" acts on the instance id; "all" on the series; "this and following" ends the series the day before (RRULE `UNTIL`) and creates a new series from the clicked instance with the edits. This last one is two calls; if the second fails, the first is rolled back and the card reports `failed`.
- Notify guests: toggle maps to `sendUpdates: all | none`, shown only when there are attendees.
- Meet link: a toggle that adds or removes `conferenceData`.
- Shared `EventEditor` component (web), reused by the calendar page in phase 8.

**Gate:** mocked tests for each slug, each recurring scope (including the rollback), and the guest toggle; `readEvent` over every calendar fixture; a test that a bot's `UPDATE_EVENT` keeps the attendees. Live: create, move, change one instance of a weekly series, change "this and following", delete; then read back with `EVENTS_LIST_ALL_CALENDARS` and assert.

## Phase 6: Sheets and Docs cards

- Sheet card: for value writes (`VALUES_UPDATE`, `VALUES_APPEND`, `UPDATE_VALUES_BATCH`, `BATCH_UPDATE`), a before → after grid of the affected range (capped at 20×10 cells with "and N more"). Structural changes (`ADD_SHEET`, `DELETE_SHEET`, `INSERT_DIMENSION`, `DELETE_DIMENSION`) and SQL writes (operation and row count from the dry run) are listed as plain sentences *(phase 0)*.
- Doc card: inserted or replacing text, shown with removed text struck through and added text highlighted; whole-document markdown updates show a line diff.
- Result card after any create or approved update: title, link to the file, and a 3-line preview.

**Gate:** mocked tests for the preview builders (grid diff, text diff, structural sentences) using phase 0 fixtures. Live: create a sheet (no card), append rows (card, approve), replace text in a doc (card with edits); read back and assert.

## Phase 7: Encrypted calendar mirror and sync

- Tables: `gcal_calendars` (user, calendar key, sealed calendar id, sealed name, colour, enabled, last sync) and `gcal_events` (user, calendar key, event key, start_ms, end_ms, all_day, status, recurring flag, sealed payload, payload hash, updated_at).
- **At rest:** everything that names or describes anything (calendar ids, which are often email addresses; titles; descriptions; locations; attendees; links) is sealed with `secretBox(DB_ENCRYPTION_KEY)` (AES-256-GCM, per-row context `gcal:<user>:<calendarKey>:<eventKey>`, so a row moved elsewhere fails to open). Keys are HMAC-SHA256 of the Google ids under a key derived from the same secret, so lookups never need plaintext. Only times, status and opaque keys stay in the clear. With no `DB_ENCRYPTION_KEY` the mirror is off and the calendar says why; it never falls back to plaintext.
- Sync worker (`calendar-sync.ts`): per user with Calendar connected, every 5 min and on `GET /api/calendar` when the last sync is over 60 s old (returns the stored view at once and pushes an SSE update when fresh data lands). Window: 30 days back, 90 ahead, `single_events: true`, `show_deleted: true`, `response_detail: 'full'` (the default returns only a summary) *(phase 0)*. Events gone from the window are marked removed, except on calendars listed in `errors_by_calendar`, whose rows are kept as they were. A failure backs off and never wipes the mirror.
- Settings: a Calendars list with on/off per calendar (primary on by default), on web and mobile.
- Disconnecting Calendar deletes the user's mirror rows.

**Gate:** tests that sealed rows decrypt only with the right key and context, that the DB file contains no event title or calendar id in plaintext (grep the SQLite file after a fixture sync), backoff on failure, removal detection, and disconnect cleanup. Live: a 5-minute window shows an event created directly in Google.

## Phase 8: One calendar for Google and Orbit events

- `GET /api/calendar` returns both kinds: `CalendarEvent` grows `source: 'google' | 'orbit'`, real end times for Google events, calendar colour, and for linked Orbit events the parent's title.
- Web and mobile calendars: Google outlined with true duration and calendar colour; Orbit filled in the bot colour; a parent chip on linked Orbit events; filter chips for Google and each bot.
- "New event" asks which kind. Google: the shared `EventEditor` and a calendar picker, no bot. Orbit: the existing routine dialog.
- Google events open in the editor (two-way): save or delete shows the same confirm summary the cards use, then runs through Composio directly (the user is acting, so no bot and no approval queue).
- `calendar_list` app tool (from, to, sources) reads the mirror for bots.

**Gate:** route tests for the merged response and filters; web vitest for rendering both kinds and the filters; `pnpm smoke` extended with a seeded mirror row. Live: create and delete a Google event from the Orbit calendar and confirm in Google.

## Phase 9: Duplicate a Google event as an Orbit event

- "Duplicate as Orbit event" on a Google event opens the routine dialog prefilled: title (editable), bot (primary preselected), the prompt template, one-time at the parent's start with the three presets, and a recurring switch when the parent is recurring and its RRULE maps to cron (DAILY, WEEKLY with BYDAY, MONTHLY by day of month; anything else keeps the switch off and says why).
- `routines` gains `parent_event_key`, `parent_offset_ms` and a sealed parent snapshot. The routine's run gets the parent's details (attendees, location, description, link) as context.
- Follow the parent: after each sync, a linked one-time routine whose parent moved is rescheduled to the new start plus its offset; if the parent is cancelled the routine is paused and the bot's chat gets a notice. Recurring duplicates are left alone and get a notice if the series changes.

**Gate:** tests for RRULE → cron (supported and refused cases), offset presets across DST, follow-on-move, pause-on-cancel. Live: duplicate an event with "15 min before", move the Google event, see the Orbit event move after the next sync.

## Phase 10: Capability manifest for every bot

- `agent/prompt.ts` rewritten into fixed sections: who you are; core capabilities (talk to the user and ask questions, work with other bots, your own computer: screen, browser, shell, screenshots; connected apps; schedules and routines; files and Library; saved logins); how approvals work (drafts and new files run, sends and edits wait for the user, a declined call is final); and a short action sheet **only for connected apps**, generated from the phase 2 catalogue (slug, required args, whether it waits). Adds the user's timezone (new `users.timezone`, set by the clients from the device). It stays free of the clock and byte-identical between turns unless something changed, so the prompt cache still holds.
- The `hq` MCP server's `initialize.instructions` carries a 15-line version, so Hermes sessions outside the app (iMessage, Telegram, cron) see the same rules.
- The verified slug list replaces the four hard-coded slugs, and the `MULTI_EXECUTE` example uses `arguments` *(phase 0)*. The Calendar sheet says to change events with `PATCH_EVENT`, never `UPDATE_EVENT`.

**Gate:** a snapshot test of the manifest for three set-ups (no apps, Gmail only, all four apps); a test that two builds with the same state are byte-identical; a size budget test (manifest under 6k tokens with all four apps).

## Phase 11: Mobile parity

- `app/thread/[botId].tsx`: Email, Event, Sheet and Doc cards with the same edit fields, built from the shared contracts.
- Calendar tab: both kinds, filters, Google event editor, duplicate dialog, calendar settings.

**Gate:** mobile typecheck; component tests where the mobile app has them; a manual run in the iOS Simulator covering draft edit → send and duplicate, with screenshots saved to `docs/evidence/`.

## Phase 12: Live eval, then the PR

- `scripts/eval-workspace.mjs` runs against a dev stack connected to the test account. For each of the two bots (primary Hermes, one managed bot on its default model) it sends scripted requests, waits for cards over SSE, decides them through the API (some with edits), and then checks Google directly:
  1. "Draft an email to <test inbox> about tomorrow's sync" → Email card → edit subject → send → the message arrives with the edited subject.
  2. "Put a 30-minute call with <test attendee> on my calendar tomorrow at 3pm" → Event card → approve → the event exists with that attendee.
  3. "Move it to 4pm" → card shows before/after → approve → moved.
  4. "Cancel it" → delete card → approve → gone, and a linked Orbit duplicate made earlier is paused.
  5. "Add these three rows to the Orbit Eval sheet" → Sheet card with grid → approve → rows present.
  6. "Write a one-page doc summarising this week" → no card (new file) → result card → doc exists.
  7. "What's on my calendar this week?" → the bot uses `calendar_list`, and its answer names the seeded events.
  8. A refusal: decline a send and check the bot does not retry.
- It cleans up the emails' drafts and every event it created. Sheets and Docs files stay in the test Drive (neither toolkit can delete a file) and are titled "Orbit eval …" *(phase 0)*. It writes `docs/evidence/workspace-eval-<date>.md`: per bot and step, pass or fail, the tool calls made, and the time taken.
- **Gate:** every step passes for both bots. A step that fails because a bot chose the wrong action is fixed in the manifest (phase 10) and the eval reruns; the PR is not opened on a partial pass.
- Then: update `docs/ARCHITECTURE.md` (Apps, Approvals, Data), push the branch, open the PR with the eval report and screenshots, and leave its "AI Disclosure" section blank.

---

## Risks to watch

- **Composio shapes drift.** Phase 0 fixtures pin them; a mismatch fails tests rather than production.
- **"This and following"** is two calls with no transaction on Google's side; the rollback path is tested explicitly.
- **Quota and rate limits.** One `EVENTS_LIST_ALL_CALENDARS` call per user every 5 minutes; the worker backs off and skips users with no enabled calendars.
- **Routine prompts stay plaintext.** The mirror is encrypted, but a duplicated routine's title and prompt are ordinary routine rows, as today. Sealing routines is a separate change if you want it.
- **Mobile editing.** Long email bodies and attendee lists need care on small screens; the simulator pass in phase 11 is the check.
