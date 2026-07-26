import {
  App,
  Editor,
  getAllTags,
  ItemView,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  normalizePath,
  Plugin,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { StateEffect } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { PatternMakerModal, PatternMakerResult } from "./pattern-maker";
import { PatternBoundaryPreviewModal } from "./pattern-boundary-preview";
import {
  createTranslationExercise as createTranslationExerciseModel,
  normalizeTranslationData,
  TRANSLATION_SCHEMA_VERSION,
  TranslationDataFile,
  TranslationExercise,
  TranslationLanguage,
  TranslationSource,
} from "./translation-model";
import {
  TranslationCaptureModal,
  TranslationStudyView,
  TranslationWorkbenchMode,
  TranslationWorkbenchStage,
  VIEW_TYPE_TRANSLATION_STUDY,
} from "./translation-study";
import {
  LANGUAGE_LABELS,
  normalizeStoredStructure,
  PatternLanguage,
  PatternStructure,
  PatternStructureKind,
  STRUCTURE_LABELS,
} from "./pattern-model";

const VIEW_TYPE_PATTERN_LIBRARY = "pattern-output-tracker-library";
const VIEW_TYPE_TAG_MANAGER = "pattern-output-tracker-tags";
const PATTERN_SCHEMA_VERSION = 4;
const TAG_SCHEMA_VERSION = 1;
const SETTINGS_SCHEMA_VERSION = 1;
const STORAGE_FOLDER = "_PatternOutputTracker";
const PATTERNS_FILE = normalizePath(`${STORAGE_FOLDER}/patterns.json`);
const TAGS_FILE = normalizePath(`${STORAGE_FOLDER}/tags.json`);
const SETTINGS_FILE = normalizePath(`${STORAGE_FOLDER}/settings.json`);
const TRANSLATIONS_FILE = normalizePath(`${STORAGE_FOLDER}/translations.json`);
const refreshPatternDecorations = StateEffect.define<void>();

interface PatternSource {
  filePath: string;
  line: number;
  column: number;
  capturedAt: string;
}

interface StoredPattern {
  id: string;
  text: string;
  language: PatternLanguage;
  structure: PatternStructure;
  note: string;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
  sources: PatternSource[];
}

interface PatternTag {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  parentId: string | null;
  obsidianTags: string[];
  createdAt: string;
  updatedAt: string;
}

interface PatternDataFile {
  schemaVersion: number;
  patterns: StoredPattern[];
}

interface TagDataFile {
  schemaVersion: number;
  tags: PatternTag[];
}

interface PluginSettings {
  schemaVersion: number;
  highlightHits: boolean;
  caseSensitive: boolean;
  defaultBackTranslationDelayDays: number;
  translationWorkbenchModes: Record<TranslationWorkbenchStage, TranslationWorkbenchMode>;
}

interface MatchRange {
  from: number;
  to: number;
  pattern: StoredPattern;
}

interface TagTreeRow {
  tag: PatternTag;
  depth: number;
}

interface PatternDraft {
  id?: string;
  text: string;
  language: PatternLanguage;
  note: string;
  tagPaths: string[];
  source?: PatternSource;
}

const DEFAULT_SETTINGS: PluginSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  highlightHits: true,
  caseSensitive: true,
  defaultBackTranslationDelayDays: 3,
  translationWorkbenchModes: {
    translate: "unit",
    backTranslate: "unit",
    compare: "unit",
  },
};

