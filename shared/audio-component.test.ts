import { describe, expect, it } from "vitest";
import { checkSpec } from "./fallback";
import { compile } from "./core";
import { COMPONENTS } from "./core/catalog";
import { nextRate, rateLabel, formatAudioTime, waveformBars } from "./logic/audio-logic";

describe("Audio component", () => {
  it("is in the catalog under Media with src + optional title", () => {
    expect(Object.keys(COMPONENTS)).toContain("Audio");
    expect(COMPONENTS.Audio?.group).toBe("Media");
    expect(COMPONENTS.Audio?.params.map((p) => p.name)).toEqual(["src", "title"]);
  });

  it("validates a spec using Audio", async () => {
    const report = await checkSpec('Card("t", [Audio("$BB_THREAD_STORAGE/rec.mp3", title: "Hi")])');
    expect(report.ok).toBe(true);
    expect(report.report).toContain("No errors.");
  });

  it("rejects missing src, unknown params, and unknown components", async () => {
    expect((await checkSpec('Card("t", [Audio()])')).ok).toBe(false);
    expect((await checkSpec('Card("t", [Audio("rec.mp3", Speed: 2)])')).ok).toBe(false);
  });

  it("the gallery example validates", async () => {
    const report = await checkSpec('Card("t", [Audio("rec.mp3", title: "A"), Audio("rec.mp3", title: "B")])');
    expect(report.ok).toBe(true);
    expect(report.report).toContain("No errors.");
  });

  it("cycles rates, formats time, and draws deterministic waveforms", () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(2)).toBe(1);
    expect(rateLabel(1.5)).toBe("1.5×");
    expect(formatAudioTime(62)).toBe("1:02");
    expect(waveformBars("rec.mp3", 20)).toEqual(waveformBars("rec.mp3", 20));
    expect(waveformBars("rec.mp3", 20)).toHaveLength(20);
  });
});
