import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Image as RNImage, Pressable, StyleSheet, Text, View } from "react-native";
import { fitView, project, tileZoom, toScreen, visibleTiles, zoomAround } from "../../shared/logic/mapMath";
import { hotspotPoints, imageRef } from "../../shared/logic/references-model";
import { formatAudioTime, nextRate, rateLabel, resamplePeaks, waveformBars } from "../../shared/logic/audio-logic";
import { asRecord, finiteNumber, list, optionalText, text, type Props } from "../../shared/logic/values";
import { useGeocodePlace, useImageSearch, useMapTileLoader } from "../loaders";
import { ErrorLine } from "../node-renderer";
import { canPlayWebAudio, createWebAudioController, extractAudioPeaks, type WebAudioController, type WebAudioState } from "../web";
import { useUiRuntime, type ImageUrl } from "../runtime";
import { LoadedImageView } from "./content";
import { ImageLightbox } from "./image-lightbox";

export function ImageSearch({ props, zoomable = true }: { props: Props; zoomable?: boolean }) {
  const { theme } = useUiRuntime();
  const query = text(props.query);
  const alt = optionalText(props.alt) ?? query;
  const aspect = optionalText(props.aspect) ?? "wide";
  const found = useImageSearch(query);
  const height = aspect === "tall" ? 260 : aspect === "square" ? 220 : 180;

  if (!query.trim()) return <ErrorLine message="ImageSearch query is empty" />;
  if (found === null) {
    return (
      <View
        style={{
          height,
          borderRadius: 8,
          backgroundColor: theme.colors.surface2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Searching photo for “{query}”…
        </Text>
      </View>
    );
  }
  if (!found.ok) {
    return (
      <View
        style={{
          borderRadius: 8,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
          padding: 10,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{found.error}</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 4 }}>
      <LoadedImageView src={found.image.url} alt={alt} height={height} zoomable={zoomable} adaptive />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <ExternalLink href={found.image.sourceUrl}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {found.image.title}
          </Text>
        </ExternalLink>
        {found.image.creator || found.image.license ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            · {[found.image.creator, found.image.license].filter(Boolean).join(" · ")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function GalleryLightbox({
  item,
  onClose,
}: {
  item: { src?: string; query?: string; caption: string | null };
  onClose(): void;
}) {
  const { loadImage } = useUiRuntime();
  const found = useImageSearch(item.query ?? "");
  const [loaded, setLoaded] = useState<ImageUrl | null>(null);

  useEffect(() => {
    if (item.query || !item.src || !loadImage) return;
    let live = true;
    void loadImage(item.src).then((res) => {
      if (live) setLoaded(res);
    });
    return () => {
      live = false;
    };
  }, [item.query, item.src, loadImage]);

  const result = item.query ? (found === null ? null : found.ok ? { ok: true as const, url: found.image.url } : found) : loaded;
  const failed = result !== null && !result.ok;
  // The tile already shows why the image failed, so a failed lookup just closes.
  useEffect(() => {
    if (failed) onClose();
  }, [failed, onClose]);

  if (result === null || !result.ok) return null;
  return <ImageLightbox uri={result.url} title={item.caption ?? item.query ?? item.src ?? "Image"} onClose={onClose} />;
}

export function Gallery({ props }: { props: Props }) {
  const { theme, compact } = useUiRuntime();
  const rawItems = list(props.images);
  const cols = compact ? 1 : Math.max(1, Math.min(4, finiteNumber(props.columns) ?? 2));
  const [selected, setSelected] = useState<{ src?: string; query?: string; caption: string | null } | null>(
    null,
  );

  const items = rawItems.map((item) => {
    if (typeof item === "string") return { src: item, query: undefined, caption: null };
    const rec = asRecord(item);
    if (rec) {
      return {
        src: optionalText(rec.src) ?? undefined,
        query: optionalText(rec.query) ?? undefined,
        caption: optionalText(rec.caption),
      };
    }
    return { src: undefined, query: undefined, caption: null };
  });

  const rows: (typeof items)[] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));

  return (
    <View style={{ gap: 8 }}>
      {rows.map((row, rIdx) => (
        <View key={rIdx} style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
          {row.map((item, cIdx) => (
            <Pressable
              key={cIdx}
              onPress={() => setSelected(item)}
              style={{
                flex: 1,
                borderRadius: 8,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
                padding: 8,
                gap: 4,
              }}
            >
              {item.query ? (
                <ImageSearch props={{ query: item.query, alt: item.caption ?? item.query }} zoomable={false} />
              ) : item.src ? (
                <LoadedImageView src={item.src} alt={item.caption} height={150} zoomable={false} />
              ) : null}
            </Pressable>
          ))}
        </View>
      ))}
      {selected ? <GalleryLightbox item={selected} onClose={() => setSelected(null)} /> : null}
    </View>
  );
}

interface PlaceSpec {
  name: string;
  lat: number | null;
  lng: number | null;
  note: string | null;
}

export function MapView({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const geocode = useGeocodePlace();
  const loadTile = useMapTileLoader();
  const route = props.route === true;

  const places: PlaceSpec[] = useMemo(
    () =>
      list(props.places).flatMap((item): PlaceSpec[] => {
        if (typeof item === "string") return [{ name: item, lat: null, lng: null, note: null }];
        const rec = asRecord(item);
        if (!rec) return [];
        const name = text(rec.name ?? rec.title);
        if (!name) return [];
        return [
          {
            name,
            lat: finiteNumber(rec.lat),
            lng: finiteNumber(rec.lng),
            note: optionalText(rec.note),
          },
        ];
      }),
    [props.places],
  );

  const [resolved, setResolved] = useState<
    ReadonlyArray<{ name: string; lat: number; lng: number; note: string | null }>
  >([]);
  const [geoError, setGeoError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    async function run() {
      const out: { name: string; lat: number; lng: number; note: string | null }[] = [];
      let near: { lat: number; lng: number } | null = null;
      for (const place of places) {
        if (place.lat !== null && place.lng !== null) {
          near = { lat: place.lat, lng: place.lng };
          out.push({ name: place.name, lat: place.lat, lng: place.lng, note: place.note });
        } else {
          const found = await geocode(place.name, near);
          if (!live) return;
          if (found.ok) {
            near = { lat: found.lat, lng: found.lng };
            out.push({ name: place.name, lat: found.lat, lng: found.lng, note: place.note });
          } else {
            setGeoError(found.error);
          }
        }
      }
      if (live) setResolved(out);
    }
    void run();
    return () => {
      live = false;
    };
  }, [geocode, places]);

  const mapSize = { width: 520, height: 220 };
  const worldPoints = useMemo(() => resolved.map((p) => project(p.lat, p.lng)), [resolved]);
  const fitted = useMemo(() => fitView(worldPoints, mapSize, 36, 15), [worldPoints]);
  const [zoomDelta, setZoomDelta] = useState(0);
  const view = useMemo(
    () => zoomAround(fitted, fitted.zoom + zoomDelta, { left: mapSize.width / 2, top: mapSize.height / 2 }, mapSize),
    [fitted, zoomDelta],
  );
  const tiles = useMemo(() => visibleTiles(view, mapSize, tileZoom(view)), [view]);
  const [tileData, setTileData] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let live = true;
    for (const tile of tiles) {
      const k = `${tile.z}/${tile.x}/${tile.y}`;
      if (tileData.has(k)) continue;
      void loadTile(tile.z, tile.x, tile.y).then((res) => {
        if (live && res.ok) {
          setTileData((prev) => new Map(prev).set(k, res.dataUrl));
        }
      });
    }
    return () => {
      live = false;
    };
  }, [loadTile, tiles, tileData]);

  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
        gap: 8,
      }}
    >
      {resolved.length > 0 ? (
        <View style={{ width: "100%", height: mapSize.height, backgroundColor: theme.colors.surface1, overflow: "hidden" }}>
          {tiles.map((tile) => {
            const uri = tileData.get(`${tile.z}/${tile.x}/${tile.y}`);
            return uri ? (
              <RNImage
                key={tile.key}
                source={{ uri }}
                style={{
                  position: "absolute",
                  left: tile.left,
                  top: tile.top,
                  width: tile.size,
                  height: tile.size,
                }}
              />
            ) : null;
          })}
          {resolved.map((place, idx) => {
            const pt = toScreen(project(place.lat, place.lng), view, mapSize);
            return (
              <View
                key={`${place.name}:${idx}`}
                style={{
                  position: "absolute",
                  left: pt.left - 11,
                  top: pt.top - 11,
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: theme.colors.accent,
                  borderWidth: 2,
                  borderColor: theme.colors.surface0,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700" }}>
                  {idx + 1}
                </Text>
              </View>
            );
          })}
          <View style={{ position: "absolute", right: 8, top: 8, gap: 4 }}>
            <Pressable
              onPress={() => setZoomDelta((d) => d + 1)}
              style={{
                width: 26,
                height: 26,
                borderRadius: 6,
                backgroundColor: theme.colors.surface0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700" }}>+</Text>
            </Pressable>
            <Pressable
              onPress={() => setZoomDelta((d) => d - 1)}
              style={{
                width: 26,
                height: 26,
                borderRadius: 6,
                backgroundColor: theme.colors.surface0,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "700" }}>−</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      <View style={{ padding: 10, gap: 6 }}>
        {places.map((p, idx) => (
          <View key={`${p.name}:${idx}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                backgroundColor: theme.colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: theme.colors.accentForeground, fontSize: 10.5, fontWeight: "700" }}>
                {idx + 1}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
                {p.name}
                {route && idx < places.length - 1 ? " →" : ""}
              </Text>
              {p.note ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>{p.note}</Text>
              ) : null}
            </View>
          </View>
        ))}
        {geoError ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{geoError}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function Hotspots({ props }: { props: Props }) {
  const { theme } = useUiRuntime();
  const img = imageRef(text(props.image));
  const { points, problems } = hotspotPoints(list(props.points));
  const [active, setActive] = useState<number>(points[0]?.number ?? 1);

  return (
    <View style={{ gap: 8 }}>
      {img.kind === "load" ? <LoadedImageView src={img.src} height={220} /> : null}
      <View style={{ gap: 6 }}>
        {points.map((pt) => {
          const isSelected = active === pt.number;
          return (
            <Pressable
              key={pt.number}
              onPress={() => setActive(pt.number)}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 8,
                padding: 8,
                borderRadius: 8,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  backgroundColor: isSelected ? theme.colors.accent : theme.colors.surface1,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: isSelected ? theme.colors.accentForeground : theme.colors.foreground,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {pt.number}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
                  {pt.title}
                </Text>
                {pt.text ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{pt.text}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        {problems.map((p, i) => (
          <ErrorLine key={i} message={p} />
        ))}
      </View>
    </View>
  );
}

const AUDIO_BAR_HEIGHT = 26;
const AUDIO_RATES_NOTE = "Scrub & vitesse : desktop uniquement";
/** Peaks are decoded once per file, at a higher resolution than any bar count. */
const PEAK_BUCKETS = 200;
const PEAK_CACHE = new Map<string, number[] | null>();

function rememberPeaks(url: string, peaks: number[] | null): void {
  PEAK_CACHE.delete(url);
  PEAK_CACHE.set(url, peaks);
  if (PEAK_CACHE.size > 32) {
    const oldest = PEAK_CACHE.keys().next().value;
    if (oldest !== undefined) PEAK_CACHE.delete(oldest);
  }
}

/**
 * The bars to draw: the file's real decoded waveform once it is available,
 * the seeded pseudo-waveform until then (and on native, where decoding is not
 * possible).
 */
function useAudioBars(url: string, count: number, fallback: readonly number[]): readonly number[] {
  const [peaks, setPeaks] = useState<number[] | null>(() => PEAK_CACHE.get(url) ?? null);
  useEffect(() => {
    if (!canPlayWebAudio()) return;
    const cached = PEAK_CACHE.get(url);
    if (cached !== undefined) {
      setPeaks(cached);
      return;
    }
    let live = true;
    setPeaks(null);
    void extractAudioPeaks(url, PEAK_BUCKETS).then((decoded) => {
      const value = decoded !== null && decoded.length > 8 ? decoded : null;
      rememberPeaks(url, value);
      if (live) setPeaks(value);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return peaks === null ? fallback : resamplePeaks(peaks, count);
}

interface AudioSnapshot {
  readonly playing: boolean;
  readonly time: number;
  readonly duration: number;
}

function useWebAudio(url: string, enabled: boolean): { snapshot: AudioSnapshot; controller: WebAudioController | null } {
  const [snapshot, setSnapshot] = useState<AudioSnapshot>({ playing: false, time: 0, duration: 0 });
  const [controller, setController] = useState<WebAudioController | null>(null);
  useEffect(() => {
    if (!enabled || !canPlayWebAudio()) return;
    let created: WebAudioController | null = null;
    const sync = () => {
      if (created !== null) setSnapshot(created.read());
    };
    created = createWebAudioController(url, sync);
    if (created === null) return;
    setController(created);
    setSnapshot(created.read());
    return () => created?.destroy();
  }, [url, enabled]);
  return { snapshot, controller };
}

function AudioWaveform({
  bars,
  ratio,
  seekable,
  onSeekRatio,
  theme,
}: {
  bars: readonly number[];
  ratio: number;
  seekable: boolean;
  onSeekRatio: ((ratio: number) => void) | null;
  theme: PluginTheme;
}) {
  const [width, setWidth] = useState(0);
  const seekTo = (event: { nativeEvent: { locationX: number } }) => {
    if (onSeekRatio === null || width <= 0) return;
    onSeekRatio(Math.min(1, Math.max(0, event.nativeEvent.locationX / width)));
  };
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={onSeekRatio === null ? undefined : () => true}
      onMoveShouldSetResponder={onSeekRatio === null ? undefined : () => true}
      onResponderGrant={onSeekRatio === null ? undefined : seekTo}
      onResponderMove={onSeekRatio === null ? undefined : seekTo}
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        columnGap: 2,
        height: AUDIO_BAR_HEIGHT,
        opacity: seekable ? 1 : 0.8,
      }}
    >
      {bars.map((bar, index) => {
        const played = index < Math.floor(ratio * bars.length);
        return (
          <View
            key={index}
            style={{
              flex: 1,
              minWidth: 2,
              height: Math.max(5, bar * AUDIO_BAR_HEIGHT),
              minHeight: 5,
              borderRadius: 2,
              backgroundColor: played ? theme.colors.accent : theme.colors.border,
            }}
          />
        );
      })}
    </View>
  );
}

function AudioBubble({
  src,
  title,
  url,
  rich,
}: {
  src: string;
  title: string | null;
  url: string;
  rich: boolean;
}) {
  const { theme, compact, playAudio } = useUiRuntime();
  const { snapshot, controller } = useWebAudio(url, rich);
  const [rate, setRate] = useState(1);
  const [hostPlaying, setHostPlaying] = useState(false);
  const barCount = compact ? 26 : 40;
  const fallbackBars = useMemo(() => waveformBars(src, barCount), [src, barCount]);
  const bars = useAudioBars(url, barCount, fallbackBars);

  useEffect(() => {
    controller?.setRate(rate);
  }, [controller, rate]);

  const playing = rich ? snapshot.playing : hostPlaying;
  const duration = snapshot.duration;
  const ratio = duration > 0 ? Math.min(1, snapshot.time / duration) : 0;

  const toggle = () => {
    if (rich) {
      if (snapshot.playing) controller?.pause();
      else controller?.play();
      return;
    }
    if (hostPlaying || !playAudio) return;
    setHostPlaying(true);
    void playAudio(url)
      .catch(() => undefined)
      .finally(() => setHostPlaying(false));
  };

  const seekRatio =
    rich && controller !== null && duration > 0 ? (r: number) => controller.seek(r * duration) : null;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? "Pause" : "Play"}
        onPress={toggle}
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon
          name={playing ? "Pause" : "Play"}
          size={16}
          color={theme.colors.accentForeground}
        />
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        {title !== null ? (
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}
          >
            {title}
          </Text>
        ) : null}
        <AudioWaveform
          bars={bars}
          ratio={ratio}
          seekable={seekRatio !== null}
          onSeekRatio={seekRatio}
          theme={theme}
        />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
            {formatAudioTime(snapshot.time)} / {formatAudioTime(duration)}
          </Text>
          {rich ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Playback speed, currently ${rateLabel(rate)}`}
              onPress={() => setRate((current) => nextRate(current))}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 10,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>
                {rateLabel(rate)}
              </Text>
            </Pressable>
          ) : (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10.5 }}>
              {AUDIO_RATES_NOTE}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

export function AudioPlayer({ props }: { props: Props }) {
  const { theme, loadAudio } = useUiRuntime();
  const src = text(props.src);
  const title = optionalText(props.title);
  const [resolved, setResolved] = useState<ImageUrl | null>(null);

  useEffect(() => {
    if (!src.trim() || !loadAudio) return;
    let live = true;
    setResolved(null);
    void loadAudio(src).then((res) => {
      if (live) setResolved(res);
    });
    return () => {
      live = false;
    };
  }, [src, loadAudio]);

  if (!src.trim()) return <ErrorLine message="Audio src is empty" />;
  if (!loadAudio) return <ErrorLine message="Audio cannot load on this host" />;
  if (resolved === null) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderRadius: 18,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Loading audio…</Text>
      </View>
    );
  }
  if (!resolved.ok) return <ErrorLine message={resolved.error} />;

  return <AudioBubble src={src} title={title} url={resolved.url} rich={canPlayWebAudio()} />;
}
