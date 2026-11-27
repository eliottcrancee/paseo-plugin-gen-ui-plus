import { describe, expect, it } from "vitest";
import { examplesReport } from "../server/data-source";
import { decodeDdgUrl, htmlToMarkdown, parseBingRss, parseDdgHtml, parseWikipediaSearch } from "../server/web/research";
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
  webSearch: async (query) => ({
    ok: true,
    query,
    results: [{ title: "Example Docs", url: "https://example.com/docs", snippet: "Helpful docs" }],
  }),
  webFetch: async (url) => ({
    ok: true,
    url,
    title: "Example Page",
    contentType: "text/html",
    content: "Hello world",
    truncated: false,
  }),
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
      "web_search",
      "web_fetch",
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

  it("handles local web_search and web_fetch tools and parses DDG/HTML cleanly", async () => {
    const searchRes = await handleMcpJsonRpc(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "web_search", arguments: { query: "paseo" } } },
      deps,
    );
    const searchText = (searchRes?.result as { content: { text: string }[] }).content[0]!.text;
    expect(searchText).toContain("Example Docs");
    expect(searchText).toContain("https://example.com/docs");

    const fetchRes = await handleMcpJsonRpc(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "web_fetch", arguments: { url: "https://example.com" } } },
      deps,
    );
    const fetchText = (fetchRes?.result as { content: { text: string }[] }).content[0]!.text;
    expect(fetchText).toContain("# Example Page");
    expect(fetchText).toContain("Hello world");

    expect(decodeDdgUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fpola.rs%2F&rut=abc")).toBe("https://pola.rs/");
    const parsed = parseDdgHtml(
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpola.rs%2F">Polars</a><a class="result__snippet">Fast DataFrames</a>',
    );
    expect(parsed).toEqual([{ title: "Polars", url: "https://pola.rs/", snippet: "Fast DataFrames" }]);

    const bing = parseBingRss(
      '<rss><channel><item><title><![CDATA[Polars — DataFrames]]></title><link>https://pola.rs/</link><description>Fast in Rust</description></item></channel></rss>',
    );
    expect(bing).toEqual([{ title: "Polars — DataFrames", url: "https://pola.rs/", snippet: "Fast in Rust" }]);

    const wiki = parseWikipediaSearch(
      JSON.stringify({ query: { search: [{ title: "Polars (software)", snippet: "<b>Polars</b> is fast" }] } }),
    );
    expect(wiki).toEqual([
      {
        title: "Polars (software)",
        url: "https://en.wikipedia.org/wiki/Polars_(software)",
        snippet: "Polars is fast",
      },
    ]);

    const md = htmlToMarkdown(
      "<html><head><title>Doc &amp; Guide</title><style>body{}</style></head><body><nav>Menu</nav><main><h1>Intro</h1><p>Read <a href=\"https://example.com\">more</a>.</p></main></body></html>",
    );
    expect(md.title).toBe("Doc & Guide");
    expect(md.text).toContain("# Intro");
    expect(md.text).toContain("[more](https://example.com)");
    expect(md.text).not.toContain("Menu");
  });
});
