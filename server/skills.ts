import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { resolveAgentCwd } from "./data-source";

const execFileAsync = promisify(execFile);

type PaseoApi = PluginHandlerContext["paseo"];

export type SkillRootScope = "lazy" | "agents" | "pi" | "claude" | "codex";

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly path: string;
  readonly body: string;
  readonly raw: string;
  readonly editable: boolean;
  readonly lazy: boolean;
  readonly repoId?: string;
  readonly frontmatterTokens: number;
  readonly fullTokens: number;
}

export interface StoredSkillRepo {
  id: string;
  url: string;
  branch: string;
  mode: "eager" | "lazy";
  localPath: string;
  currentSha: string;
  installedSkills: string[];
  addedAt: number;
  updatedAt: number;
}

export interface SkillRepoStatus extends StoredSkillRepo {
  remoteSha?: string;
  hasUpdate: boolean;
  lastCheckedAt?: number;
  error?: string;
}

const MAX_SKILL_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 45_000;
const GIT_LS_REMOTE_TIMEOUT_MS = 8_000;

function defaultReposBaseDir(): string {
  return path.join(os.homedir(), ".paseo", "genui-skill-repos");
}

function defaultReposManifestPath(): string {
  return path.join(os.homedir(), ".paseo", "genui-skill-repos.json");
}

function defaultAgentsSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

export function defaultLazySkillsDir(): string {
  return path.join(os.homedir(), ".paseo", "genui-lazy-skills");
}

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

export function formatSkillMarkdown(name: string, description: string, body: string): string {
  const cleanName = name.trim();
  const cleanDesc = description.trim().replace(/\r?\n/g, " ");
  const quotedDesc = cleanDesc.includes(":") || cleanDesc.includes("#") || cleanDesc.includes('"')
    ? JSON.stringify(cleanDesc)
    : cleanDesc;
  const fmLines = ["---", `name: ${cleanName}`];
  if (cleanDesc) fmLines.push(`description: ${quotedDesc}`);
  fmLines.push("---", "");
  return `${fmLines.join("\n")}${body.trim()}\n`;
}

export function sanitizeSkillSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function normalizeGitRepoUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Shorthand: owner/repo -> https://github.com/owner/repo.git
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  if (/^https?:\/\/\S+$/i.test(trimmed) || /^git@[^:\s]+:\S+$/i.test(trimmed) || /^ssh:\/\/\S+$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function repoSlugFromUrl(url: string): string {
  const cleaned = url
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^ssh:\/\//i, "")
    .replace(/^git@/, "")
    .replace(/[:/]+/g, "-");
  return sanitizeSkillSlug(cleaned) || `repo-${Date.now()}`;
}

function readReposManifest(manifestPath = defaultReposManifestPath()): StoredSkillRepo[] {
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is Partial<StoredSkillRepo> & { id: string } => typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string")
      .map((r) => ({
        id: r.id,
        url: r.url ?? "",
        branch: r.branch ?? "main",
        mode: r.mode === "eager" ? "eager" : "lazy",
        localPath: r.localPath ?? "",
        currentSha: r.currentSha ?? "",
        installedSkills: Array.isArray(r.installedSkills) ? r.installedSkills : [],
        addedAt: typeof r.addedAt === "number" ? r.addedAt : 0,
        updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
      }));
  } catch {
    return [];
  }
}