const LEGACY_KIND_TAG_PATHS: Record<string, string | undefined> = {
  collocation: "表达性质/搭配",
  idiom: "表达性质/Idiom",
  "fixed-expression": "表达性质/固定用语",
  term: "表达性质/术语",
  usage: "表达性质/词语用法",
  structure: "表达性质/结构 Pattern",
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectLanguage(text: string): PatternLanguage {
  if (/[\u3040-\u30ff]/u.test(text)) {
    return "ja";
  }
  if (/[A-Za-z]/u.test(text)) {
    return "en";
  }
  return "other";
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function normalizeLanguage(value: unknown, text: string): PatternLanguage {
  return value === "en" || value === "ja" || value === "other"
    ? value
    : detectLanguage(text);
}

function normalizeTagPath(value: string): string {
  const rawSegments = value.replace(/^#+/u, "").split("/");
  if (rawSegments.some((segment) => !segment.trim())) {
    throw new Error("Tag 路径中不能出现空层级。请检查连续或开头、结尾的 /。");
  }
  const segments = rawSegments.map((segment) => segment.trim());
  if (segments.length === 0 || !segments[0]) {
    throw new Error("Tag 路径不能为空。");
  }
  return segments.join("/");
}

function findExactOccurrencePositions(
  text: string,
  pattern: string,
  caseSensitive: boolean,
): number[] {
  if (!pattern) {
    return [];
  }
  const searchableText = caseSensitive ? text : text.toLocaleLowerCase();
  const searchablePattern = caseSensitive ? pattern : pattern.toLocaleLowerCase();
  const positions: number[] = [];
  let position = 0;
  while (position <= searchableText.length - searchablePattern.length) {
    const found = searchableText.indexOf(searchablePattern, position);
    if (found === -1) {
      break;
    }
    positions.push(found);
    position = found + Math.max(searchablePattern.length, 1);
  }
  return positions;
}

function findPatternOccurrenceRanges(
  text: string,
  pattern: StoredPattern,
  caseSensitive: boolean,
): Array<{ from: number; to: number }> {
  const components = pattern.structure.components.filter((component) => component.text);
  if (components.length === 0) return [];
  if (pattern.structure.kind === "contiguous" || components.length === 1) {
    const componentText = components[0]?.text ?? pattern.text;
    return findExactOccurrencePositions(text, componentText, caseSensitive)
      .map((from) => ({ from, to: from + componentText.length }));
  }

  const searchableText = caseSensitive ? text : text.toLocaleLowerCase();
  const componentTexts = components.map((component) => caseSensitive ? component.text : component.text.toLocaleLowerCase());
  const ranges: Array<{ from: number; to: number }> = [];
  let searchFrom = 0;
  while (searchFrom < searchableText.length) {
    const firstText = componentTexts[0];
    if (!firstText) break;
    const firstFrom = searchableText.indexOf(firstText, searchFrom);
    if (firstFrom < 0) break;
    let previousTo = firstFrom + firstText.length;
    let matchTo = previousTo;
    let valid = true;
    for (let index = 1; index < componentTexts.length; index += 1) {
      const componentText = componentTexts[index];
      if (!componentText) { valid = false; break; }
      const nextFrom = searchableText.indexOf(componentText, previousTo);
      if (nextFrom < 0) { valid = false; break; }
      const gap = text.slice(previousTo, nextFrom);
      const constraints = pattern.structure.constraints;
      if (constraints.scope === "same-sentence" && /[.!?。！？\n]/u.test(gap)) valid = false;
      if ((constraints.scope === "same-paragraph" || constraints.scope === "sentence-group") && /\n\s*\n/u.test(gap)) valid = false;
      if (constraints.maxDistance !== null) {
        const distance = constraints.distanceUnit === "tokens"
          ? gap.trim().split(/\s+/u).filter(Boolean).length
          : constraints.distanceUnit === "sentences"
            ? (gap.match(/[.!?。！？]/gu) ?? []).length
            : gap.length;
        if (distance > constraints.maxDistance) valid = false;
      }
      if (!valid) break;
      previousTo = nextFrom + componentText.length;
      matchTo = previousTo;
    }
    if (valid) {
      ranges.push({ from: firstFrom, to: matchTo });
      searchFrom = matchTo;
    } else {
      searchFrom = firstFrom + Math.max(firstText.length, 1);
    }
  }
  return ranges;
}

function countPatternOccurrences(text: string, pattern: StoredPattern, caseSensitive: boolean): number {
  return findPatternOccurrenceRanges(text, pattern, caseSensitive).length;
}

function buildDecorations(
  view: EditorView,
  patterns: readonly StoredPattern[],
  settings: PluginSettings,
): DecorationSet {
  if (!settings.highlightHits) {
    return Decoration.none;
  }
  const documentText = view.state.doc.toString();
  const matches: MatchRange[] = [];
  for (const pattern of patterns) {
    for (const found of findPatternOccurrenceRanges(documentText, pattern, settings.caseSensitive)) {
      matches.push({ from: found.from, to: found.to, pattern });
    }
  }
  matches.sort((left, right) => left.from - right.from || right.to - left.to);
  return Decoration.set(
    matches.map(({ from, to, pattern }) =>
      Decoration.mark({
        class: "pattern-output-tracker-hit",
        attributes: {
          title: `Pattern hit: ${pattern.text}`,
          "data-pattern-id": pattern.id,
        },
      }).range(from, to),
    ),
    true,
  );
}

class ConfirmationModal extends Modal {
  private readonly heading: string;
  private readonly message: string;
  private readonly detail: string;
  private readonly confirmLabel: string;
  private readonly resolveResult: (value: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    options: { heading: string; message: string; detail?: string; confirmLabel: string },
    resolveResult: (value: boolean) => void,
  ) {
    super(app);
    this.heading = options.heading;
    this.message = options.message;
    this.detail = options.detail ?? "";
    this.confirmLabel = options.confirmLabel;
    this.resolveResult = resolveResult;
  }

  onOpen(): void {
    this.modalEl.addClass("pattern-confirm-modal");
    this.setTitle(this.heading);
    const content = this.contentEl;
    content.empty();
    const icon = content.createDiv({ cls: "pattern-confirm-icon", text: "!" });
    content.createDiv({ cls: "pattern-confirm-message", text: this.message });
    if (this.detail) content.createDiv({ cls: "pattern-confirm-detail", text: this.detail });
    const actions = content.createDiv({ cls: "pattern-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(false));
    actions.createEl("button", { text: this.confirmLabel, cls: "mod-warning" }).addEventListener("click", () => this.finish(true));
    icon.setAttr("aria-hidden", "true");
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(false);
    }
  }

  private finish(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(value);
    this.close();
  }
}

function requestConfirmation(
  app: App,
  options: { heading: string; message: string; detail?: string; confirmLabel: string },
): Promise<boolean> {
  return new Promise((resolve) => new ConfirmationModal(app, options, resolve).open());
}

class PatternEditorModal extends Modal {
  private readonly plugin: PatternOutputTrackerPlugin;
  private readonly pattern?: StoredPattern;
  private readonly source?: PatternSource;
  private text: string;
  private language: PatternLanguage | "";
  private note: string;
  private readonly selectedTagPaths: Set<string>;
  private saveButton?: HTMLButtonElement;

  constructor(
    app: App,
    plugin: PatternOutputTrackerPlugin,
    options: { pattern?: StoredPattern; initialText?: string; source?: PatternSource },
  ) {
    super(app);
    this.plugin = plugin;
    this.pattern = options.pattern;
    this.source = options.source;
    this.text = options.pattern?.text ?? options.initialText ?? "";
    this.language = options.pattern?.language ?? "";
    this.note = options.pattern?.note ?? "";
    this.selectedTagPaths = new Set(
      (options.pattern?.tagIds ?? [])
        .map((id) => plugin.getTagSlashPath(id))
        .filter(Boolean),
    );
  }

  onOpen(): void {
    this.modalEl.addClass("pattern-metadata-modal");
    this.setTitle("Pattern 资料");
    this.render();
  }

  private render(): void {
    const content = this.contentEl;
    content.empty();
    const identity = content.createDiv({ cls: "pattern-metadata-identity" });
    identity.createDiv({ cls: "pattern-metadata-text", text: this.text });
    identity.createSpan({ cls: "pattern-chip", text: STRUCTURE_LABELS[this.pattern?.structure.kind ?? "contiguous"] });

    const languageSelect = content.createEl("select", { cls: "pattern-metadata-language" });
    for (const language of Object.keys(LANGUAGE_LABELS) as PatternLanguage[]) {
      languageSelect.createEl("option", { text: LANGUAGE_LABELS[language], value: language });
    }
    languageSelect.value = this.language || "other";
    languageSelect.addEventListener("change", () => {
      this.language = languageSelect.value as PatternLanguage;
      this.updateSaveButton();
    });

    this.renderTagComposer(content);

    const noteArea = content.createEl("textarea", { cls: "pattern-metadata-note" });
    noteArea.rows = 3;
    noteArea.placeholder = "说明";
    noteArea.value = this.note;
    noteArea.addEventListener("input", () => { this.note = noteArea.value; });

    const actions = content.createDiv({ cls: "pattern-modal-actions" });
    if (this.pattern) {
      actions.createEl("button", { text: "结构" }).addEventListener("click", () => {
        this.close();
        this.plugin.openPatternStructureEditor(this.pattern as StoredPattern);
      });
    }
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    this.saveButton = actions.createEl("button", { text: "保存", cls: "mod-cta" });
    this.saveButton.addEventListener("click", () => void this.submit());
    this.updateSaveButton();
  }

  private updateSaveButton(): void {
    if (this.saveButton) {
      this.saveButton.disabled = !this.text.trim() || !this.language;
    }
  }

  private renderTagComposer(host: HTMLElement): void {
    const composer = host.createDiv({ cls: "pattern-tag-composer" });
    const chips = composer.createDiv({ cls: "pattern-selected-tags" });
    const inputWrap = composer.createDiv({ cls: "pattern-tag-input-wrap" });
    const input = inputWrap.createEl("input", {
      type: "text",
      cls: "pattern-tag-path-input",
      placeholder: "Tag 路径 ↵",
    });
    const suggestions = inputWrap.createDiv({ cls: "pattern-tag-suggestions" });

    const renderChips = (): void => {
      chips.empty();
      if (this.selectedTagPaths.size === 0) {
        chips.createSpan({ cls: "pattern-tags-empty", text: "尚未添加 Tag" });
        return;
      }
      for (const path of this.selectedTagPaths) {
        const chip = chips.createEl("button", { cls: "pattern-path-chip" });
        chip.setAttr("type", "button");
        chip.setAttr("aria-label", `移除 ${path}`);
        chip.createSpan({ text: path });
        chip.createSpan({ cls: "pattern-chip-remove", text: "×" });
        chip.addEventListener("click", () => {
          this.selectedTagPaths.delete(path);
          renderChips();
        });
      }
    };

    const addPath = (rawPath: string): void => {
      if (!rawPath.trim()) return;
      try {
        const normalized = normalizeTagPath(rawPath);
        const existing = this.plugin.findTagByPath(normalized);
        this.selectedTagPaths.add(existing ? this.plugin.getTagSlashPath(existing.id) : normalized);
        input.value = "";
        suggestions.empty();
        renderChips();
      } catch (error) {
        new Notice(describeError(error), 6000);
      }
    };

    const renderSuggestions = (): void => {
      suggestions.empty();
      const query = input.value.trim().toLocaleLowerCase();
      if (!query) return;
      const matches = this.plugin.getAllTagPaths()
        .filter((path) => !this.selectedTagPaths.has(path) && path.toLocaleLowerCase().includes(query))
        .slice(0, 7);
      for (const path of matches) {
        const option = suggestions.createEl("button", { cls: "pattern-tag-suggestion", text: path });
        option.setAttr("type", "button");
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          addPath(path);
        });
      }
      if (matches.length === 0 && input.value.trim()) {
        const createHint = suggestions.createDiv({ cls: "pattern-tag-create-hint" });
        createHint.createSpan({ text: "按 Enter 创建路径：" });
        createHint.createEl("strong", { text: input.value.trim() });
      }
    };

    input.addEventListener("input", renderSuggestions);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addPath(input.value);
      }
      if (event.key === "Escape") suggestions.empty();
    });
    input.addEventListener("blur", () => window.setTimeout(() => suggestions.empty(), 100));
    renderChips();
  }

  private async submit(): Promise<void> {
    if (!this.text.trim() || !this.language) {
      new Notice("请先填写内容并确认语言。");
      return;
    }
    try {
      const result = await this.plugin.savePatternDraft({
        id: this.pattern?.id,
        text: this.text.trim(),
        language: this.language,
        note: this.note.trim(),
        tagPaths: [...this.selectedTagPaths],
        source: this.source,
      });
      this.close();
      new Notice(result.created ? `已保存 Pattern：${result.pattern.text}` : `已更新 Pattern：${result.pattern.text}`);
    } catch (error) {
      new Notice(`保存失败：${describeError(error)}`, 10000);
    }
  }
}

