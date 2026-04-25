import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  TFile,
  Setting
} from "obsidian";
import { loadPersistedPluginData, savePersistedPluginData } from "./persistence";
import {
  EMPTY_PUBLISH_STATE,
  getPublishStateRecord,
  setPublishStateRecord,
  type PublishStateStore
} from "./publish-state";
import {
  type PublishItemResult,
  type PublishProgress,
  publishCandidatesToAstro
} from "./publisher";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type PropertyFilter,
  type PublishToAstroSettings,
  type SyncMode,
  type ValueMapping
} from "./settings";
import { ScanResultsModal } from "./scan-modal";
import { scanVaultNotes } from "./scanner";
import { validateSettings } from "./validation";

export default class PublishToAstroPlugin extends Plugin {
  settings: PublishToAstroSettings = DEFAULT_SETTINGS;
  publishState: PublishStateStore = EMPTY_PUBLISH_STATE;

  async onload(): Promise<void> {
    await this.loadPluginData();

    this.addSettingTab(new PublishToAstroSettingTab(this.app, this));
    this.addRibbonIcon("search", "扫描可发布笔记", () => {
      void this.openScanResults();
    });
    this.addRibbonIcon("upload", "发布可发布笔记到 Astro", () => {
      void this.publishReadyNotes();
    });
    this.addCommand({
      id: "open-publish-to-astro-settings",
      name: "打开“Publish to Site”设置",
      callback: () => {
        const settingsManager = (this.app as App & {
          setting: { open: () => void; openTabById: (id: string) => void };
        }).setting;
        settingsManager.open();
        settingsManager.openTabById(this.manifest.id);
      }
    });
    this.addCommand({
      id: "scan-publishable-notes",
      name: "扫描可发布笔记",
      callback: () => {
        void this.openScanResults();
      }
    });
    this.addCommand({
      id: "publish-ready-notes-to-astro",
      name: "发布全部可发布笔记到 Astro",
      callback: () => {
        void this.publishReadyNotes();
      }
    });
    this.addCommand({
      id: "publish-active-note-to-astro",
      name: "发布当前笔记到 Astro",
      callback: () => {
        void this.publishActiveNote();
      }
    });
  }

