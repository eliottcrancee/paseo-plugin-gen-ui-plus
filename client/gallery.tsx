import type { PluginTheme } from "@getpaseo/plugin";
import {
  useRpc,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { COMPONENTS, componentSignature, type ComponentGroup, type ComponentName } from "../shared/core/catalog";
import { componentsIn, GALLERY_GROUPS, searchComponents } from "../shared/logic/gallery-search";
import { galleryGetRpc, galleryListRpc, pluginUpdateCheckRpc, type PluginUpdateInfoDto } from "../shared/rpc";
import { SpecBlockView } from "./live-ui";
import { McpServersView } from "./mcp-view";
import type { UiRuntime } from "./runtime";
import { SkillsView } from "./skills-view";

const PLAYGROUND_SPEC = `$seats = 12
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Interactive Pricing Calculator", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Row([
    Metric("Per seat", "$" + fmt(price)),
    Metric("Monthly total", "$" + fmt(price * $seats), tone: "good")
  ]),
  Button("Select " + $plan + " (" + $seats + " seats)", Send("Selected " + $plan + " with " + $seats + " seats"), variant: "primary")
])`;

function isComponent(name: string): name is ComponentName {
  return Object.hasOwn(COMPONENTS, name);
}

function componentOfFile(file: string): ComponentName | null {
  const prefix = file.replace(/\.ui$/, "").split("-")[0] ?? "";
  return isComponent(prefix) ? prefix : null;
}

export function GallerySidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="LayoutGrid"
      label="Gen-UI Plus"
      active={currentScreen?.screenId === "gallery"}
      onPress={() => openScreen({ screenId: "gallery" })}
    />
  );
}

type HubTab = "browse" | "playground" | "mcp" | "skills";

function parseTab(raw: string | undefined): HubTab {
  if (raw === "playground" || raw === "mcp" || raw === "skills") return raw;
  return "browse";
}

export function GalleryScreen(
  props: PluginScreenProps & { playAudio: UiRuntime["playAudio"] },
) {
  return (
    <GalleryBody
      theme={props.theme}
      compact={props.layout.compact}
      platform={props.layout.platform}
      playAudio={props.playAudio}
      initialComponent={props.params.component ?? null}
      initialTab={parseTab(props.params.tab)}
    />
  );
}

export function GalleryWorkspacePanel(
  props: PluginWorkspacePanelProps & { playAudio: UiRuntime["playAudio"] },
) {
  return (
    <GalleryBody
      theme={props.theme}
      compact={props.layout.compact}
      platform={props.layout.platform}
      playAudio={props.playAudio}
      initialComponent={null}
      initialTab="browse"
    />
  );
}

