import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { parseInline, parseMarkdown, type Block, type Inline } from "../shared/diagram/markdown";
import { buildMathHtml, latexToUnicode } from "../shared/logic/mathMl";
import { canRenderWebIframe, createSandboxedIframeController, themeVarsKey, type SandboxedIframeController } from "./web";

/** Renders a LaTeX expression as native MathML on web/desktop (inside a sandboxed iframe) or Unicode math on mobile. */
export function MathFormula({
  latex,
  theme,
  display = true,
}: {
  latex: string;
  theme: PluginTheme;
  display?: boolean;
}) {
  const webSupported = canRenderWebIframe();
  const containerRef = useRef<View | null>(null);
  const controllerRef = useRef<SandboxedIframeController | null>(null);
  const [height, setHeight] = useState(display ? 56 : 30);
  const html = useMemo(() => buildMathHtml(latex, display), [latex, display]);
  const themeKey = themeVarsKey(theme);

  useEffect(() => {
    if (!webSupported || !containerRef.current) return;
    const ctrl = createSandboxedIframeController(containerRef.current, {
      height: display ? 56 : 30,
      onHeight: (h) => setHeight(Math.max(28, h)),
      onError: () => {},
    });
    controllerRef.current = ctrl;
    return () => {
      ctrl.destroy();
      controllerRef.current = null;
    };
  }, [webSupported, display]);

  useEffect(() => {
    if (!webSupported) return;
    controllerRef.current?.update(html, theme);
  }, [webSupported, html, themeKey]);

  if (webSupported) {
    return (
      <View
        style={{
          borderRadius: 8,
          backgroundColor: display ? theme.colors.surface2 : "transparent",
          borderWidth: display ? StyleSheet.hairlineWidth : 0,
          borderColor: theme.colors.border,
          paddingHorizontal: display ? 8 : 0,
          paddingVertical: display ? 4 : 0,
          width: "100%",
        }}
      >
        <View ref={containerRef} style={{ width: "100%", minHeight: height }} />
      </View>
    );
  }

  return (
    <View
      style={{
        borderRadius: 8,
        borderWidth: display ? StyleSheet.hairlineWidth : 0,
        borderColor: theme.colors.border,
        backgroundColor: display ? theme.colors.surface2 : "transparent",
        paddingHorizontal: display ? 12 : 2,
        paddingVertical: display ? 8 : 0,
        alignItems: display ? "center" : "flex-start",
      }}
    >
      <Text
        selectable
        style={{
          color: theme.colors.foreground,
          fontSize: display ? 15 : 13.5,
          fontStyle: "italic",
          lineHeight: display ? 22 : 20,
        }}
      >
        {latexToUnicode(latex)}
      </Text>
    </View>
  );
}

export function MarkdownText({
  text,
  theme,
  compact = false,
  color,
}: {
  text: string;
  theme: PluginTheme;
  compact?: boolean;
  color?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={{ gap: compact ? 6 : 8 }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} theme={theme} color={color} />
      ))}
    </View>
  );
}

/** One line of inline Markdown (links, emphasis, code), nested inside a caller's styled Text. */
export function InlineMarkdown({ text, theme }: { text: string; theme: PluginTheme }) {
  const content = useMemo(() => parseInline(text), [text]);
  return <Spans content={content} theme={theme} />;
}

function BlockView({
  block,
  theme,
  color,
}: {
  block: Block;
  theme: PluginTheme;
  color?: string;
}) {
  const body = {
    color: color ?? theme.colors.foreground,
    fontSize: 13.5,
    lineHeight: 20,
  };

  if (block.kind === "rule") {
    return (
      <View
        style={{
          height: StyleSheet.hairlineWidth,
          backgroundColor: theme.colors.border,
          marginVertical: 4,
        }}
      />
    );
  }

  if (block.kind === "math") {
    return <MathFormula latex={block.text} theme={theme} display={true} />;
  }

  if (block.kind === "code") {
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
        <Text
          selectable
          style={{
            color: theme.colors.foreground,
            fontFamily: "monospace",
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          {block.text}
        </Text>
      </View>
    );
  }

  if (block.kind === "heading") {
    return (
      <Text
        selectable
        style={{
          ...body,
          fontSize: Math.max(14, 20 - block.level),
          fontWeight: "700",
        }}
      >
        <Spans content={block.content} theme={theme} />
      </Text>
    );
  }

  if (block.kind === "quote") {
    return (
      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: theme.colors.accent,
          paddingLeft: 10,
        }}
      >
        <Text selectable style={{ ...body, color: theme.colors.foregroundMuted }}>
          <Spans content={block.content} theme={theme} />
        </Text>
      </View>
    );
  }

  if (block.kind === "bullet" || block.kind === "ordered") {
    return (
      <View style={{ gap: 4 }}>
        {block.items.map((item, index) => (
          <View key={index} style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ ...body, color: theme.colors.foregroundMuted }}>
              {block.kind === "bullet" ? "•" : `${block.start + index}.`}
            </Text>
            <Text selectable style={{ ...body, flex: 1 }}>
              <Spans content={item} theme={theme} />
            </Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <Text selectable style={body}>
      <Spans content={block.content} theme={theme} />
    </Text>
  );
}

function Spans({ content, theme }: { content: Inline[]; theme: PluginTheme }) {
  return (
    <>
      {content.map((span, index) => {
        if (span.kind === "bold") {
          return (
            <Text key={index} style={{ fontWeight: "700" }}>
              {span.text}
            </Text>
          );
        }
        if (span.kind === "italic") {
          return (
            <Text key={index} style={{ fontStyle: "italic" }}>
              {span.text}
            </Text>
          );
        }
        if (span.kind === "math") {
          return (
            <Text
              key={index}
              style={{
                fontStyle: "italic",
                fontWeight: "500",
                color: theme.colors.foreground,
              }}
            >
              {latexToUnicode(span.text)}
            </Text>
          );
        }
        if (span.kind === "code") {
          return (
            <Text
              key={index}
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                color: theme.colors.accent,
                backgroundColor: theme.colors.surface2,
              }}
            >
              {span.text}
            </Text>
          );
        }
        if (span.kind === "link") {
          return (
            <Text
              key={index}
              accessibilityRole="link"
              onPress={() => void openExternalUrl(span.url)}
              style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
            >
              {span.text}
            </Text>
          );
        }
        return <Text key={index}>{span.text}</Text>;
      })}
    </>
  );
}
