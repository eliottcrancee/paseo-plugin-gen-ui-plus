import {
  ACTIONS,
  callSignature,
  COMPONENTS,
  componentSignature,
  type ComponentGroup,
  type ComponentName,
} from "./core/catalog";
import {
  AGENT_INSTRUCTIONS,
  AGENT_INSTRUCTIONS_WEB_OFF,
  CODE_WORK_INSTRUCTIONS,
  RELIABILITY_INSTRUCTIONS,
  WEB_LOOKUPS_OFF,
} from "./instructions";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const COMPONENT_GROUPS: readonly ComponentGroup[] = [
  "Layout",
  "Content",
  "Data",
  "Media",
  "Inputs",
  "Widgets",
  "Project",
  "Dev",
  "Manage",
  "Evidence",
];

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

export interface McpRequestContext {
  readonly cwd?: string | null;
  readonly storageDir?: string | null;
}

export interface McpDeps {
  readonly webLookups: () => boolean;
  readonly extraFolders: () => readonly string[];
  readonly examples: (components: readonly string[]) => Promise<{ readonly ok: boolean; readonly text: string }>;
  readonly checkUi: (
    spec: string,
    ctx: McpRequestContext,
  ) => Promise<{ readonly ok: boolean; readonly report: string }>;
}

export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export const GENUI_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "genui_guide",
    description:
      "Read the Generative UI ```ui / ```app guide: DSL syntax, $state bindings, actions, Load(), charts, code-work recipes, and reliability rules.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["overview", "syntax", "charts", "code-work", "reliability", "all"],
          description:
            "Section to read (default: overview). Use 'code-work' for test/lint/diff/CI recipes, 'charts' for chart options, 'syntax' for expressions/actions, 'reliability' for common pitfalls.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "genui_list_components",
    description:
      "List Generative UI component signatures filtered by group and/or keyword search.",
    inputSchema: {
      type: "object",
      properties: {
        group: {
          type: "string",
          enum: [...COMPONENT_GROUPS],
          description: "Optional component group to list.",
        },
        query: {
          type: "string",
          description: "Optional keyword to match component names, parameter names, or descriptions.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "genui_examples",
    description:
      "Fetch exact signatures and up to 3 working gallery ```ui examples (plus sample data previews) for 1 to 6 component names.",
    inputSchema: {
      type: "object",
      properties: {
        components: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 6,
          description: "Component names (e.g. ['Chart', 'Tabs', 'Form']).",
        },
      },
      required: ["components"],
      additionalProperties: false,
    },
  },
  {
    name: "genui_check_ui",
    description:
      "Compile, validate, and preview a ```ui spec before sending it in your reply. Catches syntax errors, invalid arguments, bad Chart series, mismatched Tabs, and missing Load() files.",
    inputSchema: {
      type: "object",
      properties: {
        spec: {
          type: "string",
          description: "The ```ui block body (with or without surrounding ```ui fences).",
        },
      },
      required: ["spec"],
      additionalProperties: false,
    },
  },
];

const ACTION_LIST = Object.entries(ACTIONS)
  .map(([name, spec]) => callSignature(name, spec))
  .join(" ");

function groupDirectory(): string {
  const byGroup = new Map<ComponentGroup, string[]>(COMPONENT_GROUPS.map((g) => [g, []]));
  for (const name of Object.keys(COMPONENTS) as ComponentName[]) {
    byGroup.get(COMPONENTS[name].group)?.push(name);
  }
  return [...byGroup].map(([group, names]) => `- **${group}**: ${names.join(", ")}`).join("\n");
}

