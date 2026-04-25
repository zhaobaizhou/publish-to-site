import {
  App,
  FrontMatterCache,
  TFile,
  getFrontMatterInfo,
  normalizePath
} from "obsidian";
import { createHash } from "crypto";
import path from "path";
import type { NoteScanCandidate } from "./scanner";
import type { PublishToAstroSettings, ValueMapping } from "./settings";

export interface AssetCopyPlan {
  sourceFile: TFile;
  targetFileName: string;
  publicUrl: string;
}

export interface TransformedAstroNote {
  candidate: NoteScanCandidate;
  markdown: string;
  assetPlans: AssetCopyPlan[];
  targetMarkdownRelativePath: string;
  targetAssetDirRelativePath: string;
}

export interface PreparedPublishItem extends TransformedAstroNote {
  contentHash: string;
}

interface AstroFrontmatter {
  title: string;
  description: string;
  summary?: string;
  pubDatetime: Date;
  draft: boolean;
  categories?: string | string[];
  tags: string[];
  featured: boolean;
  author?: string;
  modDatetime?: Date;
  ogImage?: string;
  canonicalURL?: string;
  hideEditPost?: boolean;
  timezone?: string;
}

interface AssetContext {
  slug: string;
  assetPlansBySourcePath: Map<string, AssetCopyPlan>;
  usedTargetNames: Set<string>;
}

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

export async function prepareCandidateForPublish(
  app: App,
  settings: PublishToAstroSettings,
  candidate: NoteScanCandidate
): Promise<PreparedPublishItem> {
  const rawContent = await app.vault.cachedRead(candidate.file);
  const body = stripLeadingTitleHeading(stripFrontmatter(rawContent), candidate.title);
  const cache = app.metadataCache.getFileCache(candidate.file);
  const frontmatter = cache?.frontmatter ?? {};
  const assetContext: AssetContext = {
    slug: candidate.slug,
    assetPlansBySourcePath: new Map<string, AssetCopyPlan>(),
    usedTargetNames: new Set<string>()
  };

  const rewrittenBody = rewriteBodyAssetLinks(
    app,
    settings,
    candidate.file,
    body,
    assetContext
  );
  const astroFrontmatter = buildAstroFrontmatter(
    app,
    settings,
    candidate,
    frontmatter,
    rewrittenBody,
    assetContext
  );

  const transformed: TransformedAstroNote = {
    candidate,
    markdown: renderAstroMarkdown(astroFrontmatter, rewrittenBody),
    assetPlans: Array.from(assetContext.assetPlansBySourcePath.values()),
    targetMarkdownRelativePath: normalizePath(
      `${settings.postOutputDir}/${candidate.slug}.md`
    ),
    targetAssetDirRelativePath: normalizePath(
      `${settings.assetOutputDir}/${candidate.slug}`
    )
  };

  return {
    ...transformed,
    contentHash: createContentHash(transformed)
  };
}

function buildAstroFrontmatter(
  app: App,
  settings: PublishToAstroSettings,
  candidate: NoteScanCandidate,
  frontmatter: FrontMatterCache,
  rewrittenBody: string,
  assetContext: AssetContext
): AstroFrontmatter {
  const pubDatetime =
    parseDateValue(getFrontmatterValue(frontmatter, "date")) ??
    new Date(candidate.file.stat.ctime);
  const modDatetime =
    parseDateValue(getFrontmatterValue(frontmatter, "updated")) ?? undefined;
  const descriptionValue = asString(getFrontmatterValue(frontmatter, "description"));
  const summaryValue = asString(getFrontmatterValue(frontmatter, "summary"));
  const generatedSummary = buildSummary(rewrittenBody);
  const summary =
    summaryValue ?? (descriptionValue ? undefined : generatedSummary);
  const description =
    descriptionValue ?? buildDescription(summaryValue ?? generatedSummary);
  const author = asString(getFrontmatterValue(frontmatter, "author")) ?? undefined;
  const featured = asBoolean(getFrontmatterValue(frontmatter, "featured")) ?? false;
  const canonicalURL =
    normalizeExternalUrl(asString(getFrontmatterValue(frontmatter, "canonical"))) ??
    undefined;
  const timezone = asString(getFrontmatterValue(frontmatter, "timezone")) ?? undefined;
  const coverReference = asString(getFrontmatterValue(frontmatter, "cover"));
  const ogImage = coverReference
    ? resolveCoverOutputUrl(app, settings, candidate.file, coverReference, assetContext)
    : undefined;
  const categories = mapCategoryValues(
    parseStringList(getFrontmatterValue(frontmatter, settings.categoryField)),
    settings.categoryMappings
  );
  const tags = parseTags(getFrontmatterValue(frontmatter, "tags"));

  return omitUndefined({
    title: candidate.title,
    description,
    summary,
    pubDatetime,
    modDatetime,
    draft: false,
    categories: toSingleOrArray(categories),
    tags: tags.length > 0 ? tags : ["others"],
    featured,
    author,
    ogImage,
    canonicalURL,
    hideEditPost: false,
    timezone
  });
}

