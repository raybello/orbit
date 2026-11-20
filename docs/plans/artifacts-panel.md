# Artifacts and right-panel tabs plan

Orbit's right panel gains an Artifact tab. When a Bot builds a page, dashboard, or tool, the person sees it rendered live beside the chat and can expand it to a full-page view, much as Claude.ai shows artifacts.
Bots produce artifacts through a dedicated server tool, `artifact`. Each call is a transcript row, so artifacts persist, sync over SSE, and keep a version per update.
Every artifact renders in an `<iframe sandbox="allow-scripts">` with an opaque origin. Model HTML never runs with Orbit's origin, cookies, or parent window.
Later PRs add File preview and Code tabs on the same tab registry.
assistant-ui is not adopted in this program. It is MIT and fits through `useExternalStoreRuntime`, but its artifact demo assumes a browser-side AI SDK loop that Orbit does not have. Appendix B records the follow-up evaluation.
PR ids in order. A1 server tool. A2 Artifact tab and card. A3 full-page expand. A4 live streaming (conditional on the A1 probe). A5 File preview tab. A6 Code tab.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `pstack/skills/poteto-mode/playbooks/autopilot-stack.md` with one standing operator override. No subagents. The root chat builds, verifies, and opens every PR itself, in sequence, and runs every live lane itself in the Claude desktop browser pane. The operator lands every PR. A2, A3, A5, and A6 change an interaction and stop at merge-ready for the operator's review.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them before each PR.
  - [ ] `git show origin/main:docs/plans/artifacts-panel.md`
  - [ ] `git show origin/main:apps/web/src/components/DetailsPanel.tsx`
  - [ ] `git show origin/main:apps/web/src/components/Transcript.tsx`
  - [ ] `git show origin/main:apps/server/src/agent/loop.ts`
  - [ ] `git show origin/main:apps/server/src/agent/tools/registry.ts`
- [ ] Do not arm `/loop 1h`. The operator's no-subagent rule makes the run one inline chat, so there is no fleet to audit. Post a status message to the operator in chat when a PR opens, reaches merge-ready, or hits a blocker.
- [ ] On the operator's hold, stop writing at once and report the branch and the last green SHA.

### Spawn owners

- [ ] Spawn no owners. The root owns every PR, one at a time, per the operator's rule.
- [ ] Follow this dependency graph.
  - [ ] A1 is first and branches from `main`.
  - [ ] A2 after A1. A3 after A2.
  - [x] A4 is closed. The A1 probe found no `response.function_call_arguments.delta` events. See Appendix A.
  - [ ] A5 after A2. A6 after A5.
