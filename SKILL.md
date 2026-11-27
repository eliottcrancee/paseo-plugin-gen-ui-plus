---
name: genui
description: Render interactive charts, diagrams, maps, tables, forms, plans, diffs, and dev reports inline in Paseo chat using ```ui and ```app blocks, backed by the `genui` MCP server.
---

# Generative UI — Default to ```ui in replies

This Paseo chat renders ```` ```ui ```` (89 interactive components) and ```` ```app ```` (sandboxed HTML/JS mini-apps) code blocks live inline in the chat timeline.

The user explicitly prefers ```` ```ui ```` over walls of markdown: whenever your reply contains structured info, data, steps, comparisons, code explanations, tool output, or choices, render it as a ```` ```ui ```` block. Never use ```` ```ui ```` inside source files, commit messages, PR descriptions, or tool inputs.

## When to use ```` ```ui ```` by default

- **Comparisons, pros/cons, tabular data** → `Table`, `Decision`, `Compare`, `KeyValue`
- **Numbers, KPIs, distributions, trends** → `Metric`, `Chart` (bar/line/area/pie/scatter/radar/funnel/heatmap), `Progress`, `Gauge`, `Sparkline`
- **Explanations, flows, architectures** → `Diagram` (mermaid) + `Steps` + `Snippet(path, from, to)`
- **Plans, tasks, schedules, timelines** → `Plan`, `Board`, `Roadmap`, `Timeline`, `Calendar`
- **Code & git work** → `Changes()`, `Commits()`, `PullRequest()`, `Tests`, `Findings`, `Logs`, `StackTrace`, `Coverage`, `Benchmark`, `Json`
- **Choices, calculators, questions** → `Button`, `Form`, `Slider`, `EditableTable`, `FollowUps`
- **Places, media, drafts to approve** → `Map`, `Image`, `Gallery`, `Audio`, `Draft`

## On-demand docs & validation (`genui` MCP server)

Instead of loading all 89 component signatures into every conversation upfront, component documentation, live examples, and spec validation are exposed through the **`genui`** MCP server (lazy-loaded in harnesses like Pi with `pi-mcp-adapter`, or directly available in OpenCode / Claude Code / Codex):

1. **`genui_guide(topic?)`** — Read the DSL syntax (`$state`, expressions, actions, `Load(...)`, ```` ```app ````), chart options (`charts`), code-work recipes (`code-work`), or common pitfalls (`reliability`).
2. **`genui_list_components(group?, query?)`** — Discover component signatures by group (`Layout`, `Content`, `Data`, `Media`, `Inputs`, `Widgets`, `Project`, `Dev`, `Manage`, `Evidence`) or keyword search.
3. **`genui_examples(components)`** — Fetch exact signatures and up to 3 working gallery examples for 1–6 components.
4. **`genui_check_ui(spec)`** — Compile, validate, and preview a ```` ```ui ```` block before sending your reply so it never renders an error card.

## Recommended workflow

1. Start your reply with **one plain sentence** giving the direct answer (chat previews show only plain text).
2. If you are unsure of a component's exact signature or options, call `genui_list_components` or `genui_examples` first — never guess named arguments or positional order.
3. When displaying command output (test runs, lint/typecheck findings, logs, coverage, benchmarks, API responses), save the output to `$BB_THREAD_STORAGE` and pass `Load("$BB_THREAD_STORAGE/...")` into the matching component (`Tests`, `Findings`, `Logs`, `Coverage`, `Benchmark`, `Json`, etc.).
4. Wrap each ```` ```ui ```` block in a single top-level `Card(...)`.
5. Call `genui_check_ui(spec)` on any non-trivial block before replying to catch syntax errors, mismatched `Tabs`, invalid `Chart` series, or unreadable `Load(...)` paths.
