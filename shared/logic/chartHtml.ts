// The sandboxed HTML/SVG generator behind web-rendered charts. `Chart` mounts
// this through the same theme-injecting iframe as `app` blocks (client/web.ts),
// so every color is a CSS variable and light and dark themes both work. Nothing
// here touches a DOM: the output is a string and the arithmetic is pure, so the
// whole module is testable in node (chartHtml.test.ts).

import {
  formatShare,
  funnelStages,
  heatLevel,
  niceScale,
  numericValue,
  percentages,
  pieSlices,
  radarPoint,
  scatterPoints,
  stackSeries,
  type FunnelStage,
  type Scale,
  type Segment,
  type Slice,
} from "./chartMath";
import { formatNumber, type Tone } from "./values";

export type ChartType = "bar" | "line" | "area" | "pie" | "scatter" | "radar" | "funnel" | "heatmap";

export interface ChartSeriesSpec {
  readonly name: string;
  readonly tone: Tone;
  readonly dashed: boolean;
  readonly lineDash?: string | null;
  readonly strokeWidth?: number;
  readonly fillOpacity?: number;
  readonly pointRadius?: number;
  readonly values: readonly (number | null)[];
}

export interface ChartSpecInfo {
  readonly type: ChartType;
  readonly labels: readonly string[];
  readonly series: readonly ChartSeriesSpec[];
  readonly unit: string;
  readonly title: string | null;
  readonly xLabel: string | null;
  readonly yLabel: string | null;
  readonly stacked: boolean;
  readonly donut: boolean;
  readonly smooth: boolean;
  readonly height: number;
  readonly width?: number;
  readonly showValues: boolean;
  readonly orientation: "vertical" | "horizontal";
  readonly showGrid?: boolean;
  readonly showLegend?: boolean;
  readonly tooltip?: boolean;
}

const DASH_PRESETS: Readonly<Record<string, string | null>> = {
  solid: null,
  none: null,
  dashed: "6 4",
  dotted: "2 3",
  dashdot: "8 4 2 4",
};

/** Normalizes a `lineDash` option (preset, `"8 4"`, `[8, 4]`) or `dashed` flag to a safe SVG `stroke-dasharray` value. */
export function normalizeLineDash(raw: unknown, dashed?: boolean): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "") return null;
    if (Object.hasOwn(DASH_PRESETS, trimmed)) return DASH_PRESETS[trimmed] ?? null;
    const nums = trimmed
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    return nums.length > 0 ? nums.map((n) => String(Math.round(n * 100) / 100)).join(" ") : null;
  }
  if (Array.isArray(raw)) {
    const nums = raw.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return nums.length > 0 ? nums.map((n) => String(Math.round(n * 100) / 100)).join(" ") : null;
  }
  return dashed ? "5 4" : null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function seriesDash(s: ChartSeriesSpec): string | null {
  if (s.lineDash !== undefined) return s.lineDash;
  return s.dashed ? "5 4" : null;
}

function seriesStrokeWidth(s: ChartSeriesSpec): number {
  return s.strokeWidth !== undefined && Number.isFinite(s.strokeWidth) ? clamp(s.strokeWidth, 1, 6) : 2;
}

function seriesFillOpacity(s: ChartSeriesSpec, fallback: number): number {
  return s.fillOpacity !== undefined && Number.isFinite(s.fillOpacity) ? clamp(s.fillOpacity, 0, 1) : fallback;
}

function seriesPointRadius(s: ChartSeriesSpec, fallback: number): number {
  return s.pointRadius !== undefined && Number.isFinite(s.pointRadius) ? clamp(s.pointRadius, 0, 8) : fallback;
}

export const CHART_TYPES: readonly ChartType[] = [
  "bar",
  "line",
  "area",
  "pie",
  "scatter",
  "radar",
  "funnel",
  "heatmap",
];

const TONE_VAR: Record<Tone, string> = {
  info: "var(--primary)",
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
  neutral: "var(--muted-foreground)",
};

const WHEEL: readonly Tone[] = ["info", "good", "warn", "bad", "neutral"];

/** The nth wheel tone, so a multi-series chart and the native fallback agree on colors. */
export function wheelTone(index: number): Tone {
  return WHEEL[((index % WHEEL.length) + WHEEL.length) % WHEEL.length]!;
}

/** A pie slice's color: slices are not series, so they take the wheel by position. */
function sliceColor(index: number): string {
  return TONE_VAR[wheelTone(index)];
}

/**
 * A series' color: the tone it set for itself, else its position on the wheel.
 * The native fallback paints series by tone the same way.
 */
function seriesColor(series: readonly ChartSeriesSpec[], index: number): string {
  return TONE_VAR[series[index]?.tone ?? wheelTone(index)];
}

