import {
  collectLoads,
  compile,
  compileStreaming,
  dataKey,
  evaluate,
  formatDiagnostics,
  imageSearches,
  initialState,
  specToMarkdown,
  type DataRequest,
  type LoadedData,
  type SearchedImage,
} from "./core";
import { projectRequests, toMarkdownWithProject } from "./core/markdown";
import { projectRequestKey, type ProjectRequest, type ProjectResult } from "./core/project";
import type { UiNode } from "./core/types";
import { asRecord, finiteNumber, isNode, isObject, list } from "./logic/values";

type Loader = (request: DataRequest) => Promise<LoadedData>;
type ImageFinder = (query: string) => Promise<SearchedImage | null>;
export type ProjectReader = (request: ProjectRequest) => Promise<ProjectResult>;

async function findImages(roots: readonly UiNode[], find: ImageFinder | undefined): Promise<Map<string, SearchedImage | null>> {
  if (find === undefined) return new Map();
  return new Map(await Promise.all(imageSearches(roots).map(async (query) => [query, await find(query)] as const)));
}

async function rootsMarkdown(roots: readonly UiNode[], find: ImageFinder | undefined, project: ProjectReader | undefined): Promise<string> {
  const requests = project === undefined ? [] : projectRequests(roots);
  const [images, answers] = await Promise.all([
    findImages(roots, find),
    Promise.all(requests.map(async (request) => [projectRequestKey(request), await project!(request)] as const)),
  ]);
  return toMarkdownWithProject(roots, images, new Map(answers));
}

