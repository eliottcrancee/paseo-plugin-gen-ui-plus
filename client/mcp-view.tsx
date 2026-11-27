import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import type { McpServerConfig } from "@getpaseo/protocol/agent-types";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  mcpOAuthLogoutRpc,
  mcpOAuthStartRpc,
  mcpOAuthStatusRpc,
  type McpOAuthStatusEntry,
} from "../shared/rpc";
import { genuiSettings, parseCustomMcpServers } from "../shared/settings";

type ServerType = "http" | "stdio" | "sse";

function serializeServers(servers: Record<string, McpServerConfig>): string {
  if (Object.keys(servers).length === 0) return "";
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

export function McpServersView({ theme }: { theme: PluginTheme }) {
  const settings = useSettings(genuiSettings);
  const toast = useToast();
  const fetchOAuthStatus = useRpc(mcpOAuthStatusRpc);
  const startOAuth = useRpc(mcpOAuthStartRpc);
  const logoutOAuth = useRpc(mcpOAuthLogoutRpc);

  // Quick "+ Add server" form state
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<ServerType>("http");
  const [url, setUrl] = useState("");
  const [authHeader, setAuthHeader] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");

  // Raw JSON editor state
  const [showJson, setShowJson] = useState(false);
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);

  // OAuth status & active sign-in state
  const [oauthStatuses, setOAuthStatuses] = useState<Record<string, McpOAuthStatusEntry>>({});
  const [startingUrl, setStartingUrl] = useState<string | null>(null);
  const [pendingLinks, setPendingLinks] = useState<Record<string, string>>({});
  const prevStatusRef = useRef<Record<string, McpOAuthStatusEntry["status"]>>({});

  const savedJson = settings.status === "ready" ? settings.values.customMcpServersJson : "";
  const savedParsed = useMemo(() => parseCustomMcpServers(savedJson), [savedJson]);
  const rawDraft = jsonDraft ?? savedJson;
  const draftParsed = useMemo(() => parseCustomMcpServers(rawDraft), [rawDraft]);

  const httpUrls = useMemo(() => {
    if (!savedParsed.ok) return [];
    const urls: string[] = [];
    for (const server of Object.values(savedParsed.servers)) {
      if (server.type === "http" || server.type === "sse") {
        urls.push(server.url);
      }
    }
    return urls;
  }, [savedParsed]);

  const refreshOAuth = useCallback(
    async (probePublic = false) => {
      if (httpUrls.length === 0) {
        setOAuthStatuses({});
        return;
      }
      try {
        const res = await fetchOAuthStatus({ urls: httpUrls, probePublic });
        setOAuthStatuses(res.statuses);
        for (const [u, entry] of Object.entries(res.statuses)) {
          const prev = prevStatusRef.current[u];
          if (prev === "pending" && entry.status === "connected") {
            setPendingLinks((cur) => {
              const next = { ...cur };
              delete next[u];
              return next;
            });
            toast.show("OAuth connected! Start a new session to use this MCP server.", { variant: "success" });
          } else if (prev === "pending" && entry.status !== "pending") {
            setPendingLinks((cur) => {
              const next = { ...cur };
              delete next[u];
              return next;
            });
          }
          prevStatusRef.current[u] = entry.status;
        }
      } catch {
        // Ignore transient RPC errors.
      }
    },
    [fetchOAuthStatus, httpUrls, toast],
  );

  useEffect(() => {
    void refreshOAuth(true);
  }, [refreshOAuth]);

  const hasPending = Object.values(oauthStatuses).some((s) => s.status === "pending") || Object.keys(pendingLinks).length > 0;

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      void refreshOAuth(false);
    }, 1500);
    return () => clearInterval(timer);
  }, [hasPending, refreshOAuth]);

  const handleSignIn = async (serverName: string, serverUrl: string) => {
    setStartingUrl(serverUrl);
    try {
      const res = await startOAuth({ serverName, url: serverUrl });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.noAuthRequired) {
        toast.show(`"${serverName}" is public — no sign-in required.`, { variant: "success" });
        void refreshOAuth(false);
        return;
      }
      if (res.authUrl) {
        prevStatusRef.current[serverUrl] = "pending";
        setPendingLinks((cur) => ({ ...cur, [serverUrl]: res.authUrl! }));
        toast.show(`Opening browser to sign in to "${serverName}"…`, { variant: "info" });
      }
      void refreshOAuth(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingUrl(null);
    }
  };

  const handleSignOut = async (serverName: string, serverUrl: string) => {
    try {
      await logoutOAuth({ url: serverUrl });
      setPendingLinks((cur) => {
        const next = { ...cur };
        delete next[serverUrl];
        return next;
      });
      toast.show(`Signed out of "${serverName}"`, { variant: "success" });
      void refreshOAuth();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (settings.status === "loading") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Loading MCP servers…</Text>
      </View>
    );
  }

  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>
      </View>
    );
  }

  const { values, revision, save } = settings;
  const servers: Record<string, McpServerConfig> = savedParsed.ok ? { ...savedParsed.servers } : {};
  const entries = Object.entries(servers);
  const disabledSet = new Set(values.disabledMcpServers);

  const toggleServer = (serverName: string, enabled: boolean) => {
    const nextDisabled = enabled
      ? values.disabledMcpServers.filter((item) => item !== serverName)
      : [...new Set([...values.disabledMcpServers, serverName])];
    void save({ ...values, disabledMcpServers: nextDisabled }, revision);
  };

  const deleteServer = (serverName: string) => {
    const existing = servers[serverName];
    const next = { ...servers };
    delete next[serverName];
    const nextJson = serializeServers(next);
    const nextDisabled = values.disabledMcpServers.filter((item) => item !== serverName);
    setJsonDraft(null);
    if (existing && (existing.type === "http" || existing.type === "sse")) {
      void logoutOAuth({ url: existing.url }).catch(() => undefined);
    }
    void save({ ...values, customMcpServersJson: nextJson, disabledMcpServers: nextDisabled }, revision).then(() => {
      toast.show(`Removed MCP server "${serverName}"`, { variant: "success" });
    });
  };

  const addServer = () => {
    const cleanName = name.trim();
    if (!cleanName) {
      toast.error("Server name is required");
      return;
    }
    if (cleanName === "genui") {
      toast.error('"genui" is reserved for the built-in server');
      return;
    }

    let config: McpServerConfig;
    if (type === "stdio") {
      const cleanCmd = command.trim();
      if (!cleanCmd) {
        toast.error("Command is required for stdio servers");
        return;
      }
      const args = argsText
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      config = {
        type: "stdio",
        command: cleanCmd,
        ...(args.length > 0 ? { args } : {}),
        alwaysLoad: false,
      };
    } else {
      const cleanUrl = url.trim();
      if (!cleanUrl) {
        toast.error("URL is required for HTTP/SSE servers");
        return;
      }
      const cleanAuth = authHeader.trim();
      config = {
        type,
        url: cleanUrl,
        ...(cleanAuth ? { headers: { Authorization: cleanAuth } } : {}),
        alwaysLoad: false,
      };
    }

    const next = { ...servers, [cleanName]: config };
    const nextJson = serializeServers(next);
    const nextDisabled = values.disabledMcpServers.filter((item) => item !== cleanName);
    setJsonDraft(null);
    setName("");
    setUrl("");
    setAuthHeader("");
    setCommand("");
    setArgsText("");
    setShowAdd(false);
    void save({ ...values, customMcpServersJson: nextJson, disabledMcpServers: nextDisabled }, revision).then(() => {
      toast.show(`Added MCP server "${cleanName}"`, { variant: "success" });
    });
  };

  const inputStyle = {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12.5,
  } as const;

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
            Paseo MCP Servers
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            Injected automatically into new sessions across Pi (lazy via pi-mcp-adapter), OpenCode, Claude Code, and Codex.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAdd((open) => !open)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: theme.colors.accent,
          }}
        >
          <Icon name={showAdd ? "X" : "Plus"} size={13} color={theme.colors.accentForeground} />
          <Text style={{ color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" }}>
            {showAdd ? "Cancel" : "Add server"}
          </Text>
        </Pressable>
      </View>

      {showAdd ? (
        <View
          style={{
            borderRadius: 10,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.accent,
            backgroundColor: theme.colors.surface2,
            padding: 12,
            gap: 10,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
            New MCP server
          </Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(["http", "stdio", "sse"] as const).map((t) => {
              const active = type === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 6,
                    backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
                  }}
                >
                  <Text
                    style={{
                      color: active ? theme.colors.accentForeground : theme.colors.foreground,
                      fontSize: 12,
                      fontWeight: active ? "600" : "400",
                    }}
                  >
                    {t.toUpperCase()}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Server name (e.g. notion, snowflake, github)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
          />
          {type === "stdio" ? (
            <>
              <TextInput
                value={command}
                onChangeText={setCommand}
                placeholder="Command (e.g. npx, node, uvx)"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={inputStyle}
              />
              <TextInput
                value={argsText}
                onChangeText={setArgsText}
                placeholder="Arguments (space-separated, e.g. -y @modelcontextprotocol/server-filesystem /tmp)"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={inputStyle}
              />
            </>
          ) : (
            <>
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="URL (e.g. https://mcp.notion.com/mcp)"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={inputStyle}
              />
              <TextInput
                value={authHeader}
                onChangeText={setAuthHeader}
                placeholder="Optional Authorization header (e.g. Bearer ${NOTION_TOKEN})"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={inputStyle}
              />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
                Leave empty for OAuth (Notion, GitHub, Linear…) — click Sign in after saving.
              </Text>
            </>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={addServer}
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 14,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: theme.colors.accent,
            }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" }}>
              Save server
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* Built-in genui server */}
      <View
        style={{
          borderRadius: 10,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
          padding: 12,
          gap: 4,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="Sparkles" size={14} color={theme.colors.accent} />
            <Text style={{ color: theme.colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
              genui (built-in)
            </Text>
          </View>
          <Text
            style={{
              color:
                values.autoInstructions && values.instructionMode === "mcp"
                  ? theme.colors.statusSuccess
                  : theme.colors.foregroundMuted,
              fontSize: 11.5,
              fontWeight: "600",
            }}
          >
            {values.autoInstructions && values.instructionMode === "mcp" ? "Active · stdio" : "Disabled"}
          </Text>
        </View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          genui_guide · genui_list_components · genui_examples · genui_check_ui · web_search · web_fetch · skills_search · skills_read
        </Text>
      </View>

      {/* Custom servers */}
      {entries.length > 0 ? (
        <View
          style={{
            borderRadius: 10,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            overflow: "hidden",
          }}
        >
          {entries.map(([serverName, server], idx) => {
            const enabled = !disabledSet.has(serverName);
            const isRemote = server.type === "http" || server.type === "sse";
            const target =
              server.type === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url;
            const hasExplicitAuth =
              isRemote && Object.keys(server.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
            const oauth = isRemote ? oauthStatuses[server.url] : undefined;
            const oauthState = oauth?.status ?? "none";
            const isStarting = isRemote && startingUrl === server.url;
            const pendingUrl = isRemote ? pendingLinks[server.url] : undefined;

            return (
              <View
                key={serverName}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  gap: 6,
                  borderTopWidth: idx === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: theme.colors.border,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                        {serverName}
                      </Text>
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
                        {server.type}
                      </Text>
                      {isRemote && !hasExplicitAuth && oauthState === "connected" ? (
                        <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" }}>
                          · OAuth ✓
                        </Text>
                      ) : null}
                      {isRemote && !hasExplicitAuth && oauthState === "pending" ? (
                        <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "600" }}>
                          · Signing in…
                        </Text>
                      ) : null}
                      {isRemote && !hasExplicitAuth && oauthState === "expired" ? (
                        <Text style={{ color: theme.colors.statusDanger, fontSize: 11, fontWeight: "600" }}>
                          · OAuth expired
                        </Text>
                      ) : null}
                      {isRemote && !hasExplicitAuth && oauthState === "public" ? (
                        <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" }}>
                          · Public
                        </Text>
                      ) : null}
                      {hasExplicitAuth ? (
                        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                          · Header auth
                        </Text>
                      ) : null}
                    </View>
                    <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>
                      {target}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    {isRemote && !hasExplicitAuth && oauthState !== "public" ? (
                      oauthState === "connected" ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void handleSignOut(serverName, server.url)}
                          style={{
                            paddingHorizontal: 9,
                            paddingVertical: 4,
                            borderRadius: 6,
                            backgroundColor: theme.colors.surface1,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: theme.colors.border,
                          }}
                        >
                          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontWeight: "500" }}>
                            Sign out
                          </Text>
                        </Pressable>
                      ) : (
                        <Pressable
                          accessibilityRole="button"
                          disabled={isStarting}
                          onPress={() => void handleSignIn(serverName, server.url)}
                          style={{
                            paddingHorizontal: 9,
                            paddingVertical: 4,
                            borderRadius: 6,
                            backgroundColor: theme.colors.surface1,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: theme.colors.accent,
                            opacity: isStarting ? 0.5 : 1,
                          }}
                        >
                          <Text style={{ color: theme.colors.accent, fontSize: 11.5, fontWeight: "600" }}>
                            {isStarting
                              ? "Opening…"
                              : oauthState === "expired"
                                ? "Reconnect"
                                : oauthState === "pending"
                                  ? "Retry"
                                  : "Sign in"}
                          </Text>
                        </Pressable>
                      )
                    ) : null}
                    <Pressable
                      accessibilityRole="switch"
                      onPress={() => toggleServer(serverName, !enabled)}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: 999,
                        backgroundColor: enabled ? theme.colors.accent : theme.colors.surface1,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: enabled ? theme.colors.accent : theme.colors.border,
                      }}
                    >
                      <Text
                        style={{
                          color: enabled ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                          fontSize: 11.5,
                          fontWeight: "600",
                        }}
                      >
                        {enabled ? "On" : "Off"}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => deleteServer(serverName)}
                      hitSlop={6}
                    >
                      <Icon name="Trash2" size={14} color={theme.colors.foregroundMuted} />
                    </Pressable>
                  </View>
                </View>

                {pendingUrl ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, flex: 1 }}>
                      Complete authorization in your browser.
                    </Text>
                    <Pressable onPress={() => void Linking.openURL(pendingUrl)}>
                      <Text style={{ color: theme.colors.accent, fontSize: 11.5, fontWeight: "600" }}>
                        Open link
                      </Text>
                    </Pressable>
                  </View>
                ) : null}

                {oauth?.lastError ? (
                  <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5 }}>
                    OAuth error: {oauth.lastError}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>
          No custom MCP servers yet. Click "Add server" above or paste JSON below.
        </Text>
      )}

      {/* Collapsible raw JSON editor */}
      <View style={{ gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowJson((v) => !v)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Icon name={showJson ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" }}>
            Edit raw mcpServers JSON (supports ${"{ENV_VAR}"} placeholders)
          </Text>
        </Pressable>
        {showJson ? (
          <View style={{ gap: 8 }}>
            <TextInput
              multiline
              numberOfLines={10}
              value={rawDraft}
              onChangeText={setJsonDraft}
              placeholder='{\n  "mcpServers": {\n    "notion": { "url": "https://mcp.notion.com/mcp" }\n  }\n}'
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                minHeight: 160,
                borderRadius: 8,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: draftParsed.ok ? theme.colors.border : theme.colors.statusDanger,
                backgroundColor: theme.colors.surface2,
                color: theme.colors.foreground,
                fontFamily: "monospace",
                fontSize: 12,
                padding: 10,
                textAlignVertical: "top",
              }}
            />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text
                style={{
                  color: draftParsed.ok ? theme.colors.statusSuccess : theme.colors.statusDanger,
                  fontSize: 11.5,
                  flex: 1,
                }}
              >
                {draftParsed.ok
                  ? `✓ Valid JSON (${Object.keys(draftParsed.servers).length} server${Object.keys(draftParsed.servers).length === 1 ? "" : "s"})`
                  : draftParsed.error}
              </Text>
              <Pressable
                disabled={jsonDraft === null || jsonDraft === savedJson || !draftParsed.ok}
                onPress={() => {
                  if (jsonDraft !== null && draftParsed.ok) {
                    void save({ ...values, customMcpServersJson: jsonDraft }, revision).then(() => {
                      setJsonDraft(null);
                      toast.show("Saved MCP servers JSON", { variant: "success" });
                    });
                  }
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 7,
                  backgroundColor: theme.colors.accent,
                  opacity: jsonDraft === null || jsonDraft === savedJson || !draftParsed.ok ? 0.45 : 1,
                }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>
                  Save JSON
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}
