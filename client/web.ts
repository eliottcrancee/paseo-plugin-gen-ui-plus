import type { PluginTheme } from "@getpaseo/plugin";
import { Platform } from "react-native";

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface WebIframeElement {
  title: string;
  srcdoc: string;
  referrerPolicy: string;
  readonly contentWindow: unknown;
  readonly style: {
    width: string;
    height: string;
    border: string;
    display: string;
    borderRadius: string;
    backgroundColor: string;
  };
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface WebAudioElement {
  src: string;
  playbackRate: number;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  play(): unknown;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface WebAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

interface WebAudioContext {
  decodeAudioData(data: ArrayBuffer): Promise<WebAudioBuffer>;
}

interface WebFetchResponse {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface WebContainerElement {
  innerHTML: string;
  appendChild(child: WebIframeElement): void;
}

interface WebMessageEvent {
  readonly source: unknown;
  readonly data: unknown;
}

interface WebGlobal {
  readonly localStorage?: WebStorage;
  readonly document?: {
    createElement(tag: "iframe"): WebIframeElement;
    createElement(tag: "audio"): WebAudioElement;
  };
  readonly window?: {
    addEventListener(type: "message", listener: (event: WebMessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: WebMessageEvent) => void): void;
    readonly location?: { readonly pathname: string };
    readonly history?: { pushState(state: null, unused: string, url: string): void };
    dispatchEvent?(event: unknown): boolean;
  };
  readonly OfflineAudioContext?: new (
    channels: number,
    length: number,
    sampleRate: number,
  ) => WebAudioContext;
  readonly fetch?: (url: string) => Promise<WebFetchResponse>;
  readonly PopStateEvent?: new (type: "popstate") => unknown;
}

const memoryStore = new Map<string, string>();

function getWeb(): WebGlobal | null {
  if (Platform.OS !== "web") return null;
  return globalThis as unknown as WebGlobal;
}

export function readStorage(key: string): string | null {
  const web = getWeb();
  if (web?.localStorage) {
    try {
      return web.localStorage.getItem(key);
    } catch {
      // Fall back to memory store
    }
  }
  return memoryStore.get(key) ?? null;
}

export function writeStorage(key: string, value: string): void {
  memoryStore.set(key, value);
  const web = getWeb();
  if (web?.localStorage) {
    try {
      web.localStorage.setItem(key, value);
    } catch {
      // Ignore quota errors
    }
  }
}

export function canRenderWebIframe(): boolean {
  const web = getWeb();
  return Platform.OS === "web" && Boolean(web?.document && web?.window);
}

export interface WebAudioState {
  readonly playing: boolean;
  readonly time: number;
  readonly duration: number;
}

export interface WebAudioController {
  play(): void;
  pause(): void;
  /** Jump to an absolute position in seconds; clamped to the loaded duration. */
  seek(seconds: number): void;
  setRate(rate: number): void;
  read(): WebAudioState;
  destroy(): void;
}

/** True on web/desktop, where a real `<audio>` element can back the player. */
export function canPlayWebAudio(): boolean {
  return getWeb()?.document !== undefined;
}

const AUDIO_EVENTS = ["timeupdate", "ended", "loadedmetadata", "play", "pause"] as const;

/**
 * Builds a seekable, speed-adjustable player around an unattached `<audio>`
 * element. `onChange` fires on progress, metadata, and play/pause so the UI
 * can call `read()`; returns null on native, where the renderer falls back to
 * the host's play-only `client.playAudio`.
 */
export function createWebAudioController(url: string, onChange: () => void): WebAudioController | null {
  const web = getWeb();
  if (!web?.document) return null;
  let audio: WebAudioElement;
  try {
    audio = web.document.createElement("audio");
  } catch {
    return null;
  }
  audio.src = url;
  for (const event of AUDIO_EVENTS) audio.addEventListener(event, onChange);
  return {
    play() {
      void Promise.resolve(audio.play()).catch(() => onChange());
    },
    pause() {
      audio.pause();
    },
    seek(seconds) {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      audio.currentTime = Math.min(Math.max(seconds, 0), duration > 0 ? Math.max(0, duration - 0.05) : 0);
      onChange();
    },
    setRate(rate) {
      audio.playbackRate = rate;
    },
    read(): WebAudioState {
      return {
        playing: !audio.paused && !audio.ended,
        time: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      };
    },
    destroy() {
      try {
        audio.pause();
        for (const event of AUDIO_EVENTS) audio.removeEventListener(event, onChange);
      } catch {
        // The element is already gone.
      }
    },
  };
}

/**
 * Decodes a data-url audio file and reduces it to `buckets` RMS peaks,
 * normalized to [0.15, 1] for drawing a real waveform. Returns null on native
 * or when decoding fails (unsupported codec, truncated file), and the caller
 * falls back to the seeded pseudo-waveform. OfflineAudioContext avoids any
 * audio-device permission: it decodes without playing.
 */
export async function extractAudioPeaks(dataUrl: string, buckets: number): Promise<number[] | null> {
  const web = getWeb();
  const Ctor = web?.OfflineAudioContext;
  if (!Ctor || !web?.fetch || buckets <= 0) return null;
  try {
    const raw = await (await web.fetch(dataUrl)).arrayBuffer();
    const context = new Ctor(1, 1, 44100);
    const buffer = await context.decodeAudioData(raw);
    const channel = buffer.getChannelData(0);
    const size = Math.max(1, Math.floor(channel.length / buckets));
    const peaks: number[] = [];
    let loudest = 0.0001;
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = bucket * size;
      const end = Math.min(channel.length, start + size);
      let sum = 0;
      let count = 0;
      for (let index = start; index < end; index++) {
        const sample = channel[index];
        sum += sample * sample;
        count++;
      }
      const rms = Math.sqrt(sum / Math.max(1, count));
      peaks.push(rms);
      if (rms > loudest) loudest = rms;
    }
    return peaks.map((peak) => 0.15 + 0.85 * Math.min(1, peak / loudest));
  } catch {
    return null;
  }
}

const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const BASE_STYLES = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
html{color:var(--foreground);font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.5}
code,kbd,pre,samp{font-family:ui-monospace,monospace}
img,video,canvas{max-width:100%}
button,input,select,textarea{font:inherit;color:inherit;margin:0}
button{cursor:pointer;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--background);line-height:1.25}
input,select,textarea{padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--background)}`;

const BOOTSTRAP = `(function(){
var host=window.parent,last=-1;
function post(m){m.source="genui-app";host.postMessage(m,"*");}
function measure(){
var b=document.body,h=Math.ceil(b?b.getBoundingClientRect().height:document.documentElement.getBoundingClientRect().height);
if(h>0&&h!==last){last=h;post({type:"height",height:h});}
}
var ro=new ResizeObserver(measure);
ro.observe(document.documentElement);
document.addEventListener("DOMContentLoaded",function(){if(document.body)ro.observe(document.body);measure();});
addEventListener("load",measure);
addEventListener("error",function(e){post({type:"error",message:String(e.message||"Script error")});});
})();`;

export function themeVarsKey(theme: PluginTheme): string {
  const c = theme.colors;
  return [
    `--background:${c.surface0}`,
    `--card:${c.surface1}`,
    `--muted:${c.surface2}`,
    `--border:${c.border}`,
    `--foreground:${c.foreground}`,
    `--muted-foreground:${c.foregroundMuted}`,
    `--subtle-foreground:${c.foregroundMuted}`,
    `--primary:${c.accent}`,
    `--primary-foreground:${c.accentForeground}`,
    `--accent:${c.accent}`,
    `--success:${c.statusSuccess}`,
    `--warning:${c.statusWarning}`,
    `--destructive:${c.statusDanger}`,
  ].join(";");
}

function buildSrcdoc(html: string, theme: PluginTheme): string {
  const vars = themeVarsKey(theme);
  const doctype = "<!doctype html>";
  const metaCsp = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">';
  const metaVp = '<meta name="viewport" content="width=device-width,initial-scale=1">';
  const styleBase = "<style>" + BASE_STYLES + "</style>";
  const styleTheme = '<style id="genui-theme">:root{' + vars + "}</style>";
  const scriptBoot = "<script>" + BOOTSTRAP + "</script>";
  return [doctype, metaCsp, metaVp, styleBase, styleTheme, scriptBoot, html].join("\n");
}

export interface SandboxedIframeController {
  update(html: string, theme: PluginTheme, minHeight?: number): void;
  destroy(): void;
}

/**
 * Mounts a single persistent sandboxed iframe and only rewrites `srcdoc` when
 * the compiled document (HTML + theme CSS vars) actually changes. Avoids the
 * blank flash caused by destroying and recreating the iframe during streaming.
 */
export function createSandboxedIframeController(
  hostRef: unknown,
  options: {
    height: number;
    minHeight?: number;
    onHeight(height: number): void;
    onError(message: string): void;
  },
): SandboxedIframeController {
  const web = getWeb();
  if (!web?.document || !web.window || !hostRef || typeof hostRef !== "object") {
    return { update() {}, destroy() {} };
  }
  const container = hostRef as WebContainerElement;
  if (typeof container.appendChild !== "function") {
    return { update() {}, destroy() {} };
  }

  const iframe = web.document.createElement("iframe");
  iframe.title = "Interactive App";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.referrerPolicy = "no-referrer";
  iframe.style.width = "100%";
  iframe.style.height = `${options.height}px`;
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.borderRadius = "8px";
  iframe.style.backgroundColor = "transparent";

  container.innerHTML = "";
  container.appendChild(iframe);

  let lastSrcdoc = "";

  const onMessage = (event: WebMessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (typeof event.data !== "object" || event.data === null) return;
    const data = event.data as Record<string, unknown>;
    if (data.source !== "genui-app") return;
    if (data.type === "height" && typeof data.height === "number" && Number.isFinite(data.height)) {
      const floor = options.minHeight ?? 80;
      const clamped = Math.min(1400, Math.max(floor, Math.ceil(data.height)));
      iframe.style.height = `${clamped}px`;
      options.onHeight(clamped);
    } else if (data.type === "error" && typeof data.message === "string") {
      options.onError(data.message.slice(0, 500));
    }
  };

  web.window.addEventListener("message", onMessage);

  return {
    update(html: string, theme: PluginTheme, minHeight?: number) {
      const nextSrcdoc = buildSrcdoc(html, theme);
      if (nextSrcdoc === lastSrcdoc) return;
      lastSrcdoc = nextSrcdoc;
      if (minHeight !== undefined) {
        iframe.style.height = `${minHeight}px`;
      }
      iframe.srcdoc = nextSrcdoc;
    },
    destroy() {
      web.window?.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}

export function mountSandboxedAppIframe(
  hostRef: unknown,
  options: {
    html: string;
    theme: PluginTheme;
    height: number;
    onHeight(height: number): void;
    onError(message: string): void;
  },
): () => void {
  const controller = createSandboxedIframeController(hostRef, options);
  controller.update(options.html, options.theme, options.height);
  return () => controller.destroy();
}

/**
 * Opens an absolute file path in a file tab of the workspace on screen, the way the
 * host does for file links in chat. The plugin SDK has no call for it, so this goes
 * through the host's `?open=file:<base64url path>` route. Web and desktop only.
 */
export function openWorkspaceFile(path: string): boolean {
  const web = getWeb();
  const win = web?.window;
  if (!win?.location || !win.history || !win.dispatchEvent || !web?.PopStateEvent) return false;
  if (!path.startsWith("/")) return false;
  const match = /^\/h\/[^/]+\/workspace\/[^/]+/.exec(win.location.pathname);
  if (match === null) return false;
  const token = btoa(unescape(encodeURIComponent(path))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  win.history.pushState(null, "", `${match[0]}?open=${encodeURIComponent(`file:${token}`)}`);
  win.dispatchEvent(new web.PopStateEvent("popstate"));
  return true;
}