function rewriteBodyAssetLinks(
  app: App,
  settings: PublishToAstroSettings,
  sourceFile: TFile,
  content: string,
  assetContext: AssetContext
): string {
  const withWikiEmbeds = content.replace(WIKI_EMBED_PATTERN, (fullMatch, rawTarget) => {
    const parsed = parseWikiEmbedTarget(rawTarget);
    if (!parsed.linkpath) {
      return fullMatch;
    }

    const assetFile = app.metadataCache.getFirstLinkpathDest(parsed.linkpath, sourceFile.path);
    if (!assetFile || !isImageFile(assetFile)) {
      return fullMatch;
    }

    const publicUrl = registerAsset(settings, assetContext, assetFile);
    const altText = parsed.displayText || assetFile.basename;
    return `![${escapeMarkdownAltText(altText)}](${publicUrl})`;
  });

  return rewriteMarkdownImageLinks(withWikiEmbeds, (fullMatch, altText, rawDestination) => {
    const destinations = extractMarkdownDestinationCandidates(rawDestination);
    if (destinations.length === 0 || destinations.some(isRemoteUrl)) {
      return fullMatch;
    }

    for (const destination of destinations) {
      const assetFile = resolveAssetFile(app, sourceFile, destination);
      if (!assetFile || !isImageFile(assetFile)) {
        continue;
      }

      const publicUrl = registerAsset(settings, assetContext, assetFile);
      return `![${escapeMarkdownAltText(altText)}](${publicUrl})`;
    }

    return fullMatch;
  });
}

function resolveCoverOutputUrl(
  app: App,
  settings: PublishToAstroSettings,
  sourceFile: TFile,
  coverReference: string,
  assetContext: AssetContext
): string {
  if (isRemoteUrl(coverReference)) {
    return coverReference;
  }

  const assetFile = resolveAssetFile(app, sourceFile, coverReference);
  if (!assetFile || !isImageFile(assetFile)) {
    return coverReference;
  }

  return registerAsset(settings, assetContext, assetFile);
}

function registerAsset(
  settings: PublishToAstroSettings,
  assetContext: AssetContext,
  assetFile: TFile
): string {
  const existing = assetContext.assetPlansBySourcePath.get(assetFile.path);
  if (existing) {
    return existing.publicUrl;
  }

  const targetFileName = allocateAssetFileName(assetContext.usedTargetNames, assetFile.name);
  const publicUrl = toPublicAssetUrl(settings.assetOutputDir, assetContext.slug, targetFileName);
  const plan: AssetCopyPlan = {
    sourceFile: assetFile,
    targetFileName,
    publicUrl
  };

  assetContext.assetPlansBySourcePath.set(assetFile.path, plan);
  return publicUrl;
}