class TagEditorModal extends Modal {
  private readonly plugin: PatternOutputTrackerPlugin;
  private readonly existing?: PatternTag;
  private readonly onSaved?: (tag: PatternTag) => void;

  constructor(
    app: App,
    plugin: PatternOutputTrackerPlugin,
    options: { existing?: PatternTag; onSaved?: (tag: PatternTag) => void },
  ) {
    super(app);
    this.plugin = plugin;
    this.existing = options.existing;
    this.onSaved = options.onSaved;
  }

  onOpen(): void {
    this.modalEl.addClass("pattern-tag-editor-modal");
    this.setTitle(this.existing ? "编辑 Pattern Tag" : "新建 Pattern Tag");
    const content = this.contentEl;
    content.empty();
    let path = this.existing ? this.plugin.getTagSlashPath(this.existing.id) : "";
    let description = this.existing?.description ?? "";
    let aliasesText = this.existing?.aliases.join("，") ?? "";
    let obsidianTagsText = this.existing?.obsidianTags.join("，") ?? "";
    content.createDiv({ cls: "pattern-modal-intro", text: "直接编辑完整路径即可重命名或移动。/ 只表示普通 Tag 之间的层级。" });
    const main = content.createDiv({ cls: "pattern-form-section pattern-form-section-primary" });
    main.createEl("label", { cls: "pattern-standalone-label", text: "Tag 路径" });
    const pathInput = main.createEl("input", { type: "text", cls: "pattern-tag-path-editor", placeholder: "例如：领域/经济学/金融" });
    pathInput.value = path;
    pathInput.addEventListener("input", () => { path = pathInput.value; });

    const optional = content.createEl("details", { cls: "pattern-optional-panel" });
    if (description || aliasesText || obsidianTagsText) optional.open = true;
    optional.createEl("summary", { text: "定义与关联（可选）" });
    const body = optional.createDiv({ cls: "pattern-optional-body" });
    new Setting(body).setName("说明").addTextArea((component) => {
      component.setValue(description);
      component.inputEl.rows = 3;
      component.onChange((value) => { description = value; });
    });
    new Setting(body).setName("别名").setDesc("用逗号分隔。").addText((component) => {
      component.setValue(aliasesText);
      component.onChange((value) => { aliasesText = value; });
    });
    new Setting(body).setName("Obsidian Tags").setDesc("填写名称，用逗号分隔。").addText((component) => {
      component.setValue(obsidianTagsText);
      component.onChange((value) => { obsidianTagsText = value; });
    });

    const actions = content.createDiv({ cls: "pattern-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "保存 Tag", cls: "mod-cta" }).addEventListener("click", () => {
      void (async () => {
        try {
          const tag = await this.plugin.saveTagPath({
            id: this.existing?.id,
            path,
            description,
            aliases: aliasesText.split(/[，,]/u),
            obsidianTags: obsidianTagsText.split(/[，,]/u),
          });
          this.close();
          this.onSaved?.(tag);
          new Notice(`已保存 Tag：${tag.name}`);
        } catch (error) {
          new Notice(describeError(error), 8000);
        }
      })();
    });
  }
}

class PatternLibraryView extends ItemView {
  private readonly plugin: PatternOutputTrackerPlugin;
  private query = "";

  constructor(leaf: WorkspaceLeaf, plugin: PatternOutputTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_PATTERN_LIBRARY; }
  getDisplayText(): string { return "Pattern 管理"; }
  getIcon(): string { return "library"; }
  async onOpen(): Promise<void> { this.render(); }

  render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("pattern-management-view");
    const header = container.createDiv({ cls: "pattern-page-header" });
    const titleBlock = header.createDiv();
    titleBlock.createEl("h2", { text: "Pattern 管理" });
    titleBlock.createDiv({ cls: "pattern-page-subtitle", text: `${this.plugin.patterns.length} 条 Pattern · 数据位于 ${STORAGE_FOLDER}` });
    const headerActions = header.createDiv({ cls: "pattern-page-actions" });
    headerActions.createEl("button", { text: "Tags", cls: "pattern-quiet-button" }).addEventListener("click", () => void this.plugin.openTagManager());

    const toolbar = container.createDiv({ cls: "pattern-toolbar" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "搜索内容、说明、类型或 Tag", cls: "pattern-search-input" });
    search.value = this.query;
    const listHost = container.createDiv();
    const renderList = (): void => {
      this.query = search.value.trim().toLocaleLowerCase();
      listHost.empty();
      const patterns = this.plugin.patterns.filter((pattern) => {
        if (!this.query) return true;
        const text = [
          pattern.text,
          pattern.note,
          LANGUAGE_LABELS[pattern.language],
          STRUCTURE_LABELS[pattern.structure.kind],
          ...pattern.tagIds.map((id) => this.plugin.getTagSlashPath(id)),
        ].join(" ").toLocaleLowerCase();
        return text.includes(this.query);
      });
      if (patterns.length === 0) {
        listHost.createDiv({ cls: "pattern-empty-state", text: this.plugin.patterns.length === 0 ? "还没有 Pattern。请在笔记中选中文字，打开 Pattern 制作器。" : "没有符合条件的 Pattern。" });
        return;
      }
      const list = listHost.createDiv({ cls: "pattern-card-list" });
      const activeText = this.plugin.getActiveDocumentText();
      for (const pattern of patterns) {
        const item = list.createDiv({ cls: "pattern-card" });
        item.setAttr("role", "button");
        item.setAttr("tabindex", "0");
        item.addEventListener("click", () => this.plugin.openPatternEditor(pattern));
        item.addEventListener("keydown", (event) => {
          if (event.key === "Enter") this.plugin.openPatternEditor(pattern);
        });
        const main = item.createDiv({ cls: "pattern-card-main" });
        main.createDiv({ cls: "pattern-card-text", text: pattern.text });
        main.createDiv({
          cls: "pattern-card-meta",
          text: `${LANGUAGE_LABELS[pattern.language]} · ${STRUCTURE_LABELS[pattern.structure.kind]} · 当前笔记 ${countPatternOccurrences(activeText, pattern, this.plugin.settings.caseSensitive)} 次`,
        });
        if (pattern.tagIds.length > 0) {
          const tags = main.createDiv({ cls: "pattern-chip-row" });
          for (const tagId of pattern.tagIds.slice(0, 2)) {
            const path = this.plugin.getTagSlashPath(tagId);
            if (path) tags.createSpan({ cls: "pattern-chip", text: path });
          }
          if (pattern.tagIds.length > 2) tags.createSpan({ cls: "pattern-chip", text: `+${pattern.tagIds.length - 2}` });
        }
        if (pattern.note) main.createDiv({ cls: "pattern-card-note", text: pattern.note });
        const overflow = item.createEl("button", { cls: "pattern-overflow-button", text: "⋯" });
        overflow.setAttr("aria-label", "Pattern 操作");
        overflow.addEventListener("click", (event) => {
          event.stopPropagation();
          const menu = new Menu();
          menu.addItem((entry) => entry.setTitle("编辑资料").setIcon("pencil").onClick(() => this.plugin.openPatternEditor(pattern)));
          menu.addItem((entry) => entry.setTitle("编辑结构").setIcon("scan-text").onClick(() => this.plugin.openPatternStructureEditor(pattern)));
          if (pattern.sources.length > 0) menu.addItem((entry) => entry.setTitle("来源").setIcon("file-input").onClick(() => void this.plugin.openFirstSource(pattern)));
          menu.addSeparator();
          menu.addItem((entry) => entry.setTitle("删除").setIcon("trash-2").onClick(() => void this.plugin.deletePattern(pattern.id)));
          menu.showAtMouseEvent(event);
        });
      }
    };
    search.addEventListener("input", renderList);
    renderList();
  }
}