/** Past the first wheel lap the repeats read lighter, so ten series stay distinct. */
function opacityOf(index: number): number {
  return index < WHEEL.length ? 1 : 0.55;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function r2(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** A short axis tick: grouped, no unit (the yLabel carries it). */
function tick(t: number): string {
  return formatNumber(Number(t.toPrecision(3)));
}

/** A printed value with its unit. */
function printed(v: number, unit: string): string {
  const text = formatNumber(v);
  return unit ? `${text} ${unit}` : text;
}

const CHART_CSS = `.g-chart{position:relative;padding:4px 2px 2px}
.g-title{font-size:13.5px;font-weight:600;color:var(--foreground);margin:0 0 8px 4px;line-height:1.35}
.g-legend{display:flex;flex-wrap:wrap;gap:4px 14px;padding:8px 4px 2px 4px}
.g-legend .chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted-foreground);line-height:1.3}
.g-legend .dot{width:9px;height:9px;border-radius:5px;flex:none}
.g-legend .line-swatch{width:16px;height:0;border-top:2px dashed;flex:none}
.g-mark{cursor:pointer;transition:opacity 120ms ease,filter 120ms ease}
.g-mark:hover{filter:brightness(1.12)}
.g-tip{position:absolute;top:0;left:0;z-index:20;pointer-events:none;opacity:0;transition:opacity 110ms ease;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:8px;padding:6px 9px;font-size:12px;line-height:1.35;box-shadow:0 4px 14px rgba(0,0,0,0.18);max-width:240px;white-space:nowrap}
.g-tip.show{opacity:1}
.g-tip-head{font-weight:600;color:var(--foreground);margin-bottom:2px}
.g-tip-row{display:flex;align-items:center;gap:6px;color:var(--muted-foreground)}
.g-tip-dot{width:8px;height:8px;border-radius:4px;flex:none}
.g-tip-val{font-weight:600;color:var(--foreground)}`;

const TOOLTIP_SCRIPT = `(function(){
var root=document.querySelector(".g-chart"),tip=document.getElementById("g-tip");
if(!root||!tip)return;
var head=document.createElement("div");head.className="g-tip-head";
var row=document.createElement("div");row.className="g-tip-row";
var dot=document.createElement("span");dot.className="g-tip-dot";
var ser=document.createElement("span");
var val=document.createElement("span");val.className="g-tip-val";
row.appendChild(dot);row.appendChild(ser);row.appendChild(val);
tip.appendChild(head);tip.appendChild(row);
function place(e){
var r=root.getBoundingClientRect(),x=e.clientX-r.left+12,y=e.clientY-r.top-12;
var tw=tip.offsetWidth||120,th=tip.offsetHeight||44;
if(x+tw>r.width-4)x=Math.max(4,e.clientX-r.left-tw-12);
if(y+th>r.height-4)y=Math.max(4,r.height-th-4);
if(y<4)y=4;
tip.style.transform="translate("+Math.round(x)+"px,"+Math.round(y)+"px)";
}
root.addEventListener("pointermove",function(e){
var el=e.target&&e.target.closest?e.target.closest("[data-tip-value]"):null;
if(!el){tip.classList.remove("show");return;}
var t=el.getAttribute("data-tip-title")||"";
var s=el.getAttribute("data-tip-series")||"";
var v=el.getAttribute("data-tip-value")||"";
var c=el.getAttribute("data-tip-color")||"var(--primary)";
head.textContent=t;head.style.display=t?"block":"none";
dot.style.background=c;
ser.textContent=s?s+": ":"";
val.textContent=v;
tip.classList.add("show");
place(e);
});
root.addEventListener("pointerleave",function(){tip.classList.remove("show");});
})();`;

function tipAttrs(title: string, seriesName: string | null, value: string, color: string): string {
  const seriesAttr = seriesName && seriesName !== "Value" ? ` data-tip-series="${esc(seriesName)}"` : "";
  return ` class="g-mark" data-tip-title="${esc(title)}"${seriesAttr} data-tip-value="${esc(value)}" data-tip-color="${esc(color)}"`;
}

const DEFAULT_WIDTH = 720;

function chartWidth(spec: ChartSpecInfo): number {
  const raw = spec.width;
  return raw !== undefined && Number.isFinite(raw) ? Math.round(clamp(raw, 220, 960)) : DEFAULT_WIDTH;
}

function chartHeight(spec: ChartSpecInfo): number {
  return Math.round(Math.min(560, Math.max(150, spec.height)));
}

function svg(inner: string, width: number, height: number, title: string | null): string {
  const label = title ? `<title>${esc(title)}</title>` : "";
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet" role="img">${label}${inner}</svg>`;
}

function noDataSvg(spec: ChartSpecInfo): string {
  const width = chartWidth(spec);
  const height = chartHeight(spec);
  return svg(
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="12.5" fill="var(--muted-foreground)">No data</text>`,
    width,
    height,
    spec.title,
  );
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly plotW: number;
  readonly plotH: number;
}

function labelsRotate(labels: readonly string[]): boolean {
  return labels.length > 8 || labels.some((l) => l.length > 8);
}

function axisFrame(spec: ChartSpecInfo, overrides?: { left?: number; right?: number; rotateX?: boolean }): Frame {
  const width = chartWidth(spec);
  const height = chartHeight(spec);
  const top = 12;
  const rotateX = overrides?.rotateX ?? (spec.type !== "scatter" && labelsRotate(spec.labels));
  const bottom = (rotateX ? 60 : 34) + (spec.xLabel !== null ? 20 : 0);
  const baseLeft = width < 400 ? 40 : 50;
  const left = overrides?.left ?? baseLeft + (spec.yLabel !== null ? 14 : 0);
  const right = overrides?.right ?? 14;
  return {
    width,
    height,
    top,
    left,
    plotW: Math.max(80, width - left - right),
    plotH: Math.max(60, height - top - bottom),
  };
}

function y(v: number, scale: Scale, f: Frame): number {
  return f.top + f.plotH * (1 - (v - scale.min) / (scale.max - scale.min));
}

function xTickText(l: string): string {
  return esc(l.length > 18 ? `${l.slice(0, 17)}…` : l);
}

function yTicksSvg(scale: Scale, f: Frame, showGrid = true): string {
  const parts: string[] = [];
  for (const t of scale.ticks) {
    const py = y(t, scale, f);
    if (showGrid) {
      parts.push(
        `<line x1="${f.left}" y1="${r2(py)}" x2="${f.left + f.plotW}" y2="${r2(py)}" stroke="var(--border)" opacity="0.55"/>`,
      );
    }
    parts.push(
      `<text x="${f.left - 7}" y="${r2(py + 3.5)}" text-anchor="end" font-size="10.5" fill="var(--muted-foreground)">${esc(tick(t))}</text>`,
    );
  }
  return parts.join("");
}

function yLabelSvg(spec: ChartSpecInfo, f: Frame): string {
  if (spec.yLabel === null) return "";
  return `<text transform="translate(12 ${r2(f.top + f.plotH / 2)}) rotate(-90)" text-anchor="middle" font-size="10.5" fill="var(--muted-foreground)">${esc(spec.yLabel.slice(0, 40))}</text>`;
}

function xLabelSvg(spec: ChartSpecInfo, f: Frame): string {
  if (spec.xLabel === null) return "";
  return `<text x="${f.left + f.plotW / 2}" y="${f.height - 5}" text-anchor="middle" font-size="10.5" fill="var(--muted-foreground)">${esc(spec.xLabel.slice(0, 60))}</text>`;
}

/** Value labels under the plot, rotated when there are many or long ones. */
function xTicksSvg(positions: readonly number[], labels: readonly string[], f: Frame): string {
  const rotate = labelsRotate(labels);
  const baseline = f.top + f.plotH;
  return labels
    .map((l, i) => {
      const x = positions[i] ?? f.left;
      if (rotate) {
        return `<text transform="translate(${r2(x)},${baseline + 14}) rotate(-30)" text-anchor="end" font-size="10" fill="var(--muted-foreground)">${xTickText(l)}</text>`;
      }
      return `<text x="${r2(x)}" y="${baseline + 16}" text-anchor="middle" font-size="10.5" fill="var(--muted-foreground)">${xTickText(l)}</text>`;
    })
    .join("");
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Polyline through the points; `smooth` = Catmull-Rom read as cubic beziers. */
function pathOf(points: readonly Pt[], smooth: boolean): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  if (points.length < 3 || !smooth) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${r2(p.x)},${r2(p.y)}`).join("");
  }
  let d = `M${r2(first.x)},${r2(first.y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    d += `C${r2(p1.x + (p2.x - p0.x) / 6)},${r2(p1.y + (p2.y - p0.y) / 6)},${r2(p2.x - (p3.x - p1.x) / 6)},${r2(p2.y - (p3.y - p1.y) / 6)},${r2(p2.x)},${r2(p2.y)}`;
  }
  return d;
}

function dashAttr(dash: string | null): string {
  return dash ? ` stroke-dasharray="${esc(dash)}"` : "";
}

function valueMark(x: number, yTop: number, v: number, unit: string): string {
  return `<text x="${r2(x)}" y="${r2(yTop - 5)}" text-anchor="middle" font-size="10" fill="var(--foreground)">${esc(printed(v, unit))}</text>`;
}

/** Where a series' finite values sit per label: nulls break the line into runs. */
function lineRuns(values: readonly (number | null)[], positions: readonly number[], scale: Scale, f: Frame): Pt[][] {
  const runs: Pt[][] = [];
  let run: Pt[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: positions[i] ?? f.left, y: y(v, scale, f) });
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

function scaleFor(extremes: readonly number[], zero: boolean): Scale {
  const finite = extremes.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return niceScale(0, 1, 4, zero);
  return niceScale(Math.min(...finite), Math.max(...finite), 4, zero);
}

/** Bar (vertical), line and area share one frame: ticks, then marks, then labels. */
function lineOrBarSvg(spec: ChartSpecInfo): string {
  const f = axisFrame(spec);
  const count = spec.labels.length;
  if (count === 0) return noDataSvg(spec);
  const flat = spec.series.map((s) => s.values);

  // Stacking rewrites the drawn extent (sums, not single values) and the fills.
  const stacked = spec.stacked && (spec.type === "bar" || spec.type === "area");
  const grid = stacked ? stackSeries(flat) : null;
  const scale: Scale = (() => {
    if (!grid) return scaleFor(flat.flat().filter((v): v is number => v !== null), spec.type === "bar");
    const stackExtremes: number[] = [0];
    for (let i = 0; i < count; i++) {
      let up = 0;
      let down = 0;
      for (let si = 0; si < spec.series.length; si++) {
        const seg: Segment | null = grid[si]?.[i] ?? null;
        if (!seg) continue;
        up = Math.max(up, seg.to);
        down = Math.min(down, seg.from);
      }
      stackExtremes.push(up, down);
    }
    return scaleFor(stackExtremes, true);
  })();

  const positions: number[] = [];
  for (let i = 0; i < count; i++) {
    positions.push(
      spec.type === "bar"
        ? f.left + (f.plotW / count) * (i + 0.5)
        : f.left + (count === 1 ? f.plotW / 2 : (f.plotW * i) / (count - 1)),
    );
  }

  const showGrid = spec.showGrid !== false;
  const parts: string[] = [yTicksSvg(scale, f, showGrid)];

  if (spec.type === "bar") {
    const slot = f.plotW / count;
    if (grid) {
      const groupW = Math.min(72, Math.max(6, slot * 0.66));
      spec.series.forEach((s, si) => {
        const col = seriesColor(spec.series, si);
        const op = seriesFillOpacity(s, opacityOf(si));
        (grid[si] ?? []).forEach((seg, i) => {
          if (!seg) return;
          const topY = y(seg.to, scale, f);
          const bottomY = y(seg.from, scale, f);
          const own = s.values[i] ?? seg.to - seg.from;
          const tip = tipAttrs(spec.labels[i] ?? "", s.name, printed(own, spec.unit), col);
          parts.push(
            `<rect x="${r2(positions[i]! - groupW / 2)}" y="${r2(topY)}" width="${r2(groupW)}" height="${r2(Math.max(2, bottomY - topY))}" ${rect(seg.outer ? 3 : 0)} fill="${col}" fill-opacity="${r2(op)}"${tip}/>`,
          );
        });
      });
      if (spec.showValues && count <= 14) {
        for (let i = 0; i < count; i++) {
          let up = 0;
          let net = 0;
          spec.series.forEach((s) => {
            const v = s.values[i];
            if (v !== null) {
              net += v;
              if (v > 0) up += v;
            }
          });
          if (up > 0) parts.push(valueMark(positions[i]!, y(Math.max(up, net), scale, f), net, spec.unit));
        }
      }
    } else {
      const groupW = Math.min(72, Math.max(6, slot * 0.8));
      const gap = spec.series.length > 1 ? 2 : 0;
      const barW = Math.max(2, (groupW - gap * (spec.series.length - 1)) / Math.max(1, spec.series.length));
      spec.series.forEach((s, si) => {
        const col = seriesColor(spec.series, si);
        const op = seriesFillOpacity(s, opacityOf(si));
        s.values.forEach((v, i) => {
          if (v === null || !Number.isFinite(v)) return;
          // Both signs draw: the rect spans zero to the value, whichever way it points.
          const topY = y(Math.max(0, v), scale, f);
          const bottomY = y(Math.min(0, v), scale, f);
          const x = positions[i]! - groupW / 2 + si * (barW + gap);
          const tip = tipAttrs(spec.labels[i] ?? "", s.name, printed(v, spec.unit), col);
          parts.push(
            `<rect x="${r2(x)}" y="${r2(topY)}" width="${r2(barW)}" height="${r2(Math.max(2, bottomY - topY))}" ${rect(3)} fill="${col}" fill-opacity="${r2(op)}"${tip}/>`,
          );
          if (spec.showValues && count <= 12 && spec.series.length <= 2) {
            const markY = v >= 0 ? topY : bottomY + 12;
            parts.push(valueMark(positions[i]! - groupW / 2 + si * (barW + gap) + barW / 2, markY, v, spec.unit));
          }
        });
      });
    }
  } else {
    // Line and area: fills first, then strokes, markers and labels.
    const stackedArea = spec.type === "area" && grid !== null;
    /** What series si draws at label i: its own value, or the running total it sits on. */
    const plottedAt = (si: number, i: number): number | null =>
      stackedArea ? (grid?.[si]?.[i]?.to ?? null) : (spec.series[si]?.values[i] ?? null);

    if (spec.type === "area") {
      if (grid) {
        // Stacked bands, bottom series first, each filled down to the one below it.
        let previous: readonly (number | null)[] = spec.labels.map(() => 0);
        spec.series.forEach((s, si) => {
          const top: (number | null)[] = spec.labels.map((_, i) => plottedAt(si, i));
          const op = seriesFillOpacity(s, opacityOf(si) * 0.5);
          parts.push(bandFill(positions, top, previous, scale, f, seriesColor(spec.series, si), op));
          previous = top;
        });
      } else {
        const zeroY = y(0, scale, f);
        spec.series.forEach((s, si) => {
          const op = seriesFillOpacity(s, 0.16);
          for (const run of lineRuns(s.values, positions, scale, f)) {
            if (run.length < 2) continue;
            const d = pathOf(run, spec.smooth);
            parts.push(
              `<path d="${d}L${r2(run[run.length - 1]!.x)},${r2(zeroY)}L${r2(run[0]!.x)},${r2(zeroY)}Z" fill="${seriesColor(spec.series, si)}" fill-opacity="${r2(op)}" stroke="none"/>`,
            );
          }
        });
      }
    }

    spec.series.forEach((s, si) => {
      const col = seriesColor(spec.series, si);
      const sw = seriesStrokeWidth(s);
      const dash = seriesDash(s);
      const pr = seriesPointRadius(s, 3);
      // A stacked band's stroke follows its top, not the series' own values.
      const drawn = spec.labels.map((_, i) => plottedAt(si, i));
      for (const run of lineRuns(drawn, positions, scale, f)) {
        parts.push(
          `<path d="${pathOf(run, spec.smooth)}" fill="none" stroke="${col}" stroke-width="${r2(sw)}"${dashAttr(dash)}/>`,
        );
      }
      drawn.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) return;
        const cx = positions[i]!;
        const cy = y(v, scale, f);
        const own = s.values[i];
        const tipVal = own !== null && own !== undefined ? printed(own, spec.unit) : printed(v, spec.unit);
        const tip = tipAttrs(spec.labels[i] ?? "", s.name, tipVal, col);
        if (pr > 0 && (drawn.length <= 20 || spec.showValues || s.pointRadius !== undefined)) {
          parts.push(
            `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(pr)}" fill="${col}" stroke="var(--background)" stroke-width="1.5"/>`,
          );
        }
        // Larger transparent hover target makes hovering points effortless even when dots are small or hidden.
        if (spec.tooltip !== false) {
          parts.push(`<circle cx="${r2(cx)}" cy="${r2(cy)}" r="8" fill="transparent" stroke="none"${tip}/>`);
        }
        if (spec.showValues && own !== null && own !== undefined && drawn.length <= 12 && spec.series.length <= 2) {
          parts.push(valueMark(cx, cy - 2, own, spec.unit));
        }
      });
    });
  }

  parts.push(xTicksSvg(positions, spec.labels, f));
  parts.push(xLabelSvg(spec, f));
  parts.push(yLabelSvg(spec, f));
  return svg(parts.join(""), f.width, f.height, spec.title);
}

