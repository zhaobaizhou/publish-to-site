import { App, Modal } from "obsidian";
import type { PublishToAstroSettings } from "./settings";
import type { CandidateIssue, NoteScanCandidate, NoteScanResult } from "./scanner";

const OUT_OF_SCOPE_PREVIEW_LIMIT = 12;

export class ScanResultsModal extends Modal {
  constructor(
    app: App,
    private readonly settings: PublishToAstroSettings,
    private readonly result: NoteScanResult
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    this.setTitle("发布扫描结果");
    contentEl.empty();

    contentEl.createEl("p", {
      text: "在真正发布前，用这次扫描确认当前的目录、属性、标签和发布状态规则是否符合预期。"
    });

    this.renderConfigSummary(contentEl);
    this.renderStats(contentEl);
    this.renderCandidatesSection(
      contentEl,
      "可发布",
      this.result.publishableCandidates,
      "这些笔记命中了范围和发布规则，且没有阻止发布的问题。"
    );
    this.renderCandidatesSection(
      contentEl,
      "范围内但被阻塞",
      this.result.blockedCandidates,
      "这些笔记在当前范围内，但暂时还不能发布。"
    );
    this.renderCandidatesSection(
      contentEl,
      "不在当前范围内",
      this.result.outOfScopeCandidates.slice(0, OUT_OF_SCOPE_PREVIEW_LIMIT),
      this.result.outOfScopeCandidates.length > OUT_OF_SCOPE_PREVIEW_LIMIT
        ? `这里只显示前 ${OUT_OF_SCOPE_PREVIEW_LIMIT} 篇被当前规则筛掉的笔记。`
        : "这些笔记被当前规则筛掉了。"
    );
  }

  private renderConfigSummary(containerEl: HTMLElement): void {
    const summary = containerEl.createDiv({ cls: "publish-to-astro-summary" });
    summary.createEl("h3", { text: "当前规则" });

    const list = summary.createEl("ul");
    list.createEl("li", {
      text: this.settings.sourceFolders.length
        ? `来源目录：${this.settings.sourceFolders.join(", ")}`
        : "来源目录：整个 Vault"
    });
    list.createEl("li", {
      text: `发布规则：${this.settings.publishStatusField} = ${this.settings.publishStatusValue}`
    });
    list.createEl("li", {
      text: this.settings.propertyFilters.length
        ? `属性筛选（AND）：${this.settings.propertyFilters
            .map(filter => `${filter.key}=${filter.value}`)
            .join(", ")}`
        : "属性筛选：无"
    });
    list.createEl("li", {
      text: this.settings.categoryMappings.length
        ? `栏目映射（${this.settings.categoryField}）：${this.settings.categoryMappings
            .map(mapping => `${mapping.source} -> ${mapping.target}`)
            .join(", ")}`
        : `栏目映射（${this.settings.categoryField}）：无`
    });
    list.createEl("li", {
      text: this.settings.tagFilters.length
        ? `标签筛选（OR）：${this.settings.tagFilters.join(", ")}`
        : "标签筛选：无"
    });
  }

  private renderStats(containerEl: HTMLElement): void {
    const grid = containerEl.createDiv({ cls: "publish-to-astro-stats-grid" });

    this.renderStatCard(grid, "已扫描", String(this.result.scannedCount));
    this.renderStatCard(grid, "范围内", String(this.result.inScopeCount));
    this.renderStatCard(
      grid,
      "可发布",
      String(this.result.publishableCount),
      "publish-to-astro-stat-card--success"
    );
    this.renderStatCard(grid, "已同步", String(this.result.syncedCount));
    this.renderStatCard(
      grid,
      "有变更",
      String(this.result.changedCount),
      this.result.changedCount > 0 ? "publish-to-astro-stat-card--warning" : ""
    );
    this.renderStatCard(grid, "未发布", String(this.result.unpublishedCount));
    this.renderStatCard(
      grid,
      "失败",
      String(this.result.failedCount),
      this.result.failedCount > 0 ? "publish-to-astro-stat-card--warning" : ""
    );
    this.renderStatCard(
      grid,
      "Slug 冲突",
      String(this.result.collisionCount),
      this.result.collisionCount > 0 ? "publish-to-astro-stat-card--warning" : ""
    );
  }

  private renderStatCard(
    containerEl: HTMLElement,
    label: string,
    value: string,
    extraClass = ""
  ): void {
    const card = containerEl.createDiv({
      cls: ["publish-to-astro-stat-card", extraClass].filter(Boolean).join(" ")
    });
    card.createDiv({ cls: "publish-to-astro-stat-card__label", text: label });
    card.createDiv({ cls: "publish-to-astro-stat-card__value", text: value });
  }

  private renderCandidatesSection(
    containerEl: HTMLElement,
    title: string,
    candidates: NoteScanCandidate[],
    description: string
  ): void {
    const section = containerEl.createDiv({ cls: "publish-to-astro-candidate-section" });
    section.createEl("h3", { text: `${title} (${candidates.length})` });
    section.createEl("p", {
      cls: "publish-to-astro-section-note",
      text: description
    });

    if (candidates.length === 0) {
      section.createEl("p", {
        cls: "publish-to-astro-empty-state",
        text: "这个分组里没有内容。"
      });
      return;
    }

    candidates.forEach(candidate => {
      this.renderCandidateCard(section, candidate);
    });
  }

