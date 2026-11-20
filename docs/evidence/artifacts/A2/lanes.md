# A2 live lanes

Local dev stack, test account, Bot "Atlas" with the four artifacts A1 produced, driven in the Claude desktop browser pane at 1142 px wide.

1. Regression lane against trunk. Pass. With no artifacts, the tab bar is Screen, Activity, Tasks, Library, Engine, same as trunk (`bot-switch-other.jpg`, and the UI test "stays out of the tab bar").
2. Open from card. Pass. Dice Roller opened in the Artifact tab, the card reads "Showing", and Roll works inside the frame (`open-from-card.jpg`).
3. Sandbox escape. Pass. A synthetic artifact (inserted, then deleted) tried five reads. `parent.document`, `top.location`, `document.cookie` and `localStorage` all threw SecurityError, and `location.origin` read "null" (`sandbox-escape.jpg`).
4. Versions. Pass. The picker went from "v2 of 2 (latest)" (red) to "v1 of 2" (tomato) (`versions-latest.jpg`, `versions-v1.jpg`).
5. Source. Pass. The Source view text is identical to the row's `args.html`, 6,541 characters (`source.jpg`).
6. Download. Pass. The button builds a `blob:` link named `pomodoro-timer.html`. The click was intercepted, so no file was saved.
7. Bot switch. Pass. Lane Seven (a new, empty Bot) shows no Artifact tab and no frame. Back on Atlas, the panel restores Pomodoro Timer at the pinned v1 (`bot-switch-other.jpg`, `bot-switch-back.jpg`).
8. Panel toggle. Pass. After the panel was closed, Shift+Comma reopened it on Artifact, Pomodoro Timer, v1 of 2 (`panel-toggle.jpg`). The Preview/Source choice resets to Preview.
9. Keyboard. Pass. From Artifact, ArrowRight focuses and selects Screen, and ArrowLeft returns to Artifact. The tab panel is labelled by the Artifact tab and the frame is titled "Preview of Pomodoro Timer".
10. Desktop app. Not run. The browser pane cannot drive an Electron window. Read from code: the window is `sandbox: true`, `contextIsolation: true`, and denies or externalizes every new window (`apps/desktop/src/app-window.ts:118,150`). That is why the frame drops `allow-popups`.

Found and fixed during the lanes: the wide panel squeezed the chat to about 140 px with the chat list open. The width is now capped (`width-capped.jpg`, 424 px chat beside a 362 px panel at 1142 px).