function rect(rx: number): string {
  return `rx="${rx}" ry="${rx}"`;
}

/** A filled band between two stacked-area boundaries (nulls read as 0). */
function bandFill(
  positions: readonly number[],
  top: readonly (number | null)[],
  previous: readonly (number | null)[],
  scale: Scale,
  f: Frame,
  fill: string,
  fillOpacity: number,
): string {
  const topPts = positions
    .map((x, i) => ({ x, v: top[i] ?? 0 }))
    .map((p) => ({ x: p.x, y: y(p.v, scale, f) }));
  const d = pathOf(topPts, false);
  const right = topPts[topPts.length - 1]!;
  const back = [...previous]
    .map((v, i) => ({ x: positions[i] ?? f.left, v: v ?? 0 }))
    .reverse()
    .map((p) => `L${r2(p.x)},${r2(y(p.v, scale, f))}`)
    .join("");
  return `<path d="${d}L${r2(right.x)},${r2(right.y)}${back}Z" fill="${fill}" fill-opacity="${r2(fillOpacity)}" stroke="none"/>`;
}

/** Bar with horizontal rows: labels left, value axis along the bottom. */
function hbarSvg(spec: ChartSpecInfo): string {
  const count = spec.labels.length;
  if (count === 0) return noDataSvg(spec);
  const width = chartWidth(spec);
  const stacked = spec.stacked && spec.series.length > 1;
  const maxLabelLen = Math.min(20, Math.max(0, ...spec.labels.map((l) => l.length)));
  const maxLeft = Math.min(168, Math.max(64, Math.round(width * 0.42)));
  const left = Math.max(54, Math.min(maxLeft, Math.round(maxLabelLen * 6.8 + 18))) + (spec.yLabel !== null ? 14 : 0);
  const right = spec.showValues && !stacked ? 68 : 14;
  const f = axisFrame(spec, { left, right, rotateX: false });
  const rowsH = f.plotH / count;
  const grid = stacked ? stackSeries(spec.series.map((s) => s.values)) : null;
  const scale = (() => {
    if (!grid) {
      return scaleFor(
        spec.series.flatMap((s) => s.values).filter((v): v is number => v !== null),
        true,
      );
    }
    const stackExtremes: number[] = [0];
    for (let i = 0; i < count; i++) {
      for (let si = 0; si < spec.series.length; si++) {
        const seg: Segment | null = grid[si]?.[i] ?? null;
        if (!seg) continue;
        stackExtremes.push(seg.from, seg.to);
      }
    }
    return scaleFor(stackExtremes, true);
  })();
  const zeroX = f.left + ((0 - scale.min) / (scale.max - scale.min)) * f.plotW;
  const xpx = (v: number) => f.left + ((v - scale.min) / (scale.max - scale.min)) * f.plotW;

  const showGrid = spec.showGrid !== false;
  const parts: string[] = [];
  for (const t of scale.ticks) {
    const px = xpx(t);
    if (showGrid) {
      parts.push(
        `<line x1="${r2(px)}" y1="${f.top}" x2="${r2(px)}" y2="${f.top + f.plotH}" stroke="var(--border)" opacity="0.55"/>`,
      );
    }
    parts.push(
      `<text x="${r2(px)}" y="${f.top + f.plotH + 16}" text-anchor="middle" font-size="10.5" fill="var(--muted-foreground)">${esc(tick(t))}</text>`,
    );
  }

  spec.labels.forEach((label, i) => {
    const cy = f.top + rowsH * (i + 0.5);
    parts.push(
      `<text x="${f.left - 8}" y="${r2(cy + 4)}" text-anchor="end" font-size="11.5" fill="var(--foreground)">${esc(label.length > 20 ? `${label.slice(0, 19)}…` : label)}</text>`,
    );
    if (stacked) {
      spec.series.forEach((s, si) => {
        const seg: Segment | null = grid?.[si]?.[i] ?? null;
        if (!seg) return;
        const x0 = xpx(seg.from);
        const x1 = xpx(seg.to);
        const col = seriesColor(spec.series, si);
        const op = seriesFillOpacity(s, opacityOf(si));
        const own = s.values[i] ?? seg.to - seg.from;
        const tip = tipAttrs(label, s.name, printed(own, spec.unit), col);
        parts.push(
          `<rect x="${r2(Math.min(x0, x1))}" y="${r2(cy - rowsH * 0.28)}" width="${r2(Math.max(2, Math.abs(x1 - x0)))}" height="${r2(rowsH * 0.56)}" ${rect(3)} fill="${col}" fill-opacity="${r2(op)}"${tip}/>`,
        );
      });
    } else {
      const barH = Math.min(18, rowsH * (spec.series.length > 1 ? 0.56 : 0.6));
      spec.series.forEach((s, si) => {
        const v = s.values[i];
        if (v === null || !Number.isFinite(v)) return;
        const x0 = Math.min(zeroX, xpx(v));
        const w = Math.max(2, Math.abs(xpx(v) - zeroX));
        const yy = cy - (spec.series.length * (barH + 2)) / 2 + si * (barH + 2);
        const subCy = yy + barH / 2;
        const col = seriesColor(spec.series, si);
        const op = seriesFillOpacity(s, opacityOf(si));
        const tip = tipAttrs(label, s.name, printed(v, spec.unit), col);
        parts.push(
          `<rect x="${r2(x0)}" y="${r2(yy)}" width="${r2(w)}" height="${r2(barH)}" ${rect(3)} fill="${col}" fill-opacity="${r2(op)}"${tip}/>`,
        );
        if (spec.showValues) {
          parts.push(
            `<text x="${r2(Math.max(x0 + w, zeroX) + 5)}" y="${r2(subCy + 3.5)}" text-anchor="start" font-size="10" fill="var(--foreground)">${esc(printed(v, spec.unit))}</text>`,
          );
        }
      });
    }
  });

  parts.push(xLabelSvg(spec, f));
  parts.push(yLabelSvg(spec, f));
  return svg(parts.join(""), f.width, f.height, spec.title);
}

