import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const genuiSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    autoInstructions: z.boolean().default(true),
    instructionMode: z.enum(["mcp", "full"]).default("mcp"),
    webLookups: z.boolean().default(true),
    extraFolders: z.string().default(""),
  }),
});

export function parseFolders(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((folder) => folder.trim())
    .filter((folder) => folder !== "");
}
