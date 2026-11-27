import { describe, expect, it } from "vitest";
import { AUDIO_RATES, formatAudioTime, nextRate, rateLabel, resamplePeaks, waveformBars } from "./audio-logic";

describe("nextRate", () => {
  it("cycles 1 → 1.5 → 2 → 1", () => {
    expect(nextRate(1)).toBe(1.5);
    expect(nextRate(1.5)).toBe(2);
    expect(nextRate(2)).toBe(1);
  });

  it("restarts at 1× for unknown rates", () => {
    expect(nextRate(3)).toBe(1);
    expect(nextRate(0)).toBe(1);
  });
});

describe("rateLabel", () => {
  it("labels known rates and resets unknown ones", () => {
    expect(rateLabel(1)).toBe("1×");
    expect(rateLabel(1.5)).toBe("1.5×");
    expect(rateLabel(2)).toBe("2×");
    expect(rateLabel(9)).toBe("1×");
  });
});

describe("formatAudioTime", () => {
  it("formats seconds as m:ss", () => {
    expect(formatAudioTime(0)).toBe("0:00");
    expect(formatAudioTime(4.2)).toBe("0:04");
    expect(formatAudioTime(62)).toBe("1:02");
    expect(formatAudioTime(754)).toBe("12:34");
  });

  it("reads invalid durations as 0:00", () => {
    expect(formatAudioTime(-1)).toBe("0:00");
    expect(formatAudioTime(Number.NaN)).toBe("0:00");
    expect(formatAudioTime(Infinity)).toBe("0:00");
  });
});

describe("waveformBars", () => {
  it("is deterministic for the same seed", () => {
    expect(waveformBars("recording.mp3", 30)).toEqual(waveformBars("recording.mp3", 30));
  });

  it("differs across seeds", () => {
    expect(waveformBars("a.mp3", 20)).not.toEqual(waveformBars("b.mp3", 20));
  });

  it("returns count bars within [0.15, 1]", () => {
    for (const bar of waveformBars("recording.mp3", 64)) {
      expect(bar).toBeGreaterThanOrEqual(0.15);
      expect(bar).toBeLessThanOrEqual(1);
    }
    expect(waveformBars("recording.mp3", 64)).toHaveLength(64);
  });

  it("handles empty seeds and counts", () => {
    expect(waveformBars("", 10)).toEqual([]);
    expect(waveformBars("x", 0)).toEqual([]);
    expect(waveformBars("x", -3)).toEqual([]);
  });

  it("exposes the rate ladder", () => {
    expect([...AUDIO_RATES]).toEqual([1, 1.5, 2]);
  });
});

describe("resamplePeaks", () => {
  const peaks = [0.1, 0.5, 0.9, 0.3, 0.7, 0.2, 0.6, 0.4];

  it("averages bands when shrinking", () => {
    const round = (bars: number[]) => bars.map((bar) => Math.round(bar * 1000) / 1000);
    expect(round(resamplePeaks(peaks, 2))).toEqual([0.45, 0.475]);
    expect(round(resamplePeaks(peaks, 4))).toEqual([0.3, 0.6, 0.45, 0.5]);
    expect(resamplePeaks(peaks, 4)).toHaveLength(4);
  });

  it("pads when stretching beyond the source resolution", () => {
    expect(resamplePeaks([0.5, 0.8], 4)).toEqual([0.5, 0.8, 0.8, 0.8]);
  });

  it("handles empty peaks and counts", () => {
    expect(resamplePeaks([], 5)).toEqual([]);
    expect(resamplePeaks(peaks, 0)).toEqual([]);
    expect(resamplePeaks(peaks, -1)).toEqual([]);
  });
});
