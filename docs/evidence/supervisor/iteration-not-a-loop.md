# A fixed-then-rerun build is not a loop

## What happened (desktop stack, Atlas, 2026-11-20 04:16 to 04:22 UTC)

The same command, `cd .../riscv-demo && make 2>&1`, failed three times, and each run failed differently:

| Row | Result | Next step |
| --- | --- | --- |
| 20 | Exit 127, `make: command not found` | `apt-get install -y make` (row 21, ok) |
| 28 | `Error 255`, toolchain built for x86-64 on an aarch64 host | `apt-get install -y gcc-riscv64-unknown-elf` (row 31, ok) |
| 34, 35 | `patch` to the Makefile (ok) | |
| 36 | `Error 1` at `Makefile:15` | |

`same-call-failed` counted every failure with the same name and arguments over the whole turn, so row 36 tripped it. `[supervisor] bot_Q09tQAk54uo4 tripped same-call-failed on terminal (3)`. The reassess message then said "Do not call terminal again with those arguments", which banned the build command. The person stopped the silent reassess attempt at 04:19:01 and typed "continue". Atlas then built and ran the project cleanly by 04:22.

## The rule now

A failure counts toward `same-call-failed` only when it has the same tool, arguments and output (the hash of the tool result, with Hermes's loop notes stripped) as the last one. A successful `write_file`, `patch` or `save_file` starts the count again. Three identical failures with only reads between them still trip. The reassess message tells the bot to find out why the command failed and change something before running it again.

## Live check (dev stack, this branch, Atlas)

`cd scratch/mk && make 2>&1` failed four times (rows 4, 5, 8 and 11). Three showed the identical summary `make: *** [hello] Error 1`, with a `patch` between each. The old rule would have tripped at row 8. The turn finished: make succeeded (row 14), `./hello` ran (row 16), and the server log has no `[supervisor]` line.
