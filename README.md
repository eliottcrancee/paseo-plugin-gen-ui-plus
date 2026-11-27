# Gen-UI Plus for Paseo

**Rich, interactive UI rendered inline in Paseo chat — charts with hover tooltips, diagrams, maps, tables, plans, forms, and sandboxed mini-apps — powered by an on-demand MCP server.**

![Inline Map, Calendar, and Budget UI in Paseo chat](assets/screenshot-chat.png)

![Gen-UI Gallery with 86 components and 179 live examples](assets/screenshot-gallery.png)

![Interactive Playground in Paseo](assets/screenshot-playground.png)

## Why this plugin

Instead of answering with walls of Markdown, ASCII charts, or pasted command output, agents write ```` ```ui ```` and ```` ```app ```` blocks that Paseo compiles and renders live inline as the reply streams:

- **On-demand MCP architecture (~88% less upfront context)**: Rather than dumping the full 86-component manual (~4,400 tokens) into every agent's system prompt, new agents receive a compact skill (~500 tokens) plus an attached **`genui` MCP server** (`genui_guide`, `genui_list_components`, `genui_examples`, `genui_check_ui`). Harnesses with dynamic MCP loading (like **Pi** + `pi-mcp-adapter`) keep tool schemas unloaded until needed, while eager harnesses (**OpenCode**, **Claude Code**, **Codex**) get all 4 tools immediately.
- **Pre-reply validation**: Agents can compile, lint, and preview ```` ```ui ```` specs with `genui_check_ui` before sending — catching syntax errors, mismatched `Tabs`, invalid `Chart` series, and unreadable `Load(...)` paths before they ever become an error card.
- **Interactive, theme-aware SVG charts**: All 8 chart types (`bar`, `line`, `area`, `pie`/`donut`, `scatter`, `radar`, `funnel`, `heatmap`) render as crisp SVG inside Paseo's light/dark theme with **hover tooltips**, **responsive column sizing** (readable 1:1 axes even in 3-column `Row` layouts), **flicker-free streaming**, and advanced styling (`lineDash`, `strokeWidth`, `fillOpacity`, `pointRadius`, `showGrid`, `showLegend`).
- **Local interactivity**: Sliders, steppers, toggles, editable tables, and decision matrices recompute locally with zero extra model calls. Buttons and forms send structured answers back to the agent.
- **Cross-platform & reload-resilient**: Works on macOS, Linux, and Windows — both in the Paseo desktop app and pure npm/Node/Bun daemons — with a stable stdio bridge and discovery file so existing sessions keep working across plugin reloads and daemon restarts.

## Install

```bash
paseo plugin add git:eliottcrancee/paseo-plugin-gen-ui-plus
```

Or install directly from the Paseo app (**Settings → Plugins → Add from Git**) using `eliottcrancee/paseo-plugin-gen-ui-plus`, or from a local clone with `paseo plugin install .`.

Requires Paseo 0.13.0 or later.

## What an answer looks like

The agent writes a ```` ```ui ```` block in its reply:

~~~
```ui
$seats = 12
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats)),
  Button("Go with " + $plan, Send("Go with " + $plan), variant: "primary")
])
```
~~~

Paseo renders a card with a plan switch, a seat slider, and a live total. Moving the slider recomputes the total locally; clicking the button sends the choice back to the agent.

## MCP tools (`genui`)

When **Load component docs via MCP** is enabled (default), the plugin starts a localhost-only token-authenticated bridge and attaches the `genui` MCP server to new non-internal agents:

