# Team primaries, device permissions, and research on a Bot's own computer

Three changes that touch every Bot. This page is the short version; the code comments carry the
detail.

## Primary Bots

`bots.is_primary` is a set with two invariants, both enforced by `domain/primary-bots.ts`:

- at most **3** primary Bots at once
- at least **1**, always

A primary carries the star beside its avatar and is the only kind of Bot that may create, edit,
delete or re-rank other Bots. The HTTP routes (`POST /api/bots/:id/primary`,
`POST /api/bots/:id/primary/restore`, `PATCH`, `DELETE`) and the agent tools (`create_bot`,
`update_bot`, `delete_bot`, `set_primary_bot`, `list_bots`) call the same service
(`bot-admin.ts`), so the two surfaces cannot disagree about capacity, teardown order or the primary
set. Creating, editing and deleting used to live inline in `routes.ts`; they moved so an agent-side
change cannot forget the HTTP side.

Deleting the only primary is allowed and promotes the oldest remaining Bot, so a team keeps a
coordinator; it is the *restore* path that refuses to leave zero primaries.

The seed name is **Atlas** (`PRIMARY_BOT_NAME`). Installs created before the rename are repaired at
boot, matched on `is_primary` **and** the seed label so a Bot the user named "Doug" is untouched.

## Devices & permissions

Settings → **Devices & permissions** asks this computer for the microphone, camera, screen sharing
and speaker, one card each. It also lists the real devices and remembers the chosen ones
(`orbit.devices` in localStorage). Every capture stops its tracks in a `finally`, so a finished test
never holds a device open.

The Electron shell installs a narrow permission handler on the app window's session (media,
display-capture, fullscreen; nothing else) and, on macOS, asks TCC for microphone/camera when the
renderer requests them. The bundle carries `NSCameraUsageDescription`,
`NSMicrophoneUsageDescription` and `NSScreenCaptureDescription`: without them macOS terminates the
app when the device is touched.

A browser gets the same page, gated on what it actually supports: `navigator.mediaDevices`,
`getDisplayMedia` and Web Audio each report as unsupported where they are missing.

## Research on the Bot's computer

`computer_web_search`, `computer_image_search`, `computer_video_search`, `computer_browser` and
`computer_read_page` drive the Chrome on the Bot's own screen over CDP
(`lib/cdp.ts`, `computer-research.ts`). The prompt tells every Bot to prefer them for research: the
point is that the user can watch the tab open and the picture land, not just read an answer.

`computer_image_search` clicks the first Google Images tile to open the lightbox, downloads the
largest decoded pictures, writes them to `<bot library>/images/` and returns `[hq-file:…]` markers,
so they appear in the chat reply, the Library tab and the Files page.

The page scripts live in `computer-research-scripts.ts`; a unit test parses every one of them,
because a script that does not compile surfaces 30 seconds later as "the page did not load".

### Reproducing the acceptance run

With the desktop stack up (its published port is `ORBIT_WEB_PORT` in
`~/Library/Application Support/Orbit/stack/.env`) and its `SESSION_SECRET`:

```bash
cd apps/server
BASE=http://127.0.0.1:<stack port> SESSION_SECRET=<stack secret> npx tsx scripts/e2e-research.ts
```

The run drives a real Bot's browser: opens a tab, runs a Google search, saves Google Images into the
Library, verifies each file through `/api/files` and its download URL, takes a screenshot, reads a
YouTube results page, reads a page's text, and checks that a non-primary Bot is refused a team
change. It exits non-zero on any failure.

## Storage fix that came with the research tools

The compose files now set `BOT_DATA_DIR=/data/files`. It used to default inside the API container's
writable layer, so `docker compose up --force-recreate` deleted every Library file and screenshot
while messages kept pointing at them.