function writeReposManifest(repos: StoredSkillRepo[], manifestPath = defaultReposManifestPath()): void {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(repos, null, 2)}\n`, "utf8");
  renameSync(tmp, manifestPath);
}

function allowedGlobalRoots(home = os.homedir()): Record<SkillRootScope, string> {
  return {
    lazy: path.join(home, ".paseo", "genui-lazy-skills"),
    agents: path.join(home, ".agents", "skills"),
    pi: path.join(home, ".pi", "agent", "skills"),
    claude: path.join(home, ".claude", "skills"),
    codex: path.join(home, ".codex", "skills"),
  };
}

function isPathInsideRoot(filePath: string, rootDir: string): boolean {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile.startsWith(`${resolvedRoot}${path.sep}`);
}

function isAllowedSkillFile(filePath: string, extraRoots: readonly string[] = []): boolean {
  if (path.basename(filePath) !== "SKILL.md") return false;
  const roots = [...Object.values(allowedGlobalRoots()), ...extraRoots];
  return roots.some((root) => isPathInsideRoot(filePath, root));
}

function scanDirectory(
  dir: string,
  source: string,
  lazy: boolean,
  reposByLocalPath: ReadonlyMap<string, string>,
  seen: Set<string>,
  out: SkillEntry[],
): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryDir = path.join(dir, entry);
    const skillFile = path.join(entryDir, "SKILL.md");
    try {
      if (!existsSync(skillFile)) continue;
      const st = statSync(skillFile);
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue;
      const raw = readFileSync(skillFile, "utf8");
      const parsed = parseSkillMarkdown(raw, entry);
      const key = parsed.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let repoId: string | undefined;
      try {
        const real = realpathSync(entryDir);
        for (const [repoPath, id] of reposByLocalPath.entries()) {
          if (real === repoPath || real.startsWith(`${repoPath}${path.sep}`)) {
            repoId = id;
            break;
          }
        }
      } catch {
        // Ignore realpath failures
      }

      out.push({
        name: parsed.name,
        description: parsed.description,
        source: repoId ? `git:${repoId}` : source,
        path: skillFile,
        body: parsed.body,
        raw,
        editable: !repoId,
        lazy,
        ...(repoId ? { repoId } : {}),
        frontmatterTokens: estTokens(parsed.frontmatter || parsed.description),
        fullTokens: estTokens(raw),
      });
    } catch {
      // Ignore unreadable skill entry
    }
  }
}

export function scanAllSkillsSync(cwd?: string | null, home = os.homedir()): SkillEntry[] {
  const globalRoots = allowedGlobalRoots(home);
  const roots: { dir: string; source: string; lazy: boolean }[] = [
    ...(cwd
      ? [
          { dir: path.join(cwd, ".agents", "skills"), source: "workspace", lazy: false },
          { dir: path.join(cwd, ".claude", "skills"), source: "workspace", lazy: false },
          { dir: path.join(cwd, ".codex", "skills"), source: "workspace", lazy: false },
          { dir: path.join(cwd, ".pi", "skills"), source: "workspace", lazy: false },
        ]
      : []),
    { dir: globalRoots.lazy, source: "lazy", lazy: true },
    { dir: globalRoots.agents, source: "agents", lazy: false },
    { dir: globalRoots.pi, source: "pi", lazy: false },
    { dir: globalRoots.claude, source: "claude", lazy: false },
    { dir: globalRoots.codex, source: "codex", lazy: false },
  ];

  const repos = readReposManifest();
  const reposByLocalPath = new Map<string, string>();
  for (const repo of repos) {
    try {
      reposByLocalPath.set(existsSync(repo.localPath) ? realpathSync(repo.localPath) : path.resolve(repo.localPath), repo.id);
    } catch {
      reposByLocalPath.set(path.resolve(repo.localPath), repo.id);
    }
  }

  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const root of roots) {
    scanDirectory(root.dir, root.source, root.lazy, reposByLocalPath, seen, out);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listInstalledSkills(paseo: PaseoApi, agentId?: string): Promise<SkillEntry[]> {
  const cwd = agentId ? await resolveAgentCwd(paseo, agentId) : null;
  return scanAllSkillsSync(cwd);
}

/** Searches lazy (MCP-only) skills by keyword, falling back to all installed skills if requested. */
export function searchSkillsForMcp(
  query?: string,
  limit = 15,
  cwd?: string | null,
  home = os.homedir(),
): string {
  const capped = Math.max(1, Math.min(50, Math.floor(limit || 15)));
  const all = scanAllSkillsSync(cwd, home);
  const lazySkills = all.filter((s) => s.lazy);
  const pool = lazySkills.length > 0 ? lazySkills : all;

  const q = (query ?? "").trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  const scored = pool
    .map((skill) => {
      if (tokens.length === 0) return { skill, score: 1 };
      const hayName = skill.name.toLowerCase();
      const hayDesc = skill.description.toLowerCase();
      const haySource = skill.source.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (hayName === tok) score += 10;
        else if (hayName.includes(tok)) score += 5;
        if (hayDesc.includes(tok)) score += 2;
        if (haySource.includes(tok)) score += 1;
      }
      return { skill, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  if (scored.length === 0) {
    if (pool.length === 0) {
      return "No skills installed yet. Add local or Git skills in Gen-UI Plus → Skills.";
    }
    return `No skills matched "${query ?? ""}" (${lazySkills.length} lazy / ${all.length} total skills installed). Try a broader keyword or omit query to list available skills.`;
  }

  const shown = scored.slice(0, capped);
  const header = q
    ? `Found ${scored.length} matching skill${scored.length === 1 ? "" : "s"} (showing ${shown.length}):`
    : `Available ${lazySkills.length > 0 ? "lazy " : ""}skills (${shown.length}/${pool.length}):`;
  const lines = [
    header,
    ...shown.map(({ skill }) => {
      const desc = skill.description ? ` — ${skill.description.slice(0, 140)}` : "";
      const tag = skill.lazy ? "lazy" : skill.source;
      return `- ${skill.name} [${tag}, ~${skill.fullTokens} tok]${desc}`;
    }),
    "",
    "Call `skills_read(name)` to load the full SKILL.md instructions for any skill above.",
  ];
  return lines.join("\n");
}

/** Reads the full SKILL.md instructions for a named skill (lazy or eager). */
export function readSkillForMcp(
  name: string,
  cwd?: string | null,
  home = os.homedir(),
): { ok: true; text: string } | { ok: false; error: string } {
  const needle = name.trim().toLowerCase();
  if (!needle) return { ok: false, error: "Provide a skill name." };

  const all = scanAllSkillsSync(cwd, home);
  const match =
    all.find((s) => s.name.toLowerCase() === needle) ??
    all.find((s) => path.basename(path.dirname(s.path)).toLowerCase() === needle) ??
    all.find((s) => s.name.toLowerCase().includes(needle));

  if (!match) {
    const sample = all.slice(0, 12).map((s) => s.name).join(", ");
    return {
      ok: false,
      error: `Skill "${name}" not found.${sample ? ` Available: ${sample}` : ""} Call skills_search() to browse.`,
    };
  }

  return {
    ok: true,
    text: `# Skill: ${match.name}\nSource: ${match.source}${match.lazy ? " (lazy MCP)" : ""}\nPath: ${match.path}\n\n${match.body || match.raw}`,
  };
}

