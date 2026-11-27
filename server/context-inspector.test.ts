import { describe, expect, it } from "vitest";
import { compile } from "../shared/core";
import { buildContextInspectorSpec, snapshotAgentCreate, type ContextInspectionReport } from "./context-inspector";

describe("context inspector", () => {
  it("redacts env and headers when snapshotting agent.create config", () => {
    const snap = snapshotAgentCreate({
      provider: "pi",
      cwd: "/tmp/demo",
      model: "glm-5.3-flash",
      systemPrompt: "Hello system",
      mcpServers: {
        genui: {
          type: "http",
          url: "http://127.0.0.1:9999/mcp",
          headers: { Authorization: "Bearer super-secret-token" },
        },
      },
    });
    expect(snap.mcpServers).toEqual([{ name: "genui", type: "http" }]);
    expect(JSON.stringify(snap)).not.toContain("super-secret-token");
  });

  it("produces a valid ```ui spec that compiles cleanly", () => {
    const report: ContextInspectionReport = {
      provider: "pi",
      cwd: "/tmp/demo",
      model: "glm-5.3-flash",
      exactInputTokens: 4320,
      totalEstTokens: 4100,
      mcpServers: [{ name: "genui", type: "stdio" }],
      sections: [
        {
          label: "Paseo & plugins systemPrompt",
          source: "agent.create hook",
          chars: 2000,
          estTokens: 500,
          preview: "[paseo-plugin-genui]\n# Generative UI",
        },
        {
          label: "Pi MCP adapter tools (6)",
          source: "mcp, mcp__genui",
          chars: 5500,
          estTokens: 1375,
          preview: "Tools: mcp, mcp__genui",
        },
      ],
      notes: ["All sections measured cleanly."],
    };

    const spec = buildContextInspectorSpec(report);
    const compiled = compile(spec);
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(compiled.program).not.toBeNull();
    expect(spec).toContain("4,320 tok");
    expect(spec).toContain("Initial Context Inspector");
  });
});