  async loadPluginData(): Promise<void> {
    const { settings, publishState, recoveredFromBackup } =
      await loadPersistedPluginData(this);
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, settings ?? {}));
    this.publishState = publishState;

    if (recoveredFromBackup) {
      await this.savePluginData();
      new Notice(
        "“Publish to Site”已在重载后从备份中恢复插件数据。",
        6000
      );
    }
  }

  async savePluginData(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    await savePersistedPluginData(this, {
      settings: this.settings,
      publishState: this.publishState
    });
  }

  async updatePluginSettings(
    updater:
      | Partial<PublishToAstroSettings>
      | ((current: PublishToAstroSettings) => PublishToAstroSettings)
  ): Promise<void> {
    const next =
      typeof updater === "function"
        ? updater(this.settings)
        : { ...this.settings, ...updater };
    this.settings = normalizeSettings(next);
    await this.savePluginData();
  }

  getValidationMessages(): string[] {
    return validateSettings(this.settings);
  }

  async openScanResults(): Promise<void> {
    const result = await scanVaultNotes(this.app, this.settings, this.publishState);
    new ScanResultsModal(this.app, this.settings, result).open();

    const summary =
      result.publishableCount > 0
        ? `有 ${result.publishableCount} 篇笔记可以发布。`
        : result.inScopeCount > 0
          ? "当前没有可直接发布的笔记，请查看阻塞原因。"
          : "当前没有笔记命中筛选范围，请检查目录、属性和标签规则。";

    new Notice(
      `已扫描 ${result.scannedCount} 篇 Markdown 笔记。${summary}`,
      6000
    );
  }

  async publishReadyNotes(onProgress?: (progress: PublishProgress) => void): Promise<void> {
    const scanResult = await scanVaultNotes(this.app, this.settings, this.publishState);
    if (scanResult.publishableCandidates.length === 0) {
      new Notice(
        "没有找到可发布的笔记。请先扫描并检查当前规则筛掉了哪些内容。",
        6000
      );
      return;
    }

    let result;
    try {
      result = await publishCandidatesToAstro(
        this.app,
        this.settings,
        scanResult.publishableCandidates,
        { onProgress }
      );
    } catch (error) {
      new Notice(
        `发布前校验失败。${error instanceof Error ? error.message : String(error)}`,
        9000
      );
      return;
    }
    await this.applyPublishResults(result.results);

    const summary = `已发布 ${result.successCount}/${result.attemptedCount} 篇笔记到 Astro。`;
    const failures = result.results.filter(item => !item.success);

    if (failures.length === 0) {
      new Notice(summary, 6000);
      return;
    }

    const firstFailure = failures[0];
    new Notice(
      `${summary} 其中 ${result.failureCount} 篇失败。首个错误：${firstFailure.error ?? "未知错误"}`,
      9000
    );
  }

  async publishActiveNote(onProgress?: (progress: PublishProgress) => void): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    if (!(activeFile instanceof TFile) || activeFile.extension !== "md") {
      new Notice("请先打开一篇 Markdown 笔记，再发布当前笔记。", 5000);
      return;
    }

    const scanResult = await scanVaultNotes(this.app, this.settings, this.publishState);
    const candidate = scanResult.candidates.find(item => item.path === activeFile.path);

    if (!candidate) {
      new Notice("当前笔记不在本次扫描结果中。", 5000);
      return;
    }

    if (!candidate.publishable) {
      const reason =
        candidate.issues[0]?.message ??
        "当前笔记不符合发布范围或发布规则。";
      new Notice(`当前笔记暂时不能发布。${reason}`, 7000);
      return;
    }

    let result;
    try {
      result = await publishCandidatesToAstro(this.app, this.settings, [candidate], {
        onProgress
      });
    } catch (error) {
      new Notice(
        `发布前校验失败。${error instanceof Error ? error.message : String(error)}`,
        9000
      );
      return;
    }
    await this.applyPublishResults(result.results);
    const item = result.results[0];

    if (item?.success) {
      new Notice(`当前笔记已发布到 ${item.targetMarkdownPath}。`, 7000);
      return;
    }

    new Notice(
      `发布当前笔记失败。${item?.error ?? "未知错误"}`,
      9000
    );
  }

  private async applyPublishResults(results: PublishItemResult[]): Promise<void> {
    let nextState = this.publishState;
    let changed = false;
    const attemptedAt = new Date().toISOString();

    results.forEach(result => {
      if (!result.candidate.path) {
        return;
      }

      const previous = getPublishStateRecord(nextState, result.candidate.path);
      const baseRecord = {
        sourcePath: result.candidate.path,
        slug: result.slug ?? previous?.slug ?? result.candidate.slug,
        targetMarkdownRelativePath:
          result.targetMarkdownRelativePath ?? previous?.targetMarkdownRelativePath ?? "",
        targetAssetDirRelativePath:
          result.targetAssetDirRelativePath ?? previous?.targetAssetDirRelativePath ?? "",
        contentHash: result.contentHash ?? previous?.contentHash ?? "",
        lastAttemptedAt: attemptedAt,
        lastPublishedAt: result.success
          ? attemptedAt
          : previous?.lastPublishedAt,
        lastResult: result.success ? "success" : "failure",
        lastError: result.success ? undefined : result.error
      } as const;

      nextState = setPublishStateRecord(nextState, baseRecord);
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.publishState = nextState;
    await this.savePluginData();
  }
}

class PublishToAstroSettingTab extends PluginSettingTab {
  private validationEl: HTMLDivElement | null = null;
  private progressContainerEl: HTMLDivElement | null = null;
  private progressBarEl: HTMLProgressElement | null = null;
  private progressTextEl: HTMLDivElement | null = null;

  constructor(app: App, private readonly plugin: PublishToAstroPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    const header = containerEl.createDiv({ cls: "publish-to-astro-settings-header" });
    header.createEl("h2", { text: "Publish to Site" });
    header.createEl("p", {
      text: "把 Obsidian 里准备发布的笔记转换并同步到 Astro 博客。建议先配置 1 到 2 个来源目录，扫描确认后再批量发布。"
    });

    this.validationEl = containerEl.createDiv({
      cls: "publish-to-astro-validation"
    });
    this.renderValidationMessages();

    this.renderSetupGuide(containerEl);
    this.renderImportExportSettings(containerEl);
    this.renderQuickActions(containerEl);
    this.renderAstroSiteSettings(containerEl);
    this.renderSourceScopeSettings(containerEl);
    this.renderPublishRuleSettings(containerEl);
    this.renderCategorySettings(containerEl);
    this.renderOutputSettings(containerEl);
    this.renderSyncModeSetting(containerEl);
  }

  private renderValidationMessages(): void {
    if (!this.validationEl) {
      return;
    }

    const messages = this.plugin.getValidationMessages();
    const hasErrors = messages.some(message => this.getValidationLevel(message) === "error");

    this.validationEl.empty();
    this.validationEl.toggleClass("publish-to-astro-validation--error", hasErrors);
    this.validationEl.toggleClass(
      "publish-to-astro-validation--warning",
      messages.length > 0 && !hasErrors
    );
    this.validationEl.createEl("strong", { text: "校验与配置提示" });

    if (messages.length === 0) {
      this.validationEl.createEl("p", {
        text: "当前配置可以执行扫描和发布。建议先点“扫描笔记”，确认命中范围符合预期。"
      });
      return;
    }

    const list = this.validationEl.createEl("ul");
    messages.forEach(message => {
      list.createEl("li", {
        cls:
          this.getValidationLevel(message) === "error"
            ? "publish-to-astro-validation-item--error"
            : "publish-to-astro-validation-item--warning",
        text: message
      });
    });
  }

  private getValidationLevel(message: string): "error" | "warning" {
    const warningPatterns = [
      "通常应放在 public/",
      "也可能是正常的",
      "当前没有配置来源目录",
      "其他实验性同步模式会自动回退"
    ];

    return warningPatterns.some(pattern => message.includes(pattern))
      ? "warning"
      : "error";
  }

  private renderSetupGuide(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "推荐起步",
      "第一次使用时，先用一套保守配置跑通扫描。发布动作只会写入文章输出目录和资源输出目录。"
    );

    const details = section.createEl("details", {
      cls: "publish-to-astro-guide"
    });
    details.open = true;
    details.createEl("summary", {
      cls: "publish-to-astro-guide__summary",
      text: "第一次配置建议"
    });

    const guideBody = details.createDiv({ cls: "publish-to-astro-guide__body" });
    const steps = guideBody.createEl("ol", { cls: "publish-to-astro-guide-list" });
    [
      "设置 Astro 站点根目录。",
      "把来源目录限定到真正要发布的笔记目录。",
      "用 frontmatter 的发布状态字段控制哪些笔记进入发布范围。",
      "先扫描，确认可发布列表没有异常，再执行发布。"
    ].forEach(step => {
      steps.createEl("li", { text: step });
    });

    new Setting(guideBody)
      .setName("恢复推荐默认配置")
      .setDesc(
        "使用通用默认值：posts 目录、status = published、常见栏目映射和 AstroPaper 风格输出目录。站点根目录会保留为空，需要你自己填写。"
      )
      .addButton(button => {
        button.setButtonText("应用默认配置").onClick(async () => {
          await this.plugin.updatePluginSettings(current => ({
            ...current,
            ...DEFAULT_SETTINGS
          }));
          new Notice("已应用推荐默认配置。请填写 Astro 站点根目录后扫描确认。", 6000);
          this.display();
        });
      });
  }

  private renderImportExportSettings(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "配置导入导出",
      "配置可以复制成 JSON 保存，也可以从 JSON 粘贴导入。"
    );

    new Setting(section)
      .setName("JSON 配置")
      .setDesc("导出只包含设置，不包含发布历史。导入会覆盖当前设置。")
      .addButton(button => {
        button.setButtonText("导入").onClick(() => {
          new SettingsJsonModal(this.app, this.plugin, "import", () => this.display()).open();
        });
      })
      .addButton(button => {
        button.setButtonText("导出").onClick(() => {
          new SettingsJsonModal(this.app, this.plugin, "export", () => this.display()).open();
        });
      });
  }

  private renderQuickActions(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "操作",
      "扫描只读取 Vault 和配置，不会写入博客目录；发布会把可发布笔记写入 Astro 站点。"
    );

    new Setting(section)
      .setName("立即扫描")
      .setDesc("测试当前规则，查看哪些笔记可发布、被阻塞或被筛除。")
      .addButton(button => {
        button.setCta().setButtonText("扫描笔记").onClick(async () => {
          await this.plugin.openScanResults();
        });
      });

    new Setting(section)
      .setName("发布全部可发布")
      .setDesc("重新扫描当前范围，把所有命中发布规则且无阻塞问题的笔记发布到 Astro。")
      .addButton(button => {
        button.setButtonText("发布全部可发布").onClick(async () => {
          this.startProgress("准备发布全部可发布笔记。");
          await this.plugin.publishReadyNotes(progress => this.updateProgress(progress));
          this.finishProgress();
        });
      });

    new Setting(section)
      .setName("发布当前笔记")
      .setDesc("只发布当前 Obsidian 编辑器里打开的 Markdown；它仍然必须命中来源范围和发布规则。")
      .addButton(button => {
        button.setButtonText("发布当前笔记").onClick(async () => {
          this.startProgress("准备发布当前笔记。");
          await this.plugin.publishActiveNote(progress => this.updateProgress(progress));
          this.finishProgress();
        });
      });

    this.progressContainerEl = section.createDiv({
      cls: "publish-to-astro-progress publish-to-astro-progress--hidden"
    });
    this.progressBarEl = this.progressContainerEl.createEl("progress", {
      cls: "publish-to-astro-progress__bar"
    });
    this.progressBarEl.max = 1;
    this.progressBarEl.value = 0;
    this.progressTextEl = this.progressContainerEl.createDiv({
      cls: "publish-to-astro-progress__text",
      text: "等待发布。"
    });
  }

  private renderAstroSiteSettings(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "1. 目标站点",
      "填写本地 Astro 项目的根目录。插件会检查这里是否存在 astro.config.*，避免写错目录。"
    );

    new Setting(section)
      .setName("Astro 站点根目录")
      .setDesc("必须是绝对路径，例如 /Users/name/projects/site。")
      .addText(text => {
        text
          .setPlaceholder("/Users/name/projects/my-astro-site")
          .setValue(this.plugin.settings.astroSiteRoot)
          .onChange(async value => {
            await this.plugin.updatePluginSettings({ astroSiteRoot: value });
            this.renderValidationMessages();
          });
        text.inputEl.style.width = "100%";
      });
  }

  private renderSourceScopeSettings(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "2. 扫描范围",
      "用目录、属性和标签逐步缩小范围。为了避免误发布，建议至少配置一个来源目录。"
    );

    new Setting(section)
      .setName("来源目录")
      .setDesc("相对于当前 Vault 的路径。默认 posts，可按你的 Vault 改成 writing、articles 等目录。")
      .addButton(button => {
        button.setButtonText("添加目录").onClick(async () => {
          await this.plugin.updatePluginSettings(current => ({
            ...current,
            sourceFolders: [...current.sourceFolders, ""]
          }));
          this.display();
        });
      });

    this.plugin.settings.sourceFolders.forEach((folder, index) => {
      new Setting(section)
        .setName(index === 0 ? "目录规则" : "")
        .setDesc(index === 0 ? "例如：posts 或 writing/articles" : "")
        .addText(text => {
          text.setValue(folder).onChange(async value => {
            const next = [...this.plugin.settings.sourceFolders];
            next[index] = value;
            await this.plugin.updatePluginSettings({ sourceFolders: next });
            this.renderValidationMessages();
          });
          text.inputEl.style.width = "100%";
        })
        .addExtraButton(button => {
          button.setIcon("trash").setTooltip("删除目录").onClick(async () => {
            const next = this.plugin.settings.sourceFolders.filter(
              (_, itemIndex) => itemIndex !== index
            );
            await this.plugin.updatePluginSettings({ sourceFolders: next });
            this.display();
          });
        });
    });

    new Setting(section)
      .setName("属性筛选")
      .setDesc("可选。多条属性筛选需要全部满足；不确定时先留空。")
      .addButton(button => {
        button.setButtonText("添加属性筛选").onClick(async () => {
          await this.plugin.updatePluginSettings(current => ({
            ...current,
            propertyFilters: [...current.propertyFilters, { key: "", value: "" }]
          }));
          this.display();
        });
      });

    this.plugin.settings.propertyFilters.forEach((filter, index) => {
      new Setting(section)
        .setName(index === 0 ? "属性规则" : "")
        .setDesc(index === 0 ? "例如：type = article；不确定时建议留空" : "")
        .addText(text => {
          text
            .setPlaceholder("字段")
            .setValue(filter.key)
            .onChange(async value => {
              await this.updatePropertyFilter(index, { key: value });
            });
          text.inputEl.style.width = "45%";
        })
        .addText(text => {
          text
            .setPlaceholder("值")
            .setValue(filter.value)
            .onChange(async value => {
              await this.updatePropertyFilter(index, { value });
            });
          text.inputEl.style.width = "45%";
        })
        .addExtraButton(button => {
          button
            .setIcon("trash")
            .setTooltip("删除属性筛选")
            .onClick(async () => {
              const next = this.plugin.settings.propertyFilters.filter(
                (_, itemIndex) => itemIndex !== index
              );
              await this.plugin.updatePluginSettings({ propertyFilters: next });
              this.display();
            });
        });
    });

    new Setting(section)
      .setName("标签筛选")
      .setDesc("可选。配置多条时，命中任意一个标签即可；不确定时先留空。")
      .addButton(button => {
        button.setButtonText("添加标签筛选").onClick(async () => {
          await this.plugin.updatePluginSettings(current => ({
            ...current,
            tagFilters: [...current.tagFilters, ""]
          }));
          this.display();
        });
      });

    this.plugin.settings.tagFilters.forEach((tag, index) => {
      new Setting(section)
        .setName(index === 0 ? "标签规则" : "")
        .setDesc(index === 0 ? "例如：blog" : "")
        .addText(text => {
          text.setValue(tag).onChange(async value => {
            const next = [...this.plugin.settings.tagFilters];
            next[index] = value;
            await this.plugin.updatePluginSettings({ tagFilters: next });
            this.renderValidationMessages();
          });
          text.inputEl.style.width = "100%";
        })
        .addExtraButton(button => {
          button.setIcon("trash").setTooltip("删除标签筛选").onClick(async () => {
            const next = this.plugin.settings.tagFilters.filter(
              (_, itemIndex) => itemIndex !== index
            );
            await this.plugin.updatePluginSettings({ tagFilters: next });
            this.display();
          });
        });
    });
  }

  private renderPublishRuleSettings(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "3. 发布规则",
      "只有命中这个 frontmatter 条件的笔记才会进入可发布列表。字段值支持字符串或列表。"
    );

    new Setting(section)
      .setName("发布状态字段")
      .setDesc("默认使用 status。")
      .addText(text => {
        text.setValue(this.plugin.settings.publishStatusField).onChange(async value => {
          await this.plugin.updatePluginSettings({ publishStatusField: value });
          this.renderValidationMessages();
        });
      });

    new Setting(section)
      .setName("发布状态值")
      .setDesc("默认 published；插件会匹配 status: published 或 status: [published]。")
      .addText(text => {
        text.setValue(this.plugin.settings.publishStatusValue).onChange(async value => {
          await this.plugin.updatePluginSettings({ publishStatusValue: value });
          this.renderValidationMessages();
        });
      });
  }

  private renderCategorySettings(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "4. 栏目映射",
      "把 Obsidian 里的分类值转换成站点需要的分类。常见做法是把 Projects 映射为 project。"
    );

    new Setting(section)
      .setName("栏目字段")
      .setDesc("读取栏目值的 frontmatter 字段名，通常是 categories。")
      .addText(text => {
        text.setValue(this.plugin.settings.categoryField).onChange(async value => {
          await this.plugin.updatePluginSettings({ categoryField: value });
          this.renderValidationMessages();
        });
      });

    new Setting(section)
      .setName("栏目值映射")
      .setDesc("例如：[[Posts]] -> post。未映射的值会原样输出。")
      .addButton(button => {
        button.setButtonText("添加栏目映射").onClick(async () => {
          await this.plugin.updatePluginSettings(current => ({
            ...current,
            categoryMappings: [
              ...current.categoryMappings,
              { source: "", target: "" }
            ]
          }));
          this.display();
        });
      });

    this.plugin.settings.categoryMappings.forEach((mapping, index) => {
      new Setting(section)
        .setName(index === 0 ? "栏目规则" : "")
        .setDesc(index === 0 ? "左边填 Obsidian 原值，右边填站点分类值。" : "")
        .addText(text => {
          text
            .setPlaceholder("来源值")
            .setValue(mapping.source)
            .onChange(async value => {
              await this.updateCategoryMapping(index, { source: value });
            });
          text.inputEl.style.width = "45%";
        })
        .addText(text => {
          text
            .setPlaceholder("目标值")
            .setValue(mapping.target)
            .onChange(async value => {
              await this.updateCategoryMapping(index, { target: value });
            });
          text.inputEl.style.width = "45%";
        })
        .addExtraButton(button => {
          button
            .setIcon("trash")
            .setTooltip("删除栏目映射")
            .onClick(async () => {
              const next = this.plugin.settings.categoryMappings.filter(
                (_, itemIndex) => itemIndex !== index
              );
              await this.plugin.updatePluginSettings({ categoryMappings: next });
              this.display();
            });
        });
    });
  }

  private renderOutputSettings(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "5. 输出位置",
      "这些路径都相对于 Astro 站点根目录。插件会覆盖同一 slug 的文章和该文章的资源目录。"
    );

    new Setting(section)
      .setName("文章输出目录")
      .setDesc("默认：src/data/blog/_obsidian。适合 Astro Content Collection。")
      .addText(text => {
        text.setValue(this.plugin.settings.postOutputDir).onChange(async value => {
          await this.plugin.updatePluginSettings({ postOutputDir: value });
          this.renderValidationMessages();
        });
        text.inputEl.style.width = "100%";
      });

    new Setting(section)
      .setName("资源输出目录")
      .setDesc("必须位于 public/ 下，默认：public/uploads/obsidian。")
      .addText(text => {
        text.setValue(this.plugin.settings.assetOutputDir).onChange(async value => {
          await this.plugin.updatePluginSettings({ assetOutputDir: value });
          this.renderValidationMessages();
        });
        text.inputEl.style.width = "100%";
      });
  }

  private renderSyncModeSetting(containerEl: HTMLElement): void {
    const section = this.createSettingsSection(
      containerEl,
      "6. 同步安全",
      "当前版本只做安全覆盖写入，不会删除博客目录里其他文件。删除、取消发布、全量镜像后续再开放。"
    );

    new Setting(section)
      .setName("同步模式")
      .setDesc(
        "当前版本固定使用安全模式：只发布命中的笔记，并覆盖插件管理的输出，不删除无关文件。"
      )
      .addDropdown(dropdown => {
        const options: Record<"upsert-only", string> = {
          "upsert-only": "仅覆盖写入（安全默认）"
        };

        Object.entries(options).forEach(([value, label]) => {
          dropdown.addOption(value, label);
        });

        dropdown
          .setValue("upsert-only")
          .onChange(async value => {
            const nextMode = "upsert-only" as SyncMode;
            await this.plugin.updatePluginSettings({ syncMode: nextMode });
            this.renderValidationMessages();
            new Notice(`同步模式已更新为：${options["upsert-only"]}`);
          });
      });
  }

  private createSettingsSection(
    containerEl: HTMLElement,
    title: string,
    description: string
  ): HTMLDivElement {
    const section = containerEl.createDiv({ cls: "publish-to-astro-settings-section" });
    section.createEl("h3", { text: title });
    section.createEl("p", {
      cls: "publish-to-astro-section-note",
      text: description
    });
    return section;
  }

  private startProgress(message: string): void {
    this.progressContainerEl?.removeClass("publish-to-astro-progress--hidden");
    if (this.progressBarEl) {
      this.progressBarEl.max = 1;
      this.progressBarEl.value = 0;
    }
    this.progressTextEl?.setText(message);
  }

  private updateProgress(progress: PublishProgress): void {
    const total = Math.max(progress.total, 1);
    if (this.progressBarEl) {
      this.progressBarEl.max = total;
      this.progressBarEl.value = progress.completed;
    }

    const label =
      progress.completed >= progress.total
        ? `发布进度：${progress.completed}/${progress.total}，已完成 ${progress.currentPath}`
        : `发布进度：${progress.completed}/${progress.total}，正在处理 ${progress.currentPath}`;
    this.progressTextEl?.setText(label);
  }

  private finishProgress(): void {
    if (!this.progressTextEl) {
      return;
    }

    const current = this.progressTextEl.getText();
    if (!current.includes("发布进度")) {
      this.progressTextEl.setText("发布流程已结束。");
      return;
    }

    this.progressTextEl.setText(`${current}。发布流程已结束。`);
  }

  private async updatePropertyFilter(
    index: number,
    patch: Partial<PropertyFilter>
  ): Promise<void> {
    const next = [...this.plugin.settings.propertyFilters];
    next[index] = { ...next[index], ...patch };
    await this.plugin.updatePluginSettings({ propertyFilters: next });
    this.renderValidationMessages();
  }

  private async updateCategoryMapping(
    index: number,
    patch: Partial<ValueMapping>
  ): Promise<void> {
    const next = [...this.plugin.settings.categoryMappings];
    next[index] = { ...next[index], ...patch };
    await this.plugin.updatePluginSettings({ categoryMappings: next });
    this.renderValidationMessages();
  }
}

