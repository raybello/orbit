# Orbit refactor program plan

The workspace phases 0 to 12 (commits `008706d` through `e4c3b9e`, merged as PR #19) replaced the direct Google OAuth path with Composio and shipped review cards, a unified calendar, and mobile parity in one week. The wave left predictable residue. The server's `agent/tools.ts` imports the HTTP route module, the approval decision lives in seven places, mobile re-implements web card logic near-verbatim, and one legacy contract shim still splits server imports in two. This program refactors that residue without changing any user-visible behavior. Every PR is behavior-preserving, merge-ready on its own, and ordered so each unit's check runs before the next unit starts.

PR ids in order. `DEL1` and `DOCS1` and `SHIM1` and `CAL1` and `SSE1` and `ENG1` branch from `main`. `POL1` follows `CAL1`, `TOOLS1` follows `POL1`, `REV1` follows `SHIM1`, `MOB1` follows `SHARE1`, and `SHARE1` branches from `main`.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `playbooks/autopilot-stack.md`. One owner per PR builds it to merge-ready with a full swarm verdict. Nothing merges during the run. The operator lands the contiguous verified run bottom-up at the end.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:playbooks/autopilot-stack.md` (the pstack copy under `~/.agents/skills/pstack-plugins/pstack/skills/poteto-mode/`)
  - [ ] `git show origin/main:` the swarm skill from the same pstack install
  - [ ] `git show origin/main:` the control-ui skill from `cursor-team-kit`
  - [ ] `git show origin/main:` the opening-a-pr playbook from the same pstack install
  - [ ] Re-read `docs/plans/composio-shapes.md` and `docs/plans/workspace-approvals.md` at start; they carry the phase decisions this plan must not undo.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand up a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when stacking.
  - [ ] `DEL1`, `DOCS1`, `SHIM1`, `CAL1`, `SHARE1`, `SSE1`, `ENG1` are independent and first. All branch from `main`.
  - [ ] `POL1` after `CAL1` (both edit `apps/server/src/agent/tools.ts`).
  - [ ] `TOOLS1` after `POL1`.
  - [ ] `REV1` after `SHIM1`.
  - [ ] `ERR1` after `SHIM1`.
  - [ ] `MOB1` after `SHARE1`.
- [ ] Hold the file boundaries.
  - [ ] `DEL1` touches only `apps/web/src/lib/api.ts`, `scripts/`, root plan markdown, `docs/pr-assets/`, `assets/`, and root `package.json`.
  - [ ] `DOCS1` touches only `.github/workflows/`.
  - [ ] `SHIM1` touches only `apps/server/src/**` import lines, `apps/server/src/types.ts`, and creates `scripts/codemod-contracts-imports.mjs`.
  - [ ] `CAL1` touches `apps/server/src/routes-calendar.ts`, `apps/server/src/agent/tools.ts` (import and call lines only), and creates `apps/server/src/domain/calendar-view.ts`.
  - [ ] `POL1` touches `apps/server/src/agent/tools.ts` (deletes lines 463 to 547), `apps/server/src/mcp.ts`, `apps/server/src/agent/loop.ts`, and creates `apps/server/src/domain/approval-policy.ts` and `apps/server/src/core/policy-service.ts`.
  - [ ] `TOOLS1` touches `apps/server/src/agent/**`, creates `apps/server/src/core/turn-queue.ts` and `scripts/check-import-cycles.mjs`.
  - [ ] `REV1` touches `apps/server/src/review/**`, `apps/server/src/composio.ts`, `apps/server/src/calendar/mirror.ts`, and creates `apps/server/src/lib/coerce.ts`.
  - [ ] `ERR1` touches `apps/server/src/routes.ts`, `apps/server/src/routes-calendar.ts`, `apps/server/src/api/app.ts`, `apps/server/src/review/**`, and creates `apps/server/src/api/errors.ts`.
  - [ ] `SHARE1` creates `packages/domain/**` and edits import lines in `apps/web/src/**` only.
  - [ ] `MOB1` touches `apps/mobile/**` only.
  - [ ] `SSE1` touches `apps/web/src/lib/events.ts` and the resync branch of `apps/web/src/store.ts`.
  - [ ] `ENG1` touches `apps/server/src/engine.ts`, `apps/server/src/__tests__/engine-hq-sync.test.ts`, and creates `apps/server/src/engine-hq.ts`.
- [ ] Hold the review gate. `MOB1` and `SSE1` change an interaction path. They wait for the operator's review in chat with screenshots and a video before the operator lands them.

### PR mechanics, for every PR

- [ ] Resolve the forge once. `command -v origin` was checked at plan time and the repo pushes to GitHub, so every PR operation uses `gh pr create --base main`. Record any fallback. Never require `gt`.
- [ ] Open the PR ready, never draft, per the opening-a-pr playbook. A stack child targets its parent branch.
- [ ] Run the repo's typecheck once before the PR-facing push. The command is `pnpm typecheck`. There is no lint task in this repo (see Appendix C). Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per the bugbot-triage reference.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm per the swarm skill. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in the shipping playbook.
- [ ] The owner reports merge-ready with the root's clean verdict. Nothing merges during the run. The operator lands the contiguous verified run bottom-up per the shipping playbook.

### Boot recipe, for every live lane

Each live lane runs in its own lane checkout on the operator's machine (or a runner with Docker). There are no cloud VMs wired for this repo; see Appendix C.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`, then `pnpm install --frozen-lockfile && pnpm build`.
- [ ] Start the backend with `SESSION_SECRET=lane-secret ORBIT_DB=/tmp/swarm-<pr-id>/lane-<n>/orbit.db node apps/server/dist/index.js`. Wait until `curl -s localhost:<port>/api/health` returns `{"ok":true}`. Start the web surface with `pnpm --filter web dev` and open its vite URL.
- [ ] Deliver input only through control-ui (CDP) commands. That means navigate, click, and typing into the composer and the calendar. Read-only diagnostics are the server log, `curl` against the API, and `git grep`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.
- [ ] For mobile lanes only, replace the web line with `pnpm --filter mobile ios` on a booted simulator, drive taps through `xcrun simctl` per the xcode-build skill, and save screenshots with `xcrun simctl io booted screenshot`.

## Remove dead code and repo clutter (DEL1)

**Depends on.** None.

**Files.**

- [ ] Edit `apps/web/src/lib/api.ts`.
- [ ] Delete `scripts/dev-verify.sh`.
- [ ] Delete `implementation_plan.md`, `orbit-implementation-plan.md`, `phases.md`, `ui_design_plan.md`, `Proposed Implementation Plan.md`, `Local STTTTS — Implementation Plan.md`.
- [ ] Delete `docs/ORBIT_REFACTORING_PLAN.md`.
- [ ] Delete `docs/pr-assets/`.
- [ ] Delete `assets/` only after checking the GitHub repo social-preview setting does not point at `assets/icon.svg`.
- [ ] Edit root `package.json` (the `smoke` script line).

**Build.**

- [ ] Delete `api.googleDisconnect` at `apps/web/src/lib/api.ts` line 96. It has zero callers and no matching server route after commit `4924172`.
- [ ] Delete `scripts/dev-verify.sh`, whose only grep hit is its own header.
- [ ] Move `scripts/verify-server-bundle.test.mjs` into the `smoke` script so CI actually runs it. Today no runner executes it.
- [ ] Delete the six root plan files and `docs/ORBIT_REFACTORING_PLAN.md`. Their last touches are 11-14 and 11-16, and the only external mention of any is a `.dockerignore` exclusion line; delete that line too.
- [ ] Delete `docs/pr-assets/` and (conditionally) `assets/`. Both have zero references in tracked files (measured by `git grep`, and the owner pastes the grep output in the PR body as the receipt).

**You see.**

- [ ] `git grep -c googleDisconnect -- apps/web` prints 0 files.
- [ ] `pnpm smoke` runs the bundle verifier and its line appears in the CI log for this PR.
- [ ] `ls docs/pr-assets` errors with no such file.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] No new tests. The evidence is the existing suites staying green. Run `pnpm test` and `pnpm typecheck` and `pnpm smoke`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the bot-drafts-an-email scenario (open a bot thread, ask for a draft to a fixture address, approve the card) at trunk and head. Save `draft-approval.png`. Pass when the Gmail draft row appears on both and the head diff touches no server file.
- [ ] Lane 2. Open **Apps** and connect Gmail through the Composio popup. Save `apps-connect.png`. Pass when the connected state renders after the popup returns.
- [ ] Lane 3. Open **Calendar** with one linked Google event. Save `calendar.png`. Pass when the event tile renders.
- [ ] Lane 4. Load **Files**. Save `files-view.png`. Pass when the file list renders and an image shows its preview.
- [ ] Lane 5. Sign out and sign in with the dev login. Save `sign-in.png`. Pass when the session survives reload.
- [ ] Lane 6. Open **Settings** and change the timezone. Save `settings-tz.png`. Pass when the value persists after reload.
- [ ] Lane 7. Open a bot thread and interrupt a running turn. Save `interrupt.png`. Pass when the interrupt button resolves the turn.
- [ ] Lane 8. Ask the bot for a calendar event and approve the review card. Save `event-approval.png`. Pass when the event tile appears on **Calendar**.
- [ ] Lane 9. Reload the page mid-session. Save `reload-session.png`. Pass when rows and bots restore without re-login.
- [ ] Lane 10. Run `pnpm --filter mobile start` and open the Expo bundle. Save `mobile-boot.png`. Pass when the mobile app renders the bots tab against the same server.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server cold-boot seconds and the web production bundle size, at trunk and at head.
- [ ] Probe. Time `node apps/server/dist/index.js` to first `{"ok":true}` health line, and read the vite gzip totals from `pnpm --filter web build`, run at trunk and at head, interleaved.
- [ ] Baseline. Record the trunk boot seconds and gzip KB first.
- [ ] Rule. Head boot within 0.5 s of trunk, and head web bundle no larger than the trunk bundle. A larger head fails.

**Review gate.** None. `DEL1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Guard generated docs in CI (DOCS1)

**Depends on.** None.

**Files.**

- [ ] Edit `.github/workflows/ci.yml`.

**Build.**

- [ ] Add a CI step that runs `python3 scripts/build-docs.py` then `git diff --exit-code docs/`, failing the job on any drift. The marker on line 20 of every `docs/*.html` says the source lives in `site/docs-src/`, and commits `bf6b6bf` and `4924172` edited generated output by hand anyway.

**You see.**

- [ ] Editing `docs/guide.html` locally then running the new step fails CI with a non-zero `git diff --exit-code`. The PR body records that red run, then the green run after a revert.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] No new test file. The check itself is the test. Run the new workflow step once on a clean tree. Command `python3 scripts/build-docs.py && git diff --exit-code docs/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open `docs/setup.html` on the Pages deploy at trunk and head and compare the Composio section from commit `b2a4948`. Save `setup-page.png`. Pass when both show the Composio setup guide and the head diff touches no `docs/` file.
- [ ] Lane 2. Open the site landing and click into **Docs**. Save `site-docs.png`. Pass when the docs index loads.
- [ ] Lane 3. Open `docs/guide.html`. Save `guide-page.png`. Pass when the calendar and cards sections render.
- [ ] Lane 4. Open `docs/ARCHITECTURE.md` on GitHub. Save `architecture-md.png`. Pass when it renders as markdown.
- [ ] Lane 5. Run `scripts/build-docs.py` at head and diff. Save `build-docs-diff.png`. Pass when the diff is empty.
- [ ] Lane 6. Run `scripts/build-docs.py` at trunk and diff against head's `docs/`. Save `trunk-head-sync.png`. Pass when they are byte-identical.
- [ ] Lane 7. Check the workflow file parses. Save `ci-yaml.png`. Pass when `gh workflow list` shows no errors for the repo.
- [ ] Lane 8. Trigger CI on the PR branch. Save `ci-run.png`. Pass when the docs step appears and passes.
- [ ] Lane 9. Push a deliberate `docs/` typo on a throwaway branch and watch CI. Save `ci-red.png`. Pass when the step fails red.
- [ ] Lane 10. Confirm the root `index.html` and `site/` links still resolve locally. Save `links.png`. Pass when every docs link returns 200 from a static server.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. CI job wall time for the docs job, at trunk and at head.
- [ ] Probe. Read the Actions run duration for the docs step at trunk and at head, interleaved across two runs each.
- [ ] Baseline. Record the trunk duration first.
- [ ] Rule. The new step adds no more than 15 s to the job. More fails.

**Review gate.** None. `DOCS1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Delete the contracts import shim (SHIM1)

**Depends on.** None.

**Files.**

- [ ] Create `scripts/codemod-contracts-imports.mjs`.
- [ ] Edit import lines in the 26 `apps/server/src` files that import through the shim.
- [ ] Delete `apps/server/src/types.ts`.

**Build.**

- [ ] Point the 26 files at `@orbit/contracts` directly, the same path the other 41 server files already use. `src/types.ts` is `export * from '@orbit/contracts'` and is also a self-import cycle artifact.
- [ ] The codemod is the lever. It rewrites the relative `./types.js` and `../types.js` import specifiers to `@orbit/contracts`, runs clean on the repo, and is idempotent on re-run. Prove it by re-running at head and diffing an empty result.

**You see.**

- [ ] `git grep -c "from '.*types.js'" -- apps/server/src` prints 0.
- [ ] The self-import cycle disappears from the import graph.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the existing server suite unchanged. Command `pnpm --filter @orbit/server test` (the `tsx --test src/__tests__/*.test.ts` script). Also `pnpm typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the bot-drafts-an-email scenario at trunk and head. Save `draft-approval.png`. Pass when the draft row appears identically on both.
- [ ] Lane 2. Run `pnpm smoke` end to end. Save `smoke-log.png`. Pass when every smoke section prints ok.
- [ ] Lane 3. Approve a tool call that needs consent. Save `approval-card.png`. Pass when the card gates the action.
- [ ] Lane 4. Turn on per-bot **Always allow** and re-run the same tool. Save `always-allow.png`. Pass when the second run skips the card.
- [ ] Lane 5. Open **Calendar** with mirror events. Save `calendar.png`. Pass when mirrored events render.
- [ ] Lane 6. Hit `GET /api/bots` and `GET /api/health` with curl. Save `api-curl.png`. Pass when both return ok JSON.
- [ ] Lane 7. Trigger a webhook path through the connect callback. Save `connect-callback.png`. Pass when the app lands connected.
- [ ] Lane 8. Restart the server mid-session. Save `restart.png`. Pass when boot completes with no import errors in the log.
- [ ] Lane 9. Read the PR body's diffstat. Save `diffstat.png`. Pass when no runtime behavior line changed except import specifiers and the deleted shim.
- [ ] Lane 10. Re-run the codemod at head. Save `codemod-idempotent.png`. Pass when it exits with an empty diff.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server cold-boot seconds and `pnpm --filter @orbit/server build` seconds, at trunk and at head.
- [ ] Probe. Time both at trunk and at head, interleaved, three runs each, report the medians.
- [ ] Baseline. Record the trunk medians first.
- [ ] Rule. Head medians within 10 percent of trunk. Beyond 10 percent fails.

**Review gate.** None. `SHIM1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Move calendar building into the domain (CAL1)

**Depends on.** None.

**Files.**

- [ ] Create `apps/server/src/domain/calendar-view.ts`.
- [ ] Edit `apps/server/src/routes-calendar.ts`.
- [ ] Edit `apps/server/src/agent/tools.ts` (import and call lines only).
- [ ] Create `apps/server/src/__tests__/calendar-view.test.ts`.

**Build.**

- [ ] Move `expandRoutine`, `buildCalendar`, and `CalendarRoutineRow` from `routes-calendar.ts` lines 45 to 106 into `domain/calendar-view.ts`. The route handler (lines 129 to 162) and the `calendar_list` tool (`agent/tools.ts` lines 228 to 269) both merge mirror events and expanded routines today, so the extraction deletes the agent-to-route import at `agent/tools.ts` line 22. One merge path, one owner.

**You see.**

- [ ] `git grep -c "routes-calendar" -- apps/server/src/agent` prints 0.
- [ ] `GET /api/calendar` returns the identical JSON shape as trunk for the same fixture DB.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add `__tests__/calendar-view.test.ts` asserting occurrence expansion for weekly and monthly routines and the mirror-plus-routine merge, against the existing fixtures. Keep `routines-calendar.test.ts` and the `calendar-*` tests green and unmodified. Run `pnpm --filter @orbit/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Load **Calendar** at trunk and head with the same seeded DB (one linked Google event, one Orbit event, one weekly routine). Save `calendar-month.png`. Pass when tiles match tile-for-tile across the month grid.
- [ ] Lane 2. Ask the bot "what is on my calendar this week" and compare its answer to the web view. Save `bot-calendar-answer.png`. Pass when the tool result matches the rendered tiles.
- [ ] Lane 3. Edit a routine from the web modal. Save `routine-edit.png`. Pass when the next occurrence tile moves.
- [ ] Lane 4. Pause a linked event. Save `linked-paused.png`. Pass when the paused state renders and the bot's listing omits it.
- [ ] Lane 5. Duplicate a Google event as an Orbit event. Save `duplicate-event.png`. Pass when the new tile appears.
- [ ] Lane 6. Switch months on the grid. Save `month-switch.png`. Pass when occurrences recompute.
- [ ] Lane 7. Hit `GET /api/calendar` at trunk and head on the same DB. Save `calendar-json-diff.png`. Pass when `diff` reports no difference.
- [ ] Lane 8. Create an event from the card flow and approve. Save `event-approval.png`. Pass when the tile appears without reload.
- [ ] Lane 9. Restart the server and reload **Calendar**. Save `calendar-restart.png`. Pass when the mirror rehydrates.
- [ ] Lane 10. Open the mobile **Calendar** tab. Save `mobile-calendar.png`. Pass when it renders the same month.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `GET /api/calendar` p50 latency for the seeded fixture DB, at trunk and at head.
- [ ] Probe. `curl -w` timing loop of 25 requests against a booted server, at trunk and at head, interleaved.
- [ ] Baseline. Record the trunk p50 first.
- [ ] Rule. Head p50 within 10 percent of trunk and under 300 ms absolute. Beyond either fails.

**Review gate.** None. `CAL1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Put the approval policy behind one service (POL1)

**Depends on.** `CAL1`.

**Files.**

- [ ] Create `apps/server/src/domain/approval-policy.ts`.
- [ ] Create `apps/server/src/core/policy-service.ts`.
- [ ] Edit `apps/server/src/agent/tools.ts` (delete lines 463 to 547).
- [ ] Edit `apps/server/src/mcp.ts` and `apps/server/src/agent/loop.ts`.
- [ ] Create `apps/server/src/__tests__/approval-policy.test.ts`.

**Build.**

- [ ] Move `botAllows`, `policyFor`, `mayAlwaysAllow`, and `rememberAlwaysAllow` out of `agent/tools.ts` (lines 463 to 547). The pure precedence order (a `policies` row, then `bot_policies`, then `bots.always_allow`, then the catalogue `kind`/`allowAlways` fallback) becomes `domain/approval-policy.ts` as a pure function over a decision-input record. `core/policy-service.ts` wraps it with the SQLite reads and writes, following the existing `core/rule-service.ts` pattern.
- [ ] `mcp.ts` gate (lines 81 and 111) and `loop.ts` toolkit label (line 627) call the service. `proactive.ts` keeps its own read of the `approvals` table but goes through the service's read method, not raw SQL.
- [ ] The data shape is one record in, one decision out. `Decision = {run: 'allow' | 'ask' | 'deny', source: string}` with the winning layer named, so a log line can say which layer answered.

**You see.**

- [ ] Every approval log line names the deciding layer (`policies row`, `bot_policies`, `always_allow`, or `catalogue`).
- [ ] `git grep -c "policyFor" -- apps/server/src` prints matches only inside the new files.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add `__tests__/approval-policy.test.ts` with the full precedence matrix (each layer present or absent, both toolkit kinds, read versus write actions). Keep `google-approvals-api.test.ts` and `rules.test.ts` green. Run `pnpm --filter @orbit/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask a write action cold (no policy rows) at trunk and head. Save `ask-card.png`. Pass when the card appears on both and the action runs only after approval.
- [ ] Lane 2. Approve once with **Always allow** available, enable it, repeat. Save `always-allow.png`. Pass when the second run skips the card.
- [ ] Lane 3. Deny a write. Save `denied.png`. Pass when the bot reports the denial and nothing runs.
- [ ] Lane 4. Read-only toolkit action. Save `read-autorun.png`. Pass when it runs without a card.
- [ ] Lane 5. Set an explicit policy row through the settings route. Save `policy-row.png`. Pass when the decision follows the row over the bot flag.
- [ ] Lane 6. Let an approval time out at `APPROVAL_WAIT_MS`. Save `approval-timeout.png`. Pass when it expires denied, matching trunk.
- [ ] Lane 7. Edit the draft during the approval edit window. Save `edit-window.png`. Pass when the edited content is what runs.
- [ ] Lane 8. Restart the server with a pending approval. Save `stale-approval.png`. Pass when boot expires it, matching trunk.
- [ ] Lane 9. Run the proactive briefing path that reads approvals. Save `briefing.png`. Pass when the briefing lists the pending card.
- [ ] Lane 10. Read the new decision log line for lane 5. Save `decision-log.png`. Pass when the layer name is `policies row`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Tool-call approval decision latency (time from tool call to card render or auto-run), at trunk and at head.
- [ ] Probe. Fifteen scripted tool calls each side via the eval harness, timing the API response, at trunk and head, interleaved.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head median within 10 percent of trunk. Beyond fails.

**Review gate.** None. `POL1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Break up the tools god module (TOOLS1)

**Depends on.** `POL1`.

**Files.**

- [ ] Create `apps/server/src/core/turn-queue.ts`.
- [ ] Edit `apps/server/src/index.ts` (wiring lines).
- [ ] Edit `apps/server/src/agent/loop.ts`, `apps/server/src/agent/tools.ts`, `apps/server/src/routines.ts`, `apps/server/src/triggers.ts`, `apps/server/src/proactive.ts`.
- [ ] Create `scripts/check-import-cycles.mjs`.

**Build.**

- [ ] Move the `enqueue` scheduler from `agent/loop.ts` into `core/turn-queue.ts`. Inject it at boot where `routines.ts`, `triggers.ts`, and `proactive.ts` need it, extending the DI already done at `index.ts` lines 53 to 55. That deletes import cycles 1 through 4 of the eleven cycles found in the agent cluster.
- [ ] Split the remaining `agent/tools.ts` (still around 540 lines after `POL1`) into the tool registry (the TOOLS list, lines 126 to 443), the Composio runner (`runComposioTool` and helpers), and the activity summaries (lines 595 to 621). Same public entry, three internal files.
- [ ] `scripts/check-import-cycles.mjs` is the lever. It walks the `src` import graph, prints cycles, and exits non-zero if any cycle includes `agent/loop.ts`. It becomes a repo check, not a plan promise.

**You see.**

- [ ] `node scripts/check-import-cycles.mjs` exits 0 and prints no agent-cluster cycle.
- [ ] `agent/tools.ts` no longer exists as the entry; callers import the new entry point and the boot log is unchanged.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the whole server suite untouched. Command `pnpm --filter @orbit/server test`. The lever runs inside CI too, as a step in the server job.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the bot-drafts-an-email scenario at trunk and head. Save `draft-approval.png`. Pass when the card, the approval, and the draft row match.
- [ ] Lane 2. Fire a routine trigger on schedule. Save `routine-fire.png`. Pass when the turn runs on time after the enqueue move.
- [ ] Lane 3. Fire a manual trigger. Save `manual-trigger.png`. Pass when the bot responds.
- [ ] Lane 4. Proactive ping path. Save `proactive.png`. Pass when the scheduled proactive turn posts to the thread.
- [ ] Lane 5. Tool search inside the agent (`tool search` surface). Save `tool-search.png`. Pass when the humanized tool list matches trunk names.
- [ ] Lane 6. A bot computer tool call. Save `computer-tool.png`. Pass when the box tool registry still resolves computer tools.
- [ ] Lane 7. Vault tool call. Save `vault-tool.png`. Pass when the vault read resolves through the split registry.
- [ ] Lane 8. Restart with a running turn. Save `mid-turn-restart.png`. Pass when boot is clean and stale state is expired as on trunk.
- [ ] Lane 9. Run the lever at head. Save `cycles-green.png`. Pass when it exits 0.
- [ ] Lane 10. Run the lever at trunk. Save `cycles-red.png`. Pass when it exits non-zero listing the agent cycles, proving the check is real.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Turn enqueue-to-start latency (tool call to first assistant token on a scripted turn) and cold-boot seconds, at trunk and at head.
- [ ] Probe. Twenty scripted turns each side via `scripts/eval-workspace.mjs` against the dev server, plus three boot timings, interleaved.
- [ ] Baseline. Record the trunk medians first.
- [ ] Rule. Head medians within 10 percent of trunk. Beyond fails.

**Review gate.** None. `TOOLS1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Deduplicate the review adapters (REV1)

**Depends on.** `SHIM1`.

**Files.**

- [ ] Create `apps/server/src/lib/coerce.ts`.
- [ ] Create `apps/server/src/review/slug-index.ts`.
- [ ] Edit `apps/server/src/review/email.ts`, `event.ts`, `sheet.ts`, `doc.ts`, `files.ts`, `drafts.ts`, `index.ts`.
- [ ] Edit `apps/server/src/composio.ts` and `apps/server/src/calendar/mirror.ts`.

**Build.**

- [ ] Move the seven copies of `str`/`rec`/`list` coercion helpers (`review/email.ts:15`, `event.ts:23`, `sheet.ts:19`, `doc.ts:15`, `files.ts:14`, `drafts.ts:19`, `calendar/mirror.ts:89`) into `lib/coerce.ts`.
- [ ] One shared batch-answer parser for the `COMPOSIO_MULTI_EXECUTE_TOOL` response walk. `review/drafts.ts` (lines 31 to 50) and `review/files.ts` (lines 56 to 65) hand-roll the same result tree walk today. Put the parser next to `innerToolCalls` in `composio.ts`.
- [ ] Build `review/slug-index.ts` from the catalogue's `card:` field (`domain/google-actions.ts` lines 49 to 117). The adapters' own slug lists (`email.ts:51-53`, `event.ts:128-132`, `sheet.ts:94-99`, `doc.ts:55-59`) delete. Drift becomes structurally impossible instead of test-guarded.
- [ ] Read the catalogue's toolkit version (`GOOGLE_TOOLKIT_VERSION`) instead of the constant's three copies (`domain/google-actions.ts:35`, `composio.ts` PINNED_TOOLKITS, `scripts/eval-workspace.mjs:32`); the script imports it instead of re-declaring.

**You see.**

- [ ] `git grep -c "const str = " -- apps/server/src` prints 0 outside `lib/coerce.ts`.
- [ ] `git grep -c 20261116_00` prints one declaration plus usages of one symbol.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add `__tests__/coerce.test.ts` for the coercion helpers' edge cases (null, array, wrong type). Keep `review-api`, `review-email`, `review-event`, `review-sheet-doc`, `drafts-api`, and `manifest.test.ts` green. Run `pnpm --filter @orbit/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the draft-email flow (compose, review card, edit subject, approve) at trunk and head. Save `draft-edit-approve.png`. Pass when the Gmail draft matches.
- [ ] Lane 2. Sheets review card with a two-cell diff. Save `sheet-diff.png`. Pass when the cell diff renders identically.
- [ ] Lane 3. Doc review card with an edits diff. Save `doc-diff.png`. Pass when the diff renders identically.
- [ ] Lane 4. Files notice card after a batch write. Save `files-notice.png`. Pass when the batch parse lists both files.
- [ ] Lane 5. Event card approval with scope change. Save `event-scope.png`. Pass when the right scope applies.
- [ ] Lane 6. Reject a draft. Save `draft-reject.png`. Pass when the card moves to rejected and nothing writes.
- [ ] Lane 7. A malformed Composio response (lane kills the upstream with a bad payload fixture). Save `malformed-parse.png`. Pass when the server logs one clear error and the card falls back, matching trunk.
- [ ] Lane 8. The manifest fixture check. Save `manifest-check.png`. Pass when `manifest.test.ts` prints green in CI.
- [ ] Lane 9. Run `scripts/eval-workspace.mjs` against the dev server. Save `eval-report.png`. Pass when the report lands in `docs/evidence/` with all-google manifest lines.
- [ ] Lane 10. Read the diff. Save `rev-diff.png`. Pass when no card's user-visible copy changed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Batch action parse time (server log delta between the Composio response and the card row insert), at trunk and at head.
- [ ] Probe. Ten batch actions each side through the eval harness with log timestamps, interleaved.
- [ ] Baseline. Record the trunk median delta first.
- [ ] Rule. Head median within 10 percent of trunk and under 50 ms absolute. Beyond fails.

**Review gate.** None. `REV1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## One error boundary for the API (ERR1)

**Depends on.** `SHIM1`.

**Files.**

- [ ] Create `apps/server/src/api/errors.ts`.
- [ ] Edit `apps/server/src/api/app.ts` (the `onError` hook at lines 44 to 48).
- [ ] Edit `apps/server/src/routes.ts` (delete the three bespoke helpers at lines 63 to 77 and the per-route catches), `routes-calendar.ts` (line 186), `review/drafts.ts` and `review/types.ts` mapping sites.

**Build.**

- [ ] One base error carrying an HTTP status and a user-facing message. `UserError`, `CalendarActionError`, `DraftActionError`, `ReviewEditError`, `IllegalCardMoveError` (part of 15 error classes today) extend it or map to it at their boundary. `api/app.ts` `onError` maps status and message once, so the per-route catch sites delete.
- [ ] Unknown errors still become 500 with the message hidden. The existing header comment in `api/schemas.ts` (lines 6 to 21) documents boundary discipline; this PR extends that rule to failures.

**You see.**

- [ ] `git grep -c "userFacing\|adminFailure\|googleFailure" -- apps/server/src` prints 0.
- [ ] A failing card action returns the same status code and body as trunk.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Extend `__tests__/api-integration.test.ts` asserting the status and body for each named error case (illegal card move 400, draft action failure, calendar action failure, review edit failure). Run `pnpm --filter @orbit/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trigger an illegal card decision at trunk and head. Save `illegal-move-400.png`. Pass when both return 400 with the same body.
- [ ] Lane 2. Trigger a calendar action failure (revoked grant fixture). Save `calendar-fail.png`. Pass when the web shows the same failure copy.
- [ ] Lane 3. Trigger a draft action failure. Save `draft-fail.png`. Pass when the card keeps its pending state and the copy matches trunk.
- [ ] Lane 4. Trigger a review edit race (edit after resolve). Save `edit-race.png`. Pass when the response matches trunk status and body.
- [ ] Lane 5. Force an unexpected server error (lane fixture throws). Save `unknown-500.png`. Pass when the body is the generic 500 and the server logs the cause.
- [ ] Lane 6. The happy path draft approval still works. Save `draft-approval.png`. Pass when the flow is unchanged.
- [ ] Lane 7. Unauthenticated API call. Save `unauth-401.png`. Pass when 401 is unchanged.
- [ ] Lane 8. Validation failure from `api/schemas.ts`. Save `validate-400.png`. Pass when the 400 message is unchanged.
- [ ] Lane 9. Bot thread after a failed action. Save `thread-after-fail.png`. Pass when the bot reports the failure the same way.
- [ ] Lane 10. Read the diff. Save `err-diff.png`. Pass when no route's success path changed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Error response latency for lane 1's illegal move call, at trunk and at head.
- [ ] Probe. Twenty-five illegal-decision requests each side with `curl -w`, interleaved.
- [ ] Baseline. Record the trunk p50 first.
- [ ] Rule. Head p50 within 10 percent of trunk. Beyond fails.

**Review gate.** None. `ERR1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Extract the shared client domain package (SHARE1)

**Depends on.** None.

**Files.**

- [ ] Create `packages/domain/package.json`, `tsconfig.json`, and `src/` (`card-logic.ts`, `calendar-time.ts`, `activity-preview.ts`, `file-kind.ts`, `index.ts`).
- [ ] Edit `apps/web/src/components/cards/EmailCard.tsx`, `EventCard.tsx`, `WorkspaceCards.tsx`, `Cards.tsx`, `CalendarView.tsx`, `lib/eventTime.ts`, `domain/activity-feed.ts`, `components/FilesView.tsx` (import lines and deleted local copies).
- [ ] Edit `pnpm-workspace.yaml` and `apps/web/package.json`.

**Build.**

- [ ] New workspace package `@orbit/domain`, pure TypeScript, no React, no React Native, no transport. It holds the functions web and mobile copy today.
- [ ] `card-logic.ts` takes the email edits diff (`EmailCard.tsx:25-33`), the split/join (lines 18 to 19), the `OUTCOME` map (`WorkspaceCards.tsx:35`), the event `SCOPES` (`EventCard.tsx:20-24`), `whenOf`/`asDate` (`EventCard.tsx:26-37`), the event edits loop (`EventCard.tsx:42-53`), the sheet cell diff (`WorkspaceCards.tsx:68-69`), and the doc edits diff (`WorkspaceCards.tsx:118-121`).
- [ ] `calendar-time.ts` takes `apps/web/src/lib/eventTime.ts` wholesale, the 42-day month grid (`CalendarView.tsx:36-48`), `daysOf`, `looksLikeCron`, `TIMINGS`, and the presets.
- [ ] `activity-preview.ts` takes `PREVIEW_CHARS` and the preview regex (`domain/activity-feed.ts:10-13`). `file-kind.ts` takes `TEXT_EXT` and the media buckets (`FilesView.tsx:39-47`).
- [ ] Web switches to imports from `@orbit/domain` and deletes its local copies. Web's existing card tests (`WorkspaceCards.test.tsx`, `EmailCard.test.tsx`, `EventCard.test.tsx`, `DuplicateEvent.test.tsx`) now cover the package by exercising it through the components.

**You see.**

- [ ] The local copies are gone. `git grep -c "const OUTCOME" -- apps/web` prints 0.
- [ ] The web UI renders identically, per lane evidence below.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Move the pure-case assertions from the component tests into `packages/domain/src/*.test.ts` where they test pure output, and keep the component tests asserting render. Run `pnpm --filter web test` and the new package's `tsx --test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Screenshot the four card types (email, event, sheet, doc) at trunk and head for the same seeded rows. Save `cards-parity.png`. Pass when a pixel diff of head against trunk reports no difference beyond subpixel antialiasing.
- [ ] Lane 2. Edit an email draft's subject and body in the card. Save `email-edit.png`. Pass when the diff summary updates identically to trunk.
- [ ] Lane 3. Edit an event card (time, location, notify). Save `event-edit.png`. Pass when the summary text and scope pills match trunk.
- [ ] Lane 4. Open **Calendar**, navigate three months. Save `calendar-nav.png`. Pass when occurrence placement is identical to trunk.
- [ ] Lane 5. Create a routine via the cron input. Save `cron-input.png`. Pass when invalid cron shows the same warning.
- [ ] Lane 6. Open **Files** with mixed kinds (png, md, csv). Save `files-kinds.png`. Pass when previews and icons match trunk.
- [ ] Lane 7. Activity feed preview text for a long title. Save `activity-preview.png`. Pass when truncation is the same 110 characters plus ellipsis.
- [ ] Lane 8. Sheet and doc cards approve. Save `sheet-approve.png`. Pass when decisions record identically.
- [ ] Lane 9. Web bundle report. Save `web-bundle.png`. Pass when the gzip JS delta versus trunk is at most plus 2 KB.
- [ ] Lane 10. Web test suite in CI. Save `web-ci.png`. Pass when vitest and tsx suites are green.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Web production gzip JS total and first render time on the bots tab, at trunk and at head.
- [ ] Probe. `pnpm --filter web build` gzip totals plus a CDP-measured first-render timing, at trunk and head, interleaved three times.
- [ ] Baseline. Record the trunk KB and render ms first.
- [ ] Rule. Head bundle within plus 2 KB of trunk and render within 10 percent. Beyond fails.

**Review gate.** None. `SHARE1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Point mobile at the shared package (MOB1)

**Depends on.** `SHARE1`.

**Files.**

- [ ] Edit `apps/mobile/package.json` (add `@orbit/domain`).
- [ ] Edit `apps/mobile/components/ReviewCards.tsx`, `GoogleEventSheet.tsx`, `CalendarEventModal.tsx`, `app/(tabs)/calendar.tsx`, `lib/activity.ts`, `lib/files.ts`.

**Build.**

- [ ] Replace mobile's near-verbatim copies with imports from `@orbit/domain`. `ReviewCards.tsx:78` `OUTCOME`, lines 109 to 119 `emailForm`/`emailEdits`, lines 193 to 201 `whenOf`/`asDate`, line 203 `SCOPES`, and the 5-minute ping at lines 81 to 88. `GoogleEventSheet.tsx:20-33` `fieldsOfGoogle`/`wallClock`/`addDays`. The month grid and `daysOf` in `calendar.tsx:26-48`. `lib/activity.ts:14-23` preview and limit. `lib/files.ts:17-34` kinds.
- [ ] What stays mobile-local is the React Native styling and the Switch and modal primitives. The mobile copies of pure logic delete. Mobile gains coverage for free because the web vitest suite already tests these functions.

**You see.**

- [ ] `ReviewCards.tsx` is under 250 lines.
- [ ] Mobile screens render the same card text and diffs as before the move.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `pnpm --filter mobile typecheck` (mobile has no test runner today; see Appendix C for the scaffold decision). Run `pnpm --filter web test` to prove the shared package is unchanged.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe with the mobile variant.

- [ ] Lane 1. Regression lane against trunk. Open the thread screen with seeded email, event, sheet, and doc cards at trunk and head. Save `mobile-cards-parity.png`. Pass when a pixel comparison of the card stack matches.
- [ ] Lane 2. Edit an email draft in the mobile card. Save `mobile-email-edit.png`. Pass when the diff summary updates correctly.
- [ ] Lane 3. Approve an event card with a scope change and notify switch. Save `mobile-event-approve.png`. Pass when the decision posts and the summary matches.
- [ ] Lane 4. Open the **Calendar** tab and swipe months. Save `mobile-calendar-months.png`. Pass when occurrences match trunk.
- [ ] Lane 5. Duplicate a Google event from the sheet. Save `mobile-duplicate.png`. Pass when the Orbit copy appears.
- [ ] Lane 6. Open a Google event sheet and read its times. Save `mobile-google-sheet.png`. Pass when wall-clock times match the web card for the same event.
- [ ] Lane 7. Create a routine with the timings presets. Save `mobile-routine.png`. Pass when the created routine's next run matches web for the same preset.
- [ ] Lane 8. Open **Files** with mixed kinds. Save `mobile-files.png`. Pass when icons and text previews match trunk.
- [ ] Lane 9. Activity preview for a long entry. Save `mobile-activity.png`. Pass when truncation matches web.
- [ ] Lane 10. Kill and relaunch the app. Save `mobile-relaunch.png`. Pass when all screens rebuild without a red screen.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Expo JS bundle size and cold start to the bots tab, at trunk and at head.
- [ ] Probe. `pnpm --filter mobile export:ios` bundle bytes, plus a simulator cold-start timing with `xcrun simctl launch --console-pty`, at trunk and head, interleaved.
- [ ] Baseline. Record the trunk bundle bytes and start ms first.
- [ ] Rule. Head bundle within plus 2 KB of trunk and cold start within 10 percent. Beyond fails.

**Review gate.** The operator reviews before landing.

- [ ] Copy lane 1 and lane 2 screenshots into `docs/evidence/mob1-review/`.
- [ ] Record a 30 to 60 second video of the mobile card edit and approve flow on a lane simulator. Save it as `docs/evidence/mob1-review/mob1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Reconnect web events with the cursor protocol (SSE1)

**Depends on.** None.

**Files.**

- [ ] Edit `apps/web/src/lib/events.ts`.
- [ ] Edit `apps/web/src/store.ts` (the resync branch only).

**Build.**

- [ ] Use the server's event-buffer replay that mobile already exploits. Replace the reload-everything resync at `apps/web/src/lib/events.ts:15-20` with the `?since=` cursor resume from `apps/mobile/lib/sse.ts:76`, keeping the cookie transport. The store keeps one reducer path for replayed rows instead of a bulk reload.

**You see.**

- [ ] After a dropped connection, the Network tab shows one replayed catch-up, not a full bots/rows/routines reload burst.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add a web test that fakes a socket close, reconnects, and asserts the client requests `?since=<last seq>` and applies replayed events through `handleEvent` without calling the bulk loaders. Run `pnpm --filter web test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Kill the server socket (restart the backend) with two threads open, at trunk and head. Save `reconnect-threads.png`. Pass when both catch up and no card is lost or duplicated; head additionally shows no bulk reload burst in Network.
- [ ] Lane 2. Live card push while the tab is foreground. Save `live-push.png`. Pass when the card appears without reload.
- [ ] Lane 3. Background the tab for two minutes, foreground it. Save `background-catchup.png`. Pass when missed rows appear once each.
- [ ] Lane 4. Send a message during a disconnect and reconnect. Save `queued-send.png`. Pass when the sent row dedupes after replay.
- [ ] Lane 5. Approve a card while a second tab is open. Save `two-tabs.png`. Pass when both tabs update.
- [ ] Lane 6. Expire the session mid-stream. Save `auth-expiry.png`. Pass when the client stops retrying and shows sign-in, matching mobile's stop rule.
- [ ] Lane 7. Calendar version bump still refreshes the calendar. Save `calendar-bump.png`. Pass when the tile updates without a manual reload.
- [ ] Lane 8. Reconnect count stays at one EventSource. Save `single-source.png`. Pass when the Network tab shows one active event stream.
- [ ] Lane 9. Trunk comparison of the same lane 1 scenario captured as a video. Save `trunk-vs-head-replay.png`. Pass when head's request count after reconnect is lower than trunk's.
- [ ] Lane 10. Reload the page cold. Save `cold-load.png`. Pass when the initial load path is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Catch-up time from reconnect to full thread state, and the number of refetch requests after reconnect, at trunk and at head.
- [ ] Probe. Ten backend restarts each side with CDP Network counting, interleaved.
- [ ] Baseline. Record the trunk median catch-up and request count first.
- [ ] Rule. Head catch-up no worse than trunk, and head request count at most half of trunk's. Failure on either fails the PR.

**Review gate.** The operator reviews before landing.

- [ ] Copy lane 1 and lane 9 screenshots into `docs/evidence/sse1-review/`.
- [ ] Record a 30 to 60 second video of the reconnect catch-up on a lane VM. Save it as `docs/evidence/sse1-review/sse1-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Split the Hermes HQ lease out of the engine (ENG1)

**Depends on.** None.

**Files.**

- [ ] Create `apps/server/src/engine-hq.ts`.
- [ ] Edit `apps/server/src/engine.ts`.
- [ ] Edit `apps/server/src/__tests__/engine-hq-sync.test.ts` (import path).

**Build.**

- [ ] Move the single-writer HQ config lease from commit `5c5ed5d` (engine.ts lines 917 to 1088) into `engine-hq.ts`, with the file IO helpers it needs. `engine.ts` (1168 lines today) keeps gateway lifecycle and auth. Same exported functions, one new internal module boundary.

**You see.**

- [ ] `engine.ts` no longer contains the lease block.
- [ ] Two Orbit servers run with one writing the Hermes hq config, exactly as before.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Keep all 145 lines of `engine-hq-sync.test.ts` passing with only the import path changed. Run `pnpm --filter @orbit/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Boot two servers against one Hermes home at trunk and head. Save `two-servers-lease.png`. Pass when exactly one writes the hq config on both.
- [ ] Lane 2. Kill the lease holder. Save `lease-handover.png`. Pass when the other server takes the lease within the same timeout as trunk.
- [ ] Lane 3. Engine engine start and stop through the desktop stack controller. Save `stack-toggle.png`. Pass when the engine state matches.
- [ ] Lane 4. Engine auth token path (the HMAC token at engine.ts line 77). Save `engine-auth.png`. Pass when the bot engine authenticates.
- [ ] Lane 5. Env inheritance for the engine child process. Save `engine-env.png`. Pass when the child sees the same vars as trunk.
- [ ] Lane 6. Gateway restart after config change. Save `gateway-restart.png`. Pass when the gateway comes back on the same port.
- [ ] Lane 7. Boot with a corrupt hq config fixture. Save `corrupt-config.png`. Pass when recovery matches trunk.
- [ ] Lane 8. Hermes model-provider OAuth paths stay intact (these are unrelated to the retired Google grant). Save `provider-oauth.png`. Pass when the provider connect screen renders.
- [ ] Lane 9. Cold boot timing print in the server log. Save `boot-log.png`. Pass when no new boot warning appears.
- [ ] Lane 10. Read the diff. Save `eng-diff.png`. Pass when the lease block's logic lines are moves, not rewrites.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server cold-boot seconds and lease-acquisition latency at boot, at trunk and at head.
- [ ] Probe. Five boots each side with log timestamps, interleaved.
- [ ] Baseline. Record the trunk medians first.
- [ ] Rule. Head medians within 10 percent of trunk. Beyond fails.

**Review gate.** None. `ENG1` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] Owner reports merge-ready. The operator lands it in the final stack run.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

No prototype was needed, and that is a finding, not an omission. Each candidate fork had an observable answer already. The docs duplication fork was settled by running `scripts/build-docs.py` in a temp copy and diffing against committed `docs/` (byte-identical today, so the fork is guard-in-CI, not a merge). The `googleDisconnect` fork was settled by a grep (zero callers, no server route). The import-cycle inventory was settled by walking the import graph, not by debate. One claim stays a prediction rather than a measurement. Mobile's Expo bundler resolves `@orbit/domain` as a workspace package with no extra metro config. `MOB1` lane 10 tests it at the head, and the fallback is a metro alias.

## Appendix B. Alternatives rejected

- [ ] A shared endpoint registry for the roughly 20 routes web and mobile both declare. Rejected. Contracts already carries the request and response types, the transports genuinely differ (cookie versus bearer and abort), and a registry adds a layer readers must trace to answer "which URL fires?". Adopting contracts types in web's local types (`apps/web/src/lib/api.ts:23-35`) is folded into no PR here and stays a follow-up.
- [ ] Splitting `packages/contracts/src/index.ts` (752 lines, touched by 10 of the last 30 commits). Rejected for this run. It is a hub every stacked PR would touch, so splitting it now creates merge conflicts across the whole program. Do it after this run lands, when fewer edits are in flight.
- [ ] A mobile test scaffold (vitest for RN). Rejected as scope. The extracted pure logic ships tested through `SHARE1`'s package tests and web's component tests, and mobile typecheck plus the live lanes cover integration. Revisit when mobile ships features alone again.
- [ ] Retiring `src/retire-google-oauth.ts` now. Deferred one release. It drops the old tables idempotently at boot, and deleting it before the migration floor would strand any install that has not booted since phase 1. Schedule it as the first deletion after this program, same shape as `DEL1`.

## Appendix C. Risks

- `DEL1` deletes `assets/` that the GitHub social-preview setting may reference. The owner checks the repo settings page (it is a web page read, not an API this plan has) before the delete commit. If referenced, keep the file and note the exception in the PR body.
- `DOCS1` and `d7d4d53` show the Pages deploy breaks on repo-root surprises. The owner watches the Pages build after landing, and the deploy is an irreversible-ish external surface, so the check runs on the branch before the operator lands.
- The repo has no lint task at all (`git grep '"lint"' -- '**/package.json'` returned 0 at plan time). Owners rely on typecheck and CI. Adding ESLint is deliberately out of scope; it would touch every file and fight the program's file boundaries.
- The pstack skill paths in the arm list live in the operator's home, not in this repo, so `git show origin/main:` on them fails. The tick re-reads them from the installed skill tree instead, and every lane prompt quotes the rule sentence verbatim so a stale read is visible.
- Live lanes run on the operator's machine (or a Docker runner), not on cloud VMs; none are wired. Boot and desktop release CI run in GitHub Actions. A lane that needs the desktop app (engines, Docker boxes) runs where Docker exists. `ENG1` and `TOOLS1` lanes need a Docker-capable runner; `SSE1`, `REV1`, `ERR1` need only the API and web.
- `POL1` touches the approval path that protects write actions against Google. A wrong precedence flip would auto-approve things users meant to gate. The full matrix unit test and lanes 1 to 5 exist specifically for this, and the swarm gate lane is one of them.
- `TOOLS1` changes module init order. The cycle-check lever runs in CI on every later PR, so a regression anywhere in the stack fails fast.

## Appendix D. Links and reading list

- Read before editing. `docs/ARCHITECTURE.md`, `docs/plans/composio-shapes.md`, `docs/plans/workspace-approvals.md`, `docs/voice-audiocpp.md` (for what NOT to touch in `voice-*.ts`), and `packages/contracts/src/review.ts`.
- `POL1`, `TOOLS1`, and `SHARE1` get the how skill (parallel design exploration before implementing). `POL1` also gets the interrogate skill before shipping, because the precedence service is a contested design with a safety consequence.
- Keep the decision trail per the show-me-your-work skill, one row per tick, committed only if the operator asks for an auditable record.
- The plan checker reruns with `node ~/.agents/skills/pstack-plugins/pstack/skills/poteto-mode/scripts/check-plan.mjs docs/plans/refactor-2026-11.md`.
