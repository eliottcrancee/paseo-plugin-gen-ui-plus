// Pure helpers for the Audio voice-note player. No React, no platform APIs —
// the renderer owns playback; this only shapes what it draws.

/** Playback speeds the player cycles through, in order. */
export const AUDIO_RATES = [1, 1.5, 2] as const;

/** The next speed after `rate`, wrapping back to 1×. Unknown rates restart at 1×. */
export function nextRate(rate: number): number {
  const index = AUDIO_RATES.indexOf(rate as (typeof AUDIO_RATES)[number]);
  if (index === -1) return AUDIO_RATES[0];
  return AUDIO_RATES[(index + 1) % AUDIO_RATES.length];
}

/** The compact label of a speed, e.g. "1×" or "1.5×". */
export function rateLabel(rate: number): string {
  const known = AUDIO_RATES.includes(rate as (typeof AUDIO_RATES)[number]);
  return `${known ? rate : AUDIO_RATES[0]}×`;
}

/** "m:ss" for a position or duration in seconds; invalid input reads 0:00. */
export function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Deterministic pseudo-waveform for a source: heights in [0.15, 1] shaped by a
 * speech-like envelope, so the same audio always draws the same bars without
 * decoding it.
 */
export function waveformBars(seed: string, count: number): number[] {
  const bars: number[] = [];
  if (!seed || count <= 0) return bars;
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  state >>>= 0;
  for (let index = 0; index < count; index++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const noise = (state % 1000) / 1000;
    const envelope = 0.5 + 0.5 * Math.abs(Math.sin((index / count) * Math.PI * 6));
    bars.push(0.15 + 0.85 * Math.min(1, noise * (0.35 + 0.65 * envelope)));
  }
  return bars;
}

/**
 * Shrinks (or, roughly, stretches) high-resolution peaks — the real decoded
 * waveform — down to the number of bars on screen, by averaging each band.
 */
export function resamplePeaks(peaks: readonly number[], count: number): number[] {
  if (count <= 0 || peaks.length === 0) return [];
  if (peaks.length <= count) {
    const bars = peaks.slice();
    while (bars.length < count) bars.push(bars[bars.length - 1] ?? 0);
    return bars;
  }
  const bars: number[] = [];
  for (let bar = 0; bar < count; bar++) {
    const start = Math.floor((bar * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * peaks.length) / count));
    let sum = 0;
    for (let index = start; index < end; index++) sum += peaks[index] ?? 0;
    bars.push(sum / (end - start));
  }
  return bars;
}
