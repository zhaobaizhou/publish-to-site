import { App } from "obsidian";
import { mkdir, rm, stat, writeFile } from "fs/promises";
import path from "path";
import type { NoteScanCandidate } from "./scanner";
import type { PublishToAstroSettings } from "./settings";
import {
  type AssetCopyPlan,
  prepareCandidateForPublish
} from "./transform";

export interface PublishItemResult {
  candidate: NoteScanCandidate;
  success: boolean;
  slug?: string;
  contentHash?: string;
  targetMarkdownPath?: string;
  targetMarkdownRelativePath?: string;
  targetAssetDirRelativePath?: string;
  assetCount?: number;
  error?: string;
}

export interface PublishRunResult {
  attemptedCount: number;
  successCount: number;
  failureCount: number;
  results: PublishItemResult[];
}

export interface PublishProgress {
  completed: number;
  total: number;
  currentPath: string;
}

export interface PublishOptions {
  onProgress?: (progress: PublishProgress) => void;
}

export async function publishCandidatesToAstro(
  app: App,
  settings: PublishToAstroSettings,
  candidates: NoteScanCandidate[],
  options: PublishOptions = {}
): Promise<PublishRunResult> {
  await assertPublishEnvironment(settings);

  const results: PublishItemResult[] = [];

  for (const [index, candidate] of candidates.entries()) {
    options.onProgress?.({
      completed: index,
      total: candidates.length,
      currentPath: candidate.path
    });

    try {
      const prepared = await prepareCandidateForPublish(app, settings, candidate);
      const targetMarkdownPath = resolveInsideAstroRoot(
        settings.astroSiteRoot,
        prepared.targetMarkdownRelativePath
      );
      const targetAssetDir = resolveInsideAstroRoot(
        settings.astroSiteRoot,
        prepared.targetAssetDirRelativePath
      );

      await mkdir(path.dirname(targetMarkdownPath), { recursive: true });
      await rm(targetAssetDir, { recursive: true, force: true });
      if (prepared.assetPlans.length > 0) {
        await mkdir(targetAssetDir, { recursive: true });
      }

      await syncAssets(app, targetAssetDir, prepared.assetPlans);
      await writeFile(targetMarkdownPath, prepared.markdown, "utf8");

      results.push({
        candidate,
        success: true,
        slug: prepared.candidate.slug,
        contentHash: prepared.contentHash,
        targetMarkdownPath,
        targetMarkdownRelativePath: prepared.targetMarkdownRelativePath,
        targetAssetDirRelativePath: prepared.targetAssetDirRelativePath,
        assetCount: prepared.assetPlans.length
      });
    } catch (error) {
      results.push({
        candidate,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    options.onProgress?.({
      completed: index + 1,
      total: candidates.length,
      currentPath: candidate.path
    });
  }

  return {
    attemptedCount: candidates.length,
    successCount: results.filter(result => result.success).length,
    failureCount: results.filter(result => !result.success).length,
    results
  };
}

async function syncAssets(
  app: App,
  targetAssetDir: string,
  assetPlans: AssetCopyPlan[]
): Promise<void> {
  for (const plan of assetPlans) {
    const binary = await app.vault.readBinary(plan.sourceFile);
    await writeFile(
      path.join(targetAssetDir, plan.targetFileName),
      Buffer.from(binary)
    );
  }
}

async function assertPublishEnvironment(settings: PublishToAstroSettings): Promise<void> {
  const astroRoot = settings.astroSiteRoot.trim();

  assertPublishPaths(settings);

  let rootStats;
  try {
    rootStats = await stat(astroRoot);
  } catch {
    throw new Error(`Astro 站点根目录不存在：${astroRoot}`);
  }

  if (!rootStats.isDirectory()) {
    throw new Error(`Astro 站点根目录不是一个目录：${astroRoot}`);
  }

  if (!(await hasAstroConfig(astroRoot))) {
    throw new Error(`在配置的 Astro 站点根目录中没有找到 astro.config.*：${astroRoot}`);
  }
}

function assertPublishPaths(settings: PublishToAstroSettings): void {
  const astroRoot = settings.astroSiteRoot.trim();

  if (!astroRoot) {
    throw new Error("发布前请先设置 Astro 站点根目录。");
  }

  if (path.isAbsolute(settings.postOutputDir)) {
    throw new Error("文章输出目录必须是相对于 Astro 站点根目录的路径。");
  }

  if (path.isAbsolute(settings.assetOutputDir)) {
    throw new Error("资源输出目录必须是相对于 Astro 站点根目录的路径。");
  }

  const postOutputPath = resolveInsideAstroRoot(astroRoot, settings.postOutputDir);
  const assetOutputPath = resolveInsideAstroRoot(astroRoot, settings.assetOutputDir);

  if (path.relative(path.resolve(astroRoot), postOutputPath) === "") {
    throw new Error("文章输出目录不能是 Astro 站点根目录。");
  }

  if (path.relative(path.resolve(astroRoot), assetOutputPath) === "") {
    throw new Error("资源输出目录不能是 Astro 站点根目录。");
  }
}

async function hasAstroConfig(astroRoot: string): Promise<boolean> {
  const candidates = [
    "astro.config.ts",
    "astro.config.mts",
    "astro.config.js",
    "astro.config.mjs",
    "astro.config.cjs"
  ];

  for (const fileName of candidates) {
    try {
      const fileStats = await stat(path.join(astroRoot, fileName));
      if (fileStats.isFile()) {
        return true;
      }
    } catch {
      // Try the next known Astro config filename.
    }
  }

  return false;
}

function resolveInsideAstroRoot(astroRoot: string, relativePath: string): string {
  const resolvedRoot = path.resolve(astroRoot);
  const resolvedTarget = path.resolve(astroRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`解析后的路径超出了 Astro 根目录：${relativePath}`);
  }

  return resolvedTarget;
}
