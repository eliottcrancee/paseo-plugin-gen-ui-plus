import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { resolveAgentCwd } from "./data-source";

type PaseoApi = PluginHandlerContext["paseo"];

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly path: string;
  readonly body: string;
  readonly frontmatterTokens: number;
  readonly fullTokens: number;
}

const MAX_SKILL_BYTES = 256 * 1024;

function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Parses simple YAML frontmatter (`name` + single/multi-line `description`) from a SKILL.md file. */
export function parseSkillMarkdown(raw: string, fallbackName: string): {
  name: string;
  description: string;
  frontmatter: string;
  body: string;
} {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    return { name: fallbackName, description: "", frontmatter: "", body: normalized.trim() };
  }

  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  let name = fallbackName;
  let description = "";

  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1]!.trim().replace(/^["']|["']$/g, "") || fallbackName;
      continue;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch) {
      const rest = descMatch[1]!.trim();
      if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-" || rest === "") {
        const block: string[] = [];
        while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
          i++;
          block.push(lines[i]!.trim());
        }
        description = block.filter(Boolean).join(" ").trim();
      } else {
        description = rest.replace(/^["']|["']$/g, "");
      }
    }
  }

  return { name, description, frontmatter, body };
}

function scanDirectory(dir: string, source: string, seen: Set<string>, out: SkillEntry[]): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const skillFile = path.join(dir, entry, "SKILL.md");
    try {
      if (!existsSync(skillFile)) continue;
      const st = statSync(skillFile);
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue;
      const raw = readFileSync(skillFile, "utf8");
      const parsed = parseSkillMarkdown(raw, entry);
      const key = parsed.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: parsed.name,
        description: parsed.description,
        source,
        path: skillFile,
        body: parsed.body,
        frontmatterTokens: estTokens(parsed.frontmatter || parsed.description),
        fullTokens: estTokens(raw),
      });
    } catch {
      // Ignore unreadable skill entry
    }
  }
}

export async function listInstalledSkills(paseo: PaseoApi, agentId?: string): Promise<SkillEntry[]> {
  const cwd = agentId ? await resolveAgentCwd(paseo, agentId) : null;
  const home = os.homedir();
  const roots: { dir: string; source: string }[] = [
    ...(cwd
      ? [
          { dir: path.join(cwd, ".agents", "skills"), source: "workspace" },
          { dir: path.join(cwd, ".claude", "skills"), source: "workspace" },
          { dir: path.join(cwd, ".codex", "skills"), source: "workspace" },
          { dir: path.join(cwd, ".pi", "skills"), source: "workspace" },
        ]
      : []),
    { dir: path.join(home, ".agents", "skills"), source: "agents" },
    { dir: path.join(home, ".pi", "agent", "skills"), source: "pi" },
    { dir: path.join(home, ".claude", "skills"), source: "claude" },
    { dir: path.join(home, ".codex", "skills"), source: "codex" },
  ];

  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const root of roots) {
    scanDirectory(root.dir, root.source, seen, out);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
