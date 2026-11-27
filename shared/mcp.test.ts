import { describe, expect, it } from "vitest";
import { examplesReport } from "../server/data-source";
import { checkSpec } from "./fallback";
import { buildFullInstructions, buildMcpSkillInstructions } from "./instructions";
import {
  GENUI_MCP_TOOLS,
  handleMcpJsonRpc,
  listComponentsReport,
  unwrapUiFence,
  type McpDeps,
} from "./mcp";

const deps: McpDeps = {
  webLookups: () => true,
  extraFolders: () => [],
  examples: (components) => examplesReport(components),
  checkUi: (spec) =>
    checkSpec(spec, async (req) => ({ ok: false, error: `missing ${req.path}` })),
};

describe("genui MCP server", () => {
  it("keeps the MCP skill prompt dramatically smaller than the full inline reference", () => {
    const skill = buildMcpSkillInstructions(true);
    const full = buildFullInstructions(true);
    expect(skill.length).toBeLessThan(2600);
    expect(skill.length).toBeLessThan(full.length * 0.16);
    expect(skill).toContain("genui_guide");
    expect(skill).toContain("genui_list_components");
    expect(skill).toContain("genui_examples");
    expect(skill).toContain("genui_check_ui");
  });

  it("handles initialize, ping, notifications, and tools/list", async () => {
    const init = await handleMcpJsonRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      deps,
    );
    expect(init?.error).toBeUndefined();
    expect((init?.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");

    const notif = await handleMcpJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, deps);
    expect(notif).toBeNull();

    const ping = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 2, method: "ping" }, deps);
    expect(ping?.result).toEqual({});

    const listed = await handleMcpJsonRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, deps);
    const tools = (listed?.result as { tools: typeof GENUI_MCP_TOOLS }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "genui_guide",
      "genui_list_components",
      "genui_examples",
      "genui_check_ui",
    ]);
  });

  it("filters components by group and keyword in genui_list_components", () => {
    const dataOnly = listComponentsReport("Data");
    expect(dataOnly).toContain("Chart(");
    expect(dataOnly).toContain("Table(");
    expect(dataOnly).not.toContain("Card(");

    const chartSearch = listComponentsReport(undefined, "funnel");
    expect(chartSearch).toContain("Chart(");
    expect(chartSearch).not.toContain("Slider(");

    const noMatch = listComponentsReport(undefined, "nonexistent-xyz-component");
    expect(noMatch).toContain("No components matched");
  });

  it("serves guide topics via genui_guide", async () => {
    const res = await handleMcpJsonRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "genui_guide", arguments: { topic: "charts" } } },
      deps,
    );
    const text = (res?.result as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain("Chart(");
    expect(text).toContain("radar");
  });

  it("returns gallery examples via genui_examples", async () => {
    const res = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "genui_examples", arguments: { components: ["Chart", "Tabs"] } },
      },
      deps,
    );
    const result = res?.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain("Chart(");
    expect(result.content[0]!.text).toContain("Tabs(");
  });

  it("validates specs and catches structural misuse in genui_check_ui", async () => {
    const okRes = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "genui_check_ui",
          arguments: { spec: '```ui\nCard("Summary", [Metric("Latency", "42 ms")])\n```' },
        },
      },
      deps,
    );
    expect((okRes?.result as { isError?: boolean }).isError).toBe(false);

    // Mismatched Tabs labels vs children
    const badTabs = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "genui_check_ui",
          arguments: { spec: 'Card("Tabs", [Tabs(["A", "B"], [Text("only one")])])' },
        },
      },
      deps,
    );
    const tabsResult = badTabs?.result as { isError?: boolean; content: { text: string }[] };
    expect(tabsResult.isError).toBe(true);
    expect(tabsResult.content[0]!.text).toContain("2 label(s) but 1 child panel(s)");

    // Mismatched Chart labels vs series length
    const badChart = await handleMcpJsonRpc(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "genui_check_ui",
          arguments: { spec: 'Card("Sales", [Chart("bar", ["Q1", "Q2", "Q3"], [10, 20])])' },
        },
      },
      deps,
    );
    const chartResult = badChart?.result as { isError?: boolean; content: { text: string }[] };
    expect(chartResult.isError).toBe(true);
    expect(chartResult.content[0]!.text).toContain("3 label(s) but series has 2 value(s)");
  });

  it("unwraps optional ```ui fences cleanly", () => {
    expect(unwrapUiFence('```ui\nCard("Hi", [])\n```')).toBe('Card("Hi", [])');
    expect(unwrapUiFence('Card("Hi", [])')).toBe('Card("Hi", [])');
  });
});
