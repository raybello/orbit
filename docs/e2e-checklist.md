# End-to-end checklist

The six flows from `implementation_plan.md` → *Test Strategy → End-to-End Flow Tests*, written so a
person can actually run them, plus what automated coverage backs each one.

This file is the manual half of Phase 5. The automated half lives in:

| Where | Command | What it proves |
|---|---|---|
| `scripts/smoke-server.mjs` | `pnpm smoke` | Every endpoint the desktop/mobile clients use, against a real server on a temp DB and a free port |
| `apps/server/src/__tests__/` | `pnpm --filter @orbit/server test` | Routes, cron expansion, file aggregation, skill toggles, computer status mapping, bot-to-bot cascade |
| `apps/web/src/__tests__/` | `pnpm --filter @orbit/web test` | The views render and call the right API |
| `tests/e2e.mjs` | `node tests/e2e.mjs http://localhost:8787` | Playwright pass over the real stack (needs a live server, a real Hermes engine and a computer) |

`pnpm smoke` builds nothing — run `pnpm build` first. It binds its own port (default 8899, override
with `PORT=`) and a throwaway SQLite file, and never touches a running dev stack. A failed check
prints `expected:` / `actual:`, the differing JSON paths, and the server log tail, and exits 1.

## Before you start

Shared preconditions for all six flows:

1. The app is running on <http://localhost:8787> (`pnpm dev`), and you are signed in.
2. There is a **primary bot** (`Doug` by default) whose Hermes home (`~/.hermes`) has at least one
   model credential — an `*_API_KEY=` line in `~/.hermes/.env`, or a provider signed in through
   Bot settings → Engine.
3. **A managed bot exists** (a second bot; see flow 1). Managed bots run their own Hermes gateway on
   its own port, which needs the `hermes` CLI on `PATH` (or `HERMES_BIN` set).
4. Docker is running if your install puts each bot on its own computer (`COMPUTER_KIND=docker` or
   `auto`). Without it every bot's computer reads `Unknown` and flow 6 cannot be completed.

## Flow 1 — Create a managed bot, and it has credentials immediately

**Automated backing:** `apps/server/src/__tests__/engine-auth.test.ts` (sync copies and preserves
keys), `apps/web/src/__tests__/EngineAuthPanel.test.tsx` (table, key-count badge, Sync all),
`scripts/smoke-server.mjs` (`GET /api/config/engine-auth` rows and keys, `POST …/sync` reporting and
copying a rotated key).

**Preconditions:** the primary bot has a model key in its `.env` (see above).

**Steps**

1. In the Chat list, click **New Bot** (plus icon), type a name, click **Create**.
2. Wait for the new bot's chat to open. Its engine starts in the background; a first message may
   take a few seconds to answer while the gateway comes up.
3. Click your avatar (bottom of the nav rail) → **Settings** (⌘,) → **Engine Auth**.
4. Find the new bot's row. Press **Sync all** once and watch the row again.

**What to look for**

- The row exists with engine chip **Managed** (the primary row says **Primary** and *Follows the
  computer's own agent*).
- **Credentials** shows a `✓ n keys` chip — hover it to read the key names; it must list the same
  model key(s) the primary row lists (e.g. `DEEPSEEK_API_KEY`). `No credentials` in red is the
  failure this feature exists to prevent.
- Provider/Model are editable on the managed row, read-only on the primary row.
- After **Sync all**, the chip is unchanged (already in line) and no error appears.
- On disk: the bot's Hermes home under `ENGINES_DIR` (this install: `data/engines`, so
  `data/engines/<botId>/.env`) contains the same `DEEPSEEK_API_KEY=` value as `~/.hermes/.env`. This
  is the actual assertion; the UI only counts.
- Send the bot a message that needs the model (`Say hi in five words`). It answers — credential
  sharing works end to end.

## Flow 2 — A one-time calendar event appears, runs, and greys out

**Automated backing:** partially. `apps/server/src/__tests__/routines-calendar.test.ts` covers
storage, expansion, the run marking `completed_at` and stopping the schedule;
`apps/web/src/__tests__/CalendarView.test.tsx` covers rendering and the greyed-out completed pill;
`scripts/smoke-server.mjs` covers `POST /api/routines` → 201 and the event appearing in
`GET /api/calendar` for its window. **The "bot actually runs it" half is manual only** — it needs a
real Hermes gateway and an agent turn.

**Preconditions:** flow 1 done for the bot you assign; the server runs with its scheduler enabled (no
`GROKBOT_NO_SCHEDULER=1`); Docker/Hermes healthy.

**Steps**

1. Open **Calendar** in the nav rail. Click **New event** (top right) — or click a day cell, which
   pre-fills that date.