function scatterSvg(spec: ChartSpecInfo): string {
  const f = axisFrame(spec);
  const xs = spec.labels.map((l, i) => numericValue(l) ?? i);
  const points = scatterPoints(xs, spec.series.map((s) => s.values));
  if (points.length === 0) return noDataSvg(spec);
  const sx = scaleFor(points.map((p) => p.x), true);
  const sy = scaleFor(points.map((p) => p.y), false);
  const xpx = (v: number) => f.left + ((v - sx.min) / (sx.max - sx.min)) * f.plotW;
  const ypx = (v: number) => y(v, sy, f);

  const showGrid = spec.showGrid !== false;
  const parts: string[] = [yTicksSvg(sy, f, showGrid)];
  for (const t of sx.ticks) {
    const px = xpx(t);
    if (showGrid) {
      parts.push(
        `<line x1="${r2(px)}" y1="${f.top}" x2="${r2(px)}" y2="${f.top + f.plotH}" stroke="var(--border)" opacity="0.35"/>`,
      );
    }
    parts.push(
      `<text x="${r2(px)}" y="${f.top + f.plotH + 16}" text-anchor="middle" font-size="10.5" fill="var(--muted-foreground)">${esc(tick(t))}</text>`,
    );
  }
  // The zero line only when zero is on the axis the dots are drawn against.
  if (sy.min <= 0 && sy.max >= 0) {
    const axisY = ypx(0);
    parts.push(
      `<line x1="${f.left}" y1="${r2(axisY)}" x2="${f.left + f.plotW}" y2="${r2(axisY)}" stroke="var(--border)" opacity="0.9"/>`,
    );
  }
  points.forEach((p) => {
    const s = spec.series[p.series];
    const col = seriesColor(spec.series, p.series);
    const pr = s ? seriesPointRadius(s, 4) : 4;
    const op = s ? seriesFillOpacity(s, opacityOf(p.series)) : opacityOf(p.series);
    const tip = tipAttrs(`x = ${formatNumber(p.x)}`, s?.name ?? null, printed(p.y, spec.unit), col);
    parts.push(
      `<circle cx="${r2(xpx(p.x))}" cy="${r2(ypx(p.y))}" r="${r2(Math.max(1.5, pr))}" fill="${col}" fill-opacity="${r2(op)}" stroke="var(--background)" stroke-width="1.5"${tip}/>`,
    );
    if (spec.showValues && points.length <= 24) {
      parts.push(
        `<text x="${r2(xpx(p.x) + 7)}" y="${r2(ypx(p.y) - 6)}" text-anchor="start" font-size="10" fill="var(--foreground)">${esc(printed(p.y, spec.unit))}</text>`,
      );
    }
  });
  parts.push(xLabelSvg(spec, f));
  parts.push(yLabelSvg(spec, f));
  return svg(parts.join(""), f.width, f.height, spec.title);
}

