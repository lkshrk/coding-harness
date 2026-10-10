---
name: status
description: "Answer \"how is it going\" about the running nightshift system from the `ns` read commands: what runs, what waits for the user, what failed and why, and the next useful step. Propose control commands and run them only after the user confirms. Use when the user asks about progress, runs, workers, questions or failures. Not for planning new work (`discover`, `design`, `decompose`) or re-planning an escalated issue (`replan`)."
license: MIT
---

# Status

Answer from what the system reports, never from memory of earlier turns. Read first, then answer in a few lines, then name the one next step.

## Read

These run without asking. Start with the first two; add the others only when the question needs them.

| Question | Command |
|---|---|
| Overall: dispatch, gateway, profile, workers, covered issues | `ns status` |
| Issues nightshift manages, by stage or state | `ns tasks [--project P] [--stage S] [--state S]` |
| Active workers and their progress | `ns workers` |
| What happened to one issue or run | `ns logs <issue>` (add `--type T` to filter) |
| Open questions from workers | `ns questions` |
| Gate and review results | `ns tests <issue>` |
| Code a run changed | `ns diff <issue> --stat`, then without `--stat` for the patch |
| The issue, its comments and PR | `linear issue view <ID>`, `linear issue comment list <ID>`, `gh pr view <n>`, `gh pr checks <n>` |

A failed run leaves a comment on the issue: `Attempt <n> (<agent>) failed: <reason>. Class \`<class>\`, action \`<action>\`.` Quote it rather than paraphrasing.

## Answer

- Lead with the state that matters to the user: what needs them, then what failed, then what runs, then what is done.
- Per issue one line: identifier, stage, state, and the reason when it is held or failed.
- Separate facts from guesses. A cause not shown in the logs or comments is a guess; say so and name the command that would confirm it.
- An issue held as `escalated` with class `task_too_large`, `missing_dependency` or `architectural_conflict` goes to `replan`; say so and offer to start it.
- `ns status` reporting `dispatch: paused` comes with the reason in `ns logs`; read it before suggesting `ns resume`.

## Control

Control commands change the running system. Propose the exact command with one line on what it does, and run it only after an explicit yes.

| Situation | Command |
|---|---|
| Answer a worker's question | `ns answer <issue> "<text>"` |
| Steer a running worker | `ns send <issue> "<message>"` |
| Retry after the cause is fixed | `ns retry <issue> [--profile P] [--agent A] [--continue]` |
| Stop a run that goes nowhere | `ns stop <issue> --reason "<why>"` |
| Pause or resume dispatch, or hold one issue | `ns pause [<issue>]`, `ns resume [<issue>]` |
| Start work on approved issues | `ns implement <issue>` |
| Switch the model profile | `ns profile use <name>` |

- `--continue` keeps the branch and open PR of the last attempt; without it the retry starts fresh.
- A retry without a change to its cause fails the same way. Name what changed (issue text, answer, profile) before proposing it.
- Never touch issue status or `ai-stage:` labels to unblock something; the supervisor owns them.

## Watching

`ns attach <issue>` and `ns watch` need a terminal. Print the command for the user to run in another terminal; do not run it.

## Done

- The user's question is answered from command output, with the source command named for anything surprising.
- Any control command ran only after the user confirmed it, and its result was read back with `ns status` or `ns logs <issue>`.