class TagManagerView extends ItemView {
  private readonly plugin: PatternOutputTrackerPlugin;
  private selectedTagId: string | null = null;
  private query = "";

  constructor(leaf: WorkspaceLeaf, plugin: PatternOutputTrackerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_TAG_MANAGER; }
  getDisplayText(): string { return "Pattern Tag 管理"; }
  getIcon(): string { return "tags"; }
  async onOpen(): Promise<void> { this.render(); }

  render(): void {
    if (this.selectedTagId && !this.plugin.getTag(this.selectedTagId)) {
      this.selectedTagId = null;
    }
    const container = this.contentEl;
    container.empty();
    container.addClass("pattern-management-view");
    const header = container.createDiv({ cls: "pattern-page-header" });
    const titleBlock = header.createDiv();
    titleBlock.createEl("h2", { text: "Pattern Tag 管理" });
    titleBlock.createDiv({ cls: "pattern-page-subtitle", text: `${this.plugin.tags.length} 个普通 Tag · 分层是 Tag 之间的父子关系` });
    const actions = header.createDiv({ cls: "pattern-page-actions" });
    actions.createEl("button", { text: "Pattern 管理" }).addEventListener("click", () => void this.plugin.openPatternLibrary());
    actions.createEl("button", { text: "新建 Tag", cls: "mod-cta" }).addEventListener("click", () => {
      new TagEditorModal(this.app, this.plugin, { onSaved: (tag) => { this.selectedTagId = tag.id; this.render(); } }).open();
    });

    const layout = container.createDiv({ cls: "pattern-tag-layout" });
    const sidebar = layout.createDiv({ cls: "pattern-tag-sidebar" });
    const search = sidebar.createEl("input", { type: "search", placeholder: "搜索 Tag、别名或路径", cls: "pattern-search-input" });
    search.value = this.query;
    const tree = sidebar.createDiv({ cls: "pattern-tag-tree" });
    const detail = layout.createDiv({ cls: "pattern-tag-detail" });

    const renderTree = (): void => {
      this.query = search.value.trim().toLocaleLowerCase();
      tree.empty();
      const rows = this.plugin.getTagTreeRows().filter(({ tag }) => {
        if (!this.query) return true;
        return [tag.name, ...tag.aliases, this.plugin.getTagSlashPath(tag.id)].join(" ").toLocaleLowerCase().includes(this.query);
      });
      if (rows.length === 0) {
        tree.createDiv({ cls: "pattern-inline-empty", text: this.plugin.tags.length === 0 ? "还没有 Tag。" : "没有符合条件的 Tag。" });
        return;
      }
      for (const { tag, depth } of rows) {
        const row = tree.createEl("button", { cls: `pattern-tag-tree-row${tag.id === this.selectedTagId ? " is-active" : ""}` });
        row.style.paddingLeft = `${8 + depth * 18}px`;
        row.createSpan({ cls: "pattern-tag-tree-name", text: tag.name });
        row.createSpan({ cls: "pattern-tag-tree-count", text: String(this.plugin.getPatternsForTag(tag.id, true).length) });
        row.addEventListener("click", () => { this.selectedTagId = tag.id; this.render(); });
      }
    };
    search.addEventListener("input", renderTree);
    renderTree();
    this.renderTagDetail(detail);
  }

  private renderTagDetail(detail: HTMLElement): void {
    const tag = this.selectedTagId ? this.plugin.getTag(this.selectedTagId) : undefined;
    if (!tag) {
      detail.createDiv({ cls: "pattern-empty-state", text: this.plugin.tags.length === 0 ? "先新建第一个 Pattern Tag。所有 Tag 都是同一种普通 Tag，可以位于顶层，也可以拥有父级。" : "从左侧选择一个 Tag，查看说明和相关 Pattern。" });
      return;
    }
    const titleRow = detail.createDiv({ cls: "pattern-detail-title-row" });
    const heading = titleRow.createDiv();
    heading.createEl("h3", { text: tag.name });
    heading.createDiv({ cls: "pattern-breadcrumb", text: this.plugin.getTagSlashPath(tag.id) });
    const actions = titleRow.createDiv({ cls: "pattern-page-actions" });
    const overflow = actions.createEl("button", { cls: "pattern-overflow-button", text: "⋯" });
    overflow.setAttr("aria-label", "Tag 操作");
    overflow.addEventListener("click", (event) => {
      const menu = new Menu();
      menu.addItem((entry) => entry.setTitle("编辑").setIcon("pencil").onClick(() => {
        new TagEditorModal(this.app, this.plugin, { existing: tag, onSaved: () => this.render() }).open();
      }));
      menu.addSeparator();
      menu.addItem((entry) => entry.setTitle("删除").setIcon("trash-2").onClick(() => void this.plugin.deleteTag(tag.id)));
      menu.showAtMouseEvent(event);
    });

    const facts = detail.createDiv({ cls: "pattern-tag-facts" });
    facts.createDiv({ text: tag.description || "尚未填写说明。", cls: tag.description ? "" : "pattern-muted" });
    if (tag.aliases.length > 0) facts.createDiv({ text: `别名：${tag.aliases.join("、")}` });
    if (tag.obsidianTags.length > 0) facts.createDiv({ text: `关联 Obsidian Tags：${tag.obsidianTags.join("、")}` });

    const patterns = this.plugin.getPatternsForTag(tag.id, true);
    detail.createEl("h4", { text: `相关 Pattern（包含子 Tag，共 ${patterns.length} 条）` });
    if (patterns.length === 0) {
      detail.createDiv({ cls: "pattern-inline-empty", text: "这个 Tag 及其子 Tag 还没有关联 Pattern。" });
      return;
    }
    const list = detail.createDiv({ cls: "pattern-compact-list" });
    for (const pattern of patterns) {
      const row = list.createDiv({ cls: "pattern-compact-row" });
      row.setAttr("role", "button");
      row.setAttr("tabindex", "0");
      const text = row.createDiv();
      text.createDiv({ cls: "pattern-card-text", text: pattern.text });
      text.createDiv({ cls: "pattern-card-meta", text: `${LANGUAGE_LABELS[pattern.language]} · ${STRUCTURE_LABELS[pattern.structure.kind]}` });
      row.addEventListener("click", () => this.plugin.openPatternEditor(pattern));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.plugin.openPatternEditor(pattern);
      });
    }
  }
}