function axisSvg(spec: ChartSpecInfo): string {
  if (spec.type === "bar" && spec.orientation === "horizontal") return hbarSvg(spec);
  if (spec.type === "scatter") return scatterSvg(spec);
  return lineOrBarSvg(spec);
}

// ---------------------------------------------------------------------------
// Radial and step charts

function angleLabel(lx: number, ly: number, axis: number, count: number, text: string): string {
  const angle = (axis / count) * Math.PI * 2;
  const sx = Math.sin(angle);
  const csy = -Math.cos(angle);
  const anchor = Math.abs(sx) < 0.35 ? "middle" : sx > 0 ? "start" : "end";
  const dy = csy < -0.5 ? 0 : csy > 0.5 ? 10 : 4;
  return `<text x="${r2(lx)}" y="${r2(ly + dy)}" text-anchor="${anchor}" font-size="11" fill="var(--muted-foreground)">${xTickText(text)}</text>`;
}

function radarSvg(spec: ChartSpecInfo): string {
  const width = chartWidth(spec);
  const height = chartHeight(spec);
  const count = spec.labels.length;
  if (count < 3) return noDataSvg(spec);
  const all = spec.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  if (all.length === 0) return noDataSvg(spec);
  const scale = scaleFor(all, true);
  const cx = width / 2;
  const cy = height / 2;
  const sidePad = width < 360 ? 52 : 76;
  const radius = Math.max(36, Math.min(height / 2 - 34, width / 2 - sidePad));

  const parts: string[] = [];
  for (const t of scale.ticks) {
    const ringPoints: string[] = [];
    for (let a = 0; a < count; a++) {
      const [px, py] = radarPoint(cx, cy, radius, a, count, t / scale.max);
      ringPoints.push(`${r2(px)},${r2(py)}`);
    }
    parts.push(
      `<polygon points="${ringPoints.join(" ")}" fill="none" stroke="var(--border)" opacity="${t === 0 ? "0.9" : "0.55"}"/>`,
    );
  }
  for (let a = 0; a < count; a++) {
    const [px, py] = radarPoint(cx, cy, radius, a, count, 1);
    parts.push(`<line x1="${cx}" y1="${cy}" x2="${r2(px)}" y2="${r2(py)}" stroke="var(--border)" opacity="0.7"/>`);
    const [lx, ly] = radarPoint(cx, cy, radius + 12, a, count, 1);
    parts.push(angleLabel(lx, ly, a, count, spec.labels[a] ?? ""));
  }
  spec.series.forEach((s, si) => {
    const col = seriesColor(spec.series, si);
    const sw = seriesStrokeWidth(s);
    const dash = seriesDash(s);
    const op = seriesFillOpacity(s, opacityOf(si) * 0.18);
    const pr = seriesPointRadius(s, 2.6);
    const polygon: string[] = [];
    s.values.forEach((v, a) => {
      const ratio = v === null ? 0 : Math.max(0, Math.min(1, v / scale.max));
      const [px, py] = radarPoint(cx, cy, radius, a, count, ratio);
      polygon.push(`${r2(px)},${r2(py)}`);
    });
    parts.push(
      `<polygon points="${polygon.join(" ")}" fill="${col}" fill-opacity="${r2(op)}" stroke="${col}" stroke-width="${r2(sw)}"${dashAttr(dash)} stroke-linejoin="round"/>`,
    );
    s.values.forEach((v, a) => {
      if (v === null || !Number.isFinite(v)) return;
      const [px, py] = radarPoint(cx, cy, radius, a, count, Math.max(0, Math.min(1, v / scale.max)));
      const tip = tipAttrs(spec.labels[a] ?? "", s.name, printed(v, spec.unit), col);
      if (pr > 0) {
        parts.push(`<circle cx="${r2(px)}" cy="${r2(py)}" r="${r2(pr)}" fill="${col}"${tip}/>`);
      } else if (spec.tooltip !== false) {
        parts.push(`<circle cx="${r2(px)}" cy="${r2(py)}" r="6" fill="transparent"${tip}/>`);
      }
    });
  });
  return svg(parts.join(""), width, height, spec.title);
}