2. **Title**: `Dentist reminder`. **Assigned bot**: your managed bot. **Task / prompt**:
   `Remind me about the dentist appointment tomorrow at 9am.` **Event type**: **One-time**.
   **Date and time**: a few minutes ahead (or any past time — see step 5).
3. Click **Create event**.
4. Find the pill on the right day. Click it — the **Event details** popover shows the title, the bot,
   the local date/time, the prompt, and the tag **One-time**.
5. To avoid waiting for the clock: open **Bot settings** (bot name → gear) → **Routines** → press
   **Run now** on that event.

**What to look for**

- The pill appears exactly once, on the chosen day, with a clock badge (`aria-label="One-time event"`).
- After a run: the bot's chat shows an event row `Running routine: Dentist reminder` and the agent's
  answer to the prompt.
- Refresh the calendar. The pill is greyed out (`cal-pill is-completed`) and its popover now shows
  **Completed**. The event stays on the calendar instead of vanishing — that is deliberate.
- Bot settings → **Routines**: the one-time routine now reads paused/disabled.

## Flow 3 — A recurring event lands on the right days and can be changed or removed

**Automated backing:** `routines-calendar.test.ts` (cron expansion inside vs outside the window,
per-routine cap, `PATCH`/`DELETE` exist server-side), `CalendarView.test.tsx` (month/week/day
switching, create modal validation, recurring creation), `smoke-server.mjs` (creation + window
filtering). **Editing and deleting through the UI is manual only** — the calendar popover has no
edit/delete controls; the Routines panel does, and no automated test drives it.

**Preconditions:** as flow 2.

**Steps**

1. **Calendar** → **New event**. Title `Weekday standup`, your managed bot, a prompt such as
   `Post the standup notes.`, **Event type**: **Recurring**.
2. **Repeats**: pick `Weekdays at 9am` (or set **Cron expression** `0 9 * * 1-5`). Note the hint:
   `minute hour day-of-month month day-of-week`.
3. **Create event**. Move between months with the ‹ › arrows, and switch **Month / Week / Day**.
4. Click a pill: the popover shows `Repeats · 0 9 * * 1-5`, the bot, and the prompt.
5. Change it: **Bot settings → Routines** → pause the routine's switch (it reads **Paused**), then
   resume it. Delete it with the trash button (it asks to confirm).

**What to look for**

- Pills on Monday–Friday only, none on the weekend, one per weekday per week — five per week, not
  one per day of the whole month.
- A week view shows the same event at 09:00 each weekday; a day view shows only that day's.
- Pausing removes nothing from the calendar's past; it stops future runs. Deleting removes the
  routine and its pills everywhere.
- After a paused run attempt the chat stays quiet (no new `Running routine:` row).

> Note: `pnpm smoke` asserts the same expansion logic on a fixed March 2026 window, so a timezone
> regression shows up there before it shows up here.

## Flow 4 — A file reaches Files → Attachments

**Automated backing:** mostly. `apps/server/src/__tests__/files.test.ts` covers attachment listing,
sizes, filters, pagination, the download route and the path guards; `FilesView.test.tsx` covers the
tabs, search, viewer and paging; `smoke-server.mjs` plants a message with an attachment and asserts it
appears under `/api/files`, that `?type=attachment` returns only it, and that `downloadUrl` streams the
bytes. **The "upload from the composer" step does not exist in this build** — see the note below.

**Preconditions:** for the agent-side path, a managed bot whose gateway is up.

**Steps (agent-side path — the one this build has)**

1. Open the bot's chat. Ask: `Download https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png with show_file and show it to me.`
   (Any public image/file URL works. `show_file` saves it into the bot's Library and attaches it to
   the reply.)
2. Wait for the reply. The file renders inline in the message.
3. Open **Files** in the nav rail. The same file is listed.
4. Click the **Attachments** tab. The file is still there (it is also under **Library** — an
   attachment is a Library file named by a message).
5. Click the entry: images preview inline, text previews in a modal, anything else downloads.

**What to look for**

- Message: an inline attachment, not a bare path. (A `MEDIA:/…` line pointing inside the bot's
  Library is converted to an attachment too.)
- Files → Attachments: the row shows the bot's name, the filename, a human size and a date, and the
  type filter does not drop it when you switch tabs back and forth.
- Download from the preview returns the file's bytes, with `text/plain` / `image/png` and `inline`
  where it can be shown.

> Note: there is no upload control in the web composer and no upload endpoint on the server — the
> Files API is read-only (`GET /api/files`, `GET /api/files/:id/download`). Attachments are produced
> by the agent (`show_file`, screenshots via the computer tool). Verify the file part of this flow by
> asking a bot to produce one; verify the list/download part with `pnpm smoke`, which does not need a
> gateway.