function syntaxSection(extraFolders: readonly string[]): string {
  return [
    "# Inline UI syntax",
    "One statement per line. `$x = 8` declares state inputs bind to; `name = expr` names a value and `f = (a, b) => expr` a function; each bare expression renders.",
    "JS expressions supported: `**`, `?:`, `??`, `?.`, `...spread`, destructuring, `x => { const y = ...; return y }`, template literals `${x}`, list/string/number methods, `Math.*`, `Object.keys/values/entries`, `Number()`, `String()`, `JSON.stringify`; plus `round(x, d)`, `fmt(x, d)`, `sum(list)`, `Load(path)`. No `if`, `for`, or reassignment.",
    "Named arguments go last and are lowercase: `Slider($n, 0, 10, label: \"N\")`.",
    `Actions: ${ACTION_LIST}; a list runs in order; \`Send\` posts as the user.`,
    `Data: \`Load("path")\` reads JSON/CSV/TSV/JSONL from the workspace, \`$BB_THREAD_STORAGE/x.json\`, or \`/tmp\` into lists/objects, and other files (logs, tsc output) as text. \`Snippet\` and \`Image\` read files the same way.${extraFolders.length > 0 ? ` Extra allowed folders: ${extraFolders.join(", ")}.` : ""}`,
    "Custom visuals / games / simulations: write a ```app block containing a self-contained HTML page (inline CSS/JS, CSS vars `--foreground`, `--muted-foreground`, `--border`, `--primary`, `--card`; sandboxed, no network).",
  ].join("\n\n");
}

function chartsSection(): string {
  return [
    "# Charts",
    componentSignature("Chart"),
    "Example:",
    "```ui\nCard(\"Latency\", [\n  Chart(\"area\", [\"8h\", \"10h\", \"12h\"], {\n    P50: [120, 98, 74],\n    P95: {values: [240, 210, 180], tone: \"warn\", dashed: true}\n  }, unit: \"ms\", smooth: true, yLabel: \"Latency\", title: \"Latency by hour\", height: 240)\n])\n```",
    "Rules:",
    "- `series` must be `[numbers]` or `{Name: [numbers]}` or `{Name: {values: [numbers], tone?, dashed?}}` — NEVER a list of `{x, y}` objects.",
    "- Every series `values` array must match `labels.length` (except `scatter`).",
    "- `radar` requires at least 3 labels.",
  ].join("\n\n");
}

function buildGuide(topic: string, webLookups: boolean, extraFolders: readonly string[]): string {
  switch (topic) {
    case "syntax":
      return syntaxSection(extraFolders);
    case "charts":
      return chartsSection();
    case "code-work":
      return CODE_WORK_INSTRUCTIONS;
    case "reliability":
      return RELIABILITY_INSTRUCTIONS;
    case "all":
      return [
        syntaxSection(extraFolders),
        "## Component groups\n" + groupDirectory(),
        chartsSection(),
        RELIABILITY_INSTRUCTIONS,
        CODE_WORK_INSTRUCTIONS,
        webLookups ? AGENT_INSTRUCTIONS : AGENT_INSTRUCTIONS_WEB_OFF,
      ].join("\n\n");
    case "overview":
    default:
      return [
        syntaxSection(extraFolders),
        "## Component groups (call `genui_list_components` or `genui_examples` for details)\n" + groupDirectory(),
        !webLookups ? WEB_LOOKUPS_OFF : "",
        "Tip: call `genui_examples([\"ComponentName\"])` before using an unfamiliar component, and `genui_check_ui(spec)` to validate before replying.",
      ]
        .filter(Boolean)
        .join("\n\n");
  }
}

export function listComponentsReport(group?: string, query?: string): string {
  const wantedGroup = group?.trim().toLowerCase() ?? "";
  const wantedQuery = query?.trim().toLowerCase() ?? "";

  const matched = new Map<ComponentGroup, string[]>();
  for (const g of COMPONENT_GROUPS) matched.set(g, []);

  for (const name of Object.keys(COMPONENTS) as ComponentName[]) {
    const spec = COMPONENTS[name];
    if (wantedGroup && spec.group.toLowerCase() !== wantedGroup) continue;
    const sig = componentSignature(name);
    if (wantedQuery) {
      const haystack = `${name} ${spec.group} ${sig}`.toLowerCase();
      if (!haystack.includes(wantedQuery)) continue;
    }
    matched.get(spec.group)?.push(sig);
  }

  const sections = [...matched]
    .filter(([, items]) => items.length > 0)
    .map(([g, items]) => `## ${g}\n${items.map((item) => `- ${item}`).join("\n")}`);

  if (sections.length === 0) {
    return `No components matched${group ? ` group="${group}"` : ""}${query ? ` query="${query}"` : ""}. Available groups: ${COMPONENT_GROUPS.join(", ")}.`;
  }
  return sections.join("\n\n");
}

