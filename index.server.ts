import { mkdir } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { checkSpec, renderReplyMarkdown } from "./shared/fallback";
import {
  buildFullInstructions,
  buildMcpSkillInstructions,
  GENUI_MARKER,
  GENUI_MCP_SERVER_NAME,
  GENUI_MCP_TOOL_NAMES,
} from "./shared/instructions";
import {
  appendDemoRpc,
  checkUiRpc,
  galleryAudioRpc,
  galleryDataRpc,
  galleryGetRpc,
  galleryImageRpc,
  galleryListRpc,
  inspectContextRpc,
  loadAudioRpc,
  loadDataRpc,
  loadImageRpc,
  mcpOAuthLogoutRpc,
  mcpOAuthStartRpc,
  mcpOAuthStatusRpc,
  projectChangesRpc,
  projectCommitsRpc,
  projectEnvironmentRpc,
  projectEnvironmentsRpc,
  projectPatchesRpc,
  projectPullRequestRpc,
  projectThreadsRpc,
  renderMarkdownRpc,
  sketchFontRpc,
  skillsListRpc,
  uiExamplesRpc,
  webGeocodeRpc,
  webImageRpc,
  webSearchRpc,
  webTileRpc,
} from "./shared/rpc";
import { GENUI_BLOCK_KIND } from "./shared/segment";
import { genuiSettings, parseFolders, resolveEnabledCustomMcpServers } from "./shared/settings";
import {
  agentStorageDir,
  examplesReport,
  listGallery,
  loadAgentAudio,
  loadAgentFile,
  loadAgentImage,
  loadGalleryAudio,
  loadGalleryFile,
  loadGalleryImage,
  loadScopedFile,
  readGallerySpec,
  setExtraLoadFolders,
  sketchFontDataUrl,
} from "./server/data-source";
import { buildMcpServerConfig, startMcpBridge, type McpBridgeHandle } from "./server/mcp-bridge";
import {
  clearMcpOAuthToken,
  getMcpOAuthStatuses,
  getValidMcpOAuthToken,
  startMcpOAuthFlow,
  stopAllMcpOAuthFlows,
} from "./server/mcp-oauth";
import {
  buildContextInspectionReport,
  buildContextInspectorSpec,
  snapshotAgentCreate,
  type CapturedAgentInit,
} from "./server/context-inspector";
import {
  createProjectReader,
  readProjectChanges,
  readProjectCommits,
  readProjectEnvironment,
  readProjectEnvironments,
  readProjectPatches,
  readProjectPullRequest,
  readProjectThreads,
} from "./server/project";
import { createWebLookups } from "./server/web/lookups";
import { runWebFetch, runWebSearch } from "./server/web/research";
import { listInstalledSkills } from "./server/skills";

const PREAPPROVE_MCP_PROVIDERS = new Set(["claude", "codex", "opencode"]);