- [ ] Hold the file boundaries. A1 touches only `apps/server/src/**` and `packages/contracts/src/**`. A2 through A6 touch only `apps/web/src/**`, except A4, which also touches `apps/server/src/agent/loop.ts`.
- [ ] Hold the review gate. A2, A3, A5, and A6 wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Use `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, with `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run `pnpm typecheck` and `pnpm test` once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Commit messages and PR bodies carry no AI attribution, per the operator's global rule.
- [ ] Triage every review comment on its merits per `../references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the merge-ready report.

### Verdict and merge, for every PR

- [ ] The root runs the ten live lanes and the perf lane itself at the merge-ready head, then rereads the diff against the PR body as its own audit lane.
- [ ] A finding blocks when it breaks a lane's pass predicate, the sandbox rule, or an existing test. A failure in a lane marked `Regression lane against trunk.` that also fails on trunk is recorded against trunk and does not block.
- [ ] The root stops at merge-ready. The operator lands the stack bottom-up.

### Boot recipe, for every live lane

Each live lane runs on the operator's machine at the PR head, driven through the built-in browser pane (`mcp__Claude_Browser__*`).

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] `pnpm dev`, then open the web app in the browser pane with `preview_start`. Wait until a Bot's transcript loads.
- [ ] Drive input through the pane's click and type actions. Read state with `read_page` and `read_console_messages`. Use low-resolution screenshots (`scale: 0.5`).
- [ ] Save every screenshot to `docs/evidence/artifacts/<pr-id>/<slug>.png` and list the paths in the PR body.

## Add the artifact tool to the server (A1)

**Depends on.** None.

**Files.**

- [ ] Create `apps/server/src/agent/artifact-tool.ts`.
- [ ] Edit `apps/server/src/agent/tools/registry.ts`.
- [ ] Edit `apps/server/src/agent/prompt.ts`.
- [ ] Edit `packages/contracts/src/index.ts`.
- [ ] Create `apps/server/src/__tests__/artifact-tool.test.ts`.

**Build.**

- [x] Add `ArtifactArgs` to contracts as `{ artifactId: ArtifactId; title: string; html: string }`, with `ArtifactId` branded in `branded-types.ts`. Add `artifactArgsOf(body: ToolCallBody): ArtifactArgs | null`, which parses at the boundary instead of a boolean check. `ToolResult.rowArgs` lets the tool rewrite its own row's args, so the minted id lands in the row.
- [ ] Define `ARTIFACT_TOOL` as a `ToolDef` named `artifact` with `artifact_id` (optional, reuse to update), `title`, and `html`. Mint an id when none is given. Reject `html` over 512 KiB with a message the model can act on. Return the id in `output` so the model can update the same artifact.
- [ ] Register it beside `BOT_TOOLS` in `registry.ts`.
- [ ] Add two sentences to the system prompt. Use `artifact` for a page, visualization, or interactive tool, with a complete HTML document. Pass the same `artifact_id` to revise it, and never paste artifact HTML into chat.
- [ ] Probe once, on a dev stack, whether the Hermes event stream emits `response.function_call_arguments.delta` for this tool. Log every event type seen during one artifact turn to `docs/evidence/artifacts/A1/event-types.txt`.

**You see.**

- [ ] Asking a Bot "make a pomodoro timer page" writes a `tool-call` row with `name: 'artifact'` and `args.html` starting `<!doctype html>`. The step list shows the call as done.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `artifact-tool.test.ts` covers a new id when none is given, the same id echoed on update, rejection over 512 KiB, and an empty `html` refused. Run `pnpm --filter @orbit/server test`.
- [ ] The contracts typecheck proves a raw string cannot pass as `ArtifactId`. Run `pnpm typecheck`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `root chat, browser pane` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask the same Bot for a plain text answer at trunk and head. Save `plain-answer.png`. Pass when both render the same message row and no artifact step appears.
- [ ] Lane 2. Ask for a pomodoro timer page. Save `create.png`. Pass when one `artifact` step shows done and the row's `args.html` is a full document.
- [ ] Lane 3. Ask "make the timer red". Save `update.png`. Pass when a second `artifact` row carries the same `artifactId` as lane 2.
- [ ] Lane 4. Ask for two different pages in one message. Save `two-ids.png`. Pass when two rows carry two distinct ids.
- [ ] Lane 5. Ask for a page with a deliberately huge inline dataset. Save `too-large.png`. Pass when the tool refuses with the size message and the Bot recovers with a smaller page.
- [ ] Lane 6. Reload the browser after lane 3. Save `reload.png`. Pass when both artifact rows come back from the server unchanged.
- [ ] Lane 7. Open the same chat in a second tab during lane 2. Save `sse-sync.png`. Pass when the second tab receives the artifact row over SSE without reload.
- [ ] Lane 8. Ask a question that needs no artifact ("what time is it in Tokyo"). Save `no-artifact.png`. Pass when the Bot does not call `artifact`.
- [ ] Lane 9. Inspect the Bot's chat text after lane 2. Save `no-html-in-chat.png`. Pass when the message text holds no HTML block.
- [ ] Lane 10. Run the probe turn. Save `probe.png`. Pass when `event-types.txt` exists and states whether argument deltas arrive.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. SSE `rows` payload bytes and `GET /api/bots/:id/rows` latency for a transcript with one 200 KiB artifact. Trunk lacks the feature, so also time the diff-added work, the tool's validate-and-append step.
- [ ] Probe. Seed a transcript with 50 messages, then fetch rows ten times interleaved at trunk (no artifact) and head (plus one 200 KiB artifact) with `curl -w '%{time_total}'`.
- [ ] Baseline. Record the trunk median latency first.
- [ ] Rule. Fail when the head median exceeds the trunk median by more than 50 ms, or when the tool step takes more than 20 ms.

**Review gate.** None. A1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands A1.

## Show artifacts in a right-panel tab and a chat card (A2)

**Depends on.** A1.

**Files.**

- [ ] Create `apps/web/src/domain/artifacts.ts`.
- [ ] Create `apps/web/src/components/ArtifactPanel.tsx`.
- [ ] Create `apps/web/src/components/ArtifactFrame.tsx`.
- [ ] Create `apps/web/src/components/cards/ArtifactCard.tsx`.
- [ ] Create `apps/web/src/styles/artifact.css`.
- [ ] Edit `apps/web/src/components/DetailsPanel.tsx`.
- [ ] Edit `apps/web/src/components/Transcript.tsx`.
- [ ] Edit `apps/web/src/store.ts`.
- [ ] Create `apps/web/src/__tests__/ArtifactPanel.test.tsx` and `apps/web/src/lib/artifacts.test.ts`.

**Build.**

- [ ] Write `artifactsOf(rows: Row[]): Map<ArtifactId, ArtifactVersion[]>` in `domain/artifacts.ts`, a pure fold over `artifact` tool-call rows ordered by `seq`. `ArtifactVersion` is `{ seq, title, html, createdAt }`.
- [ ] Turn the `tabs` array in `DetailsPanel.tsx` into a typed registry, `DETAILS_TABS: Record<DetailsTab, { label; render }>`, and add `artifact`. Hide the Artifact tab until the chat has at least one artifact.
- [ ] Add `openArtifact: { botId; artifactId; seq } | null` to the store. Opening sets it, opens the panel, and selects the Artifact tab.
- [ ] `ArtifactFrame` renders `<iframe sandbox="allow-scripts allow-forms allow-modals" srcDoc={html}>` and never adds `allow-same-origin`. One component owns the sandbox string.
- [ ] `ArtifactPanel` shows the title, a Preview and Source toggle, a version picker ("v2 of 3"), copy source, and download as `.html`.
- [ ] In `Transcript.tsx`, render an `artifact` tool call as `ArtifactCard` (title, version, Open button) instead of a `StepRow` with raw args.

**You see.**

- [ ] After lane 2 of A1, the chat shows a "Pomodoro timer" card. Clicking Open shows the timer running in the right panel's Artifact tab.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `artifacts.test.ts` covers versions grouped by id in `seq` order, non-artifact rows ignored, and malformed args skipped. Run `pnpm --filter @orbit/web test`.
- [ ] `ArtifactPanel.test.tsx` asserts the iframe's `sandbox` attribute lacks `allow-same-origin`, the version picker switches `srcdoc`, and the tab is absent with no artifacts. Run `pnpm --filter @orbit/web test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `root chat, browser pane` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open a chat with no artifacts and cycle every right-panel tab at trunk and head. Save `tabs-regression.png`. Pass when Screen, Activity, Tasks, Library, and Engine render the same and no Artifact tab shows.
- [ ] Lane 2. Click Open on a fresh artifact card. Save `open-from-card.png`. Pass when the Artifact tab is selected and the page renders and responds to clicks.
- [ ] Lane 3. Load an artifact whose script reads `parent.document` and `document.cookie`. Save `sandbox-escape.png`. Pass when the console shows a SecurityError, the cookie read is empty, and Orbit's UI is untouched.
- [ ] Lane 4. Switch from v2 to v1 with the version picker. Save `versions.png`. Pass when the frame shows v1 and the card in chat still reads v2 as latest.
- [ ] Lane 5. Toggle to Source and copy it. Save `source.png`. Pass when the source matches `args.html` byte for byte.
- [ ] Lane 6. Download the artifact. Save `download.png`. Pass when a `.html` file with the artifact title is saved.
- [ ] Lane 7. Switch to another Bot and back. Save `bot-switch.png`. Pass when the other Bot shows no stale artifact and the first Bot's tab reopens on the same artifact.
- [ ] Lane 8. Close and reopen the panel with Shift+Comma. Save `panel-toggle.png`. Pass when the Artifact tab and artifact survive the toggle.
- [ ] Lane 9. Use arrow keys across the tab bar. Save `keyboard.png`. Pass when focus moves through the Artifact tab and the panel announces it.
- [ ] Lane 10. Run lane 2 inside the desktop app (`pnpm desktop`). Save `desktop.png`. Pass when the artifact renders in Electron with the same sandbox behavior.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Transcript commit time when one row updates (React Profiler) and time from clicking Open to the iframe `load` event. Trunk lacks the feature, so also measure the diff-added `artifactsOf` fold.
- [ ] Probe. Profile ten interleaved runs at trunk and head on the same 200-row transcript, with head adding three 200 KiB artifacts.
- [ ] Baseline. Record the trunk median commit time first.
- [ ] Rule. Fail when the head median commit exceeds trunk by more than 2 ms, `artifactsOf` exceeds 1 ms, or Open to `load` exceeds 300 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 4 screenshots into `docs/evidence/artifacts/A2-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of creating, opening, and switching versions. Save it as `docs/evidence/artifacts/A2-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands A2.