function pieSvg(spec: ChartSpecInfo): string {
  const width = chartWidth(spec);
  const height = chartHeight(spec);
  const slices: readonly Slice[] = pieSlices(spec.labels, spec.series[0]?.values ?? [], 8);
  if (slices.length === 0) return noDataSvg(spec);
  const shares = percentages(slices.map((s) => s.value));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(38, Math.min(width / 2 - 16, height / 2 - 14));
  const inner = spec.donut ? radius * 0.58 : 0;

  const parts: string[] = [];
  let angle = -Math.PI / 2;
  slices.forEach((slice, i) => {
    const sharePct = shares[i] ?? 0;
    const share = sharePct / 100;
    if (share <= 0) return;
    const sweep = share * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const col = sliceColor(i);
    const tip = tipAttrs(slice.label, null, `${printed(slice.value, spec.unit)} (${sharePct}%)`, col);
    if (share >= 0.999) {
      // A whole circle: an arc path degenerates, so draw a ring or disc.
      if (inner > 0) {
        const mid = (radius + inner) / 2;
        parts.push(
          `<circle cx="${cx}" cy="${cy}" r="${r2(mid)}" fill="none" stroke="${col}" stroke-width="${r2(radius - inner)}"${tip}/>`,
        );
      } else {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r2(radius)}" fill="${col}"${tip}/>`);
      }
      return;
    }
    const x0 = cx + radius * Math.cos(a0);
    const yy0 = cy + radius * Math.sin(a0);
    const x1 = cx + radius * Math.cos(a1);
    const yy1 = cy + radius * Math.sin(a1);
    const large = sweep > Math.PI ? 1 : 0;
    if (inner > 0) {
      const ix1 = cx + inner * Math.cos(a1);
      const iy1 = cy + inner * Math.sin(a1);
      const ix0 = cx + inner * Math.cos(a0);
      const iy0 = cy + inner * Math.sin(a0);
      parts.push(
        `<path d="M${r2(x0)},${r2(yy0)}A${r2(radius)},${r2(radius)},0,${large},1,${r2(x1)},${r2(yy1)}L${r2(ix1)},${r2(iy1)}A${r2(inner)},${r2(inner)},0,${large},0,${r2(ix0)},${r2(iy0)}Z" fill="${col}" fill-opacity="${opacityOf(i)}" stroke="var(--card)" stroke-width="2" stroke-linejoin="round"${tip}/>`,
      );
    } else {
      parts.push(
        `<path d="M${r2(cx)},${r2(cy)}L${r2(x0)},${r2(yy0)}A${r2(radius)},${r2(radius)},0,${large},1,${r2(x1)},${r2(yy1)}Z" fill="${col}" fill-opacity="${opacityOf(i)}" stroke="var(--card)" stroke-width="2" stroke-linejoin="round"${tip}/>`,
      );
    }
  });
  if (spec.donut && spec.showValues) {
    const total = (spec.series[0]?.values ?? []).reduce<number>((sum, v) => sum + (v ?? 0), 0);
    parts.push(
      `<text x="${cx}" y="${r2(cy - 2)}" text-anchor="middle" font-size="15" font-weight="600" fill="var(--foreground)">${esc(printed(total, spec.unit))}</text>`,
      `<text x="${cx}" y="${r2(cy + 14)}" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">total</text>`,
    );
  }
  return svg(parts.join(""), width, height, spec.title);
}

