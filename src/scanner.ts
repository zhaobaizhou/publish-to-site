import {
  App,
  FrontMatterCache,
  TFile,
  getAllTags,
  normalizePath
} from "obsidian";
import {
  getPublishStateRecord,
  type PublishStateStore,
  type PublishSyncStatus
} from "./publish-state";
import type { PropertyFilter, PublishToAstroSettings } from "./settings";
import { resolveNoteSlug, type SlugSource } from "./slug";
import { prepareCandidateForPublish } from "./transform";

export interface CandidateIssue {
  level: "warning" | "error";
  message: string;
}

export interface NoteScanCandidate {
  file: TFile;
  path: string;
  title: string;
  slug: string;
  slugSource: SlugSource;
  tags: string[];
  publishFieldActual: string | null;
  folderMatched: boolean;
  propertyMatched: boolean;
  tagMatched: boolean;
  publishMatched: boolean;
  inScope: boolean;
  publishable: boolean;
  syncStatus: PublishSyncStatus;
  lastPublishedAt: string | null;
  hasChangesSincePublish: boolean;
  currentContentHash?: string;
  issues: CandidateIssue[];
}

export interface NoteScanResult {
  scannedCount: number;
  inScopeCount: number;
  publishableCount: number;
  collisionCount: number;
  syncedCount: number;
  changedCount: number;
  unpublishedCount: number;
  failedCount: number;
  candidates: NoteScanCandidate[];
  publishableCandidates: NoteScanCandidate[];
  blockedCandidates: NoteScanCandidate[];
  outOfScopeCandidates: NoteScanCandidate[];
}

const WIKI_LINK_PATTERN = /(?<!!)\[\[([^\]]+)\]\]/g;
const WIKI_EMBED_PATTERN = /!\[\[([^\]]+)\]\]/g;
const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp"
]);

export async function scanVaultNotes(
  app: App,
  settings: PublishToAstroSettings,
  publishState: PublishStateStore
): Promise<NoteScanResult> {
  const files = app.vault.getMarkdownFiles();
  const activeFolders = uniqueNonEmpty(settings.sourceFolders).map(normalizePath);
  const activePropertyFilters = settings.propertyFilters.filter(isCompletePropertyFilter);
  const activeTagFilters = uniqueNonEmpty(settings.tagFilters).map(normalizeTag);

  const candidates = files
    .map(file =>
      buildCandidate(app, file, {
        ...settings,
        sourceFolders: activeFolders,
        propertyFilters: activePropertyFilters,
        tagFilters: activeTagFilters
      })
    )
    .sort((left, right) => left.path.localeCompare(right.path));

  const collidingSlugs = findCollidingSlugs(
    candidates.filter(candidate => candidate.inScope && candidate.publishMatched)
  );

  candidates.forEach(candidate => {
    if (collidingSlugs.has(candidate.slug) && candidate.inScope && candidate.publishMatched) {
      candidate.issues.push({
        level: "error",
        message: `检测到 Slug 冲突：\"${candidate.slug}\"。`
      });
    }

    candidate.publishable =
      candidate.inScope &&
      candidate.publishMatched &&
      !candidate.issues.some(issue => issue.level === "error");
  });

  await Promise.all(
    candidates.map(async candidate => {
      await enrichCandidateMarkdownWarnings(app, candidate);
      await enrichCandidatePublishState(app, settings, publishState, candidate);
    })
  );

  const publishableCandidates = candidates.filter(candidate => candidate.publishable);
  const blockedCandidates = candidates.filter(
    candidate => candidate.inScope && !candidate.publishable
  );
  const outOfScopeCandidates = candidates.filter(candidate => !candidate.inScope);
  const inScopeCandidates = candidates.filter(candidate => candidate.inScope);

  return {
    scannedCount: files.length,
    inScopeCount: inScopeCandidates.length,
    publishableCount: publishableCandidates.length,
    collisionCount: collidingSlugs.size,
    syncedCount: inScopeCandidates.filter(candidate => candidate.syncStatus === "synced")
      .length,
    changedCount: inScopeCandidates.filter(candidate => candidate.syncStatus === "changed")
      .length,
    unpublishedCount: inScopeCandidates.filter(
      candidate => candidate.syncStatus === "unpublished"
    ).length,
    failedCount: inScopeCandidates.filter(candidate => candidate.syncStatus === "failed")
      .length,
    candidates,
    publishableCandidates,
    blockedCandidates,
    outOfScopeCandidates
  };
}