function allocateAssetFileName(usedNames: Set<string>, originalName: string): string {
  const parsed = path.posix.parse(originalName);
  const baseName = slugifySegment(parsed.name) || "asset";
  const extension = parsed.ext.toLowerCase();

  let candidate = `${baseName}${extension}`;
  let index = 2;

  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${index}${extension}`;
    index += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function resolveAssetFile(app: App, sourceFile: TFile, rawReference: string): TFile | null {
  const normalizedReference = decodeReference(rawReference);

  const direct = app.metadataCache.getFirstLinkpathDest(normalizedReference, sourceFile.path);
  if (direct) {
    return direct;
  }

  const candidates = [
    normalizedReference.startsWith("/")
      ? normalizePath(normalizedReference.slice(1))
      : normalizePath(
          `${path.posix.dirname(sourceFile.path)}/${normalizedReference}`
        ),
    normalizePath(normalizedReference)
  ];

  for (const candidatePath of candidates) {
    const abstractFile = app.vault.getAbstractFileByPath(candidatePath);
    if (abstractFile instanceof TFile) {
      return abstractFile;
    }
  }

  return null;
}

function renderAstroMarkdown(frontmatter: AstroFrontmatter, body: string): string {
  const frontmatterBlock = renderYamlFrontmatter(frontmatter);
  const normalizedBody = body.replace(/^\n+/, "");
  return `---\n${frontmatterBlock}---\n\n${normalizedBody.trimEnd()}\n`;
}

function renderYamlFrontmatter(frontmatter: AstroFrontmatter): string {
  const lines: string[] = [];

  appendYamlLine(lines, "title", frontmatter.title);
  appendYamlLine(lines, "author", frontmatter.author);
  appendYamlLine(lines, "pubDatetime", frontmatter.pubDatetime);
  appendYamlLine(lines, "modDatetime", frontmatter.modDatetime);
  appendYamlLine(lines, "featured", frontmatter.featured);
  appendYamlLine(lines, "draft", frontmatter.draft);
  appendYamlLine(lines, "categories", frontmatter.categories);
  appendYamlLine(lines, "tags", frontmatter.tags);
  appendYamlLine(lines, "ogImage", frontmatter.ogImage);
  appendYamlLine(lines, "description", frontmatter.description);
  appendYamlLine(lines, "summary", frontmatter.summary);
  appendYamlLine(lines, "canonicalURL", frontmatter.canonicalURL);
  appendYamlLine(lines, "hideEditPost", frontmatter.hideEditPost);
  appendYamlLine(lines, "timezone", frontmatter.timezone);

  return `${lines.join("\n")}\n`;
}

function appendYamlLine(lines: string[], key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }

    lines.push(`${key}:`);
    value.forEach(item => {
      lines.push(`  - ${formatYamlScalar(item)}`);
    });
    return;
  }

  lines.push(`${key}: ${formatYamlScalar(value)}`);
}

function formatYamlScalar(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  return JSON.stringify(String(value));
}

function stripFrontmatter(content: string): string {
  const info = getFrontMatterInfo(content);
  return info.exists ? content.slice(info.contentStart) : content;
}

function stripLeadingTitleHeading(content: string, title: string): string {
  const trimmedStart = content.replace(/^\uFEFF?/, "");
  const atxMatch = trimmedStart.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);

  if (atxMatch) {
    const headingText = normalizeHeadingText(atxMatch[1]);
    if (!headingText || isSameHeading(headingText, title)) {
      return trimmedStart.slice(atxMatch[0].length).replace(/^\n+/, "");
    }
  }

  const setextMatch = trimmedStart.match(/^\s*(.+?)\n=+\s*(?:\n+|$)/);
  if (setextMatch) {
    const headingText = normalizeHeadingText(setextMatch[1]);
    if (!headingText || isSameHeading(headingText, title)) {
      return trimmedStart.slice(setextMatch[0].length).replace(/^\n+/, "");
    }
  }

  return content;
}

function normalizeHeadingText(value: string): string {
  return value
    .trim()
    .replace(/\s+#+$/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .trim();
}

function isSameHeading(left: string, right: string): boolean {
  return normalizeHeadingForComparison(left) === normalizeHeadingForComparison(right);
}

function normalizeHeadingForComparison(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTags(value: unknown): string[] {
  return parseStringList(value).map(normalizeTag);
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => asString(item))
      .filter((item): item is string => Boolean(item));
  }

  const single = asString(value);
  return single ? [single] : [];
}

function mapCategoryValues(values: string[], mappings: ValueMapping[]): string[] {
  if (values.length === 0) {
    return [];
  }

  const mapped = values.map(value => applyValueMapping(value, mappings));
  return Array.from(new Set(mapped.filter(Boolean)));
}

function applyValueMapping(value: string, mappings: ValueMapping[]): string {
  const normalizedValue = normalizeComparableText(value);
  const match = mappings.find(
    mapping => normalizeComparableText(mapping.source) === normalizedValue
  );

  return match?.target.trim() || value.trim();
}

function toSingleOrArray(values: string[]): string | string[] | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.length === 1 ? values[0] : values;
}

function buildDescription(text: string): string {
  const plainText = normalizePlainText(text);

  if (plainText.length <= 160) {
    return plainText || "从 Obsidian 发布的内容。";
  }

  return `${plainText.slice(0, 157).trim()}...`;
}

function buildSummary(markdown: string): string {
  const plainText = normalizePlainText(markdown);

  if (plainText.length <= 320) {
    return plainText || "从 Obsidian 发布的内容。";
  }

  return `${plainText.slice(0, 317).trim()}...`;
}

function normalizePlainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_~>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseWikiEmbedTarget(rawTarget: string): {
  linkpath: string;
  displayText: string | null;
} {
  const [linkpath, displayText] = rawTarget.split("|");
  return {
    linkpath: decodeReference(linkpath ?? ""),
    displayText: displayText?.trim() || null
  };
}

type MarkdownImageReplacer = (
  fullMatch: string,
  altText: string,
  rawDestination: string
) => string;

function rewriteMarkdownImageLinks(
  content: string,
  replacer: MarkdownImageReplacer
): string {
  let output = "";
  let cursor = 0;

  while (cursor < content.length) {
    const start = content.indexOf("![", cursor);
    if (start === -1) {
      output += content.slice(cursor);
      break;
    }

    const parsed = parseMarkdownImageAt(content, start);
    if (!parsed) {
      output += content.slice(cursor, start + 2);
      cursor = start + 2;
      continue;
    }

    output += content.slice(cursor, start);
    output += replacer(parsed.fullMatch, parsed.altText, parsed.rawDestination);
    cursor = parsed.end;
  }

  return output;
}

function parseMarkdownImageAt(
  content: string,
  start: number
): {
  fullMatch: string;
  altText: string;
  rawDestination: string;
  end: number;
} | null {
  if (!content.startsWith("![", start)) {
    return null;
  }

  const altEnd = findClosingBracket(content, start + 2);
  if (altEnd === -1 || content[altEnd + 1] !== "(") {
    return null;
  }

  const destinationStart = altEnd + 2;
  const destinationEnd = findClosingParen(content, destinationStart);
  if (destinationEnd === -1) {
    return null;
  }

  return {
    fullMatch: content.slice(start, destinationEnd + 1),
    altText: content.slice(start + 2, altEnd),
    rawDestination: content.slice(destinationStart, destinationEnd),
    end: destinationEnd + 1
  };
}

function findClosingBracket(content: string, start: number): number {
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "]") {
      return index;
    }

    if (char === "\n") {
      return -1;
    }
  }

  return -1;
}

function findClosingParen(content: string, start: number): number {
  let escaped = false;
  let angleDestination = false;
  let depth = 0;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\n") {
      return -1;
    }

    if (index === start && char === "<") {
      angleDestination = true;
      continue;
    }

    if (angleDestination) {
      if (char === ">") {
        const nextNonSpace = content.slice(index + 1).match(/^\s*/)?.[0].length ?? 0;
        return content[index + 1 + nextNonSpace] === ")"
          ? index + 1 + nextNonSpace
          : -1;
      }
      continue;
    }

    if (char === "(") {
      depth += 1;
      continue;
    }

    if (char === ")") {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }

  return -1;
}

function extractMarkdownDestinationCandidates(rawDestination: string): string[] {
  const trimmed = rawDestination.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("<")) {
    const angled = trimmed.match(/^<([^>]+)>/)?.[1];
    return angled ? [decodeReference(angled)] : [];
  }

  const withoutWrappedTitle = trimmed
    .replace(/\s+(['"]).*?\1\s*$/, "")
    .replace(/\s+\([^)]*\)\s*$/, "")
    .trim();
  const beforeWhitespaceTitle = trimmed.split(/\s+/)[0];

  return Array.from(
    new Set(
      [withoutWrappedTitle, beforeWhitespaceTitle]
        .map(decodeReference)
        .filter(Boolean)
    )
  );
}

function decodeReference(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return decodeURI(trimmed);
  } catch {
    return trimmed;
  }
}

function toPublicAssetUrl(
  assetOutputDir: string,
  slug: string,
  fileName: string
): string {
  const targetPath = normalizePath(`${assetOutputDir}/${slug}/${fileName}`);
  const publicPrefix = "public/";
  const withoutPublicPrefix = targetPath.startsWith(publicPrefix)
    ? targetPath.slice(publicPrefix.length)
    : targetPath;

  return `/${withoutPublicPrefix}`;
}

function getFrontmatterValue(frontmatter: FrontMatterCache, key: string): unknown {
  if (!key.trim()) {
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

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function normalizeExternalUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return isRemoteUrl(value) ? value : null;
}

function isRemoteUrl(value: string): boolean {
  return /^(https?:)?\/\//i.test(value) || /^(data|mailto):/i.test(value);
}

function isImageFile(file: TFile): boolean {
  return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function normalizeComparableText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function slugifySegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeMarkdownAltText(value: string): string {
  return value.replace(/]/g, "\\]");
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, itemValue]) => itemValue !== undefined && itemValue !== null
    )
  ) as T;
}

function createContentHash(prepared: TransformedAstroNote): string {
  const hash = createHash("sha256");
  hash.update(prepared.markdown);

  prepared.assetPlans
    .slice()
    .sort((left, right) => left.sourceFile.path.localeCompare(right.sourceFile.path))
    .forEach(plan => {
      hash.update(
        [
          plan.sourceFile.path,
          plan.sourceFile.stat.mtime,
          plan.sourceFile.stat.size,
          plan.targetFileName,
          plan.publicUrl
        ].join("|")
      );
    });

  return hash.digest("hex");
}
