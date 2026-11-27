import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { skillsListRpc } from "../shared/rpc";
import { SkillsView } from "./skills-view";

const PILL_TITLE = "Skills";

function createPillIcon(agentId: string, pillRef: { current?: PluginButtonRegistration }) {
  return function SkillsPillIcon({ size, color }: PluginButtonIconProps) {
    const listSkills = useRpc(skillsListRpc);
    const [count, setCount] = useState<number | null>(null);

    useEffect(() => {
      let live = true;
      void listSkills({ agentId })
        .then((res) => {
          if (live) setCount(res.skills.length);
        })
        .catch(() => {});
      return () => {
        live = false;
      };
    }, [listSkills]);

    useEffect(() => {
      const label = count !== null ? `${PILL_TITLE} ${count}` : PILL_TITLE;
      pillRef.current?.update({ label });
    }, [count]);

    return <Icon name="Sparkles" size={size} color={color} />;
  };
}

function createSkillsPopover(openGallerySkills: () => void) {
  return function SkillsPopover(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    return (
      <View style={{ width: 380, maxHeight: 460 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: 4,
          }}
        >
          <Text style={{ color: props.theme.colors.foreground, fontSize: 13.5, fontWeight: "700" }}>
            Agent Skills
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              props.close();
              openGallerySkills();
            }}
          >
            <Text style={{ color: props.theme.colors.accent, fontSize: 12, fontWeight: "500" }}>
              Open full view
            </Text>
          </Pressable>
        </View>
        <SkillsView theme={props.theme} agentId={agentId} compact onInvoked={props.close} />
      </View>
    );
  };
}

/**
 * Registers a "Skills" composer pill above every agent's chat composer,
 * letting users browse, inspect, and invoke installed skills on any provider.
 */
export function contributeSkillsPills(
  client: PluginClientContext,
  openSkillsScreen: () => void,
): () => void {
  const pills = new Map<string, { workspaceId: string; registration: PluginButtonRegistration }>();
  let stopped = false;
  const Popover = createSkillsPopover(openSkillsScreen);

  const attach = (agentId: string, workspaceId: string | null) => {
    if (stopped || !workspaceId) return;
    const existing = pills.get(agentId);
    if (existing?.workspaceId === workspaceId) return;
    if (existing) {
      existing.registration.remove();
      pills.delete(agentId);
    }
    const pillRef: { current?: PluginButtonRegistration } = {};
    pillRef.current = client.addComposerPill({
      id: "genui-skills",
      workspaceId,
      agentId,
      button: {
        title: PILL_TITLE,
        label: PILL_TITLE,
        icon: createPillIcon(agentId, pillRef),
        behavior: { kind: "popover", Content: Popover },
      },
    });
    pills.set(agentId, { workspaceId, registration: pillRef.current });
  };

  const remove = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  // Seed from existing agents and subscribe to agent list updates if exposed by Paseo client.
  const paseo = client.paseo as unknown as {
    agents?: {
      list?: () => Promise<readonly { id: string; workspaceId?: string | null; archivedAt?: string | null }[]>;
      subscribe?: (
        listener: (event: {
          type?: string;
          agent?: { id: string; workspaceId?: string | null; archivedAt?: string | null };
          agentId?: string;
        }) => void,
      ) => () => void;
    };
  };

  void paseo.agents
    ?.list?.()
    .then((agents) => {
      for (const a of agents) {
        if (!a.archivedAt) attach(a.id, a.workspaceId ?? null);
      }
    })
    .catch(() => {});

  const unsubscribe =
    paseo.agents?.subscribe?.((event) => {
      if (event.agent) {
        if (event.agent.archivedAt) remove(event.agent.id);
        else attach(event.agent.id, event.agent.workspaceId ?? null);
      } else if (event.type === "removed" && event.agentId) {
        remove(event.agentId);
      }
    }) ?? (() => {});

  return () => {
    stopped = true;
    unsubscribe();
    for (const entry of pills.values()) entry.registration.remove();
    pills.clear();
  };
}