export interface Fence {
  open: number;
  close: number;
  language: string;
  body: string;
  closed: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/;

export function findFences(lines: readonly string[]): Fence[] {
  const fences: Fence[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE_OPEN.exec(lines[index] ?? "");
    if (open === null) continue;
    const marker = open[1] ?? "```";
    const closing = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let close = index + 1;
    while (close < lines.length && !closing.test(lines[close] ?? "")) close++;
    fences.push({
      open: index,
      close,
      language: (open[2] ?? "").toLowerCase(),
      body: lines.slice(index + 1, close).join("\n"),
      closed: close < lines.length,
    });
    index = close;
  }
  return fences;
}

function appPointer(html: string): string {
  const title = /<title>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim();
  return `_Interactive app${title ? `: ${title}` : ""}. Open this reply in Paseo to use it._`;
}

async function uiMarkdown(spec: string, load: Loader, find: ImageFinder | undefined, project: ProjectReader | undefined): Promise<string> {
  const { program } = compileStreaming(spec);
  const requests = program === null ? [] : collectLoads(program);
  const data = new Map(await Promise.all(requests.map(async (request) => [dataKey(request), await load(request)] as const)));
  const compiled = compile(spec);
  if (compiled.program === null) return specToMarkdown(spec, data);
  const { roots } = evaluate(compiled.program, initialState(compiled.program, data), data);
  return rootsMarkdown(roots, find, project);
}

export async function renderReplyMarkdown(text: string, load: Loader, find?: ImageFinder, project?: ProjectReader): Promise<string> {
  const lines = text.split("\n");
  const fences = findFences(lines).filter((fence) => fence.language === "ui" || fence.language === "app");
  if (fences.length === 0) return text;
  const output: string[] = [];
  let next = 0;
  for (const fence of fences) {
    output.push(...lines.slice(next, fence.open));
    output.push(fence.language === "app" ? appPointer(fence.body) : await uiMarkdown(fence.body, load, find, project));
    next = fence.close + 1;
  }
  output.push(...lines.slice(next));
  return output.join("\n");
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function lintNodes(roots: readonly UiNode[]): string[] {
  const issues: string[] = [];
  if (roots.length > 1) {
    issues.push(
      `Top-level has ${roots.length} separate nodes; wrap everything in a single Card(title, [...]) so it renders cleanly.`,
    );
  }

  const visit = (node: UiNode): void => {
    const props = node.props;
    switch (node.type) {
      case "Tabs": {
        const labels = list(props.labels);
        const children = list(props.children).filter(isNode);
        if (labels.length === 0) {
          issues.push("Tabs: labels list is empty.");
        } else if (labels.length !== children.length) {
          issues.push(
            `Tabs: ${labels.length} label(s) but ${children.length} child panel(s); provide one child per tab label.`,
          );
        }
        break;
      }
      case "Chart": {
        const labels = list(props.labels);
        const type = typeof props.type === "string" ? props.type : "bar";
        if (labels.length === 0) {
          issues.push("Chart: labels list is empty.");
        }
        if (type === "radar" && labels.length < 3) {
          issues.push(`Chart("radar"): needs at least 3 labels (got ${labels.length}).`);
        }
        const rawSeries = props.series;
        if (Array.isArray(rawSeries)) {
          if (rawSeries.length === 0) {
            issues.push("Chart: series is empty.");
          } else if (labels.length > 0 && rawSeries.length !== labels.length && type !== "scatter") {
            issues.push(
              `Chart: ${labels.length} label(s) but series has ${rawSeries.length} value(s); match lengths.`,
            );
          }
        } else if (isObject(rawSeries)) {
          const entries = Object.entries(rawSeries);
          if (entries.length === 0) {
            issues.push("Chart: series object has no entries.");
          }
          for (const [name, entry] of entries) {
            const entryRec = asRecord(entry);
            const vals = Array.isArray(entry)
              ? entry
              : entryRec !== null && Array.isArray(entryRec.values)
                ? entryRec.values
                : null;
            if (vals === null) {
              issues.push(`Chart: series "${name}" must be a list of numbers or {values: [numbers], tone?, dashed?}.`);
            } else if (labels.length > 0 && vals.length !== labels.length && type !== "scatter") {
              issues.push(
                `Chart: series "${name}" has ${vals.length} value(s) for ${labels.length} label(s); match lengths.`,
              );
            }
          }
        }
        break;
      }
      case "Table": {
        if (list(props.columns).length === 0) {
          issues.push("Table: columns list is empty.");
        }
        break;
      }
      case "Gauge": {
        const min = finiteNumber(props.min);
        const max = finiteNumber(props.max);
        if (min !== null && max !== null && min >= max) {
          issues.push(`Gauge: min (${min}) must be less than max (${max}).`);
        }
        break;
      }
      case "Calendar": {
        for (const item of list(props.events)) {
          const rec = asRecord(item);
          const date = rec && typeof rec.date === "string" ? rec.date : null;
          if (date !== null && !ISO_DATE.test(date)) {
            issues.push(`Calendar: event date "${date}" should be YYYY-MM-DD.`);
            break;
          }
        }
        break;
      }
      default:
        break;
    }

    for (const value of Object.values(props)) {
      if (isNode(value)) {
        visit(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) visit(item);
        }
      }
    }
  };

  for (const root of roots) visit(root);
  return issues;
}

export async function checkSpec(
  spec: string,
  load: Loader,
  find?: ImageFinder,
  project?: ProjectReader,
): Promise<{ readonly ok: boolean; readonly report: string }> {
  const compiled = compile(spec);
  if (compiled.program === null) {
    return { ok: false, report: `The block does not compile:\n${formatDiagnostics(compiled.diagnostics)}` };
  }
  const requests = collectLoads(compiled.program);
  const loaded = await Promise.all(requests.map(async (request) => [request, await load(request)] as const));
  const data = new Map(loaded.map(([request, result]) => [dataKey(request), result] as const));
  const { roots, diagnostics } = evaluate(compiled.program, initialState(compiled.program, data), data);
  const lintIssues = lintNodes(roots);
  const problems = [
    ...loaded.flatMap(([request, result]) => (result.ok ? [] : [`${request.path}: ${result.error}`])),
    ...(diagnostics.length > 0 ? [formatDiagnostics(diagnostics)] : []),
    ...lintIssues,
  ];
  const preview = `Text version of what the user will see:\n\n${await rootsMarkdown(roots, find, project)}`;
  return problems.length === 0
    ? { ok: true, report: `No errors. ${preview}` }
    : { ok: false, report: `Fix before replying:\n${problems.join("\n")}\n\n${preview}` };
}