export default class PatternOutputTrackerPlugin extends Plugin {
  patternData: PatternDataFile = { schemaVersion: PATTERN_SCHEMA_VERSION, patterns: [] };
  tagData: TagDataFile = { schemaVersion: TAG_SCHEMA_VERSION, tags: [] };
  translationData: TranslationDataFile = { schemaVersion: TRANSLATION_SCHEMA_VERSION, exercises: [] };
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private readonly dataChangeListeners = new Set<() => void>();
  private storageReady = false;

  get patterns(): readonly StoredPattern[] { return this.patternData.patterns; }
  get tags(): readonly PatternTag[] { return this.tagData.tags; }
  get translationTags(): readonly PatternTag[] { return this.tagData.tags; }
  get translationExercises(): readonly TranslationExercise[] { return this.translationData.exercises; }
  get defaultBackTranslationDelayDays(): number {
    return Math.max(0, Math.round(this.settings.defaultBackTranslationDelayDays || 3));
  }

  getTranslationWorkbenchMode(stage: TranslationWorkbenchStage): TranslationWorkbenchMode {
    return this.settings.translationWorkbenchModes?.[stage] === "full" ? "full" : "unit";
  }

  async setTranslationWorkbenchMode(stage: TranslationWorkbenchStage, mode: TranslationWorkbenchMode): Promise<void> {
    this.settings.translationWorkbenchModes = {
      ...DEFAULT_SETTINGS.translationWorkbenchModes,
      ...this.settings.translationWorkbenchModes,
      [stage]: mode,
    };
    await this.writeJsonFile(SETTINGS_FILE, this.settings);
  }

