# A3 live lanes

Local dev stack, test account, Bot "Atlas", Claude desktop browser pane at an emulated 1280 x 800 unless stated. Lane 6 and the perf probe ran in headless Chromium (Chrome for Testing build 1243, through the repo's Playwright).

1. Regression lane against trunk. Pass. Before expanding, the panel is A2's wide tab, 500 px beside a 682 px chat at 1280 px (`regression.jpg`).
2. Expand. Pass. The chat keeps 440 px, the artifact takes 776 px, and the chat list hides (`expanded.jpg`).
3. Revise while expanded. Pass. "Make the dice roller purple" landed as v4 of 4 in place, and a MutationObserver on `.app` logged no class change through the whole turn (`revise-expanded.jpg`). An earlier attempt came back collapsed. The app had stopped the dev servers at the usage-limit pause, and Vite reloaded the page, which resets in-memory state.
4. Escape. Pass. With focus in Orbit, Escape returns to the wide tab on the same artifact. Escape does nothing while focus is inside the sandboxed frame, because key events do not cross it. The Collapse button covers that case.
5. Narrow window. Pass, run at 800 px, not 375 px, because Orbit's shell does not fit a phone. Expanded, the artifact covers the chat and shows a "Conversation" back button that collapses it (`narrow-expanded.jpg`, `narrow-back.jpg`). At 800 px the chat's existing 424 px minimum plus the 360 px panel overflows slightly, the same as trunk.
6. New window. Pass in headless Chromium. The window page received the probe over postMessage, cleared `window.opener`, and framed it with the app's sandbox. The probe read `top.opener` as null, `parent.document`, `document.cookie` and `localStorage` were blocked with SecurityError, and the origin was "null" (`new-window.png`). The Claude browser pane opens popups in the same tab without an opener, and the page then shows its fallback message (`pane-popup-fallback.jpg`).
7. Switch Bots while expanded. Pass. Through Cmd+K search to Lane Seven, the view collapsed, the chat list returned, and Lane Seven shows no Artifact tab (`switch-collapses.jpg`).
8. Voice call while expanded. Not run. No voice model is installed on this stack.
9. Page state through expand. Pass. The same iframe element survives expand and collapse with zero reloads, so a running page keeps its state.
10. Desktop app. Not run. The pane cannot drive Electron. The desktop shell denies every same-origin window (`apps/desktop/src/app-window.ts:150`), so the panel hides "Open in new window" there.
