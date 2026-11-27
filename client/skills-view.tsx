import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { skillsListRpc, type SkillEntryDto } from "../shared/rpc";
import { MarkdownText } from "./markdown";

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
  const toast = useToast();
  const [skills, setSkills] = useState<SkillEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SkillEntryDto | null>(null);
  const [args, setArgs] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    void listSkills(agentId ? { agentId } : {})
      .then((res) => {
        if (live) {
          setSkills(res.skills);
          setLoading(false);
        }
      })
      .catch(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [listSkills, agentId]);

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

  if (selected) {
    return (
      <ScrollView contentContainerStyle={{ padding: compact ? 10 : 14, gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelected(null)}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Icon name="ChevronLeft" size={14} color={theme.colors.foregroundMuted} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Back to skills</Text>
          </Pressable>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>
            {selected.source} · ~{selected.frontmatterTokens} tok header / ~{selected.fullTokens} tok full
          </Text>
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
              style={{
                flex: 1,
                borderRadius: 8,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
                color: theme.colors.foreground,
                paddingHorizontal: 10,
                paddingVertical: 7,
                fontSize: 12.5,
              }}
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
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 10 : 14, gap: 10 }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search skills by name, description, or source…"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
          color: theme.colors.foreground,
          paddingHorizontal: 10,
          paddingVertical: 7,
          fontSize: 12.5,
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
              key={`${skill.source}:${skill.name}`}
              accessibilityRole="button"
              onPress={() => setSelected(skill)}
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
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 13.5, fontWeight: "600" }}>
                    {skill.name}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
                    {skill.source} · ~{skill.frontmatterTokens} tok
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
