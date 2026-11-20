# A1 live lanes

Local dev stack, test account, Bot "Atlas", driven in the Claude desktop browser pane.

1. Regression lane against trunk. Pass. Trunk: plain question gives message, one terminal step, answer (`plain-answer-trunk.jpg`, rows 14 to 16). Head: same shape (`no-artifact.jpg`, rows 11 to 13). No artifact step on either.
2. Create. Pass. Row 2 is `artifact`, done, args `{artifactId: art_Iwzk0VOlmAC9, title, html}`, html starts `<!DOCTYPE html>` (`create.jpg`).
3. Revise. Pass. "Make the timer red" wrote row 5 with the same `art_Iwzk0VOlmAC9` and red colours (`update.jpg`).
4. Two artifacts in one message. Pass. Rows 8 and 9 carry `art_lAmbsJDRlgym` and `art_nUUmoiIOklha`.
5. Too large. Partial. Refusal verified through the MCP call path, not a live model turn (`too-large.txt`). Model recovery not observed.
6. Reload. Pass. The server restarted twice (tsx watch) and the page reloaded. All artifact rows came back unchanged (`reload.jpg`).
7. SSE sync. Pass. A second tab showed the two-artifact turn live, no reload (`sse-sync.jpg`).
8. No artifact needed. Pass. "What time is it in Tokyo" used a terminal step, no `artifact` (`no-artifact.jpg`).
9. No HTML in chat. Pass. Reply text for rows 3, 6 and 10 holds no HTML (`no-html-in-chat.jpg`).
10. Probe. Pass. No `response.function_call_arguments.delta` from Hermes (`event-types.txt`). A4 is not buildable on this Hermes.