async function enrichCandidateMarkdownWarnings(
  app: App,
  candidate: NoteScanCandidate
): Promise<void> {
  if (!candidate.inScope) {
    return;
  }

  const content = await app.vault.cachedRead(candidate.file);

  if (hasWikiLinks(content)) {
    candidate.issues.push({
      level: "warning",
      message:
        "正文包含 Obsidian 内链 [[...]]。当前版本会原样保留，发布到 Astro 后可能不是可点击站内链接。"
    });
  }

  if (hasNonImageWikiEmbeds(app, candidate.file, content)) {
    candidate.issues.push({
      level: "warning",
      message:
        "正文包含非图片嵌入 ![[...]]，例如嵌入笔记、标题或块。当前版本不会展开这类内容，建议改成正文或普通链接后再发布。"
    });
  }
}

function hasWikiLinks(content: string): boolean {
  WIKI_LINK_PATTERN.lastIndex = 0;
  return WIKI_LINK_PATTERN.test(content);
}

function hasNonImageWikiEmbeds(app: App, sourceFile: TFile, content: string): boolean {
  WIKI_EMBED_PATTERN.lastIndex = 0;

  for (const match of content.matchAll(WIKI_EMBED_PATTERN)) {
    const linkpath = match[1]?.split("|")[0]?.trim() ?? "";
    const linkWithoutAnchor = linkpath.split("#")[0]?.trim() ?? "";

    if (!linkWithoutAnchor) {
      return true;
    }

    const assetFile = app.metadataCache.getFirstLinkpathDest(
      linkWithoutAnchor,
      sourceFile.path
    );
    if (!assetFile || !IMAGE_EXTENSIONS.has(assetFile.extension.toLowerCase())) {
      return true;
    }
  }

  return false;
}

function buildCandidate(
  app: App,
  file: TFile,
  settings: PublishToAstroSettings
): NoteScanCandidate {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter ?? {};
  const title = asDisplayString(getFrontmatterValue(frontmatter, "title")) || file.basename;
  const slugResolution = deriveSlug(file, frontmatter, title);
  const tags = getNormalizedTags(cache);
  const publishFieldValue = getFrontmatterValue(frontmatter, settings.publishStatusField);
  const folderMatched = matchesSourceFolders(file, settings.sourceFolders);
  const propertyMatched = matchesPropertyFilters(frontmatter, settings.propertyFilters);
  const tagMatched = matchesTagFilters(tags, settings.tagFilters);
  const inScope = folderMatched && propertyMatched && tagMatched;
  const publishMatched = matchesConfiguredValue(
    publishFieldValue,
    settings.publishStatusValue
  );
  const issues: CandidateIssue[] = [];

  if (!title.trim()) {
    issues.push({
      level: "error",
      message: "标题缺失，且无法从文件名推导出标题。"
    });
  }

  if (!slugResolution.slug) {
    issues.push({
      level: "error",
      message: "Slug 缺失，且无法从文件名推导出 Slug。"
    });
  }

  return {
    file,
    path: file.path,
    title,
    slug: slugResolution.slug,
    slugSource: slugResolution.source,
    tags,
    publishFieldActual: asDisplayString(publishFieldValue),
    folderMatched,
    propertyMatched,
    tagMatched,
    publishMatched,
    inScope,
    publishable: false,
    syncStatus: "unpublished",
    lastPublishedAt: null,
    hasChangesSincePublish: false,
    issues
  };
}