## Flow 5 — Toggling a skill off for one managed bot

**Automated backing:** `apps/server/src/__tests__/skills.test.ts` (delete one `mcp_servers` entry and
keep the rest, restore from the primary, primary read-only, 404/400/409 cases),
`SkillsView.test.tsx` (optimistic toggle, primary switch locked, revert on error),
`smoke-server.mjs` (PUT → 200 with the bot reading off, the managed `config.yaml` losing only that
entry, primary → 409, restore → 200).

**Preconditions:** the primary agent's `config.yaml` defines at least one `mcp_servers` entry other
than `hq` (the app's own connection). If Skills shows *No skills configured in the primary agent's
config*, add one to `~/.hermes/config.yaml` and reload.

**Steps**

1. Open **Skills** in the nav rail. Pick a skill in the left list.
2. In the right panel, find a **managed** bot's row and flip its switch off.
3. Reload the app (⌘R) and come back to **Skills**.
4. On disk: open that bot's Hermes config — `ENGINES_DIR/<botId>/config.yaml` (this install:
   `data/engines/<botId>/config.yaml`).
5. Flip the switch back on.

**What to look for**

- The switch flips immediately and the row's meta text reads **Off** (it said **Enabled**). No error
  banner appears; a failed write would revert the switch and show *Couldn't update …*.
- After the reload the switch still reads **Off** — the state is the config file, not local memory.
- `config.yaml` no longer has that skill under `mcp_servers:`. Everything else in the file is
  untouched: `hq` is still there with its `url` and `headers`, and `model`, `terminal`, `browser`,
  `platform_toolsets` are unchanged.
- The **primary** agent's row has no switch, is tagged **Primary**, and reads
  *Always on, from its own config* — its config is the source of truth and is never written by the app.
- Turning it back on restores the entry verbatim from the primary's config (and the switch reads
  **Enabled** again after another reload).
- `hq` cannot be toggled at all (the API answers 400 for that name).

## Flow 6 — Computers shows every awake bot, and Open works

**Automated backing:** `apps/server/src/__tests__/computers.test.ts` (kind/status mapping, unknown vs
error, rooms skipped, `vncAvailable` only with a screen), `ComputersView.test.tsx` (a card per bot,
badge labels, Working chip, Open opens the viewer, No screen disables it, 15s polling),
`smoke-server.mjs` (`GET /api/computers` rows and the awake/screen mapping).

**Preconditions:** Docker running (or an Orgo computer configured), at least one bot with a screen,
and at least one bot awake — open each bot's chat once, or send it a message, which starts its
computer.

**Steps**

1. Open **Computers** in the nav rail.
2. Wait for the list (it polls every 15 s; **Refresh** forces it).
3. Read the cards. Each shows the bot's name, a status badge, the provider kind, and a frame
   captioned **Screen ready** / **Screen sleeping** / **No screen**.
4. Click **Open** (or the frame itself) on an awake bot.
5. In the viewer: watch for a few seconds, hover the canvas, click **Take control**, then
   **Hand back to <bot>**, then press Escape.

**What to look for**

- One card per bot that has a computer; bots with no computer are left out and counted in the line
  below the grid. The counters at the top read *n computers*.
- Badges: **Awake** (green), **Sleeping**, **Starting**, **Unknown**. A bot with a computer whose
  provider cannot answer shows **Unknown** — the whole list must still render.
- A bot in a turn shows the **Working** chip.
- **Open** is disabled with **No screen** when the bot has no screen row (nothing to view yet).
- The viewer shows live pixels of that bot's desktop, and the bot's own cursor/mouse moves when you
  take control. **The grid preview is a stand-in frame, not live video** — it is drawn deliberately
  so the grid does not open one noVNC stream (and one of the computer's limited screens) per card;
  live pixels only start in the viewer.
- Closing the viewer does not stop the bot's computer.

## Known gaps (honest status)

| Flow | Step that is not possible from the UI today | What to do instead |
|---|---|---|
| 4 | Uploading a file from the composer | Ask a bot to attach one (`show_file`, screenshot); the read side is fully covered by `pnpm smoke` |
| 3 | Editing or deleting an event from the calendar popover | Bot settings → **Routines** (pause, Run now, Delete) |
| 6 | A live preview inside the grid card | Open the viewer; the card frame is a state indicator by design |
| 2, 3 | Waiting for a scheduled time | Bot settings → Routines → **Run now** |

## Recording a run

For each flow, note: date, bot names used, `pnpm smoke` output line (`n/n checks passed`), and the
results of the four suite commands above. A flow counts as passed only when its **What to look for**
bullets are all true and the automated backing still passes on the same commit.
