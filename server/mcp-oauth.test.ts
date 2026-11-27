import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearMcpOAuthToken,
  generatePkcePair,
  getMcpOAuthStatuses,
  getValidMcpOAuthToken,
  normalizeServerUrl,
  parseWwwAuthenticate,
  type StoredOAuthRecord,
} from "./mcp-oauth";

const tempDirs: string[] = [];

function makeTempStore(records: Record<string, StoredOAuthRecord>): string {
  const dir = mkdtempSync(join(tmpdir(), "genui-oauth-test-"));
  tempDirs.push(dir);
  const storePath = join(dir, "oauth.json");
  writeFileSync(storePath, JSON.stringify(records), "utf8");
  return storePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("mcp-oauth helpers", () => {
  it("normalizes server URLs by trimming, expanding env vars, and removing fragments", () => {
    expect(normalizeServerUrl("  https://mcp.notion.com/mcp#frag  ")).toBe("https://mcp.notion.com/mcp");
    expect(
      normalizeServerUrl("https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/mcp", {
        SNOWFLAKE_ACCOUNT: "acme-eu",
      }),
    ).toBe("https://acme-eu.snowflakecomputing.com/mcp");
  });

  it("generates a valid PKCE S256 verifier and challenge pair", () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    const expected = createHash("sha256")
      .update(codeVerifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(codeChallenge).toBe(expected);
  });

  it("parses resource_metadata and scope from WWW-Authenticate header", () => {
    const parsed = parseWwwAuthenticate(
      'Bearer realm="mcp", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource", scope="read write"',
    );
    expect(parsed).toEqual({
      resourceMetadata: "https://mcp.notion.com/.well-known/oauth-protected-resource",
      scope: "read write",
    });
  });

  it("reports connected, expired, and none statuses and clears stored tokens", async () => {
    const urlValid = "https://mcp.notion.com/mcp";
    const urlExpired = "https://mcp.example.com/mcp";
    const urlMissing = "https://mcp.other.com/mcp";
    const storePath = makeTempStore({
      [urlValid]: {
        serverUrl: urlValid,
        serverName: "notion",
        accessToken: "tok-valid",
        refreshToken: "ref-1",
        expiresAt: Date.now() + 3_600_000,
        tokenEndpoint: "https://mcp.notion.com/token",
        clientId: "cid-1",
        updatedAt: Date.now(),
      },
      [urlExpired]: {
        serverUrl: urlExpired,
        serverName: "example",
        accessToken: "tok-old",
        expiresAt: Date.now() - 10_000,
        tokenEndpoint: "https://mcp.example.com/token",
        clientId: "cid-2",
        updatedAt: Date.now() - 100_000,
      },
    });

    const statuses = getMcpOAuthStatuses([urlValid, urlExpired, urlMissing], storePath);
    expect(statuses[urlValid]?.status).toBe("connected");
    expect(statuses[urlValid]?.hasRefreshToken).toBe(true);
    expect(statuses[urlExpired]?.status).toBe("expired");
    expect(statuses[urlMissing]?.status).toBe("none");

    expect(await getValidMcpOAuthToken(urlValid, storePath)).toBe("tok-valid");
    expect(await getValidMcpOAuthToken(urlExpired, storePath)).toBeNull();
    expect(await getValidMcpOAuthToken(urlMissing, storePath)).toBeNull();

    expect(clearMcpOAuthToken(urlValid, storePath)).toBe(true);
    expect(await getValidMcpOAuthToken(urlValid, storePath)).toBeNull();
    expect(clearMcpOAuthToken(urlValid, storePath)).toBe(false);
  });
});
