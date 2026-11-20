# A6 live lanes

Local dev stack, test account, Bot "Atlas" making real edits with Hermes's write_file and patch tools. Lane 8 used synthetic rows on the empty "Lane Seven" Bot, deleted afterwards.

1. Regression lane against trunk. Pass. The chat's step chip still reads "Worked for 8s · 2 steps" for the edit turn. The Code tab reads rows without changing the transcript (`fizz-diff.jpg`).
2. New file. Pass. scratch/fizz.py from write_file shows "1. Created the file" with every line added (`fizz-diff.jpg`).
3. Edit. Pass. The patch shows "2. Edited" with the two Bazz lines added in context (`fizz-diff.jpg`).
4. Three files in one turn. Pass. scratch/a.py, b.py and c.py are listed with their edit counts (`three-files-rewrite.jpg`).
5. Same file twice. Pass. scratch/a.py shows "Created the file" then "Rewrote the file", and the rewrite's diff marks only the added docstring (`three-files-rewrite.jpg`).
6. Open in Preview. Not built. The edited files live in the Bot's workspace, and the chat attachment route that the viewer uses does not serve them. The Library already browses the workspace.
7. Switch Bots. Pass. Lane Seven listed only big/module.py and Atlas only its four files, both ways round, with the Code tab kept selected.
8. 5,000-line file. Pass in headless Chromium. A created 5,000-line file, a one-line patch and a full rewrite render as three diffs. The rewrite shows the two changed lines with folds of 2,497, 1,493 and 997 unchanged lines, and it correctly shows the earlier patch reverted (`big-file.png`).
9. Keyboard. Pass. Tab moves through the file rows and Enter opens b.py.
10. Desktop app. Not run. The browser pane cannot drive Electron.

Found and fixed: drawing a created 5,000-line file in full took about 280 ms. Each diff now draws at most 400 lines, then says how many more there are and points to the File view.
