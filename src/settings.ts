import { normalizePath } from "obsidian";
import path from "path";

export type SyncMode = "upsert-only" | "managed-cleanup" | "full-mirror";

export interface PropertyFilter {
  key: string;
  value: string;
}

export interface ValueMapping {
  source: string;
  target: string;
}

export interface PublishToAstroSettings {
  astroSiteRoot: string;
  sourceFolders: string[];
  propertyFilters: PropertyFilter[];
  tagFilters: string[];
  categoryField: string;
  categoryMappings: ValueMapping[];
  publishStatusField: string;
  publishStatusValue: string;
  postOutputDir: string;
  assetOutputDir: string;
  syncMode: SyncMode;
}

export const DEFAULT_SETTINGS: PublishToAstroSettings = {
  astroSiteRoot: "",
  sourceFolders: ["posts"],
  propertyFilters: [],
  tagFilters: [],
  categoryField: "categories",
  categoryMappings: [
    { source: "Posts", target: "post" },
    { source: "Notes", target: "note" },
    { source: "Projects", target: "project" },
    { source: "BookNotes", target: "booknote" },
    { source: "Clippings", target: "clipping" }
  ],
  publishStatusField: "status",
  publishStatusValue: "published",
  postOutputDir: "src/data/blog/_obsidian",
  assetOutputDir: "public/uploads/obsidian",
  syncMode: "upsert-only"
};

function normalizeSystemPath(value: string): string {
  const trimmed = value.trim();
  return trimmed ? path.normalize(trimmed) : "";
}

function normalizeVaultRelativePath(value: string): string {
  const trimmed = value.trim();
  return trimmed ? normalizePath(trimmed) : "";
}

export function normalizeSettings(
  settings: Partial<PublishToAstroSettings> | undefined
): PublishToAstroSettings {
  const next = { ...DEFAULT_SETTINGS, ...settings };

  return {
    astroSiteRoot: normalizeSystemPath(next.astroSiteRoot),
    sourceFolders: next.sourceFolders.map(normalizeVaultRelativePath),
    propertyFilters: next.propertyFilters.map(filter => ({
      key: filter.key.trim(),
      value: filter.value.trim()
    })),
    tagFilters: next.tagFilters.map(tag => tag.trim()),
    categoryField: next.categoryField.trim() || DEFAULT_SETTINGS.categoryField,
    categoryMappings: next.categoryMappings.map(mapping => ({
      source: mapping.source.trim(),
      target: mapping.target.trim()
    })),
    publishStatusField: next.publishStatusField.trim() || DEFAULT_SETTINGS.publishStatusField,
    publishStatusValue:
      next.publishStatusValue.trim() || DEFAULT_SETTINGS.publishStatusValue,
    postOutputDir:
      normalizeVaultRelativePath(next.postOutputDir) || DEFAULT_SETTINGS.postOutputDir,
    assetOutputDir:
      normalizeVaultRelativePath(next.assetOutputDir) || DEFAULT_SETTINGS.assetOutputDir,
    syncMode: isSyncMode(next.syncMode) ? next.syncMode : DEFAULT_SETTINGS.syncMode
  };
}

export function isSyncMode(value: string): value is SyncMode {
  return value === "upsert-only";
}