  async onload(): Promise<void> {
    try {
      await this.loadVaultData();
      this.storageReady = true;
    } catch (error) {
      console.error("Pattern Output Tracker failed to load Vault data", error);
      new Notice(`无法读取 ${STORAGE_FOLDER} 中的数据：${describeError(error)}`, 10000);
    }

    this.registerView(VIEW_TYPE_PATTERN_LIBRARY, (leaf) => new PatternLibraryView(leaf, this));
    this.registerView(VIEW_TYPE_TAG_MANAGER, (leaf) => new TagManagerView(leaf, this));
    this.registerView(VIEW_TYPE_TRANSLATION_STUDY, (leaf) => new TranslationStudyView(leaf, this));
    this.registerEditorExtension(this.createEditorExtension());
    this.registerMarkdownPostProcessor((element, context) => {
      const section = context.getSectionInfo(element);
      if (!section) return;
      const exercises = this.translationData.exercises.filter((exercise) =>
        exercise.source?.filePath === context.sourcePath
        && exercise.source.line >= section.lineStart
        && exercise.source.line <= section.lineEnd);
      for (const exercise of exercises) {
        const button = element.createEl("button", { cls: `translation-inline-access is-${exercise.stage}` });
        button.setAttr("data-translation-id", exercise.id);
        button.createSpan({ cls: "translation-inline-access-dot" });
        button.createSpan({
          text: exercise.stage === "prepare" ? "整理原文"
            : exercise.stage === "translate" ? "继续初译"
              : exercise.stage === "waitingBackTranslation" ? "等待回译"
                : exercise.stage === "backTranslate" ? "继续回译"
                  : exercise.stage === "compare" ? "继续对照"
                    : "查看练习",
        });
        button.addEventListener("click", () => void this.openTranslationStudy(exercise.id));
      }
    });

    this.addCommand({
      id: "capture-selection-as-pattern",
      name: "测试新版 Maker 坐标与关系",
      editorCallback: (editor, view) => this.captureSelection(editor, view),
    });
    this.addCommand({ id: "open-pattern-library", name: "打开 Pattern 管理", callback: () => void this.openPatternLibrary() });
    this.addCommand({ id: "open-pattern-tag-manager", name: "打开 Pattern Tag 管理", callback: () => void this.openTagManager() });
    this.addCommand({ id: "open-translation-study", name: "打开翻译练习", callback: () => void this.openTranslationStudy() });
    this.addCommand({ id: "new-translation-study", name: "录入翻译练习", callback: () => void this.openTranslationCapture() });
    this.addCommand({
      id: "create-translation-study-from-selection",
      name: "用选中文本开始翻译练习",
      editorCallback: (editor, view) => void this.captureSelectionAsTranslation(editor, view),
    });
    this.addCommand({ id: "reload-pattern-data-from-vault", name: "从 Vault 重新加载全部数据", callback: () => void this.reloadFromVault() });

    this.addRibbonIcon("library", "打开 Pattern 管理", () => void this.openPatternLibrary());
    this.addRibbonIcon("tags", "打开 Pattern Tag 管理", () => void this.openTagManager());
    this.addRibbonIcon("languages", "打开翻译练习", () => void this.openTranslationStudy());
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      if (!editor.getSelection().trim()) return;
      menu.addItem((item) => item.setTitle("测试新版 Maker 坐标与关系").setIcon("scan-text").onClick(() => this.captureSelection(editor, view)));
      menu.addItem((item) => item
        .setTitle("用选中文本开始翻译练习")
        .setIcon("languages")
        .onClick(() => void this.captureSelectionAsTranslation(editor, view)));
    }));
  }

  onunload(): void {
    this.dataChangeListeners.clear();
  }

  private async loadVaultData(): Promise<void> {
    await this.ensureStorageFolder();
    if (!(await this.app.vault.adapter.exists(SETTINGS_FILE))) await this.writeJsonFile(SETTINGS_FILE, DEFAULT_SETTINGS);
    if (!(await this.app.vault.adapter.exists(TAGS_FILE))) await this.writeJsonFile(TAGS_FILE, { schemaVersion: TAG_SCHEMA_VERSION, tags: [] });
    if (!(await this.app.vault.adapter.exists(TRANSLATIONS_FILE))) {
      await this.writeJsonFile(TRANSLATIONS_FILE, { schemaVersion: TRANSLATION_SCHEMA_VERSION, exercises: [] });
    }
    if (!(await this.app.vault.adapter.exists(PATTERNS_FILE))) {
      const legacy = (await this.loadData()) as { patterns?: unknown[] } | null;
      await this.writeJsonFile(PATTERNS_FILE, { schemaVersion: PATTERN_SCHEMA_VERSION, patterns: Array.isArray(legacy?.patterns) ? legacy.patterns : [] });
    }

    const loadedSettings = await this.readJsonFile<Partial<PluginSettings>>(SETTINGS_FILE);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
      translationWorkbenchModes: {
        ...DEFAULT_SETTINGS.translationWorkbenchModes,
        ...(loadedSettings.translationWorkbenchModes ?? {}),
      },
      schemaVersion: SETTINGS_SCHEMA_VERSION,
    };

    const loadedTags = await this.readJsonFile<{ tags?: unknown[] }>(TAGS_FILE);
    const now = new Date().toISOString();
    const tags: PatternTag[] = [];
    for (const raw of Array.isArray(loadedTags.tags) ? loadedTags.tags : []) {
      if (!raw || typeof raw !== "object") continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.name !== "string" || !value.name.trim()) continue;
      tags.push({
        id: value.id,
        name: value.name.trim(),
        description: typeof value.description === "string" ? value.description : "",
        aliases: normalizeStringArray(value.aliases),
        parentId: typeof value.parentId === "string" ? value.parentId : null,
        obsidianTags: normalizeStringArray(value.obsidianTags),
        createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
      });
    }
    const tagIds = new Set(tags.map((tag) => tag.id));
    for (const tag of tags) {
      if (tag.parentId === tag.id || (tag.parentId && !tagIds.has(tag.parentId))) tag.parentId = null;
    }
    this.tagData = { schemaVersion: TAG_SCHEMA_VERSION, tags };

    const loadedPatterns = await this.readJsonFile<{ patterns?: unknown[] }>(PATTERNS_FILE);
    const patterns: StoredPattern[] = [];
    let tagDataChangedByMigration = false;
    for (const raw of Array.isArray(loadedPatterns.patterns) ? loadedPatterns.patterns : []) {
      if (!raw || typeof raw !== "object") continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.text !== "string" || !Array.isArray(value.sources)) continue;
      const sources = value.sources.filter((source): source is PatternSource => {
        if (!source || typeof source !== "object") return false;
        const item = source as Record<string, unknown>;
        return typeof item.filePath === "string" && typeof item.line === "number" && typeof item.column === "number" && typeof item.capturedAt === "string";
      });
      const createdAt = typeof value.createdAt === "string" ? value.createdAt : now;
      const patternTagIds = normalizeStringArray(value.tagIds).filter((id) => tagIds.has(id));
      const legacyTagPath = typeof value.kind === "string" ? LEGACY_KIND_TAG_PATHS[value.kind] : undefined;
      if (legacyTagPath) {
        const legacyTag = this.ensureTagPathInMemory(legacyTagPath, now);
        if (!patternTagIds.includes(legacyTag.id)) patternTagIds.push(legacyTag.id);
        tagIds.add(legacyTag.id);
        tagDataChangedByMigration = true;
      }
      patterns.push({
        id: value.id,
        text: value.text,
        language: normalizeLanguage(value.language, value.text),
        structure: normalizeStoredStructure(value.structure, value.text),
        note: typeof value.note === "string" ? value.note : "",
        tagIds: patternTagIds,
        createdAt,
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : createdAt,
        sources,
      });
    }
    this.patternData = { schemaVersion: PATTERN_SCHEMA_VERSION, patterns };

    const loadedTranslations = await this.readJsonFile<unknown>(TRANSLATIONS_FILE);
    this.translationData = normalizeTranslationData(loadedTranslations);
    if (
      loadedTranslations
      && typeof loadedTranslations === "object"
      && (loadedTranslations as { schemaVersion?: number }).schemaVersion !== TRANSLATION_SCHEMA_VERSION
    ) {
      await this.saveTranslationData();
    }

    if (loadedPatterns && (loadedPatterns as { schemaVersion?: number }).schemaVersion !== PATTERN_SCHEMA_VERSION) {
      await this.savePatternData(false);
    }
    if (tagDataChangedByMigration || (loadedTags && (loadedTags as { schemaVersion?: number }).schemaVersion !== TAG_SCHEMA_VERSION)) {
      await this.saveTagData(false);
    }
  }

  private async ensureStorageFolder(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(STORAGE_FOLDER))) {
      await this.app.vault.adapter.mkdir(STORAGE_FOLDER);
    }
  }

  private async readJsonFile<T>(path: string): Promise<T> {
    const content = (await this.app.vault.adapter.read(path)).replace(/^\uFEFF/u, "").trim();
    if (!content) throw new Error(`${path} 是空文件`);
    try { return JSON.parse(content) as T; }
    catch (error) { throw new Error(`${path} 格式错误：${describeError(error)}`); }
  }

  private async writeJsonFile(path: string, value: unknown): Promise<void> {
    await this.app.vault.adapter.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async savePatternData(notify = true): Promise<void> {
    await this.writeJsonFile(PATTERNS_FILE, this.patternData);
    if (notify) this.notifyDataChanged();
  }

  private async saveTagData(notify = true): Promise<void> {
    await this.writeJsonFile(TAGS_FILE, this.tagData);
    if (notify) this.notifyDataChanged();
  }

  async saveTranslationData(): Promise<void> {
    await this.writeJsonFile(TRANSLATIONS_FILE, this.translationData);
  }

  private async reloadFromVault(): Promise<void> {
    try {
      await this.loadVaultData();
      this.storageReady = true;
      this.notifyDataChanged();
      new Notice(`已从 ${STORAGE_FOLDER} 重新加载 Pattern、Tag 和设置。`);
    } catch (error) {
      this.storageReady = false;
      new Notice(`重新加载失败：${describeError(error)}`, 10000);
    }
  }

  private captureSelection(editor: Editor, view: MarkdownView | MarkdownFileInfo): void {
    if (!this.storageReady) {
      new Notice(`数据尚未就绪，请检查 ${STORAGE_FOLDER} 文件夹。`);
      return;
    }
    const selectedText = editor.getSelection().trim();
    if (!selectedText) {
      new Notice("请先选择要收集的文字。");
      return;
    }
    if (!view.file) {
      new Notice("当前笔记还没有可记录的文件位置。");
      return;
    }
    const cursor = editor.getCursor("from");
    const source: PatternSource = {
      filePath: view.file.path,
      line: cursor.line,
      column: cursor.ch,
      capturedAt: new Date().toISOString(),
    };
    new PatternBoundaryPreviewModal(this.app, { sourceText: selectedText }).open();
  }

  private async captureSelectionAsTranslation(
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
  ): Promise<void> {
    if (!this.storageReady) {
      new Notice(`数据尚未就绪，请检查 ${STORAGE_FOLDER}。`);
      return;
    }
    const selectedText = editor.getSelection().trim();
    if (!selectedText) {
      new Notice("请先选择要翻译的原文。");
      return;
    }
    const cursor = editor.getCursor("from");
    const endCursor = editor.getCursor("to");
    const source: TranslationSource | undefined = view.file
      ? {
        filePath: view.file.path,
        line: cursor.line,
        column: cursor.ch,
        endLine: endCursor.line,
        endColumn: endCursor.ch,
        capturedAt: new Date().toISOString(),
      }
      : undefined;
    await this.openTranslationCapture(selectedText, source);
  }

  async createTranslationExercise(
    text: string,
    title: string,
    language: TranslationLanguage,
    source?: TranslationSource,
  ): Promise<TranslationExercise> {
    if (!this.storageReady) throw new Error("数据尚未就绪。");
    const exercise = createTranslationExerciseModel(text, { title, language, source });
    this.translationData.exercises.unshift(exercise);
    await this.saveTranslationData();
    return exercise;
  }

  async deleteTranslationExercise(exerciseId: string): Promise<boolean> {
    const exercise = this.translationData.exercises.find((item) => item.id === exerciseId);
    if (!exercise) return false;
    const confirmed = await requestConfirmation(this.app, {
      heading: "删除翻译练习？",
      message: exercise.title,
      detail: "原笔记不会被修改。",
      confirmLabel: "删除",
    });
    if (!confirmed) return false;
    this.translationData.exercises = this.translationData.exercises
      .filter((item) => item.id !== exerciseId);
    await this.saveTranslationData();
    return true;
  }

  openPatternEditor(pattern: StoredPattern): void {
    new PatternEditorModal(this.app, this, { pattern }).open();
  }

  openPatternStructureEditor(pattern: StoredPattern): void {
    new PatternBoundaryPreviewModal(this.app, {
      sourceText: pattern.structure.sourceText || pattern.text,
      language: pattern.language === "en" || pattern.language === "ja" ? pattern.language : undefined,
    }).open();
  }

  private async savePatternFromMaker(result: PatternMakerResult, source: PatternSource): Promise<void> {
    if (!result.displayText) throw new Error("Pattern 结构还是空的。");
    const existing = this.patternData.patterns.find((pattern) =>
      pattern.text === result.displayText && pattern.structure.kind === result.structure.kind,
    );
    if (existing) {
      if (!existing.sources.some((item) => item.filePath === source.filePath && item.line === source.line && item.column === source.column)) {
        existing.sources.push(source);
      }
      existing.structure = result.structure;
      existing.language = result.language;
      existing.updatedAt = new Date().toISOString();
      await this.savePatternData();
      new Notice(`已补充现有 Pattern：${existing.text}`);
      return;
    }
    const now = new Date().toISOString();
    const pattern: StoredPattern = {
      id: createId("pattern"),
      text: result.displayText,
      language: result.language,
      structure: result.structure,
      note: "",
      tagIds: [],
      createdAt: now,
      updatedAt: now,
      sources: [source],
    };
    this.patternData.patterns.unshift(pattern);
    await this.savePatternData();
    new Notice(`已保存 Pattern：${pattern.text}`);
  }

  async savePatternDraft(draft: PatternDraft): Promise<{ pattern: StoredPattern; created: boolean }> {
    if (!this.storageReady) throw new Error("数据尚未就绪。");
    const duplicate = this.patternData.patterns.find((pattern) => pattern.id !== draft.id && pattern.text === draft.text);
    if (draft.id && duplicate) {
      throw new Error(`已经存在相同内容的 Pattern：${duplicate.text}`);
    }
    const validTagIds = await this.resolveTagPaths(draft.tagPaths);
    const existing = draft.id
      ? this.patternData.patterns.find((pattern) => pattern.id === draft.id)
      : duplicate;
    const now = new Date().toISOString();
    if (existing) {
      existing.text = draft.text;
      existing.language = draft.language;
      existing.note = draft.note;
      existing.tagIds = [...new Set(validTagIds)];
      existing.updatedAt = now;
      if (draft.source && !existing.sources.some((source) => source.filePath === draft.source?.filePath && source.line === draft.source.line && source.column === draft.source.column)) {
        existing.sources.push(draft.source);
      }
      await this.savePatternData();
      return { pattern: existing, created: false };
    }
    const pattern: StoredPattern = {
      id: createId("pattern"),
      text: draft.text,
      language: draft.language,
      structure: normalizeStoredStructure(undefined, draft.text),
      note: draft.note,
      tagIds: [...new Set(validTagIds)],
      createdAt: now,
      updatedAt: now,
      sources: draft.source ? [draft.source] : [],
    };
    this.patternData.patterns.unshift(pattern);
    await this.savePatternData();
    return { pattern, created: true };
  }

  async saveTagPath(input: { id?: string; path: string; description: string; aliases: string[]; obsidianTags: string[] }): Promise<PatternTag> {
    if (!this.storageReady) throw new Error("数据尚未就绪。");
    const normalizedPath = normalizeTagPath(input.path);
    const segments = normalizedPath.split("/");
    const name = segments.pop();
    if (!name) throw new Error("Tag 路径不能为空。");
    const now = new Date().toISOString();
    const existing = input.id ? this.getTag(input.id) : undefined;
    const parentPath = segments.join("/");
    const existingAtPath = this.findTagByPath(normalizedPath);
    if (existingAtPath && existingAtPath.id !== input.id) {
      throw new Error(`路径“${normalizedPath}”已经存在。`);
    }
    if (existing) {
      const oldPath = this.getTagSlashPath(existing.id).toLocaleLowerCase();
      const targetParentPath = parentPath.toLocaleLowerCase();
      if (targetParentPath === oldPath || targetParentPath.startsWith(`${oldPath}/`)) {
        throw new Error("不能把 Tag 移到自己的子 Tag 下面。");
      }
    }
    const parent = parentPath ? this.ensureTagPathInMemory(parentPath, now) : undefined;
    const parentId = parent?.id ?? null;
    if (existing && parentId && (parentId === existing.id || this.getDescendantTagIds(existing.id).includes(parentId))) {
      throw new Error("不能把 Tag 移到自己的子 Tag 下面。");
    }
    const collision = this.tagData.tags.find((tag) =>
      tag.id !== input.id
      && tag.parentId === parentId
      && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (collision) throw new Error(`路径“${normalizedPath}”已经存在。`);
    if (existing) {
      existing.name = name;
      existing.description = input.description.trim();
      existing.aliases = normalizeStringArray(input.aliases).filter((alias) => alias.toLocaleLowerCase() !== name.toLocaleLowerCase());
      existing.parentId = parentId;
      existing.obsidianTags = normalizeStringArray(input.obsidianTags);
      existing.updatedAt = now;
      await this.saveTagData();
      return existing;
    }
    const tag = this.ensureTagPathInMemory(normalizedPath, now);
    tag.description = input.description.trim();
    tag.aliases = normalizeStringArray(input.aliases).filter((alias) => alias.toLocaleLowerCase() !== name.toLocaleLowerCase());
    tag.obsidianTags = normalizeStringArray(input.obsidianTags);
    tag.updatedAt = now;
    await this.saveTagData();
    return tag;
  }

  private async resolveTagPaths(paths: string[]): Promise<string[]> {
    const beforeCount = this.tagData.tags.length;
    const ids: string[] = [];
    const seenPaths = new Set<string>();
    const now = new Date().toISOString();
    for (const rawPath of paths) {
      const path = normalizeTagPath(rawPath);
      const key = path.toLocaleLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      ids.push(this.ensureTagPathInMemory(path, now).id);
    }
    if (this.tagData.tags.length !== beforeCount) await this.saveTagData(false);
    return ids;
  }

  async deletePattern(patternId: string): Promise<void> {
    const pattern = this.patternData.patterns.find((item) => item.id === patternId);
    if (!pattern) return;
    const confirmed = await requestConfirmation(this.app, {
      heading: "删除 Pattern？",
      message: pattern.text,
      detail: "这个操作会从 Pattern 库中移除该条目，不会修改原始笔记。",
      confirmLabel: "删除 Pattern",
    });
    if (!confirmed) return;
    this.patternData.patterns = this.patternData.patterns.filter((item) => item.id !== patternId);
    await this.savePatternData();
    new Notice(`已删除 Pattern：${pattern.text}`);
  }

  async deleteTag(tagId: string): Promise<void> {
    const tag = this.getTag(tagId);
    if (!tag) return;
    const children = this.tagData.tags.filter((item) => item.parentId === tagId);
    const blockedChild = children.find((child) => this.tagData.tags.some((candidate) =>
      candidate.id !== child.id
      && candidate.id !== tag.id
      && candidate.parentId === tag.parentId
      && candidate.name.toLocaleLowerCase() === child.name.toLocaleLowerCase(),
    ));
    if (blockedChild) {
      new Notice(`暂时不能删除“${tag.name}”：移动子 Tag“${blockedChild.name}”后会产生重复路径。请先移动或重命名该子 Tag。`, 9000);
      return;
    }
    const linkedCount = this.patternData.patterns.filter((pattern) => pattern.tagIds.includes(tagId)).length;
    const details = [
      children.length > 0 ? `${children.length} 个直接子 Tag 会移动到“${tag.parentId ? this.getTag(tag.parentId)?.name ?? "顶层" : "顶层"}”` : "",
      linkedCount > 0 ? `${linkedCount} 条 Pattern 会解除与它的关联` : "",
    ].filter(Boolean).join("；");
    const confirmed = await requestConfirmation(this.app, {
      heading: "删除 Pattern Tag？",
      message: this.getTagSlashPath(tag.id),
      detail: details ? `${details}。` : "这个 Tag 当前没有子 Tag 或直接关联的 Pattern。",
      confirmLabel: "删除 Tag",
    });
    if (!confirmed) return;
    for (const child of children) child.parentId = tag.parentId;
    this.tagData.tags = this.tagData.tags.filter((item) => item.id !== tagId);
    for (const pattern of this.patternData.patterns) pattern.tagIds = pattern.tagIds.filter((id) => id !== tagId);
    await this.saveTagData(false);
    await this.savePatternData();
    new Notice(`已删除 Tag：${tag.name}`);
  }

  getTag(id: string): PatternTag | undefined { return this.tagData.tags.find((tag) => tag.id === id); }

  findTagByPath(path: string): PatternTag | undefined {
    let normalized: string;
    try { normalized = normalizeTagPath(path); }
    catch { return undefined; }
    let parentId: string | null = null;
    let current: PatternTag | undefined;
    for (const segment of normalized.split("/")) {
      current = this.tagData.tags.find((tag) =>
        tag.parentId === parentId
        && tag.name.toLocaleLowerCase() === segment.toLocaleLowerCase(),
      );
      if (!current) return undefined;
      parentId = current.id;
    }
    return current;
  }

  getTagSlashPath(id: string): string {
    const names: string[] = [];
    const visited = new Set<string>();
    let current = this.getTag(id);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? this.getTag(current.parentId) : undefined;
    }
    return names.join("/");
  }

  getTranslationTagPath(id: string): string {
    return this.getTagSlashPath(id);
  }

  getObsidianTags(): readonly string[] {
    const tags = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      for (const tag of getAllTags(cache) ?? []) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right, "zh-CN"));
  }

  async saveTranslationTag(path: string, obsidianTags: string[]): Promise<PatternTag> {
    const existing = this.findTagByPath(path);
    return this.saveTagPath({
      id: existing?.id,
      path,
      description: existing?.description ?? "",
      aliases: existing?.aliases ?? [],
      obsidianTags: [...new Set([...(existing?.obsidianTags ?? []), ...obsidianTags])],
    });
  }

  getAllTagPaths(): string[] {
    return this.tagData.tags
      .map((tag) => this.getTagSlashPath(tag.id))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
  }

  private ensureTagPathInMemory(path: string, now: string): PatternTag {
    const normalized = normalizeTagPath(path);
    let parentId: string | null = null;
    let current: PatternTag | undefined;
    for (const segment of normalized.split("/")) {
      current = this.tagData.tags.find((tag) =>
        tag.parentId === parentId
        && tag.name.toLocaleLowerCase() === segment.toLocaleLowerCase(),
      );
      if (!current) {
        current = {
          id: createId("tag"),
          name: segment,
          description: "",
          aliases: [],
          parentId,
          obsidianTags: [],
          createdAt: now,
          updatedAt: now,
        };
        this.tagData.tags.push(current);
      }
      parentId = current.id;
    }
    if (!current) throw new Error("Tag 路径不能为空。");
    return current;
  }

  getDescendantTagIds(id: string): string[] {
    const descendants: string[] = [];
    const queue = [id];
    const visited = new Set(queue);
    while (queue.length > 0) {
      const parentId = queue.shift();
      for (const tag of this.tagData.tags) {
        if (tag.parentId === parentId && !visited.has(tag.id)) {
          visited.add(tag.id);
          descendants.push(tag.id);
          queue.push(tag.id);
        }
      }
    }
    return descendants;
  }

  getTagTreeRows(): TagTreeRow[] {
    const rows: TagTreeRow[] = [];
    const seen = new Set<string>();
    const addChildren = (parentId: string | null, depth: number): void => {
      const children = this.tagData.tags
        .filter((tag) => tag.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      for (const tag of children) {
        if (seen.has(tag.id)) continue;
        seen.add(tag.id);
        rows.push({ tag, depth });
        addChildren(tag.id, depth + 1);
      }
    };
    addChildren(null, 0);
    for (const tag of this.tagData.tags) {
      if (!seen.has(tag.id)) rows.push({ tag, depth: 0 });
    }
    return rows;
  }

  getPatternsForTag(tagId: string, includeDescendants: boolean): StoredPattern[] {
    const ids = new Set([tagId, ...(includeDescendants ? this.getDescendantTagIds(tagId) : [])]);
    return this.patternData.patterns.filter((pattern) => pattern.tagIds.some((id) => ids.has(id)));
  }

  async openFirstSource(pattern: StoredPattern): Promise<void> {
    const source = pattern.sources[0];
    if (!source) { new Notice("这个 Pattern 没有来源记录。"); return; }
    const file = this.app.vault.getAbstractFileByPath(source.filePath);
    if (!(file instanceof TFile)) { new Notice(`找不到来源文件：${source.filePath}`); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true });
    if (leaf.view instanceof MarkdownView) {
      leaf.view.editor.setCursor({ line: source.line, ch: source.column });
      leaf.view.editor.scrollIntoView({ from: { line: source.line, ch: source.column }, to: { line: source.line, ch: source.column + pattern.text.length } }, true);
    }
  }

  getActiveDocumentText(): string {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getValue() ?? "";
  }

  async openPatternLibrary(): Promise<void> {
    const leaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_PATTERN_LIBRARY)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit)
      ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PATTERN_LIBRARY, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openTagManager(): Promise<void> {
    const leaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_TAG_MANAGER)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit)
      ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TAG_MANAGER, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openTranslationStudy(exerciseId?: string): Promise<void> {
    const leaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_TRANSLATION_STUDY)
      .find((candidate) => candidate.getRoot() === this.app.workspace.rootSplit)
      ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_TRANSLATION_STUDY, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (exerciseId && leaf.view instanceof TranslationStudyView) {
      leaf.view.selectExercise(exerciseId);
    }
  }

  async openTranslationCapture(initialText = "", source?: TranslationSource): Promise<void> {
    new TranslationCaptureModal(this.app, {
      initialText,
      source,
      onSubmit: async (text, title, language, action) => {
        const exercise = await this.createTranslationExercise(text, title, language, source);
        if (action === "start") {
          await this.openTranslationStudy(exercise.id);
        } else {
          new Notice(`已保存到待整理：${exercise.title}`);
        }
      },
    }).open();
  }

  async openTranslationSource(exercise: TranslationExercise): Promise<void> {
    const source = exercise.source;
    if (!source) return;
    const file = this.app.vault.getAbstractFileByPath(source.filePath);
    if (!(file instanceof TFile)) {
      new Notice(`找不到来源文件：${source.filePath}`);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true });
    if (leaf.view instanceof MarkdownView) {
      leaf.view.editor.setCursor({ line: source.line, ch: source.column });
      leaf.view.editor.scrollIntoView({
        from: { line: source.line, ch: source.column },
        to: { line: source.line, ch: source.column + 1 },
      }, true);
    }
  }

  private createEditorExtension() {
    const plugin = this;
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private readonly unsubscribe: () => void;
        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, plugin.patterns, plugin.settings);
          this.unsubscribe = plugin.onDataChanged(() => view.dispatch({ effects: refreshPatternDecorations.of(undefined) }));
        }
        update(update: ViewUpdate): void {
          const needsRefresh = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshPatternDecorations)));
          if (update.docChanged || needsRefresh) this.decorations = buildDecorations(update.view, plugin.patterns, plugin.settings);
        }
        destroy(): void { this.unsubscribe(); }
      },
      { decorations: (instance) => instance.decorations },
    );
  }

  private onDataChanged(listener: () => void): () => void {
    this.dataChangeListeners.add(listener);
    return () => this.dataChangeListeners.delete(listener);
  }

  private notifyDataChanged(): void {
    for (const listener of this.dataChangeListeners) listener();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PATTERN_LIBRARY)) {
      if (leaf.view instanceof PatternLibraryView) leaf.view.render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TAG_MANAGER)) {
      if (leaf.view instanceof TagManagerView) leaf.view.render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSLATION_STUDY)) {
      if (leaf.view instanceof TranslationStudyView) leaf.view.render();
    }
  }
}
