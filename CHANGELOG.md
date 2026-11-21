## v0.4.1 — 2026-11-21

- docs: live evidence for phone pairing
- feat(mobile): sign in by opening an orbit://pair link
- feat(web): Connect your phone QR in Settings, Devices
- feat(desktop): Allow my phone to connect
- fix(native-stack): listen on loopback only
- feat(server): single-use pairing codes a phone redeems for a session
- fix(mobile): resolve React from the app so the bundle has one copy
- ci: publish the GPU voice image from its own workflow, rebuilt only when it changes


## v0.4.0 — 2026-11-21

- feat(web): resizable, collapsible side panels
- fix(release): ship the computer build files in the native server bundle
- fix(desktop): wait for Docker to release the last port; give a stopping stack 30 s
- fix(desktop): stop offering Apple's container runtime, which nothing uses yet
- fix(desktop): copy Docker data on the way to native; keep the Docker port across launches
- feat(desktop): update from Settings, with the new server fetched before the restart
- feat(desktop): one launch window from first choice to a running Orbit
- feat(desktop): write the main process log to a file
- fix(desktop): join an in-flight stack start, keep containers on stop, reuse release images
- fix(desktop): serve the native stack's web app from its one server port


## v0.3.0 — 2026-11-20

- fix UI
- fix: keep desktop overlays clear of the window buttons, and tidy UI inconsistencies
- feat: sign in to model subscriptions from the Engine tab, in a Hermes terminal
- chore: remove Orgo computers; every Bot has a Docker computer of its own
- test(smoke): an attached Library file is listed once under All
- fix(server): chat images load for Docker bots, and All lists each file once
- fix(server): a build rerun after a fix is iteration, not a loop
- fix desktop builds
- fix(web): crowded details tabs move into a More menu instead of truncating
- feat(web): a Code tab, so the files a Bot wrote or edited show as diffs beside the chat
- feat(web): open chat files in the viewer, with HTML as a page and CSV as a table
- feat(web): expand an artifact to fill the window, or open it in its own window
- feat(web): an Artifact tab and chat card, so a Bot's page renders live beside the chat
- docs: A1 live and perf evidence; close A4, Hermes sends no argument deltas
- feat(server): an artifact tool, so Bots can show a live HTML page beside the chat
- feat: browse the data folder and open files by kind


## v0.2.0 — 2026-11-19

