import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  skillReposAddRpc,
  skillReposListRpc,
  skillReposRemoveRpc,
  skillReposUpdateRpc,
  skillsDeleteRpc,
  skillsListRpc,
  skillsSaveRpc,
  type SkillEntryDto,
  type SkillRepoStatusDto,
} from "../shared/rpc";
import { MarkdownText } from "./markdown";

type SkillScope = "lazy" | "agents" | "pi" | "claude" | "codex";

const SCOPE_LABELS: Record<SkillScope, string> = {
  lazy: "Lazy (MCP · 0 startup tokens)",
  agents: "Eager (~/.agents/skills)",
  pi: "Pi (~/.pi/agent/skills)",
  claude: "Claude (~/.claude/skills)",
  codex: "Codex (~/.codex/skills)",
};

export function SkillsView({
  theme,
  agentId,
  compact = false,
  onInvoked,
}: {
  theme: PluginTheme;
  agentId?: string | null;
  compact?: boolean;
  onInvoked?: () => void;
}) {
  const paseo = usePaseo();
  const listSkills = useRpc(skillsListRpc);
  const saveSkill = useRpc(skillsSaveRpc);
  const deleteSkill = useRpc(skillsDeleteRpc);
  const listRepos = useRpc(skillReposListRpc);
  const addRepo = useRpc(skillReposAddRpc);
  const updateRepo = useRpc(skillReposUpdateRpc);
  const removeRepo = useRpc(skillReposRemoveRpc);
  const toast = useToast();

  const manageMode = !agentId;

  const [skills, setSkills] = useState<SkillEntryDto[]>([]);
  const [repos, setRepos] = useState<SkillRepoStatusDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingRepos, setCheckingRepos] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SkillEntryDto | null>(null);
  const [args, setArgs] = useState("");

  // Edit existing skill state
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Create new local skill state
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newScope, setNewScope] = useState<SkillScope>("lazy");
  const [creatingSkill, setCreatingSkill] = useState(false);

  // Add Git repo state
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [repoBranch, setRepoBranch] = useState("");
  const [repoMode, setRepoMode] = useState<"lazy" | "eager">("lazy");
  const [addingRepo, setAddingRepo] = useState(false);
  const [updatingRepoId, setUpdatingRepoId] = useState<string | null>(null);

  const reloadAll = useCallback(
    async (checkRepoUpdates = false) => {
      try {
        if (checkRepoUpdates) setCheckingRepos(true);
        const [skillsRes, reposRes] = await Promise.all([
          listSkills(agentId ? { agentId } : {}),
          manageMode ? listRepos({ checkUpdates: checkRepoUpdates }) : Promise.resolve({ repos: [] }),
        ]);
        setSkills(skillsRes.skills);
        if (manageMode) {
          setRepos(reposRes.repos);
          if (checkRepoUpdates) {
            const updates = reposRes.repos.filter((r) => r.hasUpdate).length;
            toast.show(
              updates > 0
                ? `${updates} skill ${updates === 1 ? "library has" : "libraries have"} updates available.`
                : "All Git skill libraries are up to date.",
              { variant: updates > 0 ? "info" : "success" },
            );
          }
        }
        setSelected((cur) => (cur ? skillsRes.skills.find((s) => s.path === cur.path) ?? null : null));
      } catch {
        // Ignore transient RPC errors.
      } finally {
        setLoading(false);
        setCheckingRepos(false);
      }
    },
    [listSkills, listRepos, agentId, manageMode, toast],
  );

  useEffect(() => {
    setLoading(true);
    void reloadAll(false);
  }, [reloadAll]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q),
    );
  }, [skills, query]);

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

  const invokeSkill = async (skill: SkillEntryDto) => {
    if (!agentId) return;
    const cleanArgs = args.trim();
    const prompt = cleanArgs
      ? `Read and follow the "${skill.name}" skill (${skill.path}): ${cleanArgs}`
      : `Read and follow the "${skill.name}" skill (${skill.path}).`;
    try {
      await paseo.agents.ref(agentId).send(prompt);
      setArgs("");
      toast.show(`Invoked skill "${skill.name}"`, { variant: "success" });
      onInvoked?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateSkill = async () => {
    if (!newName.trim()) {
      toast.error("Skill name is required");
      return;
    }
    setCreatingSkill(true);
    try {
      const res = await saveSkill({
        name: newName.trim(),
        description: newDesc.trim(),
        body: newBody,
        scope: newScope,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.show(`Created skill "${newName.trim()}"`, { variant: "success" });
      setNewName("");
      setNewDesc("");
      setNewBody("");
      setShowNewSkill(false);
      await reloadAll(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSkill(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!selected) return;
    setSavingEdit(true);
    try {
      const res = await saveSkill({
        existingPath: selected.path,
        raw: editDraft,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.show(`Saved "${selected.name}"`, { variant: "success" });
      setEditing(false);
      await reloadAll(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteSkill = async (skill: SkillEntryDto) => {
    try {
      const res = await deleteSkill({ path: skill.path });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.show(`Deleted skill "${skill.name}"`, { variant: "success" });
      setSelected(null);
      setEditing(false);
      await reloadAll(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddRepo = async () => {
    if (!repoUrl.trim()) {
      toast.error("Git URL or owner/repo is required");
      return;
    }
    setAddingRepo(true);
    try {
      const res = await addRepo({
        url: repoUrl.trim(),
        ...(repoBranch.trim() ? { branch: repoBranch.trim() } : {}),
        mode: repoMode,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.show(
        `Imported ${res.repo.installedSkills.length} skill${res.repo.installedSkills.length === 1 ? "" : "s"} from ${res.repo.id}`,
        { variant: "success" },
      );
      setRepoUrl("");
      setRepoBranch("");
      setShowAddRepo(false);
      await reloadAll(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingRepo(false);
    }
  };

  const handleUpdateRepo = async (repo: SkillRepoStatusDto) => {
    setUpdatingRepoId(repo.id);
    try {
      const res = await updateRepo({ id: repo.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.show(
        `Updated "${repo.id}" (${res.repo.installedSkills.length} skill${res.repo.installedSkills.length === 1 ? "" : "s"})`,
        { variant: "success" },
      );
      await reloadAll(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingRepoId(null);
    }
  };

  const handleRemoveRepo = async (repo: SkillRepoStatusDto) => {
    try {
      const res = await removeRepo({ id: repo.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.show(`Removed skill library "${repo.id}"`, { variant: "success" });
      await reloadAll(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (selected) {
    return (
      <ScrollView contentContainerStyle={{ padding: compact ? 10 : 14, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setSelected(null);
              setEditing(false);
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Icon name="ChevronLeft" size={14} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Back to skills</Text>
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>
              {selected.source} · ~{selected.frontmatterTokens} / ~{selected.fullTokens} tok
            </Text>
            {manageMode && selected.editable ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    if (editing) {
                      setEditing(false);
                    } else {
                      setEditDraft(selected.raw);
                      setEditing(true);
                    }
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 9,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor: editing ? theme.colors.surface1 : theme.colors.accent,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: editing ? theme.colors.border : theme.colors.accent,
                  }}
                >
                  <Icon
                    name={editing ? "X" : "Edit"}
                    size={12}
                    color={editing ? theme.colors.foreground : theme.colors.accentForeground}
                  />
                  <Text
                    style={{
                      color: editing ? theme.colors.foreground : theme.colors.accentForeground,
                      fontSize: 11.5,
                      fontWeight: "600",
                    }}
                  >
                    {editing ? "Cancel" : "Edit"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void handleDeleteSkill(selected)}
                  hitSlop={6}
                >
                  <Icon name="Trash2" size={14} color={theme.colors.statusDanger} />
                </Pressable>
              </>
            ) : null}
          </View>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700" }}>{selected.name}</Text>
          {selected.description ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>{selected.description}</Text>
          ) : null}
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
            {selected.path}
          </Text>
        </View>

        {agentId ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <TextInput
              value={args}
              onChangeText={setArgs}
              onSubmitEditing={() => void invokeSkill(selected)}
              placeholder="Optional instructions / arguments…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{ ...inputStyle, flex: 1, backgroundColor: theme.colors.surface2 }}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => void invokeSkill(selected)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" }}>
                Invoke
              </Text>
            </Pressable>
          </View>
        ) : null}

        {editing ? (
          <View style={{ gap: 8 }}>
            <TextInput
              multiline
              numberOfLines={16}
              value={editDraft}
              onChangeText={setEditDraft}
              style={{
                minHeight: 280,
                borderRadius: 10,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.accent,
                backgroundColor: theme.colors.surface2,
                color: theme.colors.foreground,
                fontFamily: "monospace",
                fontSize: 12,
                padding: 12,
                textAlignVertical: "top",
              }}
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                disabled={savingEdit}
                onPress={() => void handleSaveEdit()}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 8,
                  backgroundColor: theme.colors.accent,
                  opacity: savingEdit ? 0.5 : 1,
                }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" }}>
                  {savingEdit ? "Saving…" : "Save SKILL.md"}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View
            style={{
              borderRadius: 10,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              padding: 12,
            }}
          >
            <MarkdownText text={selected.body || "_No SKILL.md body._"} theme={theme} compact={compact} />
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 10 : 14, gap: 12 }}>
      {manageMode ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 180, gap: 2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>
              Skills & Git Libraries
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              Create local SKILL.md files or sync shared Git repositories into ~/.agents/skills.
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setShowNewSkill((v) => !v);
                setShowAddRepo(false);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Icon name={showNewSkill ? "X" : "Plus"} size={13} color={theme.colors.accentForeground} />
              <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "600" }}>
                {showNewSkill ? "Cancel" : "New skill"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setShowAddRepo((v) => !v);
                setShowNewSkill(false);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                backgroundColor: theme.colors.surface2,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
              }}
            >
              <Icon name="GitBranch" size={13} color={theme.colors.foreground} />
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                {showAddRepo ? "Cancel" : "Import Git"}
              </Text>
            </Pressable>
            {repos.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                disabled={checkingRepos}
                onPress={() => void reloadAll(true)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 8,
                  backgroundColor: theme.colors.surface2,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: theme.colors.border,
                  opacity: checkingRepos ? 0.5 : 1,
                }}
              >
                <Icon name="RotateCcw" size={12} color={theme.colors.foregroundMuted} />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {checkingRepos ? "Checking…" : "Check updates"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {manageMode && showNewSkill ? (
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
            Create local skill
          </Text>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {(["lazy", "agents", "pi", "claude", "codex"] as const).map((scope) => {
              const active = newScope === scope;
              return (
                <Pressable
                  key={scope}
                  onPress={() => setNewScope(scope)}
                  style={{
                    paddingHorizontal: 9,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
                  }}
                >
                  <Text
                    style={{
                      color: active ? theme.colors.accentForeground : theme.colors.foreground,
                      fontSize: 11.5,
                      fontWeight: active ? "600" : "400",
                    }}
                  >
                    {SCOPE_LABELS[scope]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="Skill name (e.g. sql-review, release-notes)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
          />
          <TextInput
            value={newDesc}
            onChangeText={setNewDesc}
            placeholder="Short description (when the agent should use this skill)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
          />
          <TextInput
            multiline
            numberOfLines={8}
            value={newBody}
            onChangeText={setNewBody}
            placeholder="Markdown instructions for the agent…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{ ...inputStyle, minHeight: 130, fontFamily: "monospace", textAlignVertical: "top" }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={creatingSkill}
            onPress={() => void handleCreateSkill()}
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 14,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: theme.colors.accent,
              opacity: creatingSkill ? 0.5 : 1,
            }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" }}>
              {creatingSkill ? "Saving…" : "Create skill"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {manageMode && showAddRepo ? (
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
            Import skills from Git repository
          </Text>
          <TextInput
            value={repoUrl}
            onChangeText={setRepoUrl}
            placeholder="owner/repo or https://github.com/org/skills.git"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
          />
          <TextInput
            value={repoBranch}
            onChangeText={setRepoBranch}
            placeholder="Optional branch (defaults to repo default branch)"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={inputStyle}
          />
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            {(
              [
                { id: "lazy", label: "Lazy (MCP · 0 startup tokens)" },
                { id: "eager", label: "Eager (~/.agents/skills)" },
              ] as const
            ).map((opt) => {
              const active = repoMode === opt.id;
              return (
                <Pressable
                  key={opt.id}
                  onPress={() => setRepoMode(opt.id)}
                  style={{
                    paddingHorizontal: 9,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
                  }}
                >
                  <Text
                    style={{
                      color: active ? theme.colors.accentForeground : theme.colors.foreground,
                      fontSize: 11.5,
                      fontWeight: active ? "600" : "400",
                    }}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
            {repoMode === "lazy"
              ? "Stores skills in ~/.paseo/genui-lazy-skills — agents discover them on demand via skills_search / skills_read without bloating startup context."
              : "Symlinks skills into ~/.agents/skills so every harness loads their descriptions at session startup."}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={addingRepo}
            onPress={() => void handleAddRepo()}
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 14,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: theme.colors.accent,
              opacity: addingRepo ? 0.5 : 1,
            }}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" }}>
              {addingRepo ? "Cloning…" : "Clone & import"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {manageMode && repos.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontWeight: "600", textTransform: "uppercase" }}>
            Git skill libraries ({repos.length})
          </Text>
          <View
            style={{
              borderRadius: 10,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              overflow: "hidden",
            }}
          >
            {repos.map((repo, idx) => {
              const isUpdating = updatingRepoId === repo.id;
              return (
                <View
                  key={repo.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                    borderTopWidth: idx === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: theme.colors.border,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                        {repo.id}
                      </Text>
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
                        {repo.mode === "lazy" ? "lazy·MCP" : "eager"} · {repo.branch}@{repo.currentSha.slice(0, 7)} · {repo.installedSkills.length} skill{repo.installedSkills.length === 1 ? "" : "s"}
                      </Text>
                      {repo.hasUpdate ? (
                        <Text style={{ color: theme.colors.accent, fontSize: 11, fontWeight: "700" }}>
                          · Update available
                        </Text>
                      ) : repo.lastCheckedAt && !repo.error ? (
                        <Text style={{ color: theme.colors.statusSuccess, fontSize: 11, fontWeight: "600" }}>
                          · Up to date
                        </Text>
                      ) : null}
                    </View>
                    <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>
                      {repo.url}
                    </Text>
                    {repo.error ? (
                      <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{repo.error}</Text>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={isUpdating}
                      onPress={() => void handleUpdateRepo(repo)}
                      style={{
                        paddingHorizontal: 9,
                        paddingVertical: 4,
                        borderRadius: 6,
                        backgroundColor: repo.hasUpdate ? theme.colors.accent : theme.colors.surface1,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: repo.hasUpdate ? theme.colors.accent : theme.colors.border,
                        opacity: isUpdating ? 0.5 : 1,
                      }}
                    >
                      <Text
                        style={{
                          color: repo.hasUpdate ? theme.colors.accentForeground : theme.colors.foreground,
                          fontSize: 11.5,
                          fontWeight: "600",
                        }}
                      >
                        {isUpdating ? "Updating…" : "Update"}
                      </Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" onPress={() => void handleRemoveRepo(repo)} hitSlop={6}>
                      <Icon name="Trash2" size={14} color={theme.colors.foregroundMuted} />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search skills by name, description, or source…"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          ...inputStyle,
          backgroundColor: theme.colors.surface2,
        }}
      />

      {loading ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Scanning installed skills…</Text>
      ) : filtered.length === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>
          No skills found{query ? ` matching "${query}"` : ""}.
        </Text>
      ) : (
        <View
          style={{
            borderRadius: 10,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface2,
            overflow: "hidden",
          }}
        >
          {filtered.map((skill, idx) => (
            <Pressable
              key={`${skill.source}:${skill.name}:${skill.path}`}
              accessibilityRole="button"
              onPress={() => {
                setSelected(skill);
                setEditing(false);
              }}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderTopWidth: idx === 0 ? 0 : StyleSheet.hairlineWidth,
                borderTopColor: theme.colors.border,
                backgroundColor: idx % 2 === 1 ? theme.colors.surface1 : "transparent",
              }}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
                    {skill.name}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
                    {skill.lazy ? `lazy·MCP (${skill.source})` : skill.source} · ~{skill.frontmatterTokens} tok
                  </Text>
                </View>
                {skill.description ? (
                  <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
                    {skill.description}
                  </Text>
                ) : null}
              </View>
              <Icon name="ChevronRight" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