function GalleryBody({
  theme,
  compact,
  platform,
  playAudio,
  initialComponent,
  initialTab,
}: {
  theme: PluginTheme;
  compact: boolean;
  platform: "ios" | "android" | "web";
  playAudio: UiRuntime["playAudio"];
  initialComponent: string | null;
  initialTab: HubTab;
}) {
  const listGallery = useRpc(galleryListRpc);
  const checkPluginUpdate = useRpc(pluginUpdateCheckRpc);
  const toast = useToast();
  const [files, setFiles] = useState<string[]>([]);
  const [updateInfo, setUpdateInfo] = useState<PluginUpdateInfoDto | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [activeGroup, setActiveGroup] = useState<ComponentGroup>("Layout");
  const [selectedComponent, setSelectedComponent] = useState<ComponentName | null>(
    initialComponent && isComponent(initialComponent) ? initialComponent : null,
  );
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<HubTab>(initialTab);
  const [playgroundCode, setPlaygroundCode] = useState(PLAYGROUND_SPEC);

  useEffect(() => {
    setMode(initialTab);
  }, [initialTab]);

  const runUpdateCheck = useCallback(
    async (force: boolean) => {
      setCheckingUpdate(true);
      try {
        const res = await checkPluginUpdate({ force });
        setUpdateInfo(res);
        if (force) {
          if (res.error) {
            toast.error(res.error);
          } else if (res.hasUpdate) {
            toast.show(
              `Gen-UI Plus update available (${res.latestVersion ? `v${res.latestVersion}` : res.latestSha ?? "new commit"}) — update in Paseo Settings → Plugins.`,
              { variant: "info" },
            );
          } else {
            toast.show(`Gen-UI Plus v${res.currentVersion} is up to date.`, { variant: "success" });
          }
        }
      } catch {
        // Ignore transient offline errors on background check.
      } finally {
        setCheckingUpdate(false);
      }
    },
    [checkPluginUpdate, toast],
  );

  useEffect(() => {
    void runUpdateCheck(false);
  }, [runUpdateCheck]);

  useEffect(() => {
    let live = true;
    void listGallery({}).then((res) => {
      if (live) setFiles(res.names);
    });
    return () => {
      live = false;
    };
  }, [listGallery]);

  const byComponent = useMemo(() => {
    const map = new Map<ComponentName, string[]>();
    for (const f of files) {
      const comp = componentOfFile(f);
      if (!comp) continue;
      map.set(comp, [...(map.get(comp) ?? []), f]);
    }
    return map;
  }, [files]);

  const searchResults = useMemo(() => {
    if (!query.trim()) return null;
    return searchComponents(query, byComponent).map((m) => m.name);
  }, [byComponent, query]);

  const visibleComponents: ComponentName[] = useMemo(() => {
    if (selectedComponent) return [selectedComponent];
    if (searchResults) return searchResults;
    return componentsIn(activeGroup);
  }, [activeGroup, searchResults, selectedComponent]);

  const sendPreview = useCallback(
    async (msg: string) => {
      toast.show(`Would send: ${msg}`, { variant: "info" });
    },
    [toast],
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: compact ? 14 : 24,
        gap: 16,
        maxWidth: 960,
        width: "100%",
        alignSelf: "center",
      }}
    >
      <View style={{ flexDirection: compact ? "column" : "row", justifyContent: "space-between", alignItems: compact ? "flex-start" : "center", gap: 12 }}>
        <View style={{ gap: 4, flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: compact ? 18 : 22, fontWeight: "700" }}>
              Gen-UI Plus
            </Text>
            {updateInfo ? (
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>
                v{updateInfo.currentVersion}
                {updateInfo.currentSha ? ` (${updateInfo.currentSha})` : ""}
              </Text>
            ) : null}
            {updateInfo?.hasUpdate ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  toast.show(
                    `Update available${updateInfo.latestCommitMessage ? `: ${updateInfo.latestCommitMessage}` : ""} — update Gen-UI Plus in Paseo Settings → Plugins.`,
                    { variant: "info" },
                  );
                  void Linking.openURL(updateInfo.repoUrl);
                }}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 4,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Icon name="Download" size={11} color={theme.colors.accentForeground} />
                <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "600" }}>
                  Update{" "}
                  {updateInfo.latestVersion && updateInfo.latestVersion !== updateInfo.currentVersion
                    ? `v${updateInfo.latestVersion}`
                    : updateInfo.latestSha ?? ""}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={checkingUpdate}
                onPress={() => void runUpdateCheck(true)}
                hitSlop={6}
                style={{ flexDirection: "row", alignItems: "center", gap: 4, opacity: checkingUpdate ? 0.5 : 0.8 }}
              >
                <Icon name="RotateCcw" size={11} color={theme.colors.foregroundMuted} />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  {checkingUpdate ? "Checking…" : "Check updates"}
                </Text>
              </Pressable>
            )}
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>
            {Object.keys(COMPONENTS).length} components · {files.length} examples · MCP Servers · Skills
          </Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {(
            [
              { id: "browse", label: "Gallery" },
              { id: "playground", label: "Playground" },
              { id: "mcp", label: "MCP Servers" },
              { id: "skills", label: "Skills" },
            ] as const
          ).map((tab) => {
            const active = mode === tab.id;
            return (
              <Pressable
                key={tab.id}
                accessibilityRole="tab"
                onPress={() => setMode(tab.id)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
                }}
              >
                <Text
                  style={{
                    color: active ? theme.colors.accentForeground : theme.colors.foreground,
                    fontSize: 12.5,
                    fontWeight: "600",
                  }}
                >
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {mode === "mcp" ? (
        <McpServersView theme={theme} />
      ) : mode === "skills" ? (
        <SkillsView theme={theme} compact={compact} />
      ) : mode === "playground" ? (
        <View style={{ gap: 12 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>
            Edit the ```ui spec below and interact with the live preview:
          </Text>
          <TextInput
            multiline
            value={playgroundCode}
            onChangeText={setPlaygroundCode}
            style={{
              minHeight: 160,
              borderRadius: 10,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
              color: theme.colors.foreground,
              fontFamily: "monospace",
              fontSize: 12.5,
              padding: 12,
              textAlignVertical: "top",
            }}
          />
          <SpecBlockView
            code={playgroundCode}
            complete={true}
            stateKey="paseo.genui.playground"
            scope="gallery"
            send={sendPreview}
            openFile={null}
            playAudio={playAudio}
            theme={theme}
            compact={compact}
            platform={platform}
          />
        </View>
      ) : (
        <>
          <View style={{ gap: 10 }}>
            <TextInput
              value={query}
              onChangeText={(txt) => {
                setQuery(txt);
                if (txt.trim()) setSelectedComponent(null);
              }}
              placeholder="Search 86 components (e.g. Chart, Diagram, Map, Decision, Kanban)…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                borderRadius: 8,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
                color: theme.colors.foreground,
                paddingHorizontal: 12,
                paddingVertical: 8,
                fontSize: 13,
              }}
            />

            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                {GALLERY_GROUPS.map((group) => {
                  const active = !selectedComponent && !query.trim() && activeGroup === group;
                  return (
                    <Pressable
                      key={group}
                      onPress={() => {
                        setActiveGroup(group);
                        setSelectedComponent(null);
                        setQuery("");
                      }}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 999,
                        backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: active ? theme.colors.accent : theme.colors.border,
                      }}
                    >
                      <Text
                        style={{
                          color: active ? theme.colors.accentForeground : theme.colors.foreground,
                          fontSize: 12,
                          fontWeight: active ? "600" : "400",
                        }}
                      >
                        {group} ({componentsIn(group).length})
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>

            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {componentsIn(activeGroup).map((comp) => {
                const active = selectedComponent === comp;
                return (
                  <Pressable
                    key={comp}
                    onPress={() => setSelectedComponent(active ? null : comp)}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 6,
                      backgroundColor: active ? theme.colors.surface2 : "transparent",
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: active ? theme.colors.accent : theme.colors.border,
                    }}
                  >
                    <Text
                      style={{
                        color: active ? theme.colors.accent : theme.colors.foregroundMuted,
                        fontSize: 11.5,
                        fontFamily: "monospace",
                      }}
                    >
                      {comp}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: 20 }}>
            {visibleComponents.map((comp) => (
              <GalleryComponentSection
                key={comp}
                name={comp}
                files={byComponent.get(comp) ?? []}
                theme={theme}
                compact={compact}
                platform={platform}
                playAudio={playAudio}
                send={sendPreview}
              />
            ))}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function GalleryComponentSection({
  name,
  files,
  theme,
  compact,
  platform,
  playAudio,
  send,
}: {
  name: ComponentName;
  files: readonly string[];
  theme: PluginTheme;
  compact: boolean;
  platform: "ios" | "android" | "web";
  playAudio: UiRuntime["playAudio"];
  send(text: string): Promise<void>;
}) {
  const [expandedAll, setExpandedAll] = useState(false);
  const shownFiles = expandedAll ? files : files.slice(0, 1);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>{name}</Text>
          <Text
            selectable
            style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}
          >
            {componentSignature(name)}
          </Text>
        </View>
        {files.length > 1 ? (
          <Pressable onPress={() => setExpandedAll((e) => !e)}>
            <Text style={{ color: theme.colors.accent, fontSize: 12 }}>
              {expandedAll ? "Show primary example" : `Show all ${files.length} examples`}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {shownFiles.map((file) => (
        <GalleryExampleCard
          key={file}
          file={file}
          theme={theme}
          compact={compact}
          platform={platform}
          playAudio={playAudio}
          send={send}
        />
      ))}
    </View>
  );
}

function GalleryExampleCard({
  file,
  theme,
  compact,
  platform,
  playAudio,
  send,
}: {
  file: string;
  theme: PluginTheme;
  compact: boolean;
  platform: "ios" | "android" | "web";
  playAudio: UiRuntime["playAudio"];
  send(text: string): Promise<void>;
}) {
  const getSpec = useRpc(galleryGetRpc);
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getSpec({ name: file }).then((res) => {
      if (live) setSource(res.source);
    });
    return () => {
      live = false;
    };
  }, [file, getSpec]);

  if (source === null) {
    return (
      <View
        style={{
          padding: 12,
          borderRadius: 10,
          backgroundColor: theme.colors.surface1,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Loading {file}…</Text>
      </View>
    );
  }

  return (
    <SpecBlockView
      code={source}
      complete={true}
      stateKey={`paseo.genui.gallery:${file}`}
      scope="gallery"
      send={send}
      openFile={null}
      playAudio={playAudio}
      theme={theme}
      compact={compact}
      platform={platform}
      footerLabel={`gallery/${file}`}
    />
  );
}