const DEFAULT_DEMO_SPEC = `$seats = 10
$plan = "Pro"
price = $plan == "Pro" ? 29 : 12
Card("Estimate", [
  Row([Choice($plan, ["Basic", "Pro"]), Slider($seats, 1, 50, label: "Seats")]),
  Metric("Total", "$" + fmt(price * $seats), note: $seats + " seats on " + $plan),
  Button("Go with " + $plan, Send("Go with " + $plan + " (" + $seats + " seats)"), variant: "primary")
])`;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(genuiSettings);
  let webLookupsEnabled = true;
  let extraFoldersList: string[] = [];

  void settings.read().then((state) => {
    if (state.status !== "ready") return;
    webLookupsEnabled = state.values.webLookups;
    extraFoldersList = parseFolders(state.values.extraFolders);
    setExtraLoadFolders(extraFoldersList);
  });
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status !== "ready") return;
    webLookupsEnabled = state.values.webLookups;
    extraFoldersList = parseFolders(state.values.extraFolders);
    setExtraLoadFolders(extraFoldersList);
  });

  const web = createWebLookups(
    async () => {
      const current = await settings.read();
      return current.status === "ready" ? current.values.webLookups : true;
    },
    () => webLookupsEnabled,
  );

  const findImage = async (query: string) => {
    const found = await web.search(query);
    return found.ok ? found.image : null;
  };

  let bridgePromise: Promise<McpBridgeHandle> | null = null;
  const ensureMcpBridge = (): Promise<McpBridgeHandle> => {
    bridgePromise ??= startMcpBridge({
      webLookups: () => webLookupsEnabled,
      extraFolders: () => extraFoldersList,
      examples: (components) => examplesReport(components),
      checkUi: (spec, ctx) =>
        checkSpec(
          spec,
          (req) => loadScopedFile(ctx.cwd ?? null, ctx.storageDir ?? null, req.path, req),
          findImage,
        ),
      webSearch: (query, limit) => runWebSearch(query, limit),
      webFetch: (url, maxChars, offset) => runWebFetch(url, maxChars, offset),
    }).catch((err) => {
      bridgePromise = null;
      throw err;
    });
    return bridgePromise;
  };

  const pendingInitByKey = new Map<string, CapturedAgentInit>();
  const initByAgentId = new Map<string, CapturedAgentInit>();
  const initKey = (provider: string, cwd: string) => `${provider.toLowerCase()}:${cwd}`;
  const rememberInit = (config: Parameters<typeof snapshotAgentCreate>[0]) => {
    const snap = snapshotAgentCreate(config);
    pendingInitByKey.set(initKey(snap.provider, snap.cwd), snap);
    if (pendingInitByKey.size > 64) {
      const oldest = pendingInitByKey.keys().next().value;
      if (oldest !== undefined) pendingInitByKey.delete(oldest);
    }
  };

  const unsubscribeCreated = server.on("agent.created", ({ agent }) => {
    const snap = pendingInitByKey.get(initKey(agent.provider, agent.cwd));
    if (snap) {
      initByAgentId.set(agent.id, snap);
      if (initByAgentId.size > 128) {
        const oldest = initByAgentId.keys().next().value;
        if (oldest !== undefined) initByAgentId.delete(oldest);
      }
    }
  });

  server.before("agent.create", async ({ request }) => {
    if (request.config.internal) return;
    const current = await settings.read();
    const rawCustomMcpServers =
      current.status === "ready"
        ? resolveEnabledCustomMcpServers(
            current.values.customMcpServersJson,
            current.values.disabledMcpServers,
            process.env,
          )
        : {};
    const customMcpServers: typeof rawCustomMcpServers = {};
    for (const [name, cfg] of Object.entries(rawCustomMcpServers)) {
      if (cfg.type === "http" || cfg.type === "sse") {
        const hasAuthHeader = Object.keys(cfg.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
        if (!hasAuthHeader) {
          const oauthToken = await getValidMcpOAuthToken(cfg.url).catch(() => null);
          if (oauthToken) {
            customMcpServers[name] = {
              ...cfg,
              headers: {
                ...cfg.headers,
                Authorization: `Bearer ${oauthToken}`,
              },
            };
            continue;
          }
        }
      }
      customMcpServers[name] = cfg;
    }
    const mergeCustomMcp = (base: typeof request.config.mcpServers) => {
      const entries = Object.entries(customMcpServers).filter(
        ([name]) => name !== GENUI_MCP_SERVER_NAME && !base?.[name],
      );
      if (entries.length === 0) return base;
      return {
        ...base,
        ...Object.fromEntries(entries),
      };
    };

    if (current.status === "ready" && !current.values.autoInstructions) {
      const withCustom = mergeCustomMcp(request.config.mcpServers);
      const nextConfig = withCustom ? { ...request.config, mcpServers: withCustom } : request.config;
      rememberInit(nextConfig);
      return withCustom ? { ...request, config: nextConfig } : undefined;
    }
    const webOn = current.status === "ready" ? current.values.webLookups : true;
    const extraFolders = current.status === "ready" ? parseFolders(current.values.extraFolders) : [];
    const mode = current.status === "ready" ? current.values.instructionMode : "mcp";
    const existing = request.config.systemPrompt ?? "";

    if (mode === "mcp") {
      const nextSystemPrompt = existing.includes(GENUI_MARKER)
        ? existing
        : [existing, buildMcpSkillInstructions(webOn, extraFolders)].filter(Boolean).join("\n\n");

      let nextMcpServers = mergeCustomMcp(request.config.mcpServers);
      let nextToolPolicy = request.config.toolPolicy;

      if (!nextMcpServers?.[GENUI_MCP_SERVER_NAME]) {
        try {
          const bridge = await ensureMcpBridge();
          nextMcpServers = {
            ...nextMcpServers,
            [GENUI_MCP_SERVER_NAME]: buildMcpServerConfig(bridge, request.config.cwd),
          };
          if (PREAPPROVE_MCP_PROVIDERS.has(request.config.provider.toLowerCase())) {
            const existingPreapproved = request.config.toolPolicy?.preapproved ?? [];
            const addedPreapproved = GENUI_MCP_TOOL_NAMES.filter(
              (tool) =>
                !existingPreapproved.some(
                  (ref) => ref.kind === "mcp" && ref.server === GENUI_MCP_SERVER_NAME && ref.tool === tool,
                ),
            ).map((tool) => ({
              kind: "mcp" as const,
              server: GENUI_MCP_SERVER_NAME,
              tool,
            }));
            nextToolPolicy = {
              ...request.config.toolPolicy,
              preapproved: [...existingPreapproved, ...addedPreapproved],
            };
          }
        } catch {
          // If the local MCP bridge cannot bind (e.g. restricted environment), fall back to full inline instructions.
          const fallbackPrompt = existing.includes(GENUI_MARKER)
            ? existing
            : [existing, buildFullInstructions(webOn, extraFolders)].filter(Boolean).join("\n\n");
          const fallbackConfig = {
            ...request.config,
            systemPrompt: fallbackPrompt,
            ...(nextMcpServers ? { mcpServers: nextMcpServers } : {}),
          };
          rememberInit(fallbackConfig);
          return {
            ...request,
            config: fallbackConfig,
          };
        }
      }

      const finalConfig = {
        ...request.config,
        systemPrompt: nextSystemPrompt,
        ...(nextMcpServers ? { mcpServers: nextMcpServers } : {}),
        ...(nextToolPolicy ? { toolPolicy: nextToolPolicy } : {}),
      };
      rememberInit(finalConfig);
      return {
        ...request,
        config: finalConfig,
      };
    }

    const withCustom = mergeCustomMcp(request.config.mcpServers);
    if (existing.includes(GENUI_MARKER)) {
      const nextConfig = withCustom ? { ...request.config, mcpServers: withCustom } : request.config;
      rememberInit(nextConfig);
      return withCustom ? { ...request, config: nextConfig } : undefined;
    }
    const fullConfig = {
      ...request.config,
      systemPrompt: [existing, buildFullInstructions(webOn, extraFolders)].filter(Boolean).join("\n\n"),
      ...(withCustom ? { mcpServers: withCustom } : {}),
    };
    rememberInit(fullConfig);
    return {
      ...request,
      config: fullConfig,
    };
  });

  server.before("agent.session_open", async ({ request }) => {
    const storageDir = agentStorageDir(request.agentId);
    await mkdir(storageDir, { recursive: true }).catch(() => undefined);
    return {
      ...request,
      env: {
        ...request.env,
        BB_THREAD_STORAGE: storageDir,
        PASEO_THREAD_STORAGE: storageDir,
      },
    };
  });

  server.handle(loadDataRpc, ({ agentId, path, raw }, { paseo }) =>
    loadAgentFile(paseo, agentId, path, { raw }),
  );
  server.handle(loadImageRpc, ({ agentId, path }, { paseo }) =>
    loadAgentImage(paseo, agentId, path),
  );
  server.handle(loadAudioRpc, ({ agentId, path }, { paseo }) =>
    loadAgentAudio(paseo, agentId, path),
  );

  server.handle(renderMarkdownRpc, async ({ agentId, text }, { paseo }) => {
    const markdown = await renderReplyMarkdown(
      text,
      (req) => loadAgentFile(paseo, agentId, req.path, req),
      findImage,
      createProjectReader(paseo, agentId),
    );
    return { markdown };
  });

  server.handle(checkUiRpc, ({ agentId, spec }, { paseo }) =>
    checkSpec(
      spec,
      (req) => loadAgentFile(paseo, agentId, req.path, req),
      findImage,
      createProjectReader(paseo, agentId),
    ),
  );

  server.handle(uiExamplesRpc, ({ components }) => examplesReport(components));
  server.handle(skillsListRpc, async ({ agentId }, { paseo }) => ({
    skills: await listInstalledSkills(paseo, agentId),
  }));

  server.handle(galleryListRpc, async () => ({ names: await listGallery() }));
  server.handle(galleryGetRpc, async ({ name }) => ({ source: await readGallerySpec(name) }));
  server.handle(galleryDataRpc, ({ path, raw }) => loadGalleryFile(path, { raw }));
  server.handle(galleryImageRpc, ({ path }) => loadGalleryImage(path));
  server.handle(galleryAudioRpc, ({ path }) => loadGalleryAudio(path));
  server.handle(sketchFontRpc, async () => ({ dataUrl: await sketchFontDataUrl() }));

  server.handle(webImageRpc, ({ url }) => web.image(url));
  server.handle(webSearchRpc, ({ query }) => web.search(query));
  server.handle(webGeocodeRpc, ({ name, near }) => web.geocode(name, near));
  server.handle(webTileRpc, ({ z, x, y }) => web.tile(z, x, y));

  server.handle(projectChangesRpc, ({ agentId, target, paths }, { paseo }) =>
    readProjectChanges(paseo, agentId, target, paths),
  );
  server.handle(projectPatchesRpc, ({ agentId, target, paths }, { paseo }) =>
    readProjectPatches(paseo, agentId, target, paths),
  );
  server.handle(projectCommitsRpc, ({ agentId }, { paseo }) =>
    readProjectCommits(paseo, agentId),
  );
  server.handle(projectPullRequestRpc, ({ agentId }, { paseo }) =>
    readProjectPullRequest(paseo, agentId),
  );
  server.handle(projectThreadsRpc, ({ agentId, ids }, { paseo }) =>
    readProjectThreads(paseo, agentId, ids),
  );
  server.handle(projectEnvironmentsRpc, ({ agentId }, { paseo }) =>
    readProjectEnvironments(paseo, agentId, false),
  );
  server.handle(projectEnvironmentRpc, ({ agentId, environmentId }, { paseo }) =>
    readProjectEnvironment(paseo, agentId, environmentId),
  );

  let demoSeq = 0;
  server.handle(appendDemoRpc, async ({ agentId, component }, { paseo }) => {
    let code = DEFAULT_DEMO_SPEC;
    let name = "Estimate";
    if (component && component.trim() !== "") {
      try {
        code = await readGallerySpec(component.trim());
        name = component.trim();
      } catch {
        // Fall back to default demo spec if the named gallery file doesn't exist
      }
    }
    const id = `genui-demo-${Date.now()}-${++demoSeq}`;
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id,
      kind: GENUI_BLOCK_KIND,
      version: 1,
      data: {
        language: "ui",
        code,
        complete: true,
        fenceIndex: 0,
        messageId: id,
      },
    });
    return { appended: true, name };
  });

  server.handle(inspectContextRpc, async ({ agentId }, { paseo }) => {
    let captured = initByAgentId.get(agentId) ?? null;
    if (captured === null) {
      try {
        const snap = paseo.agents.ref(agentId).current() ?? (await paseo.agents.ref(agentId).refresh())?.agent;
        if (snap) {
          captured = pendingInitByKey.get(initKey(snap.provider, snap.cwd)) ?? null;
        }
      } catch {
        // Ignore lookup error
      }
    }
    const report = await buildContextInspectionReport(paseo, agentId, captured);
    const code = buildContextInspectorSpec(report);
    const id = `genui-context-${Date.now()}-${++demoSeq}`;
    await paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id,
      kind: GENUI_BLOCK_KIND,
      version: 1,
      data: {
        language: "ui",
        code,
        complete: true,
        fenceIndex: 0,
        messageId: id,
      },
    });
    return { appended: true, sections: report.sections.length };
  });

  server.handle(mcpOAuthStatusRpc, ({ urls }) => ({
    statuses: getMcpOAuthStatuses(urls),
  }));

  server.handle(mcpOAuthStartRpc, ({ serverName, url }) => startMcpOAuthFlow(serverName, url));

  server.handle(mcpOAuthLogoutRpc, ({ url }) => ({
    cleared: clearMcpOAuthToken(url),
  }));

  return () => {
    unsubscribeSettings();
    unsubscribeCreated();
    stopAllMcpOAuthFlows();
    if (bridgePromise !== null) {
      void bridgePromise.then((bridge) => bridge.close()).catch(() => undefined);
      bridgePromise = null;
    }
  };
}
