# Workspace eval 2026-11-18

Server http://localhost:8799, toolkits pinned at 20261116_00, run 11181203. Test inbox and calendar: the connected test account.

## Scout (default model): 8/8

| Step | Result | Time | Detail |
|---|---|---|---|
| 1. draft an email, edit its subject, send it from the card | pass | 26s | arrived with the edited subject |
| 2. create a 30-minute call with a guest | pass | 25s | COMPOSIO_MULTI_EXECUTE_TOOL(GOOGLECALENDAR_CREATE_EVENT) |
| 3. move it to 4pm (a patch that keeps the guest) | pass | 29s | calendar_list → COMPOSIO_MULTI_EXECUTE_TOOL(GOOGLECALENDAR_PATCH_EVENT) |
| 4. read the week with calendar_list | pass | 21s | calendar_list |
| 5. duplicate the call as an Orbit event, then cancel the call | pass | 22s | deleted in Google; the linked Orbit event paused |
| 6. add three rows to a sheet (reviewed cell by cell) | pass | 33s | 3 rows under the header |
| 7. write a new doc (no card; a file card appears) | pass | 21s | Orbit eval 11181203-Scout doc · 3 preview lines |
| 8. a declined send is not retried | pass | 18s | declined once, not retried |
## How this run came about

- **First run, Scout 3/8.** It drafted and sent the edited email, filled the sheet and did not retry a declined send. It failed the calendar and doc steps for two reasons fixed before this run:
  - `calendar_list` said Google Calendar was not connected when the mirror simply had not synced yet (the eval server runs with the scheduler off; the same happened right after a person connects Calendar). It now syncs on demand when Calendar is connected but the mirror is empty.
  - The eval user had no timezone (it signs in from a script, so no device sent one), and the bot correctly asked for it before scheduling; the eval now sends one, as the web and mobile apps do. The doc prompt now gives the content instead of "this week's plan".
- **The primary agent was not evaluated.** It is the person's own Hermes, shared with their Orbit desktop app. Any second Orbit server that binds it rewrites its tool config every two minutes and restarts its gateway, so two servers fight (see the PR description). In the one turn it ran, it chose the right action with the right arguments (`tool_slug` + `arguments`) but called it by a guessed name: its Hermes loads MCP tools on demand, through `tool_search` and `tool_call`. The manifest now tells every bot to find on-demand tools with `tool_search` and call them by the exact name returned; that change is untested on the primary agent.
- The eval ran against a throwaway Orbit server (its own database, encryption key and engines folder) whose user is the Composio user the test Google account is connected under, with its primary-agent binding pointed at an empty folder so it could not touch the person's Hermes.