class SettingsJsonModal extends Modal {
  private textAreaEl: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    private readonly plugin: PublishToAstroPlugin,
    private readonly mode: "import" | "export",
    private readonly onApplied: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const isExport = this.mode === "export";

    this.setTitle(isExport ? "导出配置 JSON" : "导入配置 JSON");
    contentEl.empty();
    contentEl.createEl("p", {
      cls: "publish-to-astro-section-note",
      text: isExport
        ? "复制下面的 JSON 保存或分享。这里不包含发布历史状态。"
        : "粘贴配置 JSON 后导入。导入会覆盖当前设置，但不会修改发布历史状态。"
    });

    this.textAreaEl = contentEl.createEl("textarea", {
      cls: "publish-to-astro-config-json publish-to-astro-config-json--modal",
      attr: {
        spellcheck: "false",
        placeholder: "粘贴配置 JSON..."
      }
    });

    if (isExport) {
      this.textAreaEl.value = JSON.stringify(this.plugin.settings, null, 2);
      this.textAreaEl.select();
    }

    const actions = contentEl.createDiv({ cls: "publish-to-astro-modal-actions" });
    new Setting(actions)
      .addButton(button => {
        button.setButtonText("关闭").onClick(() => {
          this.close();
        });
      })
      .addButton(button => {
        button
          .setCta()
          .setButtonText(isExport ? "重新生成" : "导入配置")
          .onClick(async () => {
            if (isExport) {
              this.refreshExportJson();
              return;
            }
            await this.importSettings();
          });
      });
  }

  private refreshExportJson(): void {
    if (!this.textAreaEl) {
      return;
    }
    this.textAreaEl.value = JSON.stringify(this.plugin.settings, null, 2);
    this.textAreaEl.select();
    new Notice("已重新生成配置 JSON。", 4000);
  }

  private async importSettings(): Promise<void> {
    const raw = this.textAreaEl?.value.trim();
    if (!raw) {
      new Notice("请先粘贴配置 JSON。", 5000);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PublishToAstroSettings>;
      await this.plugin.updatePluginSettings(current => ({
        ...current,
        ...parsed
      }));
      new Notice("配置 JSON 已导入。请先扫描确认规则。", 6000);
      this.onApplied();
      this.close();
    } catch (error) {
      new Notice(
        `配置 JSON 导入失败。${error instanceof Error ? error.message : String(error)}`,
        9000
      );
    }
  }
}