async function enrichCandidatePublishState(
  app: App,
  settings: PublishToAstroSettings,
  publishState: PublishStateStore,
  candidate: NoteScanCandidate
): Promise<void> {
  const record = getPublishStateRecord(publishState, candidate.path);

  if (!record) {
    candidate.syncStatus = "unpublished";
    candidate.hasChangesSincePublish = false;
    candidate.lastPublishedAt = null;
    return;
  }

  candidate.lastPublishedAt = record.lastPublishedAt ?? null;

  if (!candidate.inScope) {
    candidate.syncStatus = "unpublished";
    candidate.hasChangesSincePublish = false;
    return;
  }

  if (record.lastResult === "failure") {
    candidate.syncStatus = "failed";
    candidate.hasChangesSincePublish = true;
    if (record.lastError) {
      candidate.issues.push({
        level: "warning",
        message: `上次发布失败：${record.lastError}`
      });
    }
    return;
  }

  if (!candidate.publishable) {
    candidate.syncStatus = "changed";
    candidate.hasChangesSincePublish = true;
    return;
  }

  try {
    const prepared = await prepareCandidateForPublish(app, settings, candidate);
    candidate.currentContentHash = prepared.contentHash;

    if (record.slug === candidate.slug && record.contentHash === prepared.contentHash) {
      candidate.syncStatus = "synced";
      candidate.hasChangesSincePublish = false;
      return;
    }

    candidate.syncStatus = "changed";
    candidate.hasChangesSincePublish = true;
  } catch (error) {
    candidate.syncStatus = "changed";
    candidate.hasChangesSincePublish = true;
    candidate.issues.push({
      level: "warning",
      message:
        error instanceof Error
          ? `无法计算变更状态：${error.message}`
          : "无法计算变更状态。"
    });
  }
}

function findCollidingSlugs(candidates: NoteScanCandidate[]): Set<string> {
  const counts = new Map<string, number>();

  candidates.forEach(candidate => {
    if (!candidate.slug) {
      return;
    }

    counts.set(candidate.slug, (counts.get(candidate.slug) ?? 0) + 1);
  });

  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([slug]) => slug)
  );
}

function matchesSourceFolders(file: TFile, folders: string[]): boolean {
  if (folders.length === 0) {
    return true;
  }

  return folders.some(folder => {
    const normalizedFolder = normalizePath(folder);
    return file.path.startsWith(`${normalizedFolder}/`);
  });
}

function matchesPropertyFilters(
  frontmatter: FrontMatterCache,
  filters: PropertyFilter[]
): boolean {
  if (filters.length === 0) {
    return true;
  }

  return filters.every(filter =>
    matchesConfiguredValue(getFrontmatterValue(frontmatter, filter.key), filter.value)
  );
}

function matchesTagFilters(noteTags: string[], tagFilters: string[]): boolean {
  if (tagFilters.length === 0) {
    return true;
  }

  const tagSet = new Set(noteTags.map(normalizeTag));
  return tagFilters.some(tag => tagSet.has(normalizeTag(tag)));
}

function getNormalizedTags(
  cache: ReturnType<App["metadataCache"]["getFileCache"]>
): string[] {
  const tags = cache ? getAllTags(cache) ?? [] : [];
  return Array.from(new Set(tags.map(normalizeTag))).sort((left, right) =>
    left.localeCompare(right)
  );
}

function getFrontmatterValue(frontmatter: FrontMatterCache, key: string): unknown {
  if (!frontmatter || !key.trim()) {
    return undefined;
  }

  if (frontmatter[key] !== undefined) {
    return frontmatter[key];
  }

  const lowered = key.toLowerCase();
  const match = Object.entries(frontmatter).find(
    ([entryKey]) => entryKey.toLowerCase() === lowered
  );

  return match?.[1];
}

function matchesConfiguredValue(actualValue: unknown, expectedValue: string): boolean {
  const expected = normalizeComparableValue(expectedValue);
  return flattenComparableValues(actualValue).includes(expected);
}

function flattenComparableValues(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(flattenComparableValues);
  }

  if (typeof value === "string") {
    return [normalizeComparableValue(value)];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [normalizeComparableValue(String(value))];
  }

  if (value instanceof Date) {
    return [normalizeComparableValue(value.toISOString())];
  }

  return [normalizeComparableValue(String(value))];
}

function deriveSlug(
  file: TFile,
  frontmatter: FrontMatterCache,
  title: string
) {
  const explicitSlug = asDisplayString(getFrontmatterValue(frontmatter, "slug"));
  return resolveNoteSlug({
    explicitSlug,
    title,
    fileBasename: file.basename
  });
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function normalizeComparableValue(value: string): string {
  return value.trim().toLowerCase();
}

function asDisplayString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value
      .flatMap(item => asDisplayString(item) ?? [])
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value).trim() || null;
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function isCompletePropertyFilter(filter: PropertyFilter): boolean {
  return Boolean(filter.key.trim() && filter.value.trim());
}