## Expand an artifact to a full-page view (A3)

**Depends on.** A2.

**Files.**

- [ ] Edit `apps/web/src/components/ChatView.tsx`.
- [ ] Edit `apps/web/src/components/ArtifactPanel.tsx`.
- [ ] Edit `apps/web/src/store.ts`.
- [ ] Edit `apps/web/src/styles/artifact.css` and `apps/web/src/styles/shell.css`.
- [ ] Create `apps/web/public/artifact-window.html`.

**Build.**

- [ ] Add `artifactExpanded: boolean` to the store. Expand narrows the chat column to a fixed reading width and gives the rest of the window to the artifact. Escape and a Collapse button return to the tab.
- [ ] Below 900 px wide, expand covers the chat fully, with a back button.
- [ ] Add "Open in new window". It opens the static `artifact-window.html`, which hosts the same sandboxed iframe and receives the HTML by `postMessage` from the opener. Never open a `blob:` URL, because it inherits Orbit's origin.

**You see.**

- [ ] Clicking Expand slides the artifact to fill the window beside a narrow chat. The composer still works, and a new version appears in place.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `ArtifactPanel.test.tsx` gains cases for Expand toggling `artifactExpanded`, Escape collapsing, and the new-window path posting HTML only to its own window. Run `pnpm --filter @orbit/web test:ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `root chat, browser pane` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk lacks expand. Run the A2 open-from-card scenario at trunk (no artifacts) and head. Save `regression.png`. Pass when the head panel layout matches A2 before expanding.
- [ ] Lane 2. Expand an artifact. Save `expanded.png`. Pass when the artifact fills the window beside a narrow chat.
- [ ] Lane 3. Send a revision while expanded. Save `revise-expanded.png`. Pass when the new version replaces the frame without collapsing.
- [ ] Lane 4. Press Escape. Save `collapse.png`. Pass when the view returns to the panel tab on the same version.
- [ ] Lane 5. Resize the pane to 375 px with `resize_window` mobile, then expand. Save `mobile.png`. Pass when the artifact covers the chat and the back button returns.
- [ ] Lane 6. Open in new window. Save `new-window.png`. Pass when the window renders the artifact and `window.opener` access from the artifact throws.
- [ ] Lane 7. Expand, then switch Bots. Save `switch-collapses.png`. Pass when the view collapses and the new Bot shows no artifact.
- [ ] Lane 8. Expand during an active voice call. Save `voice.png`. Pass when the voice bar stays visible and usable.
- [ ] Lane 9. Expand an artifact with a canvas animation. Save `animation.png`. Pass when it keeps running through expand and collapse.
- [ ] Lane 10. Repeat lane 2 in the desktop app. Save `desktop.png`. Pass when the title bar and layout match the web app.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Frames dropped during the expand transition. Trunk lacks the feature, so the budget is absolute on the diff-added transition.
- [ ] Probe. Record a Performance trace across ten interleaved expand and collapse runs at head, and ten panel open and close runs at trunk.
- [ ] Baseline. Record the trunk panel toggle frame time first.
- [ ] Rule. Fail when any expand drops more than 2 frames at 60 Hz or the transition exceeds 250 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 5, and 6 screenshots into `docs/evidence/artifacts/A3-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of expand, revise, collapse, and new window. Save it as `docs/evidence/artifacts/A3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands A3.

## Stream an artifact while the Bot writes it (A4)

**Depends on.** A2, and the A1 probe showing argument deltas.

**Files.**

- [ ] Edit `apps/server/src/agent/loop.ts`.
- [ ] Edit `apps/web/src/components/ArtifactPanel.tsx`.
- [ ] Edit `apps/web/src/components/cards/ArtifactCard.tsx`.

**Build.**

- [ ] In `loop.ts`, handle `response.function_call_arguments.delta` for `artifact` only. Append a `running` tool-call row on the first delta and rewrite its partial `html` with `updateRow`, throttled to one write per 250 ms.
- [ ] While the row is `running`, the panel shows Source scrolling live and the card reads "Writing". The frame swaps to Preview once the row is `done`.

**You see.**

- [ ] The source streams into the panel as the Bot writes, and the preview appears when the call finishes.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] A server test feeds recorded delta events through the loop and asserts at most one row write per 250 ms and a final row equal to the complete args. Run `pnpm --filter @orbit/server test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `root chat, browser pane` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Stream a long text answer at trunk and head. Save `text-stream.png`. Pass when text streaming looks and paces the same.
- [ ] Lane 2. Ask for a large page. Save `streaming-source.png`. Pass when source grows in the panel before the call completes.
- [ ] Lane 3. Watch the swap at completion. Save `swap.png`. Pass when Preview replaces Source within 300 ms of `done`.
- [ ] Lane 4. Stop the Bot mid-artifact. Save `stopped.png`. Pass when the card reads stopped and no broken preview renders.
- [ ] Lane 5. Reload mid-stream. Save `reload-mid.png`. Pass when the partial source resumes and finishes.
- [ ] Lane 6. Stream with the panel closed. Save `panel-closed.png`. Pass when the card shows "Writing" and Open lands on live source.
- [ ] Lane 7. Stream in two Bots at once. Save `two-bots.png`. Pass when each panel shows only its own Bot's artifact.
- [ ] Lane 8. Stream while expanded (A3). Save `expanded-stream.png`. Pass when the expanded view streams too.
- [ ] Lane 9. Stream on the desktop app. Save `desktop.png`. Pass when it matches the web app.
- [ ] Lane 10. Throttle the network to Slow 3G in the pane. Save `slow.png`. Pass when the stream stays ordered and completes.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Row writes per second and main-thread time per SSE update during one 200 KiB artifact.
- [ ] Probe. Ten interleaved runs at A2 (no streaming) and head, same prompt, same model.
- [ ] Baseline. Record the A2 main-thread total first.
- [ ] Rule. Fail above 4 row writes per second or above 8 ms main-thread time per update.