function funnelSvg(spec: ChartSpecInfo): string {
  const width = chartWidth(spec);
  const height = chartHeight(spec);
  const stages: readonly FunnelStage[] = funnelStages(spec.labels, spec.series[0]?.values ?? []);
  if (stages.length === 0) return noDataSvg(spec);
  const pad = Math.min(120, Math.max(36, Math.round(width * 0.16)));
  const usable = width - pad * 2;
  const cx = width / 2;
  const stageH = (height - 16) / stages.length;
  const tone = spec.series[0]?.tone ?? "info";

  const parts: string[] = [];
  stages.forEach((stage, i) => {
    const previous = i === 0 ? stage.width : (stages[i - 1]?.width ?? stage.width);
    const y0 = 8 + stageH * i;
    const y1 = y0 + stageH;
    // The trapezoid flows from the previous stage's width into this one's.
    const pw = usable * Math.max(previous, stage.width);
    const cw = usable * stage.width;
    const col = TONE_VAR[tone];
    const shareText = i > 0 && stage.ofFirst !== null ? ` (${formatShare(stage.ofFirst)})` : "";
    const tip = tipAttrs(stage.label, null, `${printed(stage.value, spec.unit)}${shareText}`, col);
    parts.push(
      `<path d="M${r2(cx - pw / 2)},${r2(y0)}L${r2(cx - cw / 2)},${r2(y1)}L${r2(cx + cw / 2)},${r2(y1)}L${r2(cx + pw / 2)},${r2(y0)}Z" fill="${col}" fill-opacity="${r2(1 - (i / Math.max(1, stages.length - 1)) * 0.5)}" stroke="var(--card)" stroke-width="1.5"${tip}/>`,
    );
    if (stage.width > 0.18) {
      parts.push(
        `<text x="${cx}" y="${r2(y0 + stageH / 2 + (spec.showValues ? -2 : 4))}" text-anchor="middle" font-size="12" font-weight="600" fill="var(--foreground)" opacity="0.9">${esc(stage.label.slice(0, 24))}</text>`,
      );
      if (spec.showValues) {
        parts.push(
          `<text x="${cx}" y="${r2(y0 + stageH / 2 + 13)}" text-anchor="middle" font-size="10.5" fill="var(--foreground)" opacity="0.75">${esc(printed(stage.value, spec.unit))}</text>`,
        );
      }
    } else {
      parts.push(
        `<text x="${r2(cx - cw / 2 - 8)}" y="${r2(y0 + stageH / 2 + 4)}" text-anchor="end" font-size="11" fill="var(--foreground)">${esc(stage.label.slice(0, 18))}</text>`,
        `<text x="${r2(cx + cw / 2 + 8)}" y="${r2(y0 + stageH / 2 + 4)}" text-anchor="start" font-size="10.5" fill="var(--muted-foreground)">${esc(printed(stage.value, spec.unit))}</text>`,
      );
    }
    const share = stage.ofFirst;
    if (i > 0 && share !== null) {
      parts.push(
        `<text x="${r2(pad - 14)}" y="${r2(y0 + stageH / 2 + 4)}" text-anchor="end" font-size="10.5" fill="var(--muted-foreground)">${esc(formatShare(share))}</text>`,
      );
    }
  });
  return svg(parts.join(""), width, height, spec.title);
}

const HEAT_FILLS = [0.15, 0.35, 0.6, 0.85, 1];

