import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareSemver } from "./plugin-updates";
import {
  deleteLocalSkill,
  formatSkillMarkdown,
  normalizeGitRepoUrl,
  parseSkillMarkdown,
  readSkillForMcp,
  sanitizeSkillSlug,
  saveLocalSkill,
  searchSkillsForMcp,
  toggleLocalSkillMode,
} from "./skills";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("skills management & plugin update helpers", () => {
  it("compares semver versions accurately", () => {
    expect(compareSemver("0.5.0", "0.4.0")).toBeGreaterThan(0);
    expect(compareSemver("0.4.0", "0.4.0")).toBe(0);
    expect(compareSemver("0.4.9", "0.5.0")).toBeLessThan(0);
    expect(compareSemver("v1.2.3", "1.2.2")).toBeGreaterThan(0);
  });

  it("normalizes Git repository URLs and shorthand owner/repo", () => {
    expect(normalizeGitRepoUrl("anthropics/skills")).toBe("https://github.com/anthropics/skills.git");
    expect(normalizeGitRepoUrl("https://github.com/org/skills")).toBe("https://github.com/org/skills");
    expect(normalizeGitRepoUrl("git@github.com:org/skills.git")).toBe("git@github.com:org/skills.git");
    expect(normalizeGitRepoUrl("not a url")).toBeNull();
  });

  it("formats and parses SKILL.md round-trip and sanitizes slugs", () => {
    expect(sanitizeSkillSlug("My SQL: Review!")).toBe("my-sql-review");
    const md = formatSkillMarkdown("sql-review", "Review SQL queries: perf & safety", "## Rules\nUse indexes.");
    const parsed = parseSkillMarkdown(md, "fallback");
    expect(parsed.name).toBe("sql-review");
    expect(parsed.description).toBe("Review SQL queries: perf & safety");
    expect(parsed.body).toBe("## Rules\nUse indexes.");
  });

  it("edits and deletes skills inside allowed roots while blocking arbitrary paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "genui-skills-test-"));
    tempDirs.push(root);
    const skillDir = join(root, "demo-skill");
    const skillFile = join(skillDir, "SKILL.md");

    // Blocked outside allowed roots
    const blocked = await saveLocalSkill({ existingPath: "/etc/passwd", raw: "nope" });
    expect(blocked.ok).toBe(false);

    // Allowed when root is in extraRoots
    mkdtempSync(join(root, "tmp-"));
    const fs = await import("node:fs");
    fs.mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, "---\nname: demo\n---\nOld", "utf8");

    const edited = await saveLocalSkill(
      { existingPath: skillFile, raw: "---\nname: demo\ndescription: Updated\n---\nNew body" },
      [root],
    );
    expect(edited.ok).toBe(true);
    expect(readFileSync(skillFile, "utf8")).toContain("New body");

    const delBlocked = deleteLocalSkill("/tmp/not-a-skill.txt");
    expect(delBlocked.ok).toBe(false);

    const delOk = deleteLocalSkill(skillFile, [root]);
    expect(delOk.ok).toBe(true);
    expect(existsSync(skillDir)).toBe(false);
  });

  it("searches and reads lazy MCP skills without loading eager ones by default", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "genui-lazy-home-"));
    tempDirs.push(fakeHome);
    const fs = await import("node:fs");
    const polarsDir = join(fakeHome, ".paseo", "genui-lazy-skills", "polars");
    fs.mkdirSync(polarsDir, { recursive: true });
    writeFileSync(
      join(polarsDir, "SKILL.md"),
      formatSkillMarkdown("polars", "Fast DataFrame transformations in Python with Polars", "Always prefer lazy() and collect()."),
      "utf8",
    );

    const searchRes = searchSkillsForMcp("polars", 10, null, fakeHome);
    expect(searchRes).toContain("polars");
    expect(searchRes).toContain("lazy");

    const readRes = readSkillForMcp("polars", null, fakeHome);
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect(readRes.text).toContain("Always prefer lazy() and collect().");
    }

    // Toggle lazy -> eager -> lazy
    const toEager = toggleLocalSkillMode(join(polarsDir, "SKILL.md"), fakeHome);
    expect(toEager.ok).toBe(true);
    if (toEager.ok) {
      expect(toEager.lazy).toBe(false);
      expect(toEager.path).toContain(join(".agents", "skills", "polars", "SKILL.md"));
      const backToLazy = toggleLocalSkillMode(toEager.path, fakeHome);
      expect(backToLazy.ok).toBe(true);
      if (backToLazy.ok) {
        expect(backToLazy.lazy).toBe(true);
        expect(backToLazy.path).toContain(join(".paseo", "genui-lazy-skills", "polars", "SKILL.md"));
      }
    }
  });
});
