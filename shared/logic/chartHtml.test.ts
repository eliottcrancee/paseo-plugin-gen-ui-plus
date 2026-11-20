import { describe, expect, it } from "vitest";
import {
  buildChartHtml,
  CHART_TYPES,
  normalizeLineDash,
  wheelTone,
  type ChartSeriesSpec,
  type ChartSpecInfo,
  type ChartType,
} from "./chartHtml";

function line(name: string, values: (number | null)[], extra: Partial<ChartSeriesSpec> = {}): ChartSeriesSpec {
  return { name, tone: "info", dashed: false, values, ...extra };
}

function spec(over: Partial<ChartSpecInfo> = {}): ChartSpecInfo {
  return {
    type: "bar",
    labels: ["Mon", "Tue", "Wed"],
    series: [line("Web", [3, 5, 2])],
    unit: "",
    title: null,
    xLabel: null,
    yLabel: null,
    stacked: false,
    donut: false,
    smooth: false,
    height: 260,
    showValues: false,
    orientation: "vertical",
    ...over,
  };
}

const CASES: Record<ChartType, ChartSpecInfo> = {
  bar: spec(),
  line: spec({ type: "line", series: [line("A", [3, 5, 2]), line("B", [1, 2, 4])] }),
  area: spec({ type: "area", smooth: true, series: [line("A", [3, 5, 2])] }),
  pie: spec({ type: "pie", series: [line("A", [3, 5, 2])], showValues: true }),
  scatter: spec({ type: "scatter", labels: ["1", "2", "3"], series: [line("A", [10, 12, 14])] }),
  radar: spec({ type: "radar", labels: ["Speed", "Weight", "Price", "Ports"], series: [line("Air", [3, 5, 2, 4])] }),
  funnel: spec({ type: "funnel", labels: ["Visit", "Trial", "Paid"], series: [line("A", [100, 40, 12])] }),
  heatmap: spec({
    type: "heatmap",
    labels: ["am", "pm"],
    series: [line("Mon", [1, null]), line("Tue", [0, 3])],
  }),
};

