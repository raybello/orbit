# A5 live lanes

Scope changed before building. PR #42 had already added one file viewer, a dialog used by the Library and the Files section. The operator chose to extend that dialog rather than add a Preview tab. So A5 adds HTML and CSV views to it and opens chat attachments in it.

Local dev stack, test account, Bot "Atlas". Atlas saved plan.md, cities.csv and report.html with save_file. save_file attaches nothing to the chat (it returns only `{ ok, path }`), so a synthetic assistant message carried those files plus site.zip and a missing gone.md as attachments. It was deleted afterwards.

1. Regression lane against trunk. Not driven. Image attachments still use `ImagePreview` and the lightbox, which this PR does not touch. The existing FileViewer tests pass unchanged.
2. Markdown. Pass. plan.md opens rendered from its chat chip, with Preview, Source and Download (`markdown.jpg`, `chat-chips.jpg`).
3. CSV. Pass. cities.csv shows a table with name, country and population headers and five rows, including the quoted "São Paulo" (`csv.jpg`).
4. PDF. Not built. Inline PDF needs the data route's sandboxing CSP relaxed, a security change outside this PR. PDFs still download.
5. HTML. Pass. report.html renders as a page in an `iframe srcdoc` with `sandbox="allow-scripts allow-forms allow-modals"` and no `src` (`html.jpg`). The raw route serves it as `application/octet-stream`, attachment, so it never runs as an Orbit page.
6. Zip. Pass. site.zip stays a download link (`download="site.zip"`).
7. Files section. Pass. report.html from the Files section renders the same way, through the data route (`files-view.jpg`).
8. Missing file. Pass. gone.md shows "Couldn't open this file. not found" with no broken glyph (`missing.jpg`).
9. 20 MB CSV. Pass in headless Chromium. The table appears in 160 ms with the longest frame 83 ms, showing a header and 999 rows and the note "Showing the first 1,000 rows" (`big-csv.png`).
10. Desktop app. Not run. The browser pane cannot drive Electron.

Found and fixed: a 1 MB Markdown file froze the page for about 21 s, because react-markdown renders synchronously and grows faster than the file. Markdown over 100 KB now opens as source, with a note.