- feat(server): a turn supervisor, so bots keep working through failures
- feat: a shared skill library across bots, installable from GitHub
- feat: shared Hermes settings editor, per-bot app access, and fresh inherited tokens
- test(web): give the Transcript fixture's event row its event kind
- fix(web): one text column for everything in the chat timeline
- fix(server): put an email's text under the name the Gmail action takes
- feat(server): default new Bots to Claude Sonnet 4.6
- feat(web): pick a new Bot's model in Create Bot
- feat(server): new Bots run Claude Sonnet 4.5 unless a model is picked
- fix(server): carry a custom provider's key named in key_env
- feat(server): the one-time import carries the subscription sign-ins
- docs: the server runs the primary agent; describe the one-time import
- feat(desktop): import ~/.hermes into the stack once instead of wiring host Hermes
- chore(infra): the stack mounts nothing from the host for Hermes
- feat(server): run the primary Hermes gateway in-process like every other bot
- feat(server): one-time import of a person's Hermes home into the primary's
- fix(server): point the primary Hermes hq entry at /mcp/primary
- refactor(mobile): use @orbit/domain instead of local copies (MOB1)
- refactor(server): one error boundary for the API (ERR1)
- refactor(server): deduplicate the review adapters (REV1)
- refactor(server): move turn queue to core and split agent tools (TOOLS1)
- refactor(server): extract approval-policy domain module (POL1)
- refactor: create @orbit/domain and switch web to shared imports (SHARE1)
- refactor(server): extract calendar-view domain module (CAL1)
- refactor(web): replace bulk resync with SSE cursor resume
- refactor(engine): split Hermes HQ lease out of engine.ts
- refactor(server): delete contracts import shim
- ci(docs): fail CI when generated docs drift from source
- chore(repo): remove dead code and repo clutter
- Adde UI fixes
- added release script
- update ignore
- fix: remove stale orbit MCP entry that blocks Atlas from team tools
- refactor
- Desktop: normalize stack .env line endings so compose sees the secrets
- Remove stale Claude worktree submodule entries breaking Pages deploy
- Only one Orbit server at a time writes the primary Hermes hq config
- Docs: setup guide for connecting apps with Composio
- iOS check: commit the native project, show paused linked events, ask before emailing guests
- Phase 12: live workspace eval, on-demand calendar sync, deferred-tool guidance
- feat(workspace): phase 11, mobile parity
- feat(workspace): phase 10, capability manifest for every bot
- feat(workspace): phase 9, duplicate a Google event as an Orbit event
- feat(workspace): phase 8, one calendar for Google and Orbit
- feat(workspace): phase 7, encrypted Google Calendar mirror
- feat(workspace): phase 6, Sheets and Docs cards
- feat(workspace): phase 5, calendar event cards
- feat(workspace): phase 4, draft-first email card
- feat(workspace): phase 3, review cards that can edit what runs
- feat(workspace): per-bot Always allow, off by default
- feat(workspace): phase 2, Google action catalogue and approval policy
- test(smoke): start-up drops the retired Google OAuth tables
- feat(workspace): phase 1, remove the direct Google OAuth path
- feat(workspace): phase 0, Composio ground truth
- Sync to main
- fix(dev): rebuild loop opens the window, and on the image it just built
- perf(computers): fit ten bot computers on a 16 GB machine
- docs: GPU voice setup, model choice and installer builds on the website and README
- fix(voice): HTTPS front door works when opened by IP; vite reachable from the sidecar
- docs: GPU voice, installers and screenshots in the README, website and guide
- feat(voice): GPU sidecar install from the desktop app, streamed replies, and installer fixes
- fix(dev): Windows parity for the launch configs and dev scripts
- feat(voice): GPU voice calls through audio.cpp, with a lip-synced portrait avatar
- fix: fill missing secrets on upgrade, center nav+search in titlebar
- fix: update tests for agents/groups ordering and onMouseDown avatar toggle
- feat: Teams UI redesign, enhanced search, back/forward nav, user avatar, menu click fix
- fix: CI failure + poteto-mode principle violations
- feat(F11): Teams of Bots — preset team wizard with group room + orchestrating routine
- fix: resolve post-merge type errors (initiative optional, secure-form card case)
- chore: commit in-progress work from stopped agent
- chore: commit in-progress work from stopped agent
- chore: commit in-progress work from stopped agent
- chore: commit in-progress work from stopped agent
- test(web): first-run chooser gating, manager states and call bar prompt
- feat(web): initiative level, morning briefing and idle check in bot settings
- feat(web): one PageShell frame and page tokens for every top-level view
- feat(web): first-run voice chooser, Voice models manager and call bar prompt
- feat(mobile): route orbit:// prompt links to the thread composer
- feat(web): add a Rules tab to bot settings
- feat(web): open deep links from the desktop app and prefill an empty composer
- fix(web): key template routines by position, not name
- feat(desktop): register orbit:// and hand deep links to the app window
- feat(rules): enforce bot rules at the tool gate and add rules CRUD
- feat(vault): seal secrets with AES-256-GCM and store vault entries
- feat(cards): add the secure-form card kind and the vault and audit contracts
- feat(web): template gallery, share sheet and bot duplication
- feat(voice): default to on-device and manage voice models
- feat(server): initiative level, signal outbox and seeded morning briefing
- feat(web): fold consecutive Activity entries per bot into collapsible runs
- fix(web): Leave deletes the group and every client drops it
- fix(server): delete a group chat through DELETE /api/rooms/:id
- feat(server): cap Hermes context at CONTEXT_COMPACTION_THRESHOLD and surface compactions as notices
- feat(server): bot duplication, bot templates and starter gallery
- feat(rules): add auto-review rule model and pure evaluator
- test(server): owner deleting a group chat removes it and its rows
- feat(server): configurable XAI_BASE_URL and hashed safety identifier on direct xAI calls
- docs: add Grok Bot parity implementation plan
- fix(desktop): show Orbit icon in task tray / dock during development
- fix: use valid AvatarColor in test (violet not purple)
- fix: show sender bot avatar in inter-bot chat bubbles
- fix: ensure primary bot always has team-management tools in its Hermes agent
- Stop bot engines with their server; reset stack to a clean slate
- Settings: modal dialog in place of the full-page view
- build-installer: follow the manual run this script starts
- Add installer build and try-out scripts; keep dev and test stacks apart