**Review gate.** None. A4 is not review-gated, because it changes timing, not the interaction A2 already passed review on.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands A4.

## Preview library files in a right-panel tab (A5)

**Depends on.** A2.

**Files.**

- [ ] Create `apps/web/src/components/FilePreviewPanel.tsx`.
- [ ] Create `apps/web/src/domain/file-preview.ts`.
- [ ] Edit `apps/web/src/components/DetailsPanel.tsx`.
- [ ] Edit `apps/web/src/components/FilePart.tsx` and `apps/web/src/components/FilesView.tsx`.

**Build.**

- [ ] Write `previewKindFor(mediaType, filename)` as a table returning `html`, `markdown`, `csv`, `pdf`, `image`, `text`, or `none`.
- [ ] Add a `preview` entry to `DETAILS_TABS`. Clicking a file chip or a Files row opens it there instead of downloading.
- [ ] HTML renders through `ArtifactFrame`. Markdown reuses `Markdown.tsx`. CSV renders a table of the first 1,000 rows. PDF and images use the browser. `none` falls back to the download chip.

**You see.**

- [ ] Clicking `report.md` in a message shows it formatted in the Preview tab.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `file-preview.test.ts` covers every row of the table plus unknown types. Run `pnpm --filter @orbit/web test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `root chat, browser pane` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Click an image chip at trunk and head. Save `image.png`. Pass when the lightbox behavior is unchanged.
- [ ] Lane 2. Open a Markdown file. Save `markdown.png`. Pass when it renders formatted.
- [ ] Lane 3. Open a CSV file. Save `csv.png`. Pass when a table shows with headers.
- [ ] Lane 4. Open a PDF. Save `pdf.png`. Pass when it renders in the panel.
- [ ] Lane 5. Open an `.html` library file. Save `html.png`. Pass when it renders sandboxed like an artifact.
- [ ] Lane 6. Open a `.zip`. Save `zip.png`. Pass when it falls back to the download chip.
- [ ] Lane 7. Open a file from the Files view. Save `files-view.png`. Pass when the Preview tab opens on it.
- [ ] Lane 8. Open a file that was deleted. Save `missing.png`. Pass when the panel says it is gone, with no broken glyph.
- [ ] Lane 9. Open a 20 MB CSV. Save `big-csv.png`. Pass when the first 1,000 rows show and the UI stays responsive.
- [ ] Lane 10. Repeat lane 2 in the desktop app. Save `desktop.png`. Pass when it matches the web app.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Click to first paint of the preview for a 1 MB Markdown file. Trunk downloads instead, so the budget is absolute.
- [ ] Probe. Ten interleaved runs at trunk (time to download start) and head (time to paint).
- [ ] Baseline. Record the trunk download-start time first.
- [ ] Rule. Fail when head paint exceeds 500 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 5 screenshots into `docs/evidence/artifacts/A5-review-<slug>.png`.
- [ ] Record a 30 to 60 second video previewing each file kind. Save it as `docs/evidence/artifacts/A5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands A5.

