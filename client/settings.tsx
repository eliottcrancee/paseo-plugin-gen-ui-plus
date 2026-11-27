import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { genuiSettings, parseCustomMcpServers } from "../shared/settings";

type SettingsTab = "general" | "mcp";

const MCP_EXAMPLE = `{
  "mcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "headers": { "Authorization": "Bearer \${NOTION_TOKEN}" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}`;

export function GenUiSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(genuiSettings);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [folders, setFolders] = useState<string | null>(null);
  const [mcpDraft, setMcpDraft] = useState<string | null>(null);

  const rawMcp = mcpDraft ?? (settings.status === "ready" ? settings.values.customMcpServersJson : "");
  const parsedDraft = useMemo(() => parseCustomMcpServers(rawMcp), [rawMcp]);
  const savedMcp = useMemo(
    () => parseCustomMcpServers(settings.status === "ready" ? settings.values.customMcpServersJson : ""),
    [settings.status === "ready" ? settings.values.customMcpServersJson : ""],
  );

  if (settings.status === "loading") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Loading settings…</Text>
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
  const savedEntries = savedMcp.ok ? Object.entries(savedMcp.servers) : [];
  const disabledSet = new Set(values.disabledMcpServers);
  const mcpDirty = mcpDraft !== null && mcpDraft !== values.customMcpServersJson;

  const toggleServer = (name: string, enabled: boolean) => {
    const nextDisabled = enabled
      ? values.disabledMcpServers.filter((item) => item !== name)
      : [...new Set([...values.disabledMcpServers, name])];
    void save({ ...values, disabledMcpServers: nextDisabled }, revision);
  };

  return (
    <View style={{ gap: 16 }}>
      <View
        style={{
          flexDirection: "row",
          gap: 6,
          backgroundColor: theme.colors.surface2,
          padding: 4,
          borderRadius: 10,
          alignSelf: "flex-start",
        }}
      >
        {(
          [
            { id: "general", label: "General" },
            {
              id: "mcp",
              label: `MCP Servers${savedEntries.length > 0 ? ` (${savedEntries.length + 1})` : ""}`,
            },
          ] as const
        ).map((item) => {
          const active = tab === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              onPress={() => setTab(item.id)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 7,
                backgroundColor: active ? theme.colors.accent : "transparent",
              }}
            >
              <Text
                style={{
                  color: active ? theme.colors.accentForeground : theme.colors.foreground,
                  fontSize: 12.5,
                  fontWeight: active ? "600" : "400",
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "general" ? (
        <>
          <SettingsSection title="Agent instructions">
            <SettingsCard>
              <SettingsSwitch
                label="Automatically teach new agents Generative UI"
                hint="Enables inline ```ui and ```app support for new agents on creation."
                value={values.autoInstructions}
                onValueChange={(autoInstructions) => {
                  void save({ ...values, autoInstructions }, revision);
                }}
              />
              <SettingsSwitch
                label="Load component docs via MCP (recommended)"
                hint="Injects only a compact skill and attaches the local `genui` MCP server (`genui_guide`, `genui_list_components`, `genui_examples`, `genui_check_ui`, `web_search`, `web_fetch`) so harnesses like Pi + pi-mcp-adapter load tools dynamically without bloating context."
                value={values.instructionMode === "mcp"}
                disabled={!values.autoInstructions}
                onValueChange={(useMcp) => {
                  void save({ ...values, instructionMode: useMcp ? "mcp" : "full" }, revision);
                }}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Network and web lookups">
            <SettingsCard>
              <SettingsSwitch
                label="Web lookups"
                hint="Enables local `web_search` and `web_fetch` MCP tools plus ImageSearch (Wikimedia Commons), Map (Photon geocoding and OpenStreetMap tiles), and https Image links with private-IP SSRF protection."
                value={values.webLookups}
                onValueChange={(webLookups) => {
                  void save({ ...values, webLookups }, revision);
                }}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Files">
            <SettingsCard>
              <SettingsInput
                label="Extra folders"
                hint="Comma-separated folders, besides the workspace, thread storage and /tmp, that Load, Snippet and Image can read."
                initialValue={values.extraFolders}
                placeholder="~/dev/scratch"
                onChangeText={setFolders}
              />
              <SettingsAction
                label="Apply folder changes"
                actionLabel="Save"
                disabled={folders === null || folders === values.extraFolders}
                onPress={() => {
                  if (folders !== null) void save({ ...values, extraFolders: folders }, revision);
                }}
              />
            </SettingsCard>
          </SettingsSection>
        </>
      ) : (
        <>
          <SettingsSection title="Paseo-managed MCP servers (all harnesses)">
            <SettingsCard>
              <View style={{ padding: 12, gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                    genui (built-in)
                  </Text>
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
                  Component docs, gallery examples, UI validator, and local web_search / web_fetch. Controlled from the General tab.
                </Text>
              </View>

              {savedEntries.map(([name, server]) => {
                const enabled = !disabledSet.has(name);
                const target = server.type === "stdio" ? [server.command, ...(server.args ?? [])].join(" ") : server.url;
                return (
                  <SettingsSwitch
                    key={name}
                    label={`${name} (${server.type})`}
                    hint={target}
                    value={enabled}
                    onValueChange={(next) => toggleServer(name, next)}
                  />
                );
              })}

              {savedEntries.length === 0 ? (
                <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                    No custom MCP servers configured yet. Paste a standard `mcpServers` JSON config below to inject them automatically into Pi, OpenCode, Claude Code, and Codex sessions.
                  </Text>
                </View>
              ) : null}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Custom mcpServers JSON">
            <SettingsCard>
              <View style={{ padding: 12, gap: 8 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  Supports standard `stdio` (`command`, `args`, `env`), `http`, and `sse` (`url`, `headers`). Use `${"{ENV_VAR}"}` placeholders to read secrets from the Paseo daemon environment without hardcoding them.
                </Text>
                <TextInput
                  multiline
                  numberOfLines={10}
                  value={rawMcp}
                  onChangeText={setMcpDraft}
                  placeholder={MCP_EXAMPLE}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{
                    minHeight: 180,
                    borderRadius: 8,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: parsedDraft.ok ? theme.colors.border : theme.colors.statusDanger,
                    backgroundColor: theme.colors.surface2,
                    color: theme.colors.foreground,
                    fontFamily: "monospace",
                    fontSize: 12,
                    padding: 10,
                    textAlignVertical: "top",
                  }}
                />
                {parsedDraft.ok ? (
                  <Text style={{ color: theme.colors.statusSuccess, fontSize: 12 }}>
                    ✓ Valid JSON — {Object.keys(parsedDraft.servers).length} custom server
                    {Object.keys(parsedDraft.servers).length === 1 ? "" : "s"} parsed
                  </Text>
                ) : (
                  <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{parsedDraft.error}</Text>
                )}
              </View>
              <SettingsAction
                label="Save custom MCP servers"
                actionLabel="Save"
                disabled={!mcpDirty || !parsedDraft.ok}
                onPress={() => {
                  if (mcpDraft !== null && parsedDraft.ok) {
                    void save({ ...values, customMcpServersJson: mcpDraft }, revision);
                  }
                }}
              />
            </SettingsCard>
          </SettingsSection>
        </>
      )}
    </View>
  );
}