/** Strips optional surrounding ```ui ... ``` fences if a model passes a fenced block to genui_check_ui. */
export function unwrapUiFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^(?:`{3,}|~{3,})\s*ui\s*\r?\n([\s\S]*?)\r?\n(?:`{3,}|~{3,})\s*$/i.exec(trimmed);
  return match ? match[1]! : raw;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function callGenuiMcpTool(
  name: string,
  args: unknown,
  deps: McpDeps,
  ctx: McpRequestContext = {},
): Promise<McpToolCallResult> {
  const input = asObject(args);

  switch (name) {
    case "genui_guide": {
      const topic = typeof input.topic === "string" ? input.topic : "overview";
      const text = buildGuide(topic, deps.webLookups(), deps.extraFolders());
      return { content: [{ type: "text", text }] };
    }

    case "genui_list_components": {
      const group = typeof input.group === "string" ? input.group : undefined;
      const query = typeof input.query === "string" ? input.query : undefined;
      const text = listComponentsReport(group, query);
      return { content: [{ type: "text", text }] };
    }

    case "genui_examples": {
      const raw = Array.isArray(input.components) ? input.components : [];
      const components = raw
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim())
        .slice(0, 6);
      if (components.length === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide 1 to 6 component names in `components`." }],
        };
      }
      const res = await deps.examples(components);
      return {
        isError: !res.ok,
        content: [{ type: "text", text: res.text }],
      };
    }

    case "genui_check_ui": {
      const rawSpec = typeof input.spec === "string" ? input.spec : "";
      const spec = unwrapUiFence(rawSpec);
      if (spec.trim() === "") {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide a non-empty `spec` string to validate." }],
        };
      }
      if (spec.length > 20_000) {
        return {
          isError: true,
          content: [{ type: "text", text: "Spec exceeds the 20,000-character limit." }],
        };
      }
      const res = await deps.checkUi(spec, ctx);
      return {
        isError: !res.ok,
        content: [{ type: "text", text: res.report }],
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
}

/** Handles one MCP JSON-RPC 2.0 request. Returns `null` for notifications (no response required). */
export async function handleMcpJsonRpc(
  req: JsonRpcRequest,
  deps: McpDeps,
  ctx: McpRequestContext = {},
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const method = req.method;

  // Notifications have no id and expect no JSON-RPC response body.
  if (req.id === undefined && typeof method === "string" && method.startsWith("notifications/")) {
    return null;
  }

  if (typeof method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request: missing method" },
    };
  }

  try {
    switch (method) {
      case "initialize": {
        const params = asObject(req.params);
        const requestedVersion =
          typeof params.protocolVersion === "string" && params.protocolVersion.trim() !== ""
            ? params.protocolVersion
            : MCP_PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: requestedVersion,
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "paseo-plugin-genui",
              version: "0.4.0",
            },
          },
        };
      }

      case "notifications/initialized":
        return null;

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: GENUI_MCP_TOOLS,
          },
        };

      case "tools/call": {
        const params = asObject(req.params);
        const toolName = typeof params.name === "string" ? params.name : "";
        if (!toolName) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: missing tool name" },
          };
        }
        const result = await callGenuiMcpTool(toolName, params.arguments, deps, ctx);
        return { jsonrpc: "2.0", id, result };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (cause) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}
