import { existsSync, statSync } from "fs";
import path from "path";
import type { PublishToAstroSettings } from "./settings";

function hasAstroConfig(siteRoot: string): boolean {
  const candidates = [
    "astro.config.ts",
    "astro.config.mts",
    "astro.config.js",
    "astro.config.mjs",
    "astro.config.cjs"
  ];

  return candidates.some(fileName => existsSync(path.join(siteRoot, fileName)));
}

function isInsideRoot(root: string, relativePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, relativePath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function validateSettings(settings: PublishToAstroSettings): string[] {
  const messages: string[] = [];
  const astroRoot = settings.astroSiteRoot;

  if (!astroRoot) {
    messages.push("发布前请先设置 Astro 站点根目录。");
  } else if (!existsSync(astroRoot)) {
    messages.push(`Astro 站点根目录不存在：${astroRoot}`);
  } else if (!statSync(astroRoot).isDirectory()) {
    messages.push(`Astro 站点根目录不是一个目录：${astroRoot}`);
  } else {
    if (!hasAstroConfig(astroRoot)) {
      messages.push("在配置的 Astro 站点根目录中没有找到 astro.config.*。");
    }

    const contentConfigTs = path.join(astroRoot, "src", "content.config.ts");
    const contentConfigJs = path.join(astroRoot, "src", "content.config.js");
    if (!existsSync(contentConfigTs) && !existsSync(contentConfigJs)) {
      messages.push(
        "在配置的 Astro 站点根目录中没有找到 src/content.config.ts。如果你的站点用的是别的内容结构，这也可能是正常的。"
      );
    }

    if (path.isAbsolute(settings.postOutputDir)) {
      messages.push("文章输出目录必须是相对于 Astro 站点根目录的路径。");
    } else if (!isInsideRoot(astroRoot, settings.postOutputDir)) {
      messages.push("文章输出目录必须位于 Astro 站点根目录内部。");
    }

    if (path.isAbsolute(settings.assetOutputDir)) {
      messages.push("资源输出目录必须是相对于 Astro 站点根目录的路径。");
    } else if (!isInsideRoot(astroRoot, settings.assetOutputDir)) {
      messages.push("资源输出目录必须位于 Astro 站点根目录内部。");
    } else if (!settings.assetOutputDir.startsWith("public/")) {
      messages.push(
        "资源输出目录通常应放在 public/ 下，这样 Astro 才能正常提供这些资源。"
      );
    }
  }

  if (!settings.publishStatusField.trim()) {
    messages.push("发布状态字段不能为空。");
  }

  if (!settings.publishStatusValue.trim()) {
    messages.push("发布状态值不能为空。");
  }

  settings.categoryMappings.forEach((mapping, index) => {
    const hasSource = Boolean(mapping.source.trim());
    const hasTarget = Boolean(mapping.target.trim());

    if (hasSource !== hasTarget) {
      messages.push(
        `栏目映射 ${index + 1} 需要同时填写来源值和目标值。`
      );
    }
  });

  if (settings.syncMode !== "upsert-only") {
    messages.push(
      "当前版本只支持“仅覆盖写入”模式。其他实验性同步模式会自动回退到安全默认值。"
    );
  }

  if (settings.sourceFolders.every(folder => !folder.trim())) {
    messages.push(
      "当前没有配置来源目录，插件会扫描整个 Vault。"
    );
  }

  settings.sourceFolders
    .filter(folder => folder.trim().startsWith("/"))
    .forEach(folder => {
      messages.push(`来源目录必须是相对于 Vault 的路径，不能是绝对路径：${folder}`);
    });

  settings.propertyFilters.forEach((filter, index) => {
    const hasKey = Boolean(filter.key.trim());
    const hasValue = Boolean(filter.value.trim());

    if (hasKey !== hasValue) {
      messages.push(
        `属性筛选 ${index + 1} 需要同时填写字段和对应的值。`
      );
    }
  });

  return messages;
}