export async function saveLocalSkill(
  input: {
    name?: string;
    description?: string;
    body?: string;
    raw?: string;
    scope?: SkillRootScope;
    existingPath?: string;
  },
  extraRoots: readonly string[] = [],
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    if (input.existingPath) {
      if (!isAllowedSkillFile(input.existingPath, extraRoots)) {
        return { ok: false, error: "Refused to write outside allowed skill directories." };
      }
      const content =
        typeof input.raw === "string"
          ? `${input.raw.replace(/\r\n?/g, "\n").trimEnd()}\n`
          : formatSkillMarkdown(input.name ?? path.basename(path.dirname(input.existingPath)), input.description ?? "", input.body ?? "");
      writeFileSync(input.existingPath, content, "utf8");
      return { ok: true, path: input.existingPath };
    }

    const rawName = (input.name ?? "").trim();
    const slug = sanitizeSkillSlug(rawName);
    if (!slug) {
      return { ok: false, error: "Skill name is required (letters, numbers, hyphens)." };
    }
    const scope: SkillRootScope = input.scope ?? "agents";
    const rootDir = allowedGlobalRoots()[scope];
    const skillDir = path.join(rootDir, slug);
    const skillFile = path.join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    const content =
      typeof input.raw === "string" && input.raw.trim()
        ? `${input.raw.replace(/\r\n?/g, "\n").trimEnd()}\n`
        : formatSkillMarkdown(rawName, input.description ?? "", input.body ?? "");
    writeFileSync(skillFile, content, "utf8");
    return { ok: true, path: skillFile };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function deleteLocalSkill(
  skillFilePath: string,
  extraRoots: readonly string[] = [],
): { ok: true } | { ok: false; error: string } {
  try {
    if (!isAllowedSkillFile(skillFilePath, extraRoots)) {
      return { ok: false, error: "Refused to delete outside allowed skill directories." };
    }
    const skillDir = path.dirname(skillFilePath);
    if (!existsSync(skillDir)) {
      return { ok: false, error: "Skill directory does not exist." };
    }
    const st = lstatSync(skillDir);
    if (st.isSymbolicLink()) {
      unlinkSync(skillDir);
    } else {
      rmSync(skillDir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function discoverSkillDirsInRepo(repoDir: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    if (existsSync(path.join(dir, "SKILL.md"))) {
      found.push(dir);
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules" || entry === ".github") continue;
      const child = path.join(dir, entry);
      try {
        if (statSync(child).isDirectory()) {
          walk(child, depth + 1);
        }
      } catch {
        // Ignore broken entries
      }
    }
  };
  walk(repoDir, 0);
  return found;
}

function syncRepoSymlinks(
  repo: { id: string; localPath: string },
  previousSkills: readonly string[],
  targetRoot = defaultAgentsSkillsDir(),
): string[] {
  mkdirSync(targetRoot, { recursive: true });
  const repoReal = existsSync(repo.localPath) ? realpathSync(repo.localPath) : path.resolve(repo.localPath);

  // Clean up old symlinks belonging to this repo before re-linking.
  for (const oldName of previousSkills) {
    const linkPath = path.join(targetRoot, oldName);
    try {
      if (lstatSync(linkPath).isSymbolicLink()) {
        const target = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
        if (target === repoReal || target.startsWith(`${repoReal}${path.sep}`)) {
          unlinkSync(linkPath);
        }
      }
    } catch {
      // Ignore missing link
    }
  }

  const skillDirs = discoverSkillDirsInRepo(repo.localPath);
  const installed: string[] = [];

  for (const dir of skillDirs) {
    const baseName = sanitizeSkillSlug(path.basename(dir) === path.basename(repo.localPath) ? repo.id : path.basename(dir));
    if (!baseName) continue;
    const linkPath = path.join(targetRoot, baseName);
    if (existsSync(linkPath)) {
      try {
        const st = lstatSync(linkPath);
        if (st.isSymbolicLink()) {
          const target = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
          if (target === repoReal || target.startsWith(`${repoReal}${path.sep}`)) {
            unlinkSync(linkPath);
          } else {
            continue;
          }
        } else {
          // Do not overwrite a user's hand-edited local skill directory.
          continue;
        }
      } catch {
        continue;
      }
    }
    symlinkSync(dir, linkPath, process.platform === "win32" ? "junction" : "dir");
    installed.push(baseName);
  }

  return installed.sort();
}

async function runGit(args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function fetchRemoteHeadSha(url: string, branch: string): Promise<string | null> {
  try {
    const ref = branch && branch !== "HEAD" ? `refs/heads/${branch}` : "HEAD";
    const out = await runGit(["ls-remote", url, ref], GIT_LS_REMOTE_TIMEOUT_MS);
    const first = out.split(/\s+/)[0]?.trim();
    return first && /^[0-9a-f]{7,40}$/i.test(first) ? first : null;
  } catch {
    return null;
  }
}

export async function listSkillRepos(
  checkUpdates = false,
  manifestPath = defaultReposManifestPath(),
): Promise<SkillRepoStatus[]> {
  const repos = readReposManifest(manifestPath);
  if (!checkUpdates) {
    return repos.map((repo) => ({ ...repo, hasUpdate: false }));
  }

  const now = Date.now();
  return Promise.all(
    repos.map(async (repo) => {
      const remoteSha = await fetchRemoteHeadSha(repo.url, repo.branch);
      if (!remoteSha) {
        return {
          ...repo,
          hasUpdate: false,
          lastCheckedAt: now,
          error: "Could not check remote (offline or auth required).",
        };
      }
      return {
        ...repo,
        remoteSha,
        hasUpdate: remoteSha !== repo.currentSha,
        lastCheckedAt: now,
      };
    }),
  );
}

export async function addSkillRepo(
  input: { url: string; branch?: string; mode?: "eager" | "lazy" },
  opts?: { reposBaseDir?: string; manifestPath?: string; targetRoot?: string },
): Promise<{ ok: true; repo: SkillRepoStatus } | { ok: false; error: string }> {
  const normalizedUrl = normalizeGitRepoUrl(input.url);
  if (!normalizedUrl) {
    return { ok: false, error: 'Invalid Git URL. Use "owner/repo" or an https:// / git@ URL.' };
  }

  const mode: "eager" | "lazy" = input.mode === "eager" ? "eager" : "lazy";
  const reposBaseDir = opts?.reposBaseDir ?? defaultReposBaseDir();
  const manifestPath = opts?.manifestPath ?? defaultReposManifestPath();
  const targetRoot = opts?.targetRoot ?? (mode === "lazy" ? defaultLazySkillsDir() : defaultAgentsSkillsDir());
  const repos = readReposManifest(manifestPath);

  const existing = repos.find((r) => r.url.toLowerCase() === normalizedUrl.toLowerCase());
  if (existing) {
    return { ok: false, error: `Repository "${normalizedUrl}" is already added.` };
  }

  let id = repoSlugFromUrl(normalizedUrl);
  while (repos.some((r) => r.id === id)) {
    id = `${id}-${Math.floor(Math.random() * 1000)}`;
  }

  const localPath = path.join(reposBaseDir, id);
  mkdirSync(reposBaseDir, { recursive: true });
  if (existsSync(localPath)) {
    rmSync(localPath, { recursive: true, force: true });
  }

  try {
    const cleanBranch = input.branch?.trim();
    const cloneArgs = ["clone", "--depth", "1", ...(cleanBranch ? ["-b", cleanBranch] : []), normalizedUrl, localPath];
    await runGit(cloneArgs);

    const currentSha = await runGit(["-C", localPath, "rev-parse", "HEAD"]);
    const branch = cleanBranch || (await runGit(["-C", localPath, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "main"));
    const installedSkills = syncRepoSymlinks({ id, localPath }, [], targetRoot);

    const now = Date.now();
    const stored: StoredSkillRepo = {
      id,
      url: normalizedUrl,
      branch,
      mode,
      localPath,
      currentSha,
      installedSkills,
      addedAt: now,
      updatedAt: now,
    };
    writeReposManifest([...repos, stored], manifestPath);
    return { ok: true, repo: { ...stored, hasUpdate: false, lastCheckedAt: now } };
  } catch (err) {
    if (existsSync(localPath)) {
      rmSync(localPath, { recursive: true, force: true });
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateSkillRepo(
  id: string,
  opts?: { manifestPath?: string; targetRoot?: string },
): Promise<{ ok: true; repo: SkillRepoStatus } | { ok: false; error: string }> {
  const manifestPath = opts?.manifestPath ?? defaultReposManifestPath();
  const repos = readReposManifest(manifestPath);
  const idx = repos.findIndex((r) => r.id === id);
  if (idx === -1) {
    return { ok: false, error: `Skill repository "${id}" not found.` };
  }

  const repo = repos[idx]!;
  const targetRoot = opts?.targetRoot ?? (repo.mode === "lazy" ? defaultLazySkillsDir() : defaultAgentsSkillsDir());
  try {
    if (!existsSync(repo.localPath)) {
      mkdirSync(path.dirname(repo.localPath), { recursive: true });
      await runGit(["clone", "--depth", "1", "-b", repo.branch, repo.url, repo.localPath]);
    } else {
      await runGit(["-C", repo.localPath, "fetch", "--depth", "1", "origin", repo.branch]);
      await runGit(["-C", repo.localPath, "reset", "--hard", "FETCH_HEAD"]);
    }

    const currentSha = await runGit(["-C", repo.localPath, "rev-parse", "HEAD"]);
    const installedSkills = syncRepoSymlinks(repo, repo.installedSkills, targetRoot);
    const now = Date.now();
    const updated: StoredSkillRepo = {
      ...repo,
      currentSha,
      installedSkills,
      updatedAt: now,
    };
    const next = [...repos];
    next[idx] = updated;
    writeReposManifest(next, manifestPath);
    return { ok: true, repo: { ...updated, remoteSha: currentSha, hasUpdate: false, lastCheckedAt: now } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function removeSkillRepo(
  id: string,
  opts?: { manifestPath?: string; targetRoot?: string },
): { ok: true } | { ok: false; error: string } {
  const manifestPath = opts?.manifestPath ?? defaultReposManifestPath();
  const repos = readReposManifest(manifestPath);
  const repo = repos.find((r) => r.id === id);
  if (!repo) {
    return { ok: false, error: `Skill repository "${id}" not found.` };
  }

  const targetRoot = opts?.targetRoot ?? (repo.mode === "lazy" ? defaultLazySkillsDir() : defaultAgentsSkillsDir());
  try {
    const repoReal = existsSync(repo.localPath) ? realpathSync(repo.localPath) : path.resolve(repo.localPath);
    for (const skillName of repo.installedSkills) {
      const linkPath = path.join(targetRoot, skillName);
      try {
        if (lstatSync(linkPath).isSymbolicLink()) {
          const target = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
          if (target === repoReal || target.startsWith(`${repoReal}${path.sep}`)) {
            unlinkSync(linkPath);
          }
        }
      } catch {
        // Ignore missing links
      }
    }
    if (existsSync(repo.localPath)) {
      rmSync(repo.localPath, { recursive: true, force: true });
    }
    writeReposManifest(
      repos.filter((r) => r.id !== id),
      manifestPath,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function removeRepoSymlinksFromRoot(repo: { localPath: string; installedSkills: readonly string[] }, targetRoot: string): void {
  const repoReal = existsSync(repo.localPath) ? realpathSync(repo.localPath) : path.resolve(repo.localPath);
  for (const skillName of repo.installedSkills) {
    const linkPath = path.join(targetRoot, skillName);
    try {
      if (lstatSync(linkPath).isSymbolicLink()) {
        const target = path.resolve(path.dirname(linkPath), readlinkSync(linkPath));
        if (target === repoReal || target.startsWith(`${repoReal}${path.sep}`)) {
          unlinkSync(linkPath);
        }
      }
    } catch {
      // Ignore missing links
    }
  }
}

function moveDirectory(src: string, dst: string): void {
  mkdirSync(path.dirname(dst), { recursive: true });
  try {
    renameSync(src, dst);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/** Moves a local global skill between `~/.paseo/genui-lazy-skills` (lazy MCP) and `~/.agents/skills` (eager). */
export function toggleLocalSkillMode(
  skillFilePath: string,
  home = os.homedir(),
): { ok: true; lazy: boolean; path: string } | { ok: false; error: string } {
  try {
    const roots = allowedGlobalRoots(home);
    if (path.basename(skillFilePath) !== "SKILL.md") {
      return { ok: false, error: "Expected a SKILL.md file." };
    }
    const inGlobalRoot = Object.values(roots).some((root) => isPathInsideRoot(skillFilePath, root));
    if (!inGlobalRoot) {
      return { ok: false, error: "Only global user skills can be toggled between Lazy and Eager." };
    }

    const srcDir = path.dirname(skillFilePath);
    if (!existsSync(srcDir)) {
      return { ok: false, error: "Skill directory does not exist." };
    }
    if (lstatSync(srcDir).isSymbolicLink()) {
      return { ok: false, error: "Git-managed skills must be toggled from their Git library row." };
    }

    const currentlyLazy = isPathInsideRoot(skillFilePath, roots.lazy);
    const nextLazy = !currentlyLazy;
    const dstRoot = nextLazy ? roots.lazy : roots.agents;
    const slug = path.basename(srcDir);
    const dstDir = path.join(dstRoot, slug);

    if (existsSync(dstDir)) {
      return {
        ok: false,
        error: `A skill named "${slug}" already exists in ${nextLazy ? "Lazy (MCP)" : "Eager (~/.agents/skills)"}.`,
      };
    }

    moveDirectory(srcDir, dstDir);
    return { ok: true, lazy: nextLazy, path: path.join(dstDir, "SKILL.md") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Switches a Git skill library between `lazy` (`~/.paseo/genui-lazy-skills`) and `eager` (`~/.agents/skills`). */
export function toggleSkillRepoMode(
  id: string,
  opts?: { manifestPath?: string; lazyRoot?: string; eagerRoot?: string },
): { ok: true; repo: SkillRepoStatus } | { ok: false; error: string } {
  const manifestPath = opts?.manifestPath ?? defaultReposManifestPath();
  const lazyRoot = opts?.lazyRoot ?? defaultLazySkillsDir();
  const eagerRoot = opts?.eagerRoot ?? defaultAgentsSkillsDir();
  const repos = readReposManifest(manifestPath);
  const idx = repos.findIndex((r) => r.id === id);
  if (idx === -1) {
    return { ok: false, error: `Skill repository "${id}" not found.` };
  }

  const repo = repos[idx]!;
  const oldRoot = repo.mode === "lazy" ? lazyRoot : eagerRoot;
  const nextMode: "eager" | "lazy" = repo.mode === "lazy" ? "eager" : "lazy";
  const nextRoot = nextMode === "lazy" ? lazyRoot : eagerRoot;

  try {
    removeRepoSymlinksFromRoot(repo, oldRoot);
    const installedSkills = syncRepoSymlinks(repo, [], nextRoot);
    const now = Date.now();
    const updated: StoredSkillRepo = {
      ...repo,
      mode: nextMode,
      installedSkills,
      updatedAt: now,
    };
    const next = [...repos];
    next[idx] = updated;
    writeReposManifest(next, manifestPath);
    return { ok: true, repo: { ...updated, hasUpdate: false } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