describe("chart html", () => {
  it("draws every chart type as one complete svg", () => {
    for (const type of CHART_TYPES) {
      const html = buildChartHtml(CASES[type]);
      expect(html, type).toContain("<svg");
      expect(html, type).toContain("</svg>");
      // A half-computed coordinate lands in the markup as one of these and the chart disappears.
      expect(html, type).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it("escapes labels instead of writing markup", () => {
    const html = buildChartHtml(spec({ labels: ['a<b', 'x"y', "c&d"] }));
    expect(html).toContain("a&lt;b");
    expect(html).toContain("x&quot;y");
    expect(html).toContain("c&amp;d");
    expect(html).not.toContain("<b");
  });

  it("draws a bar for each sign of the value", () => {
    const html = buildChartHtml(spec({ labels: ["Q1", "Q2"], series: [line("Net", [-4, 6])] }));
    const rects = html.match(/<rect /g) ?? [];
    expect(rects).toHaveLength(2);
    // The negative bar hangs below the zero line, not collapsed to a 2px stub at it.
    const heights = [...html.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(heights.every((height) => height > 2)).toBe(true);
  });

  it("stacks segments instead of drawing them side by side", () => {
    const html = buildChartHtml(
      spec({ labels: ["Mon"], stacked: true, series: [line("Web", [3]), line("Mobile", [5])] }),
    );
    const rects = [...html.matchAll(/<rect x="([\d.-]+)"[^>]*y="([\d.-]+)"[^>]*height="([\d.]+)"/g)];
    expect(rects).toHaveLength(2);
    // Same column, one piece on top of the other.
    expect(rects[0]![1]).toBe(rects[1]![1]);
    const tops = rects.map((m) => Number(m[2]));
    const occupied = rects.reduce((sum, m) => sum + Number(m[3]), 0);
    expect(Math.min(...tops)).toBeLessThan(Math.max(...tops));
    expect(occupied).toBeGreaterThan(0);
  });

  it("dashes a series only when asked", () => {
    const dashed = buildChartHtml(spec({ type: "line", series: [line("A", [1, 2, 3], { dashed: true })] }));
    expect(dashed).toContain('stroke-dasharray="5 4"');
    const solid = buildChartHtml(spec({ type: "line", series: [line("A", [1, 2, 3])] }));
    expect(solid).not.toContain("stroke-dasharray");
  });

  it("smoothes a line into curves", () => {
    const smooth = buildChartHtml(spec({ type: "line", smooth: true, series: [line("A", [1, 4, 2, 5])] }));
    expect(smooth).toMatch(/<path d="M[\d.,]+C/);
    const straight = buildChartHtml(spec({ type: "line", series: [line("A", [1, 4, 2, 5])] }));
    expect(straight).not.toMatch(/<path d="M[\d.,]+C/);
  });

  it("writes the title and both axis labels, with the unit as the y label by default", () => {
    const html = buildChartHtml(spec({ title: "Weekly PRs", xLabel: "Weekday", yLabel: "Pull requests" }));
    expect(html).toContain('<div class="g-title">Weekly PRs</div>');
    expect(html).toContain("Weekday");
    expect(html).toContain("Pull requests");
  });

  it("prints the total in the middle of a donut", () => {
    const html = buildChartHtml(
      spec({ type: "pie", donut: true, showValues: true, unit: "tok", series: [line("A", [60, 40])] }),
    );
    expect(html).toContain("100 tok");
    expect(html).toContain("total");
  });

  it("lays a horizontal bar chart out as rows with the labels on the left", () => {
    const html = buildChartHtml(
      spec({ orientation: "horizontal", labels: ["Visits", "Paid"], series: [line("A", [100, 20])], showValues: true }),
    );
    expect(html).toContain(">Visits<");
    expect(html).toContain("100");
    // The row labels anchor to the same right edge, left of every bar.
    const labelXs = [...html.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end" font-size="11.5"/g)].map((m) =>
      Number(m[1]),
    );
    const barXs = [...html.matchAll(/<rect x="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(labelXs).toHaveLength(2);
    expect(new Set(labelXs).size).toBe(1);
    expect(Math.max(...labelXs)).toBeLessThan(Math.min(...barXs));
  });

  it("keeps percentages adding up to 100 across the pie legend", () => {
    const html = buildChartHtml(spec({ type: "pie", labels: ["a", "b", "c"], series: [line("A", [1, 1, 1])] }));
    const shares = [...html.matchAll(/· (\d+)%/g)].map((m) => Number(m[1]));
    expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100);
  });

  it("says so when there is nothing to draw", () => {
    expect(buildChartHtml(spec({ labels: [] }))).toContain("No data");
  });

  it("paints each series with the tone it carries", () => {
    const html = buildChartHtml(
      spec({ type: "line", series: [line("A", [1, 2, 3]), line("B", [3, 2, 1], { tone: "warn" })] }),
    );
    expect(html).toContain('stroke="var(--primary)"');
    expect(html).toContain('stroke="var(--warning)"');
    // The legend agrees with the strokes.
    expect(html).toContain("background:var(--warning)");
  });

  it("wraps the colour wheel so every series stays in the theme", () => {
    expect(wheelTone(5)).toBe(wheelTone(0));
    expect(wheelTone(-1)).toBe(wheelTone(4));
  });

  it("scales stacked horizontal bars by their sum so bars stay inside the viewBox", () => {
    const html = buildChartHtml(
      spec({
        orientation: "horizontal",
        stacked: true,
        labels: ["Authentication", "Database Queries"],
        series: [line("Read", [60, 40]), line("Write", [60, 80])],
      }),
    );
    const rects = [...html.matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
    expect(rects).toHaveLength(4);
    for (const m of rects) {
      const rightEdge = Number(m[1]) + Number(m[2]);
      expect(rightEdge).toBeLessThanOrEqual(720);
    }
    // Long labels get a wider left margin so they aren't clipped at x=0.
    const labelXs = [...html.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end" font-size="11.5"/g)].map((m) =>
      Number(m[1]),
    );
    expect(labelXs[0]!).toBeGreaterThan(100);
  });

  it("reserves extra bottom space when x-axis labels rotate", () => {
    const rotated = buildChartHtml(
      spec({ labels: ["VeryLongCategoryA", "VeryLongCategoryB", "VeryLongCategoryC"], series: [line("A", [1, 2, 3])] }),
    );
    const short = buildChartHtml(spec({ labels: ["A", "B", "C"], series: [line("A", [1, 2, 3])] }));
    const rotatedBaseY = Number(/translate\([\d.]+,([\d.]+)\) rotate\(-30\)/.exec(rotated)?.[1] ?? 0);
    const shortBaseY = Number(/y="([\d.]+)" text-anchor="middle" font-size="10.5"/.exec(short)?.[1] ?? 0);
    expect(rotatedBaseY).toBeGreaterThan(0);
    expect(rotatedBaseY).toBeLessThan(shortBaseY);
  });

  it("emits hover tooltip markup and data-tip attributes by default, and omits script when tooltip is false", () => {
    const withTip = buildChartHtml(spec({ type: "line", unit: "ms", series: [line("P50", [10, 20, 30])] }));
    expect(withTip).toContain('id="g-tip"');
    expect(withTip).toContain('data-tip-title="Mon"');
    expect(withTip).toContain('data-tip-series="P50"');
    expect(withTip).toContain('data-tip-value="10 ms"');

    const noTip = buildChartHtml(spec({ type: "line", tooltip: false, series: [line("P50", [10, 20, 30])] }));
    expect(noTip).not.toContain('id="g-tip"');
    expect(noTip).not.toContain("<script>");
  });

  it("supports custom lineDash, strokeWidth, fillOpacity, pointRadius, showGrid, and showLegend", () => {
    expect(normalizeLineDash("dotted")).toBe("2 3");
    expect(normalizeLineDash("dashdot")).toBe("8 4 2 4");
    expect(normalizeLineDash([10, 4, 2, 4])).toBe("10 4 2 4");
    expect(normalizeLineDash("solid", true)).toBeNull();

    const html = buildChartHtml(
      spec({
        type: "area",
        showGrid: false,
        showLegend: true,
        series: [
          line("Forecast", [10, 20, 30], {
            lineDash: "8 4 2 4",
            strokeWidth: 3.5,
            fillOpacity: 0.3,
            pointRadius: 5,
          }),
        ],
      }),
    );
    expect(html).toContain('stroke-dasharray="8 4 2 4"');
    expect(html).toContain('stroke-width="3.5"');
    expect(html).toContain('fill-opacity="0.3"');
    expect(html).toContain('r="5"');
    expect(html).toContain("line-swatch");
    // No horizontal gridlines when showGrid is false.
    expect(html).not.toContain('<line x1=');
  });

  it("adapts the SVG viewBox to narrow side-by-side columns across all chart types", () => {
    for (const type of CHART_TYPES) {
      const html = buildChartHtml({ ...CASES[type], width: 260 });
      expect(html, type).toContain('viewBox="0 0 260 ');
      expect(html, type).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
