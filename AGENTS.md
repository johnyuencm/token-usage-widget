# Agent instructions

## Commander (ycm-harness plugin)

Protocol lives in the enabled **ycm-harness** plugin and updates when that plugin updates. Do not use `~/.agents/system/` as protocol.

1. Read and follow the plugin skill **commander** (`/commander` or `$commander`).
2. Guides are `commander-system/system/` inside that plugin (next to `skills/`). Start with `10-DISPATCH.md` when delegating.
3. Machine journal only: append durable environment facts to `~/.agents/system/LESSONS.md`. Long artifacts go to `~/.agents/reports/` only when no git project is involved.
4. If ycm-harness SOP is active, follow that SOP; use commander files only for model-tier choice and verification discipline.
5. In a git project, commit and push every review, report and architecture output (code and architecture reviews, review rounds, verification records, HTML reports, wiki run records) into the repo, using its existing place (e.g. `artifacts/`), else `docs/reviews/`. Remote agents only see the remote; `/tmp` and `~/.agents/reports/` are invisible to them. Link committed paths, never `/tmp`.
6. Write explanations, reports and docs in ASD-STE100 Simplified Technical English, about 80% strict. One idea per sentence. Procedural sentences max 20 words, descriptive max 25. Active voice. Use the imperative for instructions. Use the same word for the same thing. Noun clusters max 3 words. Keep code, commands, paths and quoted errors exact. Prefer pictures to prose: show structure, flow or state with a Mermaid diagram. Make an HTML page for a report with many parts, a comparison or data, and a video for a process that changes over time. Use the **explainer** skill for these formats.
7. Do the work that you can do yourself. Do not tell the user to run a command, edit a file or check a result when your tools can do it. Do it directly, then report the result. Give a step to the user only when it is destructive or has a big impact and needs human approval, or when only a human can do it (for example: log in, approve a payment, use a UI that you cannot reach).