function heatmapSvg(spec: ChartSpecInfo): string {
  const width = chartWidth(spec);
  const rows = spec.series.length;
  const cols = spec.labels.length;
  if (rows === 0 || cols === 0) return noDataSvg(spec);
  const nameW = Math.min(86, Math.max(52, Math.round(width * 0.24)));
  const cw = Math.min(56, Math.max(20, (width - nameW - 16) / cols));
  const ch = 30;
  const gap = 3;
  const headerH = 20;
  const H = headerH + rows * (ch + gap) + (spec.xLabel !== null ? 42 : 34);
  const maxVal = Math.max(
    0,
    ...spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v))),
  );

  const parts: string[] = [];
  spec.labels.forEach((l, ci) => {
    parts.push(
      `<text x="${r2(nameW + ci * (cw + gap) + cw / 2)}" y="12" text-anchor="middle" font-size="10" fill="var(--muted-foreground)">${esc(l.length > 7 ? `${l.slice(0, 6)}…` : l)}</text>`,
    );
  });
  spec.series.forEach((s, si) => {
    const ry = headerH + si * (ch + gap);
    parts.push(
      `<text x="${nameW - 6}" y="${r2(ry + ch / 2 + 4)}" text-anchor="end" font-size="11" fill="var(--muted-foreground)">${esc(s.name.length > 12 ? `${s.name.slice(0, 11)}…` : s.name)}</text>`,
    );
    s.values.forEach((v, ci) => {
      const cx = nameW + ci * (cw + gap);
      if (v === null || !Number.isFinite(v)) {
        parts.push(
          `<rect x="${r2(cx)}" y="${ry}" width="${r2(cw)}" height="${ch}" rx="4" fill="var(--muted)" opacity="0.5" stroke="var(--border)"/>`,
        );
        return;
      }
      const level = heatLevel(v, maxVal, 5);
      const strong = level >= 4;
      const tip = tipAttrs(spec.labels[ci] ?? "", s.name, printed(v, spec.unit), "var(--primary)");
      parts.push(
        `<rect x="${r2(cx)}" y="${ry}" width="${r2(cw)}" height="${ch}" rx="4" fill="${level === 0 ? "var(--muted)" : "var(--primary)"}" fill-opacity="${level === 0 ? 0.6 : HEAT_FILLS[level - 1]}" stroke="var(--border)" stroke-width="0.75"${tip}/>`,
      );
      if (spec.showValues) {
        parts.push(
          `<text x="${r2(cx + cw / 2)}" y="${r2(ry + ch / 2 + 3.5)}" text-anchor="middle" font-size="10.5" fill="${strong ? "var(--primary-foreground)" : "var(--foreground)"}">${esc(formatNumber(v))}</text>`,
        );
      }
    });
  });
  // Color scale legend under the grid.
  const legendY = headerH + rows * (ch + gap) + 20;
  parts.push(`<text x="${nameW - 6}" y="${legendY + 4}" text-anchor="end" font-size="10" fill="var(--muted-foreground)">0</text>`);
  HEAT_FILLS.forEach((op, i) => {
    parts.push(
      `<rect x="${r2(nameW + i * 26)}" y="${legendY - 5}" width="22" height="10" rx="2" fill="var(--primary)" fill-opacity="${op}"/>`,
    );
  });
  parts.push(
    `<text x="${r2(nameW + HEAT_FILLS.length * 26 + 8)}" y="${legendY + 4}" text-anchor="start" font-size="10" fill="var(--muted-foreground)">${esc(formatNumber(maxVal))}${spec.unit ? ` ${esc(spec.unit)}` : ""}</text>`,
  );
  if (spec.xLabel !== null) {
    parts.push(
      `<text x="${r2(nameW + (cols * (cw + gap)) / 2)}" y="${H - 4}" text-anchor="middle" font-size="10.5" fill="var(--muted-foreground)">${esc(spec.xLabel.slice(0, 60))}</text>`,
    );
  }
  return svg(parts.join(""), width, H, spec.title);
}

// ---------------------------------------------------------------------------

function seriesLegend(series: readonly ChartSeriesSpec[], forceShow?: boolean): string {
  if (forceShow === false) return "";
  if (forceShow !== true && series.length < 2) return "";
  const chips = series
    .map((s, i) => {
      const col = seriesColor(series, i);
      const dash = seriesDash(s);
      const swatch = dash
        ? `<span class="line-swatch" style="border-top-color:${col};opacity:${opacityOf(i)}"></span>`
        : `<span class="dot" style="background:${col};opacity:${opacityOf(i)}"></span>`;
      return `<span class="chip">${swatch}${esc(s.name)}</span>`;
    })
    .join("");
  return `<div class="g-legend">${chips}</div>`;
}

function pieLegend(spec: ChartSpecInfo): string {
  if (spec.showLegend === false) return "";
  const slices: readonly Slice[] = pieSlices(spec.labels, spec.series[0]?.values ?? [], 8);
  if (slices.length === 0) return "";
  const shares = percentages(slices.map((s) => s.value));
  const chips = slices
    .map((slice, i) => {
      const share = shares[i] ?? 0;
      const detail = spec.showValues
        ? `${esc(printed(slice.value, spec.unit))} (${share}%)`
        : `${share}%`;
      return `<span class="chip"><span class="dot" style="background:${sliceColor(i)};opacity:${opacityOf(i)}"></span>${esc(slice.label)} · ${detail}</span>`;
    })
    .join("");
  return `<div class="g-legend">${chips}</div>`;
}

/** One chart, drawn as SVG in the sandboxed iframe on web/desktop. */
export function buildChartHtml(spec: ChartSpecInfo): string {
  const body =
    spec.type === "pie"
      ? pieSvg(spec)
      : spec.type === "funnel"
        ? funnelSvg(spec)
        : spec.type === "radar"
          ? radarSvg(spec)
          : spec.type === "heatmap"
            ? heatmapSvg(spec)
            : axisSvg(spec);
  const legend =
    spec.type === "pie"
      ? pieLegend(spec)
      : spec.type === "funnel" || spec.type === "heatmap"
        ? ""
        : seriesLegend(spec.series, spec.showLegend);
  // The title sits in HTML above the plot so it wraps and stays legible; the SVG keeps the same height.
  const title = spec.title === null ? "" : `<div class="g-title">${esc(spec.title)}</div>`;
  const tooltip = spec.tooltip === false ? "" : `<div class="g-tip" id="g-tip" aria-hidden="true"></div><script>${TOOLTIP_SCRIPT}</script>`;
  return `<div class="g-chart"><style>${CHART_CSS}</style>${title}${body}${legend}${tooltip}</div>`;
}