## Show code the Bot wrote in a Code tab (A6)

**Depends on.** A5.

**Files.**

- [ ] Create `apps/web/src/components/CodePanel.tsx`.
- [ ] Create `apps/web/src/domain/code-edits.ts`.
- [ ] Edit `apps/web/src/components/DetailsPanel.tsx`.

**Build.**

- [ ] First, record which Hermes tool calls write files and what their `args` carry (path, full content, or patch). Save the list to `docs/evidence/artifacts/A6/edit-tools.txt`. If no call carries content, stop and report. The tab cannot be built from rows alone.
- [ ] Write `codeEditsOf(rows)` returning `{ path, before?, after, seq }[]` from those calls.
- [ ] Add a `code` entry to `DETAILS_TABS`. It lists edited files and shows a unified diff, or the full file for a new one, syntax-highlighted with the existing `CodeEditor` in read-only mode.

**You see.**

- [ ] After a Bot edits `script.py`, the Code tab lists it and shows the diff.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `code-edits.test.ts` covers each recorded edit tool shape and ignores other calls. Run `pnpm --filter @orbit/web test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `root chat, browser pane` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask for a code edit at trunk and head. Save `steps.png`. Pass when the step list in chat is unchanged.
- [ ] Lane 2. Ask the Bot to create a new file. Save `new-file.png`. Pass when the Code tab shows its full contents.
- [ ] Lane 3. Ask the Bot to edit it. Save `diff.png`. Pass when the tab shows a diff with the change.
- [ ] Lane 4. Edit three files in one turn. Save `three.png`. Pass when all three are listed.
- [ ] Lane 5. Edit the same file twice. Save `twice.png`. Pass when the latest edit shows and history is reachable.
- [ ] Lane 6. Open a file from the list in Preview (A5). Save `to-preview.png`. Pass when it opens there.
- [ ] Lane 7. Switch Bots. Save `bot-switch.png`. Pass when no edits leak across Bots.
- [ ] Lane 8. Edit a 5,000-line file. Save `big.png`. Pass when the diff renders without freezing.
- [ ] Lane 9. Keyboard through the file list. Save `keyboard.png`. Pass when every file is reachable.
- [ ] Lane 10. Repeat lane 3 in the desktop app. Save `desktop.png`. Pass when it matches the web app.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time to render a diff of a 5,000-line file. Trunk lacks the feature, so the budget is absolute.
- [ ] Probe. Ten runs at head, interleaved with ten trunk transcript renders of the same turn.
- [ ] Baseline. Record the trunk transcript render first.
- [ ] Rule. Fail when the diff takes over 200 ms or the transcript render regresses by more than 2 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 4 screenshots into `docs/evidence/artifacts/A6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a create and an edit. Save it as `docs/evidence/artifacts/A6-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator lands A6.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with each PR link, what each lane proved, and what stays unproven.

## Appendix A. Prototype evidence

No prototype ran before this plan. Two questions stay unproven and are settled inside the program.

- Whether Hermes emits `response.function_call_arguments.delta`. Settled by A1 lane 10 on 2026-11-19. It does not. A function call arrives whole in `response.output_item.added` and `response.output_item.done` (`docs/evidence/artifacts/A1/event-types.txt`). A4 is closed as not buildable on this Hermes. The person sees "Thinking" for the 60 to 90 seconds the model spends writing the HTML. A2's card should say "Building an artifact" as soon as the row lands, and a Hermes change is the only route to live source.
- What file-edit tool calls carry in `args`. A6's first Build box settles it and can stop A6.
- Where file previews live. Settled by the operator on 2026-11-19, after PR #42 shipped a file viewer dialog. A5 extends that dialog (HTML in the artifact sandbox, CSV as a table, chat attachments open in it) instead of adding a Preview tab. PDF stays a download, because inline PDF needs the data route's sandboxing CSP relaxed.

Settled by reading code, not by a run.

- The raw library route serves `.html` as `attachment` with `nosniff` (`apps/server/src/routes-config.ts:433`), so library HTML never renders with Orbit's origin today.
- The assistant-ui artifact demo drives `unstable_interactableTool` from a Next.js `/api/chat` route on the AI SDK (`examples/with-artifacts/app/api/chat/route.ts`). Orbit's model loop runs in Hermes on the server.

## Appendix B. Alternatives rejected

- **Swap Transcript and Composer to assistant-ui now.** Orbit's transcript already carries streaming, tool-step groups, approval cards, voice, and skill suggestions. Porting them buys branching, editing, and scroll polish but does not help artifacts. Deferred to a separate prototype. Feed real Orbit rows into `useExternalStoreRuntime` with assistant-ui's unstyled primitives on a throwaway branch and compare side by side.
- **assistant-ui's interactable artifact tool.** It is `unstable_`, assumes frontend tools on a browser-side loop, and its state lives in the client. Orbit needs artifacts as server rows that persist and sync.
- **`safe-content-frame`.** MIT and well built, but it loads frames from `scf.auiusercontent.com`. Self-hosting needs a domain on the Public Suffix List with wildcard TLS. That breaks offline desktop use and sends every artifact to a third-party host. A local opaque-origin sandbox gives the isolation Orbit needs.
- **Artifacts as library `.html` files only.** Zero server work, but no live streaming and no version identity. Kept as a path through A5 Preview.
- **Web preview tab.** Most sites refuse framing through `X-Frame-Options` or CSP, and a dev server inside a Bot's computer is not reachable from the person's browser. The Screen tab already shows the Bot's real browser. Held out of the program pending the operator's call.

## Appendix C. Risks

- **Sandbox regression (A2, A3, A5).** One added `allow-same-origin` would give model code Orbit's cookies. `ArtifactFrame` owns the only sandbox string, and an A2 unit test asserts it.
- **Row size (A1, A4).** 512 KiB artifacts ride every SSE `rows` event and the rows fetch. A1 perf watches latency. If it fails, store HTML out of row and keep a reference.
- **Artifacts that fetch the network.** Sandboxed pages may still load CDN scripts. That is useful and expected. A CSP on `srcdoc` could restrict it later if the operator wants offline-only artifacts.
- **Electron.** The desktop shell may treat sandboxed frames differently. A2 lane 10 and A3 lane 10 cover it.
- **No control skill.** `control-ui` from `cursor-team-kit` is not installed here, so lanes drive the Claude desktop browser pane instead.
- **Mobile app.** `apps/mobile` is out of scope. Artifacts show there as a normal tool step until a later plan.

## Appendix D. Links and reading list

- assistant-ui repository, MIT. https://github.com/assistant-ui/assistant-ui
- The with-artifacts example. https://github.com/assistant-ui/assistant-ui/tree/main/examples/with-artifacts
- ExternalStoreRuntime docs, for the deferred evaluation. `apps/docs/content/docs/runtimes/custom/external-store.mdx` in that repository.
- Orbit files to read before editing. `apps/web/src/components/DetailsPanel.tsx`, `apps/web/src/components/Transcript.tsx`, `apps/server/src/agent/loop.ts`, `apps/server/src/agent/bot-tools.ts`, `packages/contracts/src/index.ts`.
- A2 gets an interrogate pass on the sandbox design if the operator allows a second model. Under the no-subagent rule, the root does a written self-review instead.
