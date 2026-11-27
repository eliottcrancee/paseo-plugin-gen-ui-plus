import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { genuiSettings } from "../shared/settings";

export function GenUiSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(genuiSettings);
  const [folders, setFolders] = useState<string | null>(null);

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

  return (
    <View style={{ gap: 16 }}>
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
            hint="Injects only a compact skill and attaches the local `genui` MCP server (`genui_guide`, `genui_list_components`, `genui_examples`, `genui_check_ui`, `web_search`, `web_fetch`). Manage custom MCP servers from the Gen-UI Plus sidebar screen → MCP Servers tab."
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
    </View>
  );
}
