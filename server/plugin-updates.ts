import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PLUGIN_REPO_SLUG = "eliottcrancee/paseo-plugin-gen-ui-plus";
export const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_REPO_SLUG}`;

export interface PluginUpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  currentSha: string | null;
  latestSha: string | null;
  latestCommitMessage: string | null;
  latestCommitDate: string | null;
  hasUpdate: boolean;
  repoUrl: string;
  checkedAt: number;
  error?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;

let cachedInfo: PluginUpdateInfo | null = null;

function isPluginRoot(dir: string): boolean {
  return existsSync(join(dir, "paseo-plugin.json")) || existsSync(join(dir, "package.json"));
}

function pluginRootDir(): string {
  // Walk up from import.meta.url (handles both unbundled server/*.ts and Paseo-bundled root index.server.js).
  try {
    if (typeof import.meta.url === "string" && import.meta.url.startsWith("file:")) {
      let cur = dirname(fileURLToPath(import.meta.url));
      for (let i = 0; i < 4; i++) {
        if (isPluginRoot(cur)) return cur;
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
  } catch {
    // Fallback below
  }

  // Fallback: locate the newest installed revision checkout under ~/.paseo/plugins/genui/*/checkout.
  try {
    const base = join(homedir(), ".paseo", "plugins", "genui");
    if (existsSync(base)) {
      const candidates = readdirSync(base)
        .map((entry) => join(base, entry, "checkout"))
        .filter((dir) => existsSync(dir) && isPluginRoot(dir))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (candidates[0]) return candidates[0];
    }
  } catch {
    // Ignore
  }

  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function readGitHeadDirectly(root: string): string | null {
  try {
    const gitDir = join(root, ".git");
    const headPath = join(gitDir, "HEAD");
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, "utf8").trim();
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head;
    const refMatch = /^ref:\s*(.+)$/.exec(head);
    if (!refMatch?.[1]) return null;
    const refName = refMatch[1].trim();
    const looseRef = join(gitDir, refName);
    if (existsSync(looseRef)) {
      const sha = readFileSync(looseRef, "utf8").trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
    }
    const packedRefs = join(gitDir, "packed-refs");
    if (existsSync(packedRefs)) {
      for (const line of readFileSync(packedRefs, "utf8").split("\n")) {
        if (line.startsWith("#") || line.startsWith("^")) continue;
        const [sha, ref] = line.trim().split(/\s+/);
        if (ref === refName && sha && /^[0-9a-f]{7,40}$/i.test(sha)) return sha;
      }
    }
  } catch {
    // Fall through to git CLI
  }
  return null;
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function readLocalPackageVersion(root: string): string {
  try {
    const pkgPath = join(root, "package.json");
    if (!existsSync(pkgPath)) return "0.0.0";
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function readLocalGitSha(root: string): Promise<string | null> {
  const direct = readGitHeadDirectly(root);
  if (direct) return direct;
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 3_000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "paseo-plugin-gen-ui-plus",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkPluginUpdate(force = false): Promise<PluginUpdateInfo> {
  const now = Date.now();
  if (!force && cachedInfo && now - cachedInfo.checkedAt < CACHE_TTL_MS) {
    return cachedInfo;
  }

  const root = pluginRootDir();
  const currentVersion = readLocalPackageVersion(root);
  const currentSha = await readLocalGitSha(root);

  try {
    const [commitData, remotePkg] = await Promise.all([
      fetchJson<{
        sha?: string;
        commit?: { message?: string; committer?: { date?: string } };
      }>(`https://api.github.com/repos/${PLUGIN_REPO_SLUG}/commits/main`),
      fetchJson<{ version?: string }>(
        `https://raw.githubusercontent.com/${PLUGIN_REPO_SLUG}/main/package.json`,
      ),
    ]);

    const latestSha = typeof commitData?.sha === "string" ? commitData.sha : null;
    const latestCommitMessage =
      typeof commitData?.commit?.message === "string"
        ? commitData.commit.message.split("\n")[0]!.trim()
        : null;
    const latestCommitDate =
      typeof commitData?.commit?.committer?.date === "string"
        ? commitData.commit.committer.date
        : null;
    const latestVersion =
      typeof remotePkg?.version === "string" && remotePkg.version.trim()
        ? remotePkg.version.trim()
        : null;

    if (!latestSha && !latestVersion) {
      const offlineResult: PluginUpdateInfo = {
        currentVersion,
        latestVersion: null,
        currentSha,
        latestSha: null,
        latestCommitMessage: null,
        latestCommitDate: null,
        hasUpdate: false,
        repoUrl: PLUGIN_REPO_URL,
        checkedAt: now,
        error: "Unable to reach GitHub to check for updates.",
      };
      cachedInfo = offlineResult;
      return offlineResult;
    }

    const versionBehind = latestVersion !== null && compareSemver(latestVersion, currentVersion) > 0;
    const shaBehind = currentSha !== null && latestSha !== null && !latestSha.startsWith(currentSha) && !currentSha.startsWith(latestSha);
    const hasUpdate = versionBehind || shaBehind;

    const info: PluginUpdateInfo = {
      currentVersion,
      latestVersion,
      currentSha: currentSha ? currentSha.slice(0, 7) : null,
      latestSha: latestSha ? latestSha.slice(0, 7) : null,
      latestCommitMessage,
      latestCommitDate,
      hasUpdate,
      repoUrl: PLUGIN_REPO_URL,
      checkedAt: now,
    };
    cachedInfo = info;
    return info;
  } catch (err) {
    const info: PluginUpdateInfo = {
      currentVersion,
      latestVersion: null,
      currentSha: currentSha ? currentSha.slice(0, 7) : null,
      latestSha: null,
      latestCommitMessage: null,
      latestCommitDate: null,
      hasUpdate: false,
      repoUrl: PLUGIN_REPO_URL,
      checkedAt: now,
      error: err instanceof Error ? err.message : String(err),
    };
    cachedInfo = info;
    return info;
  }
}
