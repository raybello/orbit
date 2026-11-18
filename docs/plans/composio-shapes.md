# Composio shapes: phase 0 findings

Captured 2026-11-18 with `scripts/composio-shapes.mjs` against the dedicated test Google account (Composio user `orbit-eval-test`), Composio SDK `@composio/core` 0.28.0, all four toolkits at version `20261116_00`. 38 of 39 calls succeeded; the one failure is finding 4.

Fixtures (redacted: addresses, names, Google ids and links replaced with stable placeholders):
- `apps/server/src/__tests__/fixtures/composio/schemas/`: input and output schemas for 32 actions, the tool router's meta-tool schemas, and `_summary.json` (version, required args, arg names).
- `apps/server/src/__tests__/fixtures/composio/responses/`: one request/response pair per call, plus `_index.json`.

## What differs from the plan, and the change it makes

1. **`COMPOSIO_MULTI_EXECUTE_TOOL` items are `{ tool_slug, arguments }`.** The router also accepts the older `tool_params` (verified: both run). Bots today are taught `tool_params`.
   → Phase 3 reads and patches either key, writing back to whichever the bot used. Phase 10 teaches `arguments`. `innerToolSlugs` stays as is.

2. **Router results are `data.results[i].{ tool_slug, index, response: { successful, data, error } }`** with `total_count`, `success_count`, `error_count`. One inner call can fail while the outer call reports `resultType: 'completed'`.
   → `runComposioTool` must check the inner `successful` flags. Today it reports a partial failure as success, so the tool row says "done" and the connection watch never hears about it. Fixed in phase 3.

3. **The server can run one action directly:** `composio.tools.execute(slug, { userId, arguments })`, with `toolkitVersions` pinned in the client. Unpinned calls throw `ComposioToolVersionRequiredError`.
   → Phases 4–8 add a `runAction(userId, slug, args)` helper in `composio.ts` with versions pinned to `20261116_00` in one constant. The SDK logs a warning for Gmail and Docs actions that accept file uploads; auto-upload stays off and attachments are shown read-only on cards.

4. **`GOOGLECALENDAR_UPDATE_EVENT` replaces the whole event.** Updating only the title and time removed the event's attendees, location and description (the Meet link survived). The following `REMOVE_ATTENDEE` then failed with "Attendee not found". A bot that "moves a meeting" with `UPDATE_EVENT` today silently drops its guests.
   → The Event card always runs `PATCH_EVENT` with only the changed fields. When a bot calls `UPDATE_EVENT`, the card is built from the current event (`EVENTS_GET`) plus the bot's changes and runs as a patch. The manifest (phase 10) tells bots to use `PATCH_EVENT` for changes. A unit test pins this.

5. **Create and patch name fields differently.** Create: `start_datetime` plus `event_duration_minutes` (or `end_datetime`), `timezone`, `attendees` as a list of addresses, `create_meeting_room` for Meet, `send_updates`. Patch: `start_time`, `end_time`, `timezone`, `attendees`, `conference_data`, `send_updates`. Google adds the organizer to `attendees` on create.
   → The Event card keeps one field model and maps it per action; the organizer is shown but cannot be removed.

6. **Calendar responses are wrapped inconsistently.** Create and update return `data.response_data.<event>`; get and patch return `data.<event>`; quick add returns `data.event`; instances return `data.items[]`.
   → One `readEvent(data)` normaliser in phase 5, tested against every fixture above.

7. **`EVENTS_LIST_ALL_CALENDARS` returns only a summary by default** (`summary_view[]`: title, start, end, is_all_day, calendar, event_id; `events` empty). `response_detail: 'full'` gives `events[]` of `{ event, source_calendar_id, source_calendar_summary, all_calendar_ids }`, de-duplicated across calendars, plus `calendars_queried` and `errors_by_calendar`.
   → The sync worker (phase 7) uses `full`, and treats a calendar listed in `errors_by_calendar` as "keep the old rows", not "everything was deleted".

8. **Gmail drafts:** create returns `data.id` (the draft id) and `data.message.{ id, threadId }`; send returns the sent message's `id` and `threadId`; `GET_DRAFT` returns `id` and the full `message` with headers. `REPLY_TO_THREAD` takes `message_body`, not `body`.
   → Matches phase 4; the Email card reads the payload headers for To, Cc and Subject.

9. **Sheets:** `BATCH_UPDATE` is a value write starting at `first_cell_location` (not a structural change). Structural changes are `ADD_SHEET`, `DELETE_SHEET`, `INSERT_DIMENSION`, `DELETE_DIMENSION` and similar. `EXECUTE_SQL` accepts `dry_run` and reports `operation` and `affected_rows`. Arg casing varies: `VALUES_APPEND` uses `spreadsheetId` and `valueInputOption`; most others use `spreadsheet_id`.
   → Phase 6 grid previews cover `VALUES_UPDATE`, `VALUES_APPEND`, `UPDATE_VALUES_BATCH` and `BATCH_UPDATE`. For `EXECUTE_SQL`, the server runs a `dry_run` first: a pure `SELECT` runs without a card, anything else gets a card showing the operation and row count. Phase 2's action catalogue records each action's exact argument names.

10. **Sheets and Docs cannot delete files.** Neither toolkit has a file delete (that is Google Drive's toolkit). "Deleting" in Q22 therefore means deleting content: sheets, rows, columns, ranges, tabs, headers.
    → Phase 2 catalogue marks those as review; the live eval leaves its sheets and docs in the test Drive, titled "Orbit eval …".

11. **Docs:** create returns `documentId`, `title`, `tab_ids`; `GET_DOCUMENT_PLAINTEXT` returns `plain_text` and is enough for the before/after text diff.

## Not changed by phase 0

- The SDK reports 0.30.0 is available. This PR stays on 0.28.0, the version the fixtures were captured with.
- `GMAIL_WHO_AM_I` returns an OpenID profile (`email`, `name`, `sub`); it is a read and is catalogued as one.

## Found later

12. **`event_duration_minutes` is capped at 59** on `GOOGLECALENDAR_CREATE_EVENT` (Composio rejects 60). Whole hours go in `event_duration_hour`, or the call gives `end_datetime`. The bot manifest says so (phase 10); the app's own calls always send `end_datetime`.

13. **Toolkit versions move under the app.** Composio published Gmail `20261118_00` two days after phase 0 (it only adds an optional `timezone` to drafts and replies). The server's own calls are pinned to `20261116_00`, but bots call through Composio's router, which uses the latest version. Schemas are now captured at the pinned version (`node scripts/composio-shapes.mjs schemas`), and `node scripts/composio-shapes.mjs drift` lists removed or newly required arguments in the latest versions; run it before moving the pin.
