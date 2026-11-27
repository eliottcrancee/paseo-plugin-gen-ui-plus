import { describe, expect, it } from "vitest";
import { parseCustomMcpServers, resolveEnabledCustomMcpServers } from "./settings";

describe("custom MCP server settings", () => {
  it("parses wrapped mcpServers and direct maps for stdio, http, and sse", () => {
    const wrapped = parseCustomMcpServers(
      JSON.stringify({
        mcpServers: {
          notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer ${NOTION_TOKEN}" } },
          fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
          legacy: { type: "sse", url: "https://example.com/sse" },
        },
      }),
    );
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.servers.notion).toEqual({
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${NOTION_TOKEN}" },
      alwaysLoad: false,
    });
    expect(wrapped.servers.fs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      alwaysLoad: false,
    });
    expect(wrapped.servers.legacy?.type).toBe("sse");
  });

  it("reports clear errors for malformed JSON or invalid entries", () => {
    expect(parseCustomMcpServers("{bad").ok).toBe(false);
    expect(parseCustomMcpServers(JSON.stringify({ foo: {} })).ok).toBe(false);
    expect(parseCustomMcpServers(JSON.stringify({ foo: { command: "node", args: [123] } })).ok).toBe(false);
  });

  it("filters disabled servers and expands ${ENV_VAR} placeholders", () => {
    const raw = JSON.stringify({
      notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer ${NOTION_TOKEN}" } },
      snowflake: { command: "node", args: ["server.js"], env: { SF_KEY: "${SF_KEY}" } },
    });
    const resolved = resolveEnabledCustomMcpServers(raw, ["snowflake"], { NOTION_TOKEN: "secret-123" });
    expect(Object.keys(resolved)).toEqual(["notion"]);
    expect(resolved.notion).toMatchObject({
      type: "http",
      headers: { Authorization: "Bearer secret-123" },
    });
  });
});