| Tool | Purpose |
| --- | --- |
| `genui_guide(topic?)` | DSL syntax, `$state`, actions, `Load(...)`, charts, code-work recipes, and reliability rules |
| `genui_list_components(group?, query?)` | Search component signatures by group or keyword |
| `genui_examples(components)` | Fetch exact signatures and up to 3 working gallery examples (with data previews) for 1–6 components |
| `genui_check_ui(spec)` | Compile, lint, and preview a ```` ```ui ```` block (including `Load(...)` files in the workspace / `$BB_THREAD_STORAGE`) |

You can switch back to the full inline system prompt anytime in **Settings → Plugins → Gen-UI Plus**. A standalone [`SKILL.md`](SKILL.md) is also included for manual use in Pi, OpenCode, or Claude Code.

## Charts

`Chart` renders real SVG charts with axes, gridlines, ticks, legends, and interactive hover tooltips on desktop and web (with a native fallback on mobile):

```ui
Card("API Latency", [
  Chart("area", ["8h", "10h", "12h", "14h"], {
    P50: {values: [120, 98, 74, 82], strokeWidth: 2.5, fillOpacity: 0.25},
    P95: {values: [240, 210, 180, 195], tone: "warn", lineDash: "dashdot", pointRadius: 4},
    SLA: {values: [200, 200, 200, 200], tone: "bad", lineDash: [4, 4], pointRadius: 0}
  }, unit: "ms", smooth: true, yLabel: "Latency", title: "Latency by hour", height: 240)
])
```

- **Types**: `bar`, `line`, `area`, `pie`, `scatter`, `radar`, `funnel`, `heatmap`
- **Layout & data**: `stacked`, `orientation: "horizontal"`, `donut`, `smooth`, `showValues`, `height` (150–560 px), `title`, `xLabel`, `yLabel` (defaults to `unit`)
- **Advanced styling** (chart-level or per-series): `lineDash` (`"dashed"`, `"dotted"`, `"dashdot"`, `"solid"`, `"8 4"`, or `[8, 4]`), `strokeWidth` (1–6), `fillOpacity` (0–1), `pointRadius` (0–8), `showGrid`, `showLegend`, `tooltip` (default `true`)

## Components (86 across 10 groups)

| Group | Components |
| --- | --- |
| **Layout** | `Card` · `Row` · `Stack` · `Grid` · `Tabs` · `Details` · `Divider` · `Carousel` |
| **Content** | `Text` · `Callout` · `Draft` · `Metric` · `Badge` · `Icon` · `KeyValue` · `Image` · `File` · `Entity` · `Sources` · `List` |
| **Data** | `Table` · `Chart` · `Sparkline` · `Progress` · `Gauge` · `SegmentedBar` · `Steps` · `Timeline` · `Calendar` · `CalendarHeatmap` · `Tree` · `Code` · `Snippet` · `Diff` · `Diagram` |
| **Media** | `ImageSearch` · `Gallery` · `Map` · `Hotspots` |
| **Inputs** | `Slider` · `Stepper` · `Toggle` · `Choice` · `Radio` · `Select` · `Checklist` · `ListEditor` · `Input` · `TextArea` · `DateInput` · `Rating` · `OptionCards` · `Swatches` · `EditableTable` · `Button` · `Form` · `FollowUps` |
| **Widgets** | `Timer` · `Quiz` · `Flashcards` · `Walkthrough` |
| **Project** | `Changes` · `Commits` · `PullRequest` · `Threads` · `Tests` · `Json` |
| **Dev** | `Logs` · `StackTrace` · `Findings` · `Coverage` · `Dependencies` · `Pipeline` · `Benchmark` · `Waterfall` · `Treemap` |
| **Manage** | `Board` · `Roadmap` · `Status` · `Plan` · `Decision` · `Estimate` · `Environments` |
| **Evidence** | `Acceptance` · `Compare` · `Transcript` · `Provenance` |

## Slash commands & surfaces

- `/genui [prompt]` — Teach an existing agent the Generative UI component language.
- `/genui-demo [ComponentName]` — Insert a live interactive Gen-UI block into the current chat (e.g. `/genui-demo Decision` or `/genui-demo Map`).
- `/genui-gallery` — Open the **Gen-UI Gallery** screen (179 examples across all 86 components + live Playground).

## Development

```bash
npm install
npm run typecheck && npm test
paseo plugin install .
paseo plugin reload gen-ui-plus
```

## Credits & License

Licensed under [Apache-2.0](LICENSE).

Originally forked from [anh-chu/paseo-plugin-genui](https://github.com/anh-chu/paseo-plugin-genui) (based on the DSL, component catalog, and gallery examples by [ComicBit/bb-plugin-genui](https://github.com/ComicBit/bb-plugin-genui)), then extensively reworked with an on-demand MCP server + compact skill architecture, interactive SVG charts with hover tooltips & advanced styling, responsive multi-column layout, flicker-free streaming, and structural spec linting. Excalifont is under the SIL Open Font License (`assets/fonts/Excalifont-OFL.txt`).
