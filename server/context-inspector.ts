import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

type PaseoApi = PluginHandlerContext["paseo"];

export interface CapturedAgentInit {
  readonly provider: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly systemPrompt: string;
  readonly mcpServers: readonly { readonly name: string; readonly type: string }[];
  readonly preapprovedTools: readonly string[];
  readonly capturedAt: number;
}

export interface ContextSection {
  readonly label: string;
  readonly source: string;
  readonly chars: number;
  readonly estTokens: number;
  readonly preview: string;
}

export interface ContextInspectionReport {
  readonly provider: string;
  readonly cwd: string;
  readonly model: string | null;
  readonly exactInputTokens: number | null;
  readonly totalEstTokens: number;
  readonly sections: readonly ContextSection[];
  readonly mcpServers: readonly { readonly name: string; readonly type: string }[];
  readonly notes: readonly string[];
}

function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clip(text: string, max = 6000): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n\n…[truncated: ${trimmed.length} chars total]`;
}

/** Captures a secret-free snapshot of `agent.create` config. */
export function snapshotAgentCreate(config: AgentSessionConfig): CapturedAgentInit {
  const mcpServers = Object.entries(config.mcpServers ?? {}).map(([name, server]) => ({
    name,
    type: server.type,
  }));
  const preapprovedTools = (config.toolPolicy?.preapproved ?? []).map((ref) => `${ref.server}/${ref.tool}`);
  return {
    provider: config.provider,
    cwd: config.cwd,
    model: config.model ?? null,
    systemPrompt: config.systemPrompt ?? "",
    mcpServers,
    preapprovedTools,
    capturedAt: Date.now(),
  };
}

function readOptionalText(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const st = statSync(filePath);
    if (!st.isFile() || st.size === 0 || st.size > 512 * 1024) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function scanSkillFrontmatters(dir: string): ContextSection[] {
  if (!existsSync(dir)) return [];
  const results: ContextSection[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const skillFile = path.join(dir, name, "SKILL.md");
      const content = readOptionalText(skillFile);
      if (content === null) continue;
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? content.slice(0, 400);
      results.push({
        label: `Skill: ${name}`,
        source: skillFile,
        chars: fm.length,
        estTokens: estTokens(fm),
        preview: clip(fm, 1200),
      });
    }
  } catch {
    // Ignore unreadable skill directory
  }
  return results;
}

function encodePiCwd(cwd: string): string {
  return `--${cwd.replace(/^\/+/, "").replace(/[\\/]/g, "-")}--`;
}

interface PiSessionDump {
  readonly sessionFile: string;
  readonly exactInputTokens: number | null;
  readonly sections: readonly ContextSection[];
}

function readLatestPiSession(cwd: string): PiSessionDump | null {
  const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions", encodePiCwd(cwd));
  if (!existsSync(sessionsDir)) return null;
  let newest: { file: string; mtimeMs: number } | null = null;
  try {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(sessionsDir, name);
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: st.mtimeMs };
    }
  } catch {
    return null;
  }
  if (!newest) return null;

  try {
    const raw = readFileSync(newest.file, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    const sections: ContextSection[] = [];
    let exactInputTokens: number | null = null;

    for (const line of lines.slice(0, 20)) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const msg = obj.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      if (msg.role === "system") {
        const rawSections = msg.sections as Record<string, unknown> | undefined;
        if (rawSections && typeof rawSections === "object") {
          for (const [key, val] of Object.entries(rawSections)) {
            if (typeof val !== "string" || val.trim() === "") continue;
            sections.push({
              label: `Pi system: ${key}`,
              source: newest.file,
              chars: val.length,
              estTokens: estTokens(val),
              preview: clip(val),
            });
          }
        } else if (typeof msg.content === "string" && msg.content.trim() !== "") {
          sections.push({
            label: "Pi system prompt",
            source: newest.file,
            chars: msg.content.length,
            estTokens: estTokens(msg.content),
            preview: clip(msg.content),
          });
        }

        const toolsAdded = Array.isArray(msg.toolsAdded) ? (msg.toolsAdded as Record<string, unknown>[]) : [];
        if (toolsAdded.length > 0) {
          const coreTools: Record<string, unknown>[] = [];
          const mcpTools: Record<string, unknown>[] = [];
          const otherTools: Record<string, unknown>[] = [];
          for (const tool of toolsAdded) {
            const name = typeof tool.name === "string" ? tool.name : "";
            if (["read", "bash", "edit", "write"].includes(name)) coreTools.push(tool);
            else if (name === "mcp" || name.startsWith("mcp__")) mcpTools.push(tool);
            else otherTools.push(tool);
          }
          const pushToolGroup = (label: string, group: Record<string, unknown>[]) => {
            if (group.length === 0) return;
            const serialized = JSON.stringify(group, null, 2);
            const names = group.map((t) => String(t.name ?? "?")).join(", ");
            sections.push({
              label: `${label} (${group.length})`,
              source: names,
              chars: serialized.length,
              estTokens: estTokens(serialized),
              preview: clip(`Tools: ${names}\n\n${serialized}`, 4000),
            });
          };
          pushToolGroup("Pi core tools", coreTools);
          pushToolGroup("Pi MCP adapter tools", mcpTools);
          pushToolGroup("Pi extension tools", otherTools);
        }
      }

      if (msg.role === "assistant" && exactInputTokens === null) {
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.input === "number" && Number.isFinite(usage.input)) {
          exactInputTokens = usage.input;
        }
      }
    }

    return { sessionFile: newest.file, exactInputTokens, sections };
  } catch {
    return null;
  }
}

export async function buildContextInspectionReport(
  paseo: PaseoApi,
  agentId: string,
  captured: CapturedAgentInit | null,
): Promise<ContextInspectionReport> {
  let provider = captured?.provider ?? "unknown";
  let cwd = captured?.cwd ?? "";
  let model = captured?.model ?? null;

  try {
    const handle = paseo.agents.ref(agentId);
    const snap = handle.current() ?? (await handle.refresh())?.agent;
    if (snap) {
      provider = snap.provider || provider;
      cwd = snap.cwd || cwd;
      if (snap.model) model = snap.model;
    }
  } catch {
    // Use captured fallback metadata
  }

  const sections: ContextSection[] = [];
  const notes: string[] = [];

  if (captured?.systemPrompt) {
    sections.push({
      label: "Paseo & plugins systemPrompt",
      source: "agent.create hook",
      chars: captured.systemPrompt.length,
      estTokens: estTokens(captured.systemPrompt),
      preview: clip(captured.systemPrompt),
    });
  } else {
    notes.push("Session started before the latest plugin reload: Paseo's `agent.create` systemPrompt was not captured in memory.");
  }

  // Workspace & global context files
  const home = os.homedir();
  const contextFiles: { label: string; path: string }[] = [
    ...(cwd
      ? [
          { label: "Workspace AGENTS.md", path: path.join(cwd, "AGENTS.md") },
          { label: "Workspace CLAUDE.md", path: path.join(cwd, "CLAUDE.md") },
        ]
      : []),
    { label: "Global ~/.pi/agent/APPEND_SYSTEM.md", path: path.join(home, ".pi", "agent", "APPEND_SYSTEM.md") },
    { label: "Global ~/.claude/CLAUDE.md", path: path.join(home, ".claude", "CLAUDE.md") },
  ];

  for (const candidate of contextFiles) {
    const content = readOptionalText(candidate.path);
    if (content !== null && content.trim() !== "") {
      sections.push({
        label: candidate.label,
        source: candidate.path,
        chars: content.length,
        estTokens: estTokens(content),
        preview: clip(content),
      });
    }
  }

  let exactInputTokens: number | null = null;
  if (provider.toLowerCase() === "pi" && cwd) {
    const piDump = readLatestPiSession(cwd);
    if (piDump) {
      exactInputTokens = piDump.exactInputTokens;
      sections.push(...piDump.sections);
    } else {
      notes.push("No Pi session transcript found yet for this workspace (send 1 message first to inspect Pi's full dump).");
    }
  } else {
    // For non-Pi harnesses, list installed skills frontmatters as a helpful reference
    const skills = scanSkillFrontmatters(path.join(home, ".agents", "skills"));
    if (skills.length > 0) {
      const totalChars = skills.reduce((sum, s) => sum + s.chars, 0);
      sections.push({
        label: `Installed skills (${skills.length})`,
        source: "~/.agents/skills",
        chars: totalChars,
        estTokens: Math.ceil(totalChars / 4),
        preview: skills.map((s) => `- ${s.label}: ~${s.estTokens} tok`).join("\n"),
      });
    }
    notes.push(
      `Harness "${provider}" builds its own internal system prompt and native tool schemas inside its CLI process, so only Paseo-injected context and workspace files are directly inspectable.`,
    );
  }

  const totalEstTokens = sections.reduce((sum, s) => sum + s.estTokens, 0);

  return {
    provider,
    cwd,
    model,
    exactInputTokens,
    totalEstTokens,
    sections,
    mcpServers: captured?.mcpServers ?? [],
    notes,
  };
}

/** Formats the inspection report as a valid ```ui spec rendered inline in Paseo. */
export function buildContextInspectorSpec(report: ContextInspectionReport): string {
  const sorted = [...report.sections].sort((a, b) => b.estTokens - a.estTokens);
  const topChart = sorted.slice(0, 10);
  const chartLabels = JSON.stringify(topChart.map((s) => s.label.slice(0, 22)));
  const chartValues = JSON.stringify(topChart.map((s) => s.estTokens));

  const tableRows = JSON.stringify(
    sorted.map((s) => [s.label, `${s.chars.toLocaleString("en-US")} chars`, `~${s.estTokens.toLocaleString("en-US")} tok`]),
  );

  const mcpText =
    report.mcpServers.length > 0
      ? report.mcpServers.map((m) => `${m.name} (${m.type})`).join(", ")
      : "None captured";

  const detailBlocks = sorted
    .slice(0, 12)
    .map(
      (s) =>
        `Details(${JSON.stringify(`${s.label} — ~${s.estTokens} tok (${s.chars} chars)`)}, [Code(${JSON.stringify(s.preview)}, "markdown")])`,
    )
    .join(",\n    ");

  const metrics = [
    `Metric("Provider", ${JSON.stringify(report.provider)})`,
    report.exactInputTokens !== null
      ? `Metric("1st Turn Input", ${JSON.stringify(`${report.exactInputTokens.toLocaleString("en-US")} tok`)}, note: "actual API usage", tone: "info")`
      : `Metric("Inspectable Context", ${JSON.stringify(`~${report.totalEstTokens.toLocaleString("en-US")} tok`)}, note: "estimated", tone: "info")`,
    `Metric("Sections", ${JSON.stringify(String(report.sections.length))})`,
    `Metric("MCP Servers", ${JSON.stringify(String(report.mcpServers.length))}, note: ${JSON.stringify(mcpText)})`,
  ];

  const children: string[] = [
    `Row([${metrics.join(", ")}])`,
  ];

  if (topChart.length > 0) {
    children.push(
      `Chart("bar", ${chartLabels}, ${chartValues}, orientation: "horizontal", unit: "tok", showValues: true, title: "Estimated tokens by section", height: ${Math.max(180, Math.min(360, topChart.length * 34 + 60))})`,
    );
  }

  if (sorted.length > 0) {
    children.push(`Table(["Section", "Size", "Est. tokens"], ${tableRows})`);
  }

  for (const note of report.notes) {
    children.push(`Callout(${JSON.stringify(note)}, tone: "info")`);
  }

  if (detailBlocks) {
    children.push(`Stack([\n    ${detailBlocks}\n  ])`);
  }

  return `Card(${JSON.stringify(`Initial Context Inspector (${report.provider}${report.model ? ` · ${report.model}` : ""})`)}, [\n  ${children.join(",\n  ")}\n])`;
}