  private renderCandidateCard(containerEl: HTMLElement, candidate: NoteScanCandidate): void {
    const card = containerEl.createDiv({ cls: "publish-to-astro-candidate-card" });
    const header = card.createDiv({ cls: "publish-to-astro-candidate-card__header" });
    header.createEl("strong", { text: candidate.title });
    header.createSpan({
      cls: [
        "publish-to-astro-pill",
        candidate.publishable
          ? "publish-to-astro-pill--success"
          : candidate.inScope
            ? "publish-to-astro-pill--warning"
            : ""
      ]
        .filter(Boolean)
        .join(" "),
      text: candidate.publishable
        ? "可发布"
        : candidate.inScope
          ? "被阻塞"
          : "已筛除"
    });

    const meta = card.createDiv({ cls: "publish-to-astro-candidate-card__meta" });
    meta.createEl("code", { text: candidate.path });
    meta.createEl("div", { text: `Slug：${candidate.slug || "（缺失）"}` });
    meta.createEl("div", {
      text: `Slug 来源：${this.getSlugSourceLabel(candidate)}`
    });
    meta.createEl("div", {
      text: `发布状态：${this.getSyncStatusLabel(candidate)}`
    });
    if (candidate.lastPublishedAt) {
      meta.createEl("div", {
        text: `上次发布：${new Date(candidate.lastPublishedAt).toLocaleString()}`
      });
    }
    meta.createEl("div", {
      text: candidate.tags.length
        ? `标签：${candidate.tags.map(tag => `#${tag}`).join(", ")}`
        : "标签：无"
    });

    const badges = card.createDiv({ cls: "publish-to-astro-badge-row" });
    this.renderMatchBadge(badges, "目录", candidate.folderMatched);
    this.renderMatchBadge(badges, "属性", candidate.propertyMatched);
    this.renderMatchBadge(badges, "标签", candidate.tagMatched);
    this.renderMatchBadge(badges, "发布", candidate.publishMatched);

    const details = this.getCandidateDetails(candidate);
    if (details.length > 0) {
      const list = card.createEl("ul", { cls: "publish-to-astro-issue-list" });
      details.forEach(detail => {
        const item = list.createEl("li");
        item.setText(detail.message);
        item.addClass(
          detail.level === "error"
            ? "publish-to-astro-issue--error"
            : "publish-to-astro-issue--warning"
        );
      });
    }
  }

  private renderMatchBadge(
    containerEl: HTMLElement,
    label: string,
    matched: boolean
  ): void {
    containerEl.createSpan({
      cls: [
        "publish-to-astro-badge",
        matched ? "publish-to-astro-badge--match" : "publish-to-astro-badge--miss"
      ].join(" "),
      text: `${label}：${matched ? "是" : "否"}`
    });
  }

  private getCandidateDetails(candidate: NoteScanCandidate): CandidateIssue[] {
    const details = [...candidate.issues];

    if (!candidate.publishMatched) {
      details.unshift({
        level: "warning",
        message: `未命中发布规则。期望 ${this.settings.publishStatusField}=${this.settings.publishStatusValue}，实际值为 ${candidate.publishFieldActual ?? "（缺失）"}。`
      });
    }

    if (!candidate.folderMatched) {
      details.push({
        level: "warning",
        message: "这篇笔记不在配置的来源目录内。"
      });
    }

    if (!candidate.propertyMatched) {
      details.push({
        level: "warning",
        message: "这篇笔记没有满足全部属性筛选条件。"
      });
    }

    if (!candidate.tagMatched) {
      details.push({
        level: "warning",
        message: "这篇笔记没有命中任何一个配置的标签筛选条件。"
      });
    }

    if (candidate.syncStatus === "changed") {
      details.unshift({
        level: "warning",
        message: "这篇笔记自上次成功发布后已经有未同步的变更。"
      });
    }

    if (candidate.slugSource === "title-pinyin") {
      details.push({
        level: "warning",
        message: "Slug 当前是根据标题自动生成的。如果你想固定它，建议手动填写 frontmatter slug。"
      });
    }

    if (candidate.slugSource === "filename") {
      details.push({
        level: "warning",
        message: "当前没有可用的标题或 frontmatter slug，Slug 已回退为文件名。"
      });
    }

    return details;
  }

  private getSyncStatusLabel(candidate: NoteScanCandidate): string {
    switch (candidate.syncStatus) {
      case "synced":
        return "已与 Astro 同步";
      case "changed":
        return "自上次发布后有变更";
      case "failed":
        return "上次发布失败";
      default:
        return "从未发布";
    }
  }

  private getSlugSourceLabel(candidate: NoteScanCandidate): string {
    switch (candidate.slugSource) {
      case "frontmatter":
        return "frontmatter 手动指定";
      case "title-pinyin":
        return "由标题拼音自动生成";
      default:
        return "回退为文件名";
    }
  }
}
