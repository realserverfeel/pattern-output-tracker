import {
  App,
  ItemView,
  Menu,
  Modal,
  Notice,
  setIcon,
  WorkspaceLeaf,
} from "obsidian";
import {
  addTranslationRelation,
  assignTranslationBlockRange,
  autoAssignTranslationExercise,
  createTranslationExercise,
  createTranslationId,
  findTranslationUnit,
  getBackTranslationTiming,
  getTranslationSegments,
  getTranslationBlockUnitSeparators,
  getTranslationStageProgress,
  getTranslationUnits,
  hasUnassignedTranslationText,
  mergeAssignedTranslationUnits,
  normalizeTextRanges,
  reopenTranslationUnits,
  resetTranslationSegmentation,
  scheduleBackTranslation,
  setTranslationNote,
  setTranslationStage,
  suggestTranslationTitle,
  TranslationExercise,
  TranslationLanguage,
  TranslationNote,
  TranslationRelation,
  TranslationRelationLayer,
  TranslationSource,
  TranslationStage,
  TranslationTextRange,
  TranslationUnit,
  TranslationUnitStatus,
  updateTranslationUnitText,
} from "./translation-model";

export const VIEW_TYPE_TRANSLATION_STUDY = "pattern-output-tracker-translation-study";

export interface TranslationStudyHost {
  readonly translationExercises: readonly TranslationExercise[];
  readonly defaultBackTranslationDelayDays: number;
  readonly translationTags: readonly TranslationTagOption[];
  createTranslationExercise(
    text: string,
    title: string,
    language: TranslationLanguage,
    source?: TranslationSource,
  ): Promise<TranslationExercise>;
  saveTranslationData(): Promise<void>;
  deleteTranslationExercise(id: string): Promise<boolean>;
  openTranslationSource(exercise: TranslationExercise): Promise<void>;
  getTranslationTagPath(id: string): string;
  getObsidianTags(): readonly string[];
  saveTranslationTag(path: string, obsidianTags: string[]): Promise<TranslationTagOption>;
  getTranslationWorkbenchMode(stage: TranslationWorkbenchStage): TranslationWorkbenchMode;
  setTranslationWorkbenchMode(stage: TranslationWorkbenchStage, mode: TranslationWorkbenchMode): Promise<void>;
  getNoteEditorHeight(): number | null;
  setNoteEditorHeight(height: number): Promise<void>;
}

export interface TranslationTagOption {
  id: string;
  name: string;
  aliases: string[];
  obsidianTags: string[];
}

type TranslationPage = "library" | "records" | "task" | "article";
export type CaptureAction = "save" | "start";
export type TranslationWorkbenchStage = "translate" | "backTranslate" | "compare";
export type TranslationWorkbenchMode = "unit" | "full";
type CompletedProjection = "sourceText" | "translation" | "backTranslation";

interface RelationDraftSelection {
  side: "left" | "right";
  range: TranslationTextRange;
}

interface RelationDraft {
  layer: TranslationRelationLayer;
  left: TranslationTextRange[];
  right: TranslationTextRange[];
  history: RelationDraftSelection[];
}

interface ActiveRelation {
  unitId: string;
  layer: TranslationRelationLayer;
  relationId: string;
}

const STAGE_LABELS: Record<TranslationStage, string> = {
  prepare: "待整理",
  translate: "初译中",
  waitingBackTranslation: "等待回译",
  backTranslate: "回译中",
  compare: "对照中",
  complete: "已完成",
};

const STAGE_INDEX: Record<TranslationStage, number> = {
  prepare: 0,
  translate: 1,
  waitingBackTranslation: 2,
  backTranslate: 3,
  compare: 4,
  complete: 5,
};

const LANGUAGE_LABELS: Record<TranslationLanguage, string> = {
  en: "英语",
  ja: "日语",
};

function iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "translation-icon-button" });
  button.type = "button";
  button.setAttr("aria-label", label);
  button.setAttr("title", label);
  setIcon(button, icon);
  return button;
}

function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date);
}

function normalizeNativeTag(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith("#") ? trimmed : `#${trimmed}`).toLocaleLowerCase();
}

function cloneExercise(exercise: TranslationExercise): TranslationExercise {
  return JSON.parse(JSON.stringify(exercise)) as TranslationExercise;
}

function replaceExercise(target: TranslationExercise, snapshot: TranslationExercise): void {
  for (const key of Object.keys(target) as (keyof TranslationExercise)[]) delete target[key];
  Object.assign(target, cloneExercise(snapshot));
}

function statusForStage(unit: TranslationUnit, stage: TranslationStage): TranslationUnitStatus {
  if (stage === "translate" || stage === "waitingBackTranslation") return unit.translation.trim() ? "draft" : "empty";
  if (stage === "backTranslate") return unit.backTranslation.trim() ? "draft" : "empty";
  if (stage === "compare" || stage === "complete") return unit.backTranslation.trim() ? "draft" : "empty";
  return "empty";
}

type FullTextField = "sourceText" | "translation" | "backTranslation";

function fullTextJoiner(left: string, right: string): string {
  if (!left || !right || /\s$/u.test(left) || /^\s/u.test(right)) return "";
  const last = left.at(-1) ?? "";
  const first = right[0] ?? "";
  const cjkOrFullwidth = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/u;
  return cjkOrFullwidth.test(last) || cjkOrFullwidth.test(first) ? "" : " ";
}

function fullTextSeparator(field: FullTextField, left: string, right: string, sourceSeparator: string): string {
  if (field === "sourceText") return sourceSeparator;
  if (/\r|\n/u.test(sourceSeparator)) return sourceSeparator;
  return fullTextJoiner(left, right);
}

function captureTextRange(root: HTMLElement, clearSelection = true): TranslationTextRange | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const from = before.toString().length;
  const to = from + range.toString().length;
  if (clearSelection) selection.removeAllRanges();
  return to > from ? { from, to } : null;
}

function renderRangeText(
  root: HTMLElement,
  text: string,
  relations: readonly TranslationRelation[],
  side: "left" | "right",
  draft: readonly TranslationTextRange[] = [],
  activeRelationId?: string,
): void {
  root.empty();
  const boundaries = new Set([0, text.length]);
  for (const relation of relations) {
    for (const range of side === "left" ? relation.leftRanges : relation.rightRanges) {
      boundaries.add(range.from);
      boundaries.add(range.to);
    }
  }
  for (const range of draft) {
    boundaries.add(range.from);
    boundaries.add(range.to);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index] ?? 0;
    const to = sorted[index + 1] ?? text.length;
    if (to <= from) continue;
    const relationIndex = relations.findIndex((relation) =>
      (side === "left" ? relation.leftRanges : relation.rightRanges)
        .some((range) => range.from <= from && range.to >= to));
    const isDraft = draft.some((range) => range.from <= from && range.to >= to);
    const span = root.createSpan({ text: text.slice(from, to) });
    if (relationIndex >= 0) {
      const relation = relations[relationIndex];
      span.addClass("is-related");
      span.style.setProperty("--relation-index", String(relationIndex % 6));
      span.setAttr("data-relation-index", String(relationIndex));
      if (relation) span.setAttr("data-relation-id", relation.id);
      if (relation?.id === activeRelationId) span.addClass("is-active-relation");
    }
    if (isDraft) span.addClass("is-draft-range");
  }
}

export class TranslationCaptureModal extends Modal {
  private text: string;
  private title = "";
  private language: TranslationLanguage;
  private titleEdited = false;
  private readonly source?: TranslationSource;
  private readonly onSubmit: (
    text: string,
    title: string,
    language: TranslationLanguage,
    action: CaptureAction,
  ) => Promise<void>;

  constructor(
    app: App,
    options: {
      initialText?: string;
      source?: TranslationSource;
      onSubmit: (
        text: string,
        title: string,
        language: TranslationLanguage,
        action: CaptureAction,
      ) => Promise<void>;
    },
  ) {
    super(app);
    this.text = options.initialText ?? "";
    this.language = /[\u3040-\u30ff]/u.test(this.text) ? "ja" : "en";
    this.title = suggestTranslationTitle(this.text);
    this.source = options.source;
    this.onSubmit = options.onSubmit;
  }

  onOpen(): void {
    this.modalEl.addClass("translation-capture-modal");
    this.contentEl.empty();
    const top = this.contentEl.createDiv({ cls: "translation-capture-heading" });
    top.createDiv({ cls: "translation-eyebrow", text: this.source ? "FROM SELECTION" : "NEW TEXT" });
    top.createEl("h2", { text: "录入翻译练习" });

    const languageGroup = this.contentEl.createDiv({ cls: "translation-capture-language" });
    languageGroup.createDiv({ cls: "translation-field-label", text: "原文语言" });
    const languageTabs = languageGroup.createDiv({ cls: "translation-segmented" });
    const languageButtons = (["en", "ja"] as TranslationLanguage[]).map((language) => {
      const button = languageTabs.createEl("button", { text: LANGUAGE_LABELS[language] });
      button.type = "button";
      button.toggleClass("is-active", language === this.language);
      button.addEventListener("click", () => {
        this.language = language;
        for (const candidate of languageButtons) candidate.toggleClass("is-active", candidate === button);
      });
      return button;
    });

    const titleLabel = this.contentEl.createEl("label", { cls: "translation-field" });
    titleLabel.createSpan({ cls: "translation-field-label", text: "标题" });
    const titleInput = titleLabel.createEl("input", { type: "text" });
    titleInput.value = this.title;
    titleInput.addEventListener("input", () => {
      this.titleEdited = true;
      this.title = titleInput.value;
      updateActions();
    });

    const sourceLabel = this.contentEl.createEl("label", { cls: "translation-field" });
    sourceLabel.createSpan({ cls: "translation-field-label", text: "原文" });
    const sourceArea = sourceLabel.createEl("textarea");
    sourceArea.rows = 11;
    sourceArea.placeholder = "粘贴文章或短段落";
    sourceArea.value = this.text;
    sourceArea.addEventListener("input", () => {
      this.text = sourceArea.value;
      if (!this.titleEdited) {
        this.title = suggestTranslationTitle(this.text);
        titleInput.value = this.title;
      }
      updateActions();
    });

    const sourceHint = this.contentEl.createDiv({
      cls: "translation-capture-source-hint",
      text: this.source ? `来自 ${this.source.filePath}` : "保留自然段；之后再切分为练习单位。",
    });
    const actions = this.contentEl.createDiv({ cls: "translation-capture-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "保存" });
    const start = actions.createEl("button", { text: "开始整理", cls: "mod-cta" });
    const updateActions = (): void => {
      const disabled = !this.text.trim() || !this.title.trim();
      save.disabled = disabled;
      start.disabled = disabled;
    };
    const submit = async (action: CaptureAction): Promise<void> => {
      if (!this.text.trim() || !this.title.trim()) return;
      save.disabled = true;
      start.disabled = true;
      try {
        await this.onSubmit(this.text.trim(), this.title.trim(), this.language, action);
        this.close();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 7000);
        updateActions();
      }
    };
    save.addEventListener("click", () => void submit("save"));
    start.addEventListener("click", () => void submit("start"));
    sourceArea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void submit("start");
      }
    });
    updateActions();
    window.setTimeout(() => (this.text ? titleInput : sourceArea).focus(), 30);
  }
}

class TranslationRenameModal extends Modal {
  constructor(
    app: App,
    private readonly exercise: TranslationExercise,
    private readonly onSave: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("translation-rename-modal");
    this.setTitle("修改标题");
    let title = this.exercise.title;
    const input = this.contentEl.createEl("input", { type: "text", cls: "translation-rename-input" });
    input.value = title;
    input.addEventListener("input", () => { title = input.value; });
    const actions = this.contentEl.createDiv({ cls: "translation-capture-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "保存", cls: "mod-cta" }).addEventListener("click", async () => {
      if (!title.trim()) return;
      this.exercise.title = title.trim();
      this.exercise.updatedAt = new Date().toISOString();
      await this.onSave();
      this.close();
    });
    window.setTimeout(() => { input.focus(); input.select(); }, 20);
  }
}

class BackTranslationScheduleModal extends Modal {
  private due: string;

  constructor(
    app: App,
    defaultDelayDays: number,
    private readonly onConfirm: (dueAt: string) => Promise<void>,
  ) {
    super(app);
    const date = new Date();
    date.setDate(date.getDate() + defaultDelayDays);
    this.due = date.toISOString().slice(0, 10);
  }

  onOpen(): void {
    this.modalEl.addClass("translation-schedule-modal");
    this.setTitle("完成初译");
    this.contentEl.createDiv({ cls: "translation-modal-lead", text: "下次回译" });
    const input = this.contentEl.createEl("input", { type: "date", cls: "translation-date-input" });
    input.value = this.due;
    input.addEventListener("input", () => { this.due = input.value; });
    const quick = this.contentEl.createDiv({ cls: "translation-schedule-quick" });
    for (const days of [1, 3, 7]) {
      quick.createEl("button", { text: `${days} 天后` }).addEventListener("click", () => {
        const date = new Date();
        date.setDate(date.getDate() + days);
        this.due = date.toISOString().slice(0, 10);
        input.value = this.due;
      });
    }
    const actions = this.contentEl.createDiv({ cls: "translation-capture-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "确认", cls: "mod-cta" }).addEventListener("click", async () => {
      if (!this.due) return;
      const date = new Date(`${this.due}T12:00:00`);
      await this.onConfirm(date.toISOString());
      this.close();
    });
  }
}

export class TranslationStudyView extends ItemView {
  private page: TranslationPage = "library";
  private selectedExerciseId: string | null = null;
  private libraryFilter: TranslationStage | "all" = "all";
  private query = "";
  private relationDraft: RelationDraft | null = null;
  private activeRelation: ActiveRelation | null = null;
  private selectionPopover: HTMLElement | null = null;
  private relationUndo: TranslationExercise[] = [];
  private relationRedo: TranslationExercise[] = [];
  private structuralUndoPending = false;
  private prepareUndo: TranslationExercise[] = [];
  private prepareRedo: TranslationExercise[] = [];
  private selectedPrepareIds = new Set<string>();
  private completedProjection: CompletedProjection = "sourceText";
  private completedDetailLayer: TranslationRelationLayer = "translation";
  private articleReturnPage: "library" | "records" = "library";

  constructor(leaf: WorkspaceLeaf, private readonly host: TranslationStudyHost) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_TRANSLATION_STUDY; }
  getDisplayText(): string { return "翻译练习"; }
  getIcon(): string { return "languages"; }

  async onOpen(): Promise<void> {
    this.registerDomEvent(window, "keydown", (event) => {
      if (this.app.workspace.getActiveViewOfType(TranslationStudyView) !== this) return;
      this.handleKeydown(event);
    });
    this.render();
  }

  selectExercise(exerciseId: string): void {
    const exercise = this.host.translationExercises.find((item) => item.id === exerciseId);
    if (!exercise) return;
    this.selectedExerciseId = exerciseId;
    this.articleReturnPage = "library";
    this.page = exercise.stage === "waitingBackTranslation" || exercise.stage === "complete" ? "article" : "task";
    if (exercise.stage === "complete") {
      const units = getTranslationUnits(exercise);
      if (!findTranslationUnit(exercise, exercise.activeUnitId)?.assigned) exercise.activeUnitId = units[0]?.id ?? null;
      this.completedProjection = "sourceText";
      this.completedDetailLayer = "translation";
    }
    this.relationDraft = null;
    this.activeRelation = null;
    this.relationUndo = [];
    this.relationRedo = [];
    this.structuralUndoPending = false;
    this.render();
  }

  openCapture(initialText = "", source?: TranslationSource): void {
    new TranslationCaptureModal(this.app, {
      initialText,
      source,
      onSubmit: async (text, title, language, action) => {
        const exercise = await this.host.createTranslationExercise(text, title, language, source);
        this.selectedExerciseId = exercise.id;
        this.page = action === "start" ? "task" : "library";
        this.render();
      },
    }).open();
  }

  render(): void {
    this.removeSelectionPopover();
    const container = this.contentEl;
    container.empty();
    container.addClass("translation-app");
    if (this.page === "library") this.renderLibrary(container);
    else if (this.page === "records") this.renderRecords(container);
    else {
      const exercise = this.host.translationExercises.find((item) => item.id === this.selectedExerciseId);
      if (!exercise) {
        this.page = "library";
        this.renderLibrary(container);
        return;
      }
      if (this.page === "article") this.renderArticle(container, exercise);
      else this.renderTask(container, exercise);
    }
  }

  private renderTopbar(container: HTMLElement, active: "articles" | "records"): void {
    const topbar = container.createDiv({ cls: "translation-topbar" });
    const brand = topbar.createDiv({ cls: "translation-brand" });
    const mark = brand.createDiv({ cls: "translation-brand-mark" });
    setIcon(mark, "languages");
    brand.createSpan({ text: "Translation" });
    const nav = topbar.createDiv({ cls: "translation-primary-nav" });
    const articles = nav.createEl("button", { text: "文本练习" });
    const records = nav.createEl("button", { text: "句子记录" });
    articles.toggleClass("is-active", active === "articles");
    records.toggleClass("is-active", active === "records");
    articles.addEventListener("click", () => { this.page = "library"; this.render(); });
    records.addEventListener("click", () => { this.page = "records"; this.render(); });
    const actions = topbar.createDiv({ cls: "translation-topbar-actions" });
    const create = actions.createEl("button", { cls: "mod-cta translation-create-button" });
    setIcon(create, "plus");
    create.createSpan({ text: "新建" });
    create.addEventListener("click", () => this.openCapture());
  }

  private renderLibrary(container: HTMLElement): void {
    this.renderTopbar(container, "articles");
    const page = container.createDiv({ cls: "translation-library-page" });
    const hero = page.createDiv({ cls: "translation-library-hero" });
    const text = hero.createDiv();
    text.createDiv({ cls: "translation-eyebrow", text: "WORKSPACE" });
    text.createEl("h1", { text: "翻译练习" });
    text.createDiv({ cls: "translation-library-subtitle", text: "从原文整理到回译对照，每篇文章保留一条完整记录。" });
    const due = this.host.translationExercises.filter((exercise) => {
      const timing = getBackTranslationTiming(exercise);
      return exercise.stage === "waitingBackTranslation" && timing && timing.kind !== "future";
    }).length;
    if (due > 0) {
      const callout = hero.createEl("button", { cls: "translation-due-callout" });
      callout.createSpan({ cls: "translation-due-dot" });
      callout.createSpan({ text: `${due} 篇可以开始回译` });
      callout.addEventListener("click", () => {
        this.libraryFilter = "waitingBackTranslation";
        this.render();
      });
    }

    const controls = page.createDiv({ cls: "translation-library-controls" });
    const filters = controls.createDiv({ cls: "translation-filter-tabs" });
    const choices: Array<[TranslationStage | "all", string]> = [
      ["all", "全部"],
      ["prepare", "待整理"],
      ["translate", "初译中"],
      ["waitingBackTranslation", "等待回译"],
      ["backTranslate", "回译中"],
      ["compare", "对照中"],
      ["complete", "已完成"],
    ];
    for (const [value, label] of choices) {
      const button = filters.createEl("button", { text: label });
      button.toggleClass("is-active", this.libraryFilter === value);
      button.addEventListener("click", () => { this.libraryFilter = value; this.render(); });
    }
    const searchWrap = controls.createDiv({ cls: "translation-search" });
    setIcon(searchWrap.createSpan(), "search");
    const search = searchWrap.createEl("input", { type: "search", placeholder: "搜索文本" });
    search.value = this.query;
    search.addEventListener("input", () => { this.query = search.value; this.renderLibraryRows(list); });

    const list = page.createDiv({ cls: "translation-article-list" });
    this.renderLibraryRows(list);
  }

  private renderLibraryRows(list: HTMLElement): void {
    list.empty();
    const filtered = this.host.translationExercises.filter((exercise) => {
      const stageMatch = this.libraryFilter === "all" || exercise.stage === this.libraryFilter;
      const queryMatch = !this.query.trim() || `${exercise.title}\n${exercise.sourceSnapshot}`.toLocaleLowerCase()
        .includes(this.query.trim().toLocaleLowerCase());
      return stageMatch && queryMatch;
    });
    if (filtered.length === 0) {
      const empty = list.createDiv({ cls: "translation-empty-state" });
      const icon = empty.createDiv({ cls: "translation-empty-icon" });
      setIcon(icon, "book-open-text");
      empty.createEl("h3", { text: this.host.translationExercises.length ? "没有符合条件的文本" : "开始第一篇练习" });
      empty.createDiv({ text: this.host.translationExercises.length ? "换一个筛选或搜索词。" : "从当前选区录入，也可以直接粘贴一篇文章。" });
      if (!this.host.translationExercises.length) empty.createEl("button", { text: "录入文本", cls: "mod-cta" }).addEventListener("click", () => this.openCapture());
      return;
    }
    const header = list.createDiv({ cls: "translation-list-header" });
    header.createSpan({ text: "文本" });
    header.createSpan({ text: "阶段" });
    header.createSpan({ text: "进度" });
    header.createSpan();
    for (const exercise of filtered) this.renderArticleRow(list, exercise);
  }

  private renderArticleRow(list: HTMLElement, exercise: TranslationExercise): void {
    const row = list.createDiv({ cls: `translation-article-row is-${exercise.stage}` });
    const identity = row.createDiv({ cls: "translation-article-identity" });
    identity.createDiv({ cls: "translation-article-title", text: exercise.title });
    const meta = identity.createDiv({ cls: "translation-article-meta" });
    meta.createSpan({ text: LANGUAGE_LABELS[exercise.language] });
    meta.createSpan({ text: `${getTranslationUnits(exercise).length || "—"} 个单位` });
    if (exercise.source) meta.createSpan({ text: exercise.source.filePath });
    const stage = row.createDiv({ cls: "translation-stage-cell" });
    stage.createSpan({ cls: `translation-status-dot is-${exercise.stage}` });
    let stageText = STAGE_LABELS[exercise.stage];
    const timing = getBackTranslationTiming(exercise);
    if (exercise.stage === "waitingBackTranslation" && timing) {
      stageText = timing.kind === "future" ? `${timing.days} 天后回译`
        : timing.kind === "today" ? "今天回译"
          : `已过期 ${timing.days} 天`;
    }
    stage.createSpan({ text: stageText });
    const progress = getTranslationStageProgress(exercise);
    const progressCell = row.createDiv({ cls: "translation-progress-cell" });
    const track = progressCell.createDiv({ cls: "translation-progress-track" });
    const bar = track.createDiv({ cls: "translation-progress-fill" });
    const percent = exercise.stage === "prepare"
      ? (hasUnassignedTranslationText(exercise) ? 0 : 100)
      : exercise.stage === "complete" ? 100
        : progress.total ? Math.round(progress.completed / progress.total * 100) : 0;
    bar.style.width = `${percent}%`;
    progressCell.createSpan({ text: exercise.stage === "prepare" ? (progress.ready ? "已切分" : "未切分") : `${progress.completed} / ${progress.total}` });
    const actions = row.createDiv({ cls: "translation-row-actions" });
    const open = actions.createEl("button", {
      text: exercise.stage === "waitingBackTranslation" || exercise.stage === "complete" ? "查看" : "继续",
      cls: "translation-row-open",
    });
    open.addEventListener("click", (event) => { event.stopPropagation(); this.selectExercise(exercise.id); });
    const more = iconButton(actions, "ellipsis", "更多");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openExerciseMenu(event, exercise);
    });
    row.addEventListener("click", () => this.selectExercise(exercise.id));
  }

  private openExerciseMenu(event: MouseEvent, exercise: TranslationExercise): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("修改标题").setIcon("pencil").onClick(() => {
      new TranslationRenameModal(this.app, exercise, async () => {
        await this.host.saveTranslationData();
        this.render();
      }).open();
    }));
    if (exercise.source) {
      menu.addItem((item) => item.setTitle("打开来源").setIcon("file-text").onClick(() => void this.host.openTranslationSource(exercise)));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除").setIcon("trash-2").onClick(async () => {
      if (await this.host.deleteTranslationExercise(exercise.id)) this.render();
    }));
    menu.showAtMouseEvent(event);
  }

  private renderTask(container: HTMLElement, exercise: TranslationExercise): void {
    const shell = container.createDiv({ cls: `translation-task-shell is-${exercise.stage}` });
    this.renderTaskHeader(shell, exercise);
    if (exercise.stage === "prepare") this.renderPreparation(shell, exercise);
    else if (exercise.stage === "translate") this.renderUnitWorkbench(shell, exercise, "translate");
    else if (exercise.stage === "backTranslate") this.renderUnitWorkbench(shell, exercise, "backTranslate");
    else if (exercise.stage === "compare") this.renderUnitWorkbench(shell, exercise, "compare");
    else {
      this.page = "article";
      this.render();
    }
  }

  private renderTaskHeader(shell: HTMLElement, exercise: TranslationExercise): void {
    const header = shell.createDiv({ cls: "translation-task-header" });
    const back = iconButton(header, "arrow-left", "返回文本列表");
    back.addEventListener("click", () => { this.page = "library"; this.render(); });
    const title = header.createDiv({ cls: "translation-task-title" });
    title.createDiv({ cls: "translation-task-stage", text: STAGE_LABELS[exercise.stage] });
    title.createEl("h2", { text: exercise.title });
    const steps = header.createDiv({ cls: "translation-stage-rail" });
    for (const [index, label] of ["整理", "初译", "等待", "回译", "对照", "完成"].entries()) {
      const step = steps.createDiv({ cls: "translation-stage-step" });
      step.toggleClass("is-past", index < STAGE_INDEX[exercise.stage]);
      step.toggleClass("is-current", index === STAGE_INDEX[exercise.stage]);
      step.createSpan({ cls: "translation-stage-node" });
      step.createSpan({ text: label });
    }
    const actions = header.createDiv({ cls: "translation-task-header-actions" });
    if (exercise.source) {
      const source = iconButton(actions, "file-text", "打开来源");
      source.addEventListener("click", () => void this.host.openTranslationSource(exercise));
    }
    const more = iconButton(actions, "ellipsis", "更多");
    more.addEventListener("click", (event) => this.openExerciseMenu(event, exercise));
  }

  private pushPrepareHistory(exercise: TranslationExercise): void {
    this.prepareUndo.push(cloneExercise(exercise));
    if (this.prepareUndo.length > 40) this.prepareUndo.shift();
    this.prepareRedo = [];
  }

  private pushRelationHistory(exercise: TranslationExercise): void {
    this.relationUndo.push(cloneExercise(exercise));
    if (this.relationUndo.length > 40) this.relationUndo.shift();
    this.relationRedo = [];
    this.structuralUndoPending = true;
  }

  private async undoRelationOperation(exercise: TranslationExercise): Promise<void> {
    const previous = this.relationUndo.pop();
    if (!previous) return;
    this.relationRedo.push(cloneExercise(exercise));
    replaceExercise(exercise, previous);
    this.activeRelation = null;
    this.relationDraft = null;
    this.structuralUndoPending = true;
    await this.persist(exercise);
  }

  private async redoRelationOperation(exercise: TranslationExercise): Promise<void> {
    const next = this.relationRedo.pop();
    if (!next) return;
    this.relationUndo.push(cloneExercise(exercise));
    replaceExercise(exercise, next);
    this.activeRelation = null;
    this.relationDraft = null;
    this.structuralUndoPending = true;
    await this.persist(exercise);
  }

  private async persist(exercise: TranslationExercise, rerender = true): Promise<void> {
    exercise.updatedAt = new Date().toISOString();
    await this.host.saveTranslationData();
    if (rerender) this.render();
  }

  private renderPreparation(shell: HTMLElement, exercise: TranslationExercise): void {
    const body = shell.createDiv({ cls: "translation-prepare-layout" });
    const command = body.createDiv({ cls: "translation-prepare-command" });
    const commandText = command.createDiv();
    commandText.createDiv({ cls: "translation-eyebrow", text: "UNIT MAP" });
    commandText.createEl("h3", { text: "切分原文" });
    commandText.createDiv({ text: "拖选一段文字，把它划为一个单位。已切出的部分会沉下去。", cls: "translation-command-hint" });
    const toolbar = command.createDiv({ cls: "translation-prepare-toolbar" });
    const undo = iconButton(toolbar, "undo-2", "撤销 Ctrl+Z");
    undo.disabled = this.prepareUndo.length === 0;
    undo.addEventListener("click", () => void this.undoPreparation(exercise));
    const redo = iconButton(toolbar, "redo-2", "重做 Ctrl+Shift+Z");
    redo.disabled = this.prepareRedo.length === 0;
    redo.addEventListener("click", () => void this.redoPreparation(exercise));
    toolbar.createEl("button", { text: "自动切分" }).addEventListener("click", async () => {
      this.pushPrepareHistory(exercise);
      if (!autoAssignTranslationExercise(exercise)) this.prepareUndo.pop();
      await this.persist(exercise);
    });
    const merge = toolbar.createEl("button", { text: "合并" });
    merge.disabled = this.selectedPrepareIds.size < 2;
    merge.addEventListener("click", async () => {
      this.pushPrepareHistory(exercise);
      if (!mergeAssignedTranslationUnits(exercise, [...this.selectedPrepareIds])) {
        this.prepareUndo.pop();
        new Notice("只能合并同一自然段内相邻的单位。");
        return;
      }
      this.selectedPrepareIds.clear();
      await this.persist(exercise);
    });
    const reopen = toolbar.createEl("button", { text: "放回所选" });
    reopen.disabled = this.selectedPrepareIds.size === 0;
    reopen.addEventListener("click", async () => {
      this.pushPrepareHistory(exercise);
      reopenTranslationUnits(exercise, [...this.selectedPrepareIds]);
      this.selectedPrepareIds.clear();
      await this.persist(exercise);
    });
    const reset = toolbar.createEl("button", { text: "重新切分" });
    reset.disabled = getTranslationUnits(exercise).length === 0;
    reset.addEventListener("click", async () => {
      this.pushPrepareHistory(exercise);
      if (!resetTranslationSegmentation(exercise)) {
        this.prepareUndo.pop();
        return;
      }
      this.selectedPrepareIds.clear();
      await this.persist(exercise);
    });

    const source = body.createDiv({ cls: "translation-carving-canvas" });
    const commitSelection = (): void => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      const flow = Array.from(source.querySelectorAll<HTMLElement>(".translation-carving-flow"))
        .find((candidate) =>
          candidate.contains(range.startContainer)
          && candidate.contains(range.endContainer));
      if (!flow) return;
      const blockId = flow.dataset.blockId;
      const textRange = captureTextRange(flow, false);
      if (!blockId || !textRange) return;
      this.pushPrepareHistory(exercise);
      const assignedId = assignTranslationBlockRange(
        exercise,
        blockId,
        textRange.from,
        textRange.to,
      );
      selection.removeAllRanges();
      if (!assignedId) {
        this.prepareUndo.pop();
        new Notice("请只选择尚未切出的连续原文。");
        return;
      }
      this.selectedPrepareIds.clear();
      void this.persist(exercise);
    };
    source.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const flow = Array.from(source.querySelectorAll<HTMLElement>(".translation-carving-flow"))
        .find((candidate) => candidate.contains(target));
      if (!flow) return;
      window.addEventListener("pointerup", () => {
        window.requestAnimationFrame(commitSelection);
      }, { capture: true, once: true });
    });
    exercise.blocks.forEach((block, blockIndex) => {
      const blockEl = source.createDiv({ cls: "translation-carving-block" });
      blockEl.createDiv({ cls: "translation-carving-block-label", text: `P${blockIndex + 1}` });
      const flow = blockEl.createDiv({ cls: "translation-carving-flow" });
      flow.dataset.blockId = block.id;
      for (const segment of block.units) {
        const segmentEl = flow.createSpan({
          cls: segment.assigned ? "translation-carved-unit" : "translation-unassigned-source",
        });
        segmentEl.setAttr("data-segment-id", segment.id);
        segmentEl.textContent = segment.sourceText;
        if (segment.assigned) {
          segmentEl.toggleClass("is-selected", this.selectedPrepareIds.has(segment.id));
          segmentEl.setAttr("role", "button");
          segmentEl.setAttr("tabindex", "0");
          segmentEl.addEventListener("click", (event) => {
            event.preventDefault();
            if (!event.ctrlKey && !event.metaKey) this.selectedPrepareIds.clear();
            if (this.selectedPrepareIds.has(segment.id)) this.selectedPrepareIds.delete(segment.id);
            else this.selectedPrepareIds.add(segment.id);
            this.render();
          });
        } else {
          segmentEl.setAttr("aria-label", "尚未切分的原文");
        }
        if (segment.separatorAfter) flow.appendText(segment.separatorAfter);
      }
    });

    const footer = shell.createDiv({ cls: "translation-task-footer" });
    const progress = getTranslationStageProgress(exercise);
    footer.createDiv({
      cls: "translation-footer-summary",
      text: `${getTranslationUnits(exercise).length} 个单位${hasUnassignedTranslationText(exercise) ? " · 仍有未切分文字" : ""}`,
    });
    const begin = footer.createEl("button", { text: "完成整理，开始初译", cls: "mod-cta translation-primary-action" });
    begin.disabled = !progress.ready;
    begin.addEventListener("click", async () => {
      if (!getTranslationStageProgress(exercise).ready) return;
      setTranslationStage(exercise, "translate");
      this.prepareUndo = [];
      this.prepareRedo = [];
      await this.persist(exercise);
    });
  }

  private async undoPreparation(exercise: TranslationExercise): Promise<void> {
    const previous = this.prepareUndo.pop();
    if (!previous) return;
    this.prepareRedo.push(cloneExercise(exercise));
    replaceExercise(exercise, previous);
    this.selectedPrepareIds.clear();
    await this.persist(exercise);
  }

  private async redoPreparation(exercise: TranslationExercise): Promise<void> {
    const next = this.prepareRedo.pop();
    if (!next) return;
    this.prepareUndo.push(cloneExercise(exercise));
    replaceExercise(exercise, next);
    this.selectedPrepareIds.clear();
    await this.persist(exercise);
  }

  private renderUnitWorkbench(
    shell: HTMLElement,
    exercise: TranslationExercise,
    stage: "translate" | "backTranslate" | "compare",
  ): void {
    const units = getTranslationUnits(exercise);
    let active = findTranslationUnit(exercise, exercise.activeUnitId);
    if (!active?.assigned) {
      active = units[0];
      exercise.activeUnitId = active?.id ?? null;
    }
    if (!active) return;
    const activeIndex = units.indexOf(active);
    const mode = this.host.getTranslationWorkbenchMode(stage);
    const layout = shell.createDiv({ cls: `translation-work-layout is-${stage} is-${mode}-mode` });
    if (mode === "unit") this.renderUnitNavigator(layout, exercise, units, active);
    const workspace = layout.createDiv({ cls: "translation-unit-workspace" });
    const unitHeader = workspace.createDiv({ cls: "translation-unit-header" });
    const stageTitle = stage === "translate" ? "初译" : stage === "backTranslate" ? "回译" : "原文对照";
    unitHeader.createEl("h3", { text: stageTitle });
    const headerTools = unitHeader.createDiv({ cls: "translation-unit-header-tools" });
    this.renderWorkbenchModeSwitch(headerTools, stage, mode);
    headerTools.createDiv({ cls: "translation-unified-hint", text: "自动保存" });

    if (mode === "full") this.renderFullTextWorkspace(workspace, exercise, active, stage);
    else if (stage === "translate") this.renderTranslationWorkspace(workspace, exercise, active);
    else if (stage === "backTranslate") this.renderBackTranslationWorkspace(workspace, exercise, active);
    else this.renderComparisonWorkspace(workspace, exercise, active);
    this.renderWorkbenchFooter(workspace, exercise, units, activeIndex, stage);
  }

  private renderWorkbenchModeSwitch(
    parent: HTMLElement,
    stage: TranslationWorkbenchStage,
    mode: TranslationWorkbenchMode,
  ): void {
    const control = parent.createDiv({ cls: "translation-workbench-view-switch" });
    for (const [value, label] of [["unit", "逐句"], ["full", "全文"]] as const) {
      const button = control.createEl("button", { text: label });
      button.toggleClass("is-active", mode === value);
      button.setAttr("aria-pressed", String(mode === value));
      button.addEventListener("click", async () => {
        if (mode === value) return;
        await this.host.setTranslationWorkbenchMode(stage, value);
        this.removeSelectionPopover();
        this.render();
      });
    }
  }

  private renderUnitNavigator(
    layout: HTMLElement,
    exercise: TranslationExercise,
    units: TranslationUnit[],
    active: TranslationUnit,
  ): void {
    const nav = layout.createDiv({ cls: "translation-unit-nav" });
    const heading = nav.createDiv({ cls: "translation-unit-nav-heading" });
    heading.createSpan({ text: "单位" });
    const list = nav.createDiv({ cls: "translation-unit-nav-list" });
    units.forEach((unit, index) => {
      const button = list.createEl("button", { cls: "translation-unit-nav-item" });
      button.setAttr("data-unit-id", unit.id);
      button.toggleClass("is-active", unit.id === active.id);
      const hasContent = statusForStage(unit, exercise.stage) !== "empty";
      button.toggleClass("has-content", hasContent);
      button.createSpan({ cls: "translation-unit-number", text: `S${index + 1}` });
      const preview = exercise.stage === "backTranslate" ? unit.translation : unit.sourceText;
      button.createSpan({ cls: "translation-unit-preview", text: preview.replace(/\s+/gu, " ") });
      const state = button.createSpan({ cls: "translation-unit-check" });
      if (hasContent) setIcon(state, "circle-dot");
      button.addEventListener("click", () => {
        exercise.activeUnitId = unit.id;
        this.relationDraft = null;
        this.activeRelation = null;
        this.relationUndo = [];
        this.relationRedo = [];
        this.structuralUndoPending = false;
        this.render();
      });
    });
  }

  private renderFullTextWorkspace(
    workspace: HTMLElement,
    exercise: TranslationExercise,
    active: TranslationUnit,
    stage: TranslationWorkbenchStage,
  ): HTMLElement {
    const layout = workspace.createDiv({ cls: `translation-full-layout is-${stage}` });
    const documentColumn = layout.createDiv({ cls: "translation-full-document" });
    const documentHeader = documentColumn.createDiv({ cls: "translation-full-document-header" });
    const units = getTranslationUnits(exercise);
    const documentTitle = stage === "backTranslate" ? "初译全文" : "原文全文";
    documentHeader.createEl("strong", { text: documentTitle });
    documentHeader.createSpan({ text: `${exercise.blocks.length} 个自然段 · ${units.length} 个单位` });

    exercise.blocks.forEach((block, blockIndex) => {
      const blockUnits = block.units.filter((unit) => unit.assigned);
      if (!blockUnits.length) return;
      const sourceSeparators = getTranslationBlockUnitSeparators(block);
      const blockEl = documentColumn.createDiv({ cls: "translation-full-block" });
      blockEl.setAttr("data-full-block-id", block.id);
      blockEl.createDiv({ cls: "translation-full-block-number", text: `P${blockIndex + 1}` });

      const documentField: FullTextField = stage === "backTranslate" ? "translation" : "sourceText";
      this.renderFullTextLayer(blockEl, workspace, exercise, blockUnits, {
        label: "",
        field: documentField,
        relations: stage === "backTranslate" ? "translation" : stage === "compare" ? "comparison" : "translation",
        side: stage === "backTranslate" ? "right" : "left",
        editable: false,
        allowSelection: stage !== "backTranslate",
        wireRelations: true,
        sourceSeparators,
      });
    });

    const processor = layout.createDiv({ cls: "translation-full-processor" });
    this.renderFullTextProcessor(processor, workspace, exercise, active, stage);
    return layout;
  }

  private renderFullTextProcessor(
    processor: HTMLElement,
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    stage: TranslationWorkbenchStage,
  ): void {
    const body = processor.createDiv({ cls: "translation-full-processor-body translation-unified-pair" });
    if (stage === "translate") {
      this.renderUnifiedEditableCard(body, workspace, exercise, unit, "译文", "translation", unit.translationRelations, "translation");
      this.renderFullTextActiveNotes(body, exercise, unit, stage);
    } else if (stage === "backTranslate") {
      this.renderEditorCard(body, "回译", unit.backTranslation, "不看原文，把它译回去", (value) => {
        updateTranslationUnitText(unit, "backTranslation", value);
        this.refreshStageControls(exercise);
      }, () => this.persist(exercise, false));
      this.renderFullTextActiveNotes(body, exercise, unit, stage);
    } else {
      this.renderUnifiedEditableCard(body, workspace, exercise, unit, "回译", "backTranslation", unit.comparisonRelations, "comparison");
      this.renderFullTextProcessorReference(body, unit);
    }

    const context = processor.createDiv({ cls: "translation-context-sidebar translation-full-processor-context" });
    this.renderFullTextSidebar(context, workspace, exercise, unit, stage);
  }

  private renderFullTextProcessorReference(parent: HTMLElement, unit: TranslationUnit): void {
    const reference = parent.createEl("details", {
      cls: "translation-full-reference translation-forward-reference is-main",
    });
    reference.createEl("summary", { text: "初译参照" });
    const layer = reference.createDiv({ cls: "translation-full-layer is-compact" });
    const flow = layer.createDiv({ cls: "translation-full-flow is-readonly" });
    renderRangeText(flow, unit.translation, unit.translationRelations, "right");
    this.renderFullTextReferenceDetails(reference, layer, [unit]);
  }

  private renderFullTextLayer(
    parent: HTMLElement,
    workspace: HTMLElement,
    exercise: TranslationExercise,
    units: TranslationUnit[],
    options: {
      label: string;
      field: FullTextField;
      relations: TranslationRelationLayer | null;
      side: "left" | "right";
      editable: boolean;
      allowSelection: boolean;
      wireRelations: boolean;
      compact?: boolean;
      sourceSeparators: string[];
    },
  ): HTMLElement {
    const layer = parent.createDiv({ cls: `translation-full-layer${options.compact ? " is-compact" : ""}` });
    if (options.label) layer.createDiv({ cls: "translation-full-layer-label", text: options.label });
    const flow = layer.createDiv({ cls: `translation-full-flow${options.editable ? " is-editable" : " is-readonly"}` });

    units.forEach((unit, index) => {
      const text = unit[options.field];
      const relations = options.relations === "translation"
        ? unit.translationRelations
        : options.relations === "comparison"
          ? unit.comparisonRelations
          : [];
      const wrapper = flow.createSpan({ cls: "translation-full-unit" });
      wrapper.setAttr("data-full-unit-id", unit.id);
      wrapper.toggleClass("is-active", unit.id === exercise.activeUnitId);
      wrapper.setAttr("tabindex", "0");
      wrapper.setAttr("aria-label", `选择 S${getTranslationUnits(exercise).indexOf(unit) + 1}`);
      if (unit.id === exercise.activeUnitId) wrapper.setAttr("aria-current", "true");
      wrapper.toggleClass("has-content", Boolean(text.trim()));
      const surface = wrapper.createSpan({
        cls: `translation-full-unit-surface${options.editable ? " is-editable" : " is-selecting"}`,
      });
      surface.setAttr("data-placeholder", options.editable ? "待填写" : "");
      if (options.editable) {
        surface.setAttr("contenteditable", "true");
        surface.setAttr("role", "textbox");
        surface.setAttr("aria-label", `${options.label || "文本"} S${getTranslationUnits(exercise).indexOf(unit) + 1}`);
        surface.spellcheck = true;
      }
      const draft = unit.id === exercise.activeUnitId && this.relationDraft?.layer === options.relations
        ? (options.side === "left" ? this.relationDraft.left : this.relationDraft.right)
        : [];
      const activeRelationId = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === options.relations
        ? this.activeRelation.relationId
        : undefined;
      renderRangeText(surface, text, relations, options.side, draft, activeRelationId);

      surface.addEventListener("pointerdown", () => {
        if (exercise.activeUnitId === unit.id) return;
        this.activateFullTextUnit(workspace, exercise, unit, exercise.stage as TranslationWorkbenchStage);
      });
      wrapper.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (exercise.activeUnitId !== unit.id) {
          this.activateFullTextUnit(workspace, exercise, unit, exercise.stage as TranslationWorkbenchStage);
        }
      });

      if (options.editable && options.field !== "sourceText") {
        const editableField: "translation" | "backTranslation" = options.field;
        let saveTimer = 0;
        surface.addEventListener("input", () => {
          const value = surface.innerText.replace(/\r\n?/gu, "\n");
          updateTranslationUnitText(unit, editableField, value);
          wrapper.toggleClass("has-content", Boolean(value.trim()));
          this.refreshFullTextFlowSeparators(flow, units, options.field, options.sourceSeparators);
          this.refreshStageControls(exercise);
          this.relationUndo = [];
          this.relationRedo = [];
          this.structuralUndoPending = false;
          window.clearTimeout(saveTimer);
          saveTimer = window.setTimeout(() => void this.persist(exercise, false), 320);
        });
        surface.addEventListener("paste", (event) => {
          event.preventDefault();
          document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") ?? "");
        });
        surface.addEventListener("keydown", (event) => {
          if (event.key !== "Backspace" || !this.activeRelation || !options.relations) return;
          if (this.activeRelation.unitId !== unit.id || this.activeRelation.layer !== options.relations) return;
          const selection = window.getSelection();
          if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          if (!surface.contains(range.startContainer)) return;
          const before = document.createRange();
          before.selectNodeContents(surface);
          before.setEnd(range.startContainer, range.startOffset);
          const offset = before.toString().length;
          const relation = relations.find((candidate) => candidate.id === this.activeRelation?.relationId);
          if (!relation || !relation.rightRanges.some((item) => item.from === offset || item.to === offset)) return;
          event.preventDefault();
          this.pushRelationHistory(exercise);
          relations.splice(relations.indexOf(relation), 1);
          this.activeRelation = null;
          void this.persist(exercise);
        });
        surface.addEventListener("blur", () => {
          window.clearTimeout(saveTimer);
          void this.persist(exercise, false);
        });
      }

      if (options.wireRelations && options.relations) {
        this.wireRelationSurface(
          surface,
          workspace,
          exercise,
          unit,
          relations,
          options.side,
          options.relations,
          options.allowSelection,
        );
      }

      const next = units[index + 1];
      if (next) {
        const separator = fullTextSeparator(
          options.field,
          text,
          next[options.field],
          options.sourceSeparators[index] ?? "",
        );
        const separatorEl = flow.createSpan({ cls: "translation-full-separator", text: separator || "\u200b" });
        separatorEl.setAttr("data-full-separator-index", String(index));
      }
    });
    return layer;
  }

  private renderFullTextReferenceDetails(
    reference: HTMLElement,
    referenceLayer: HTMLElement,
    units: readonly TranslationUnit[],
  ): void {
    const entries = units.flatMap((unit) => unit.translationRelations.map((relation) => ({ unit, relation })));
    const flow = referenceLayer.querySelector<HTMLElement>(".translation-full-flow");
    if (flow) flow.addClass("translation-reference-text");
    if (!entries.length && !units.some((unit) => unit.translationNotes.length)) return;

    const details = reference.createDiv({ cls: "translation-reference-relations translation-full-reference-details" });
    const activate = (relationId: string): void => {
      const current = reference.dataset.activeReferenceRelation;
      const next = current === relationId ? "" : relationId;
      reference.dataset.activeReferenceRelation = next;
      for (const fragment of Array.from(reference.querySelectorAll<HTMLElement>("[data-relation-id]"))) {
        fragment.toggleClass("is-reference-active", Boolean(next) && fragment.dataset.relationId === next);
      }
      for (const row of Array.from(details.querySelectorAll<HTMLElement>("[data-reference-relation-id]"))) {
        const active = Boolean(next) && row.dataset.referenceRelationId === next;
        row.toggleClass("is-reference-active", active);
        if (active) row.scrollIntoView({ block: "nearest" });
      }
    };

    entries.forEach(({ unit, relation }, index) => {
      for (const fragment of Array.from(referenceLayer.querySelectorAll<HTMLElement>(`[data-relation-id="${relation.id}"]`))) {
        fragment.setAttr("data-reference-number", String(index + 1));
        fragment.setAttr("role", "button");
        fragment.setAttr("tabindex", "0");
        fragment.setAttr("aria-label", `查看初译关联 ${index + 1}`);
      }
      const row = details.createEl("button", { cls: "translation-reference-relation" });
      row.setAttr("data-reference-relation-id", relation.id);
      row.createSpan({ cls: "translation-reference-relation-index", text: String(index + 1) });
      row.createSpan({
        cls: "translation-reference-relation-summary",
        text: this.describeRelation(unit, relation, "translation"),
      });
      if (relation.note) row.createSpan({ cls: "translation-reference-note", text: relation.note });
      row.addEventListener("click", () => {
        if (this.hasTextSelection()) return;
        activate(relation.id);
      });
    });

    units.forEach((unit) => {
      const note = unit.translationNotes[0];
      if (!note) return;
      const noteRow = details.createDiv({ cls: "translation-full-reference-note" });
      setIcon(noteRow.createSpan(), "message-square-text");
      noteRow.createSpan({ text: note.text });
      noteRow.setAttr("data-unit-id", unit.id);
    });

    referenceLayer.addEventListener("click", (event) => {
      if (this.hasTextSelection()) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-relation-id]") : null;
      if (target?.dataset.relationId) activate(target.dataset.relationId);
    });
    referenceLayer.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-relation-id]") : null;
      if (!target?.dataset.relationId) return;
      event.preventDefault();
      activate(target.dataset.relationId);
    });
  }

  private refreshFullTextFlowSeparators(
    flow: HTMLElement,
    units: TranslationUnit[],
    field: FullTextField,
    sourceSeparators: readonly string[],
  ): void {
    for (const separator of Array.from(flow.querySelectorAll<HTMLElement>("[data-full-separator-index]"))) {
      const index = Number(separator.dataset.fullSeparatorIndex);
      const current = units[index];
      const next = units[index + 1];
      if (!current || !next) continue;
      separator.textContent = fullTextSeparator(
        field,
        current[field],
        next[field],
        sourceSeparators[index] ?? "",
      ) || "\u200b";
    }
  }

  private activateFullTextUnit(
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    stage: TranslationWorkbenchStage,
  ): void {
    const previousId = exercise.activeUnitId;
    exercise.activeUnitId = unit.id;
    if (previousId !== unit.id) {
      this.relationDraft = null;
      this.activeRelation = null;
      this.relationUndo = [];
      this.relationRedo = [];
      this.structuralUndoPending = false;
    }
    for (const item of Array.from(workspace.querySelectorAll<HTMLElement>("[data-full-unit-id]"))) {
      const active = item.dataset.fullUnitId === unit.id;
      item.toggleClass("is-active", active);
      if (active) item.setAttr("aria-current", "true");
      else item.removeAttribute("aria-current");
    }
    const processor = workspace.querySelector<HTMLElement>(".translation-full-processor");
    if (processor) {
      processor.empty();
      this.renderFullTextProcessor(processor, workspace, exercise, unit, stage);
    }
    this.refreshStageControls(exercise);
    void this.persist(exercise, false);
  }

  private renderFullTextSidebar(
    sidebar: HTMLElement,
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    stage: TranslationWorkbenchStage,
  ): void {
    if (stage === "translate") {
      this.renderRelationDraft(sidebar, exercise, unit, "translation");
      this.renderRelationInspector(workspace, exercise, unit, "translation");
      this.renderContextPlaceholder(sidebar, unit, "translation");
      return;
    }
    if (stage === "backTranslate") {
      this.renderRelationInspector(workspace, exercise, unit, "translation");
      this.renderBackTranslationAnnotationPlaceholder(sidebar, unit);
      return;
    }
    this.renderRelationDraft(sidebar, exercise, unit, "comparison");
    this.renderRelationInspector(workspace, exercise, unit, "comparison");
    this.renderContextPlaceholder(sidebar, unit, "comparison");
    this.renderComparisonNote(sidebar, exercise, unit);
  }

  private renderFullTextActiveNotes(
    parent: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    stage: TranslationWorkbenchStage,
  ): void {
    const index = getTranslationUnits(exercise).indexOf(unit) + 1;
    if (stage === "backTranslate" && unit.translationNotes.length) {
      this.renderReadOnlySentenceNote(parent, unit.translationNotes, `初译批注 · S${index}`);
    }
    if (stage === "translate") this.renderSentenceNote(parent, exercise, unit, "translation", `句子批注 · S${index}`);
    else if (stage === "backTranslate") this.renderSentenceNote(parent, exercise, unit, "backTranslation", `回译笔记 · S${index}`);
  }

  private renderReadOnlySentenceNote(parent: HTMLElement, notes: readonly TranslationNote[], label: string): void {
    const note = notes[0];
    if (!note) return;
    const section = parent.createDiv({ cls: "translation-sentence-note is-readonly is-static" });
    const heading = section.createDiv({ cls: "translation-sentence-note-heading" });
    setIcon(heading.createSpan({ cls: "translation-sentence-note-icon" }), "message-square-text");
    heading.createSpan({ cls: "translation-sentence-note-label", text: label });
    section.createDiv({ cls: "translation-sentence-note-readonly-value", text: note.text });
  }

  private renderTranslationWorkspace(workspace: HTMLElement, exercise: TranslationExercise, unit: TranslationUnit): HTMLElement {
    const layout = workspace.createDiv({ cls: "translation-unified-layout" });
    const cards = layout.createDiv({ cls: "translation-pair-stack translation-unified-pair" });
    this.renderUnifiedReadOnlyCard(cards, workspace, exercise, unit, "原文", unit.sourceText, unit.translationRelations, "left", "translation");
    this.renderUnifiedEditableCard(cards, workspace, exercise, unit, "译文", "translation", unit.translationRelations, "translation");
    this.renderSentenceNote(cards, exercise, unit, "translation", "句子批注");
    const sidebar = layout.createDiv({ cls: "translation-context-sidebar" });
    this.renderRelationDraft(sidebar, exercise, unit, "translation");
    this.renderRelationInspector(workspace, exercise, unit, "translation");
    this.renderContextPlaceholder(sidebar, unit, "translation");
    return cards;
  }

  private renderBackTranslationWorkspace(workspace: HTMLElement, exercise: TranslationExercise, unit: TranslationUnit): HTMLElement {
    const layout = workspace.createDiv({ cls: "translation-unified-layout is-back-translation" });
    const main = layout.createDiv({ cls: "translation-pair-stack translation-unified-pair" });
    const material = main.createDiv({ cls: "translation-text-card translation-unified-card translation-back-material" });
    material.createDiv({ cls: "translation-card-label", text: "初译材料" });
    const materialText = material.createDiv({ cls: "translation-selectable-text translation-context-text" });
    const activeId = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === "translation"
      ? this.activeRelation.relationId
      : undefined;
    renderRangeText(materialText, unit.translation, unit.translationRelations, "right", [], activeId);
    this.wireRelationSurface(materialText, workspace, exercise, unit, unit.translationRelations, "right", "translation", false);
    this.renderReadOnlyNotes(material, unit.translationNotes);
    this.renderEditorCard(main, "回译", unit.backTranslation, "不看原文，把它译回去", (value) => {
      updateTranslationUnitText(unit, "backTranslation", value);
      this.refreshStageControls(exercise);
    }, () => this.persist(exercise, false));
    this.renderSentenceNote(main, exercise, unit, "backTranslation", "回译笔记");
    const sidebar = layout.createDiv({ cls: "translation-context-sidebar" });
    this.renderRelationInspector(workspace, exercise, unit, "translation");
    this.renderBackTranslationAnnotationPlaceholder(sidebar, unit);
    return main;
  }

  private renderComparisonWorkspace(workspace: HTMLElement, exercise: TranslationExercise, unit: TranslationUnit): HTMLElement {
    const compare = workspace.createDiv({ cls: "translation-unified-layout is-comparison" });
    const main = compare.createDiv({ cls: "translation-compare-main translation-unified-pair" });
    this.renderUnifiedReadOnlyCard(main, workspace, exercise, unit, "原文", unit.sourceText, unit.comparisonRelations, "left", "comparison");
    this.renderUnifiedEditableCard(main, workspace, exercise, unit, "回译", "backTranslation", unit.comparisonRelations, "comparison");
    const reference = main.createDiv({ cls: "translation-forward-reference is-main" });
    reference.createDiv({ cls: "translation-reference-kicker", text: "初译参照" });
    const referenceText = reference.createDiv({ cls: "translation-reference-text" });
    renderRangeText(referenceText, unit.translation, unit.translationRelations, "right");
    for (const fragment of Array.from(referenceText.querySelectorAll<HTMLElement>("[data-relation-index]"))) {
      const index = Number(fragment.dataset.relationIndex);
      fragment.setAttr("data-reference-number", String(index + 1));
      fragment.setAttr("role", "button");
      fragment.setAttr("tabindex", "0");
      fragment.setAttr("aria-label", `查看初译关联 ${index + 1}`);
    }
    if (unit.translationRelations.length) {
      const relationList = reference.createDiv({ cls: "translation-reference-relations" });
      for (const [index, relation] of unit.translationRelations.entries()) {
        const row = relationList.createEl("button", { cls: "translation-reference-relation" });
        row.setAttr("data-reference-relation-id", relation.id);
        row.createSpan({ cls: "translation-reference-relation-index", text: String(index + 1) });
        row.createSpan({ cls: "translation-reference-relation-summary", text: this.describeRelation(unit, relation, "translation") });
        if (relation.note) row.createSpan({ cls: "translation-reference-note", text: relation.note });
      }
      const activateReference = (relationId: string): void => {
        const current = reference.dataset.activeReferenceRelation;
        const next = current === relationId ? "" : relationId;
        reference.dataset.activeReferenceRelation = next;
        for (const fragment of Array.from(referenceText.querySelectorAll<HTMLElement>("[data-relation-id]"))) {
          fragment.toggleClass("is-reference-active", Boolean(next) && fragment.dataset.relationId === next);
        }
        for (const row of Array.from(relationList.querySelectorAll<HTMLElement>("[data-reference-relation-id]"))) {
          const active = Boolean(next) && row.dataset.referenceRelationId === next;
          row.toggleClass("is-reference-active", active);
          if (active) row.scrollIntoView({ block: "nearest" });
        }
      };
      referenceText.addEventListener("click", (event) => {
        if (this.hasTextSelection()) return;
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-relation-id]") : null;
        if (target?.dataset.relationId) activateReference(target.dataset.relationId);
      });
      referenceText.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-relation-id]") : null;
        if (!target?.dataset.relationId) return;
        event.preventDefault();
        activateReference(target.dataset.relationId);
      });
      relationList.addEventListener("click", (event) => {
        if (this.hasTextSelection()) return;
        const target = event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-reference-relation-id]")
          : null;
        if (target?.dataset.referenceRelationId) activateReference(target.dataset.referenceRelationId);
      });
    }
    this.renderReadOnlyNotes(reference, unit.translationNotes);
    const sidebar = compare.createDiv({ cls: "translation-context-sidebar" });
    this.renderRelationDraft(sidebar, exercise, unit, "comparison");
    this.renderRelationInspector(workspace, exercise, unit, "comparison");
    this.renderContextPlaceholder(sidebar, unit, "comparison");
    this.renderComparisonNote(sidebar, exercise, unit);
    return main;
  }

  private renderInspectorEmptyState(
    sidebar: HTMLElement,
    kicker: string,
    hint: string,
    icon: string,
  ): void {
    const placeholder = sidebar.createDiv({ cls: "translation-context-placeholder is-empty" });
    placeholder.createDiv({ cls: "translation-reference-kicker", text: kicker });
    const figure = placeholder.createDiv({ cls: "translation-context-empty-figure" });
    setIcon(figure.createSpan({ cls: "translation-context-empty-icon" }), icon);
    figure.createDiv({ text: hint, cls: "translation-context-placeholder-value" });
  }

  private renderBackTranslationAnnotationPlaceholder(sidebar: HTMLElement, unit: TranslationUnit): void {
    const hasActive = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === "translation";
    if (hasActive) return;
    this.renderInspectorEmptyState(
      sidebar,
      "初译批注",
      "选择初译材料中的标记查看",
      "message-square-text",
    );
  }

  private renderContextPlaceholder(
    sidebar: HTMLElement,
    unit: TranslationUnit,
    layer: TranslationRelationLayer,
  ): void {
    const hasDraft = this.relationDraft?.layer === layer;
    const hasActive = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === layer;
    if (hasDraft || hasActive) return;
    this.renderInspectorEmptyState(
      sidebar,
      "关联",
      layer === "comparison" ? "拖选原文与回译片段建立关联" : "拖选原文与译文片段建立关联",
      "link",
    );
  }

  private renderUnifiedReadOnlyCard(
    parent: HTMLElement,
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    label: string,
    text: string,
    relations: TranslationRelation[],
    side: "left" | "right",
    layer: TranslationRelationLayer,
  ): void {
    const card = parent.createDiv({ cls: "translation-text-card translation-unified-card" });
    card.createDiv({ cls: "translation-card-label", text: label });
    const textEl = card.createDiv({ cls: "translation-selectable-text is-selecting" });
    const draft = this.relationDraft?.layer === layer
      ? (side === "left" ? this.relationDraft.left : this.relationDraft.right)
      : [];
    const activeId = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === layer
      ? this.activeRelation.relationId
      : undefined;
    renderRangeText(textEl, text, relations, side, draft, activeId);
    this.wireRelationSurface(textEl, workspace, exercise, unit, relations, side, layer);
  }

  private renderUnifiedEditableCard(
    parent: HTMLElement,
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    label: string,
    field: "translation" | "backTranslation",
    relations: TranslationRelation[],
    layer: TranslationRelationLayer,
  ): void {
    const card = parent.createDiv({ cls: "translation-editor-card translation-unified-card" });
    card.createDiv({ cls: "translation-card-label", text: label });
    const editor = card.createDiv({ cls: "translation-unit-editor translation-unified-editor" });
    editor.setAttr("contenteditable", "true");
    editor.setAttr("role", "textbox");
    editor.setAttr("aria-multiline", "true");
    editor.setAttr("data-placeholder", field === "translation" ? "写下你的翻译" : "检查并修改回译");
    editor.spellcheck = true;
    const text = field === "translation" ? unit.translation : unit.backTranslation;
    const draft = this.relationDraft?.layer === layer ? this.relationDraft.right : [];
    const activeId = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === layer
      ? this.activeRelation.relationId
      : undefined;
    renderRangeText(editor, text, relations, "right", draft, activeId);
    this.wireRelationSurface(editor, workspace, exercise, unit, relations, "right", layer);
    let saveTimer = 0;
    const save = (): void => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void this.persist(exercise, false), 320);
    };
    editor.addEventListener("input", () => {
      this.removeSelectionPopover();
      const nextText = editor.innerText.replace(/\r\n?/gu, "\n");
      updateTranslationUnitText(unit, field, nextText);
      this.refreshStageControls(exercise);
      this.relationUndo = [];
      this.relationRedo = [];
      this.structuralUndoPending = false;
      save();
    });
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const plainText = event.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, plainText);
    });
    editor.addEventListener("keydown", (event) => {
      if (event.key !== "Backspace" || !this.activeRelation) return;
      if (this.activeRelation.unitId !== unit.id || this.activeRelation.layer !== layer) return;
      const selection = window.getSelection();
      if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.startContainer)) return;
      const before = document.createRange();
      before.selectNodeContents(editor);
      before.setEnd(range.startContainer, range.startOffset);
      const offset = before.toString().length;
      const relation = relations.find((candidate) => candidate.id === this.activeRelation?.relationId);
      if (!relation || !relation.rightRanges.some((item) => item.from === offset || item.to === offset)) return;
      event.preventDefault();
      this.pushRelationHistory(exercise);
      relations.splice(relations.indexOf(relation), 1);
      this.activeRelation = null;
      void this.persist(exercise);
    });
    editor.addEventListener("blur", () => {
      window.clearTimeout(saveTimer);
      void this.persist(exercise, false);
    });
  }

  private wireRelationSurface(
    surface: HTMLElement,
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    relations: TranslationRelation[],
    side: "left" | "right",
    layer: TranslationRelationLayer,
    allowSelection = true,
  ): void {
    if (allowSelection) {
      surface.addEventListener("pointerdown", () => {
        window.addEventListener("pointerup", () => {
          window.requestAnimationFrame(() => {
            const range = captureTextRange(surface, false);
            if (!range) {
              this.removeSelectionPopover();
              return;
            }
            this.showSelectionPopover(surface, workspace, exercise, unit, side, layer, range);
          });
        }, { capture: true, once: true });
      });
    }
    surface.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const relationPart = target.closest<HTMLElement>("[data-relation-id]");
      const relationId = relationPart?.dataset.relationId;
      if (relationId && relations.some((relation) => relation.id === relationId)) {
        this.activateRelation(workspace, exercise, unit, layer, relationId);
      } else if (window.getSelection()?.isCollapsed) {
        this.deactivateRelation(workspace, exercise, unit, layer);
      }
    });
  }

  private showSelectionPopover(
    surface: HTMLElement,
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    side: "left" | "right",
    layer: TranslationRelationLayer,
    range: TranslationTextRange,
  ): void {
    this.removeSelectionPopover();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    const popover = document.body.createDiv({ cls: "translation-selection-popover" });
    this.selectionPopover = popover;
    popover.style.left = `${Math.max(10, Math.min(bounds.left, window.innerWidth - 170))}px`;
    popover.style.top = `${Math.max(10, bounds.bottom + 7)}px`;
    const add = popover.createEl("button", {
      text: this.relationDraft?.layer === layer ? "加入当前关联" : "加入关联",
    });
    setIcon(add.createSpan({ cls: "translation-selection-popover-icon" }), "link-2");
    add.addEventListener("pointerdown", (event) => event.preventDefault());
    add.addEventListener("click", () => {
      this.addRelationDraftSelection(unit, layer, side, range);
      selection.removeAllRanges();
      this.removeSelectionPopover();
      this.activeRelation = null;
      this.render();
    });
    const dismiss = iconButton(popover, "x", "关闭");
    dismiss.addEventListener("pointerdown", (event) => event.preventDefault());
    dismiss.addEventListener("click", () => {
      this.removeSelectionPopover();
      surface.focus();
    });
    popover.setAttr("data-unit", unit.id);
    workspace.setAttr("data-selection-side", side);
    void exercise;
  }

  private addRelationDraftSelection(
    unit: TranslationUnit,
    layer: TranslationRelationLayer,
    side: "left" | "right",
    range: TranslationTextRange,
  ): void {
    if (!this.relationDraft || this.relationDraft.layer !== layer) {
      this.relationDraft = { layer, left: [], right: [], history: [] };
    }
    this.relationDraft.history.push({ side, range: { ...range } });
    this.recomputeRelationDraft(unit);
  }

  private recomputeRelationDraft(unit: TranslationUnit): void {
    const draft = this.relationDraft;
    if (!draft) return;
    const rightText = draft.layer === "translation" ? unit.translation : unit.backTranslation;
    draft.left = normalizeTextRanges(
      draft.history.filter((item) => item.side === "left").map((item) => item.range),
      unit.sourceText.length,
    );
    draft.right = normalizeTextRanges(
      draft.history.filter((item) => item.side === "right").map((item) => item.range),
      rightText.length,
    );
  }

  private undoRelationDraftSelection(unit: TranslationUnit): void {
    const draft = this.relationDraft;
    if (!draft) return;
    draft.history.pop();
    if (!draft.history.length) this.relationDraft = null;
    else this.recomputeRelationDraft(unit);
    this.render();
  }

  private removeSelectionPopover(): void {
    this.selectionPopover?.remove();
    this.selectionPopover = null;
  }

  private hasTextSelection(): boolean {
    return Boolean(window.getSelection()?.toString());
  }

  private activateRelation(
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    layer: TranslationRelationLayer,
    relationId: string,
  ): void {
    this.activeRelation = { unitId: unit.id, layer, relationId };
    workspace.addClass("has-active-relation");
    for (const element of Array.from(workspace.querySelectorAll<HTMLElement>("[data-relation-id]"))) {
      element.toggleClass("is-active-relation", element.dataset.relationId === relationId);
    }
    this.renderRelationInspector(workspace, exercise, unit, layer);
  }

  private deactivateRelation(
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    layer: TranslationRelationLayer,
  ): void {
    if (!this.activeRelation) return;
    this.activeRelation = null;
    workspace.removeClass("has-active-relation");
    for (const element of Array.from(workspace.querySelectorAll<HTMLElement>("[data-relation-id]"))) {
      element.removeClass("is-active-relation");
    }
    const inspector = workspace.querySelector<HTMLElement>(".translation-relation-inspector");
    inspector?.empty();
    inspector?.removeClass("is-visible");
    const sidebar = workspace.querySelector<HTMLElement>(".translation-context-sidebar");
    if (!sidebar) return;
    sidebar.querySelector(".translation-context-placeholder")?.remove();
    if (exercise.stage === "backTranslate" && layer === "translation") {
      this.renderBackTranslationAnnotationPlaceholder(sidebar, unit);
    } else {
      this.renderContextPlaceholder(sidebar, unit, layer);
    }
  }

  private renderEditorCard(
    parent: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => void,
    onPersist: () => Promise<void>,
  ): void {
    const card = parent.createDiv({ cls: "translation-editor-card translation-unified-card" });
    card.createDiv({ cls: "translation-card-label", text: label });
    const textarea = card.createEl("textarea", { cls: "translation-unit-editor translation-unified-editor" });
    textarea.value = value;
    textarea.placeholder = placeholder;
    textarea.rows = 7;
    let timer = 0;
    textarea.addEventListener("input", () => {
      onChange(textarea.value);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void onPersist(), 350);
    });
    textarea.addEventListener("blur", () => {
      window.clearTimeout(timer);
      void onPersist();
    });
  }

  private renderRelationDraft(
    parent: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    layer: TranslationRelationLayer,
  ): void {
    const draft = this.relationDraft?.layer === layer ? this.relationDraft : null;
    if (!draft) return;
    const composer = parent.createDiv({ cls: "translation-relation-composer is-drafting" });
    const instruction = composer.createDiv({ cls: "translation-relation-instruction" });
    instruction.createSpan({ text: "关联草稿" });
    instruction.createEl("strong", { text: `${draft.history.length} 处已选` });

    const groups = composer.createDiv({ cls: "translation-relation-draft-groups" });
    const rightText = layer === "translation" ? unit.translation : unit.backTranslation;
    const renderGroup = (side: "left" | "right", label: string, text: string): void => {
      const group = groups.createDiv({ cls: "translation-relation-draft-group" });
      group.createDiv({ cls: "translation-relation-draft-side", text: label });
      const fragments = group.createDiv({ cls: "translation-relation-draft-fragments" });
      const entries = draft.history
        .map((selection, index) => ({ selection, index }))
        .filter(({ selection }) => selection.side === side);
      if (!entries.length) {
        fragments.createSpan({ cls: "translation-relation-draft-empty", text: "尚未选择" });
        return;
      }
      for (const { selection, index } of entries) {
        const raw = text.slice(selection.range.from, selection.range.to);
        const compact = raw.replace(/\s+/gu, " ").trim();
        const chip = fragments.createEl("button", {
          cls: "translation-relation-draft-fragment",
          attr: { type: "button", title: raw },
        });
        chip.createSpan({ text: compact.length > 34 ? `${compact.slice(0, 34)}…` : compact });
        setIcon(chip.createSpan({ cls: "translation-relation-draft-remove" }), "x");
        chip.setAttr("aria-label", `移除${label}选取：${compact}`);
        chip.addEventListener("click", () => {
          draft.history.splice(index, 1);
          if (!draft.history.length) this.relationDraft = null;
          else this.recomputeRelationDraft(unit);
          this.render();
        });
      }
    };
    renderGroup("left", "原文", unit.sourceText);
    renderGroup("right", layer === "translation" ? "译文" : "回译", rightText);

    const actions = composer.createDiv({ cls: "translation-relation-actions" });
    const undo = actions.createEl("button", { text: "撤销", cls: "translation-control-button is-quiet" });
    undo.setAttr("title", "撤销最近加入关联的文字（Ctrl+Z）");
    undo.disabled = draft.history.length === 0;
    undo.addEventListener("click", () => this.undoRelationDraftSelection(unit));
    actions.createEl("button", { text: "取消", cls: "translation-control-button is-quiet" }).addEventListener("click", () => {
      this.relationDraft = null;
      this.render();
    });
    const finish = actions.createEl("button", { text: "完成关联", cls: "translation-control-button is-primary" });
    finish.disabled = draft.left.length === 0 || draft.right.length === 0;
    finish.addEventListener("click", async () => {
      try {
        this.pushRelationHistory(exercise);
        const relation = addTranslationRelation(unit, layer, draft.left, draft.right);
        this.relationDraft = null;
        this.activeRelation = { unitId: unit.id, layer, relationId: relation.id };
        await this.persist(exercise);
      } catch (error) {
        this.relationUndo.pop();
        this.structuralUndoPending = false;
        new Notice(error instanceof Error ? error.message : String(error), 6000);
      }
    });
  }

  private renderRelationInspector(
    workspace: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    layer: TranslationRelationLayer,
  ): void {
    const inspectorHost = workspace.querySelector<HTMLElement>(".translation-context-sidebar") ?? workspace;
    let inspector = inspectorHost.querySelector<HTMLElement>(".translation-relation-inspector");
    if (!inspector) inspector = inspectorHost.createDiv({ cls: "translation-relation-inspector" });
    inspector.empty();
    const active = this.activeRelation;
    if (!active || active.unitId !== unit.id || active.layer !== layer) {
      inspector.removeClass("is-visible");
      workspace.removeClass("has-active-relation");
      return;
    }
    const relations = layer === "translation" ? unit.translationRelations : unit.comparisonRelations;
    const relation = relations.find((candidate) => candidate.id === active.relationId);
    if (!relation) {
      this.activeRelation = null;
      inspector.removeClass("is-visible");
      workspace.removeClass("has-active-relation");
      return;
    }
    inspector.addClass("is-visible");
    workspace.addClass("has-active-relation");
    inspectorHost.querySelector(".translation-context-placeholder")?.remove();
    const readonlyProjection = exercise.stage === "backTranslate" && layer === "translation";
    inspector.toggleClass("is-readonly", readonlyProjection);
    const header = inspector.createDiv({ cls: "translation-relation-inspector-header" });
    const title = header.createDiv();
    title.createDiv({ cls: "translation-reference-kicker", text: readonlyProjection ? "初译片段" : "关联" });
    title.createDiv({
      cls: "translation-relation-inspector-summary",
      text: readonlyProjection
        ? this.describeTranslationRelationRightSide(unit, relation)
        : this.describeRelation(unit, relation, layer),
    });
    const close = iconButton(header, "x", "关闭关联检查器");
    close.addEventListener("click", () => this.deactivateRelation(workspace, exercise, unit, layer));

    if (readonlyProjection) {
      this.renderReadOnlyTranslationRelationDetails(inspector, relation);
      return;
    }

    const tagSection = inspector.createDiv({ cls: "translation-relation-tag-section" });
    tagSection.createDiv({ cls: "translation-field-label", text: "Tags" });
    const tagBody = tagSection.createDiv({ cls: "translation-relation-tag-body" });
    const renderTags = (): void => {
      tagBody.empty();
      const chips = tagBody.createDiv({ cls: "translation-relation-tags" });
      for (const tagId of [...relation.tagIds]) {
        const path = this.host.getTranslationTagPath(tagId) || "已删除的标签";
        const chip = chips.createEl("button", { cls: `translation-relation-tag${path === "已删除的标签" ? " is-orphan" : ""}` });
        chip.createSpan({ text: path });
        setIcon(chip.createSpan(), "x");
        chip.setAttr("aria-label", `移除 ${path}`);
        chip.addEventListener("click", async () => {
          relation.tagIds = relation.tagIds.filter((id) => id !== tagId);
          await this.persist(exercise, false);
          renderTags();
        });
      }
      for (const [index, legacyTag] of relation.tags.entries()) {
        const chip = chips.createEl("button", { cls: "translation-relation-tag is-legacy" });
        chip.createSpan({ text: legacyTag });
        setIcon(chip.createSpan(), "x");
        chip.setAttr("aria-label", `移除 ${legacyTag}`);
        chip.addEventListener("click", async () => {
          relation.tags.splice(index, 1);
          await this.persist(exercise, false);
          renderTags();
        });
      }
      const add = tagBody.createEl("button", { cls: "translation-tag-add-button" });
      setIcon(add.createSpan(), "plus");
      add.createSpan({ text: "添加标签" });
      add.addEventListener("click", () => {
        const existing = tagBody.querySelector<HTMLElement>(".translation-tag-picker");
        if (existing) {
          existing.remove();
          return;
        }
        this.renderTranslationTagPicker(tagBody, exercise, relation);
      });
    };
    renderTags();

    const commentLabel = inspector.createEl("label", { cls: "translation-relation-comment" });
    commentLabel.createSpan({ cls: "translation-field-label", text: "评论" });
    const comment = commentLabel.createEl("textarea");
    comment.rows = 3;
    comment.placeholder = "写下这组对应关系的说明";
    comment.value = relation.note;
    this.bindPersistentNoteHeight(comment);
    let noteTimer = 0;
    comment.addEventListener("input", () => {
      relation.note = comment.value;
      window.clearTimeout(noteTimer);
      noteTimer = window.setTimeout(() => void this.persist(exercise, false), 320);
    });
    comment.addEventListener("blur", () => {
      window.clearTimeout(noteTimer);
      void this.persist(exercise, false);
    });

    const footer = inspector.createDiv({ cls: "translation-relation-inspector-footer" });
    const remove = footer.createEl("button", { cls: "translation-danger-action" });
    setIcon(remove.createSpan(), "unlink");
    remove.createSpan({ text: "解除关联" });
    remove.addEventListener("click", async () => {
      this.pushRelationHistory(exercise);
      relations.splice(relations.indexOf(relation), 1);
      this.activeRelation = null;
      await this.persist(exercise);
    });
  }

  private renderReadOnlyTranslationRelationDetails(parent: HTMLElement, relation: TranslationRelation): void {
    const tagSection = parent.createDiv({ cls: "translation-relation-tag-section" });
    tagSection.createDiv({ cls: "translation-field-label", text: "Tags" });
    const tags = tagSection.createDiv({ cls: "translation-relation-tags" });
    const paths = [
      ...relation.tagIds.map((tagId) => this.host.getTranslationTagPath(tagId) || "已删除的标签"),
      ...relation.tags,
    ];
    if (paths.length) {
      for (const path of paths) tags.createSpan({ cls: "translation-relation-tag is-readonly", text: path });
    } else {
      tags.createSpan({ cls: "translation-relation-empty", text: "无" });
    }

    const comment = parent.createDiv({ cls: "translation-relation-comment is-readonly" });
    comment.createDiv({ cls: "translation-field-label", text: "评论" });
    comment.createDiv({
      cls: `translation-relation-comment-value${relation.note.trim() ? "" : " is-empty"}`,
      text: relation.note.trim() || "无评论",
    });
  }

  private renderTranslationTagPicker(
    parent: HTMLElement,
    exercise: TranslationExercise,
    relation: TranslationRelation,
  ): void {
    const picker = parent.createDiv({ cls: "translation-tag-picker" });
    const onOutsidePointerDown = (event: PointerEvent): void => {
      if (picker.isConnected && event.target instanceof Node && picker.contains(event.target)) return;
      document.removeEventListener("pointerdown", onOutsidePointerDown, true);
      picker.remove();
    };
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
    const search = picker.createDiv({ cls: "translation-tag-picker-search" });
    setIcon(search.createSpan(), "search");
    const input = search.createEl("input", { type: "text", placeholder: "搜索标签，或输入 # 查找 Obsidian Tag" });
    const results = picker.createDiv({ cls: "translation-tag-picker-results" });
    let nativeFilter = "";
    let activeResultIndex = -1;

    const getResultRows = (): HTMLButtonElement[] =>
      Array.from(results.querySelectorAll<HTMLButtonElement>(".translation-tag-picker-row"));
    const activateResult = (index: number): void => {
      const rows = getResultRows();
      if (!rows.length) {
        activeResultIndex = -1;
        return;
      }
      activeResultIndex = Math.max(0, Math.min(index, rows.length - 1));
      rows.forEach((row, rowIndex) => {
        const active = rowIndex === activeResultIndex;
        row.toggleClass("is-keyboard-active", active);
        row.setAttr("aria-selected", String(active));
      });
      rows[activeResultIndex]?.scrollIntoView({ block: "nearest" });
    };
    const finishResults = (): void => {
      const rows = getResultRows();
      rows.forEach((row, index) => row.addEventListener("mouseenter", () => activateResult(index)));
      activateResult(0);
    };

    const addTag = async (tag: TranslationTagOption): Promise<void> => {
      if (!relation.tagIds.includes(tag.id)) relation.tagIds.push(tag.id);
      await this.persist(exercise, false);
      this.render();
    };
    const renderResults = (): void => {
      results.empty();
      const query = input.value.trim();
      if (nativeFilter) {
        const context = results.createDiv({ cls: "translation-tag-native-context" });
        context.createSpan({ text: `通过 ${nativeFilter} 查找` });
        const clear = iconButton(context, "x", "清除 Obsidian Tag 条件");
        clear.addEventListener("click", () => {
          nativeFilter = "";
          input.value = "";
          renderResults();
          input.focus();
        });
      }
      if (query.startsWith("#") && !nativeFilter) {
        const nativeTags = this.host.getObsidianTags()
          .filter((tag) => tag.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .slice(0, 10);
        results.createDiv({ cls: "translation-tag-picker-heading", text: "Obsidian Tags" });
        for (const nativeTag of nativeTags) {
          const row = results.createEl("button", { cls: "translation-tag-picker-row is-native" });
          setIcon(row.createSpan(), "hash");
          row.createSpan({ text: nativeTag });
          row.addEventListener("click", () => {
            nativeFilter = nativeTag;
            input.value = "";
            renderResults();
            input.focus();
          });
        }
        if (!nativeTags.length) results.createDiv({ cls: "translation-tag-picker-empty", text: "没有匹配的 Obsidian Tag" });
        finishResults();
        return;
      }

      const lowered = query.toLocaleLowerCase();
      const candidates = this.host.translationTags
        .filter((tag) => !relation.tagIds.includes(tag.id))
        .filter((tag) => !nativeFilter || tag.obsidianTags.some((nativeTag) => normalizeNativeTag(nativeTag) === normalizeNativeTag(nativeFilter)))
        .filter((tag) => {
          if (!lowered) return true;
          const path = this.host.getTranslationTagPath(tag.id);
          return path.toLocaleLowerCase().includes(lowered)
            || tag.aliases.some((alias) => alias.toLocaleLowerCase().includes(lowered));
        })
        .slice(0, 10);
      results.createDiv({
        cls: "translation-tag-picker-heading",
        text: nativeFilter ? `关联了 ${nativeFilter} 的插件标签` : "插件标签",
      });
      for (const tag of candidates) {
        const path = this.host.getTranslationTagPath(tag.id);
        const row = results.createEl("button", { cls: "translation-tag-picker-row" });
        const copy = row.createDiv();
        copy.createSpan({ text: path });
        if (tag.obsidianTags.length) copy.createEl("small", { text: tag.obsidianTags.join(" · ") });
        setIcon(row.createSpan(), "plus");
        row.addEventListener("click", () => void addTag(tag));
      }
      if (query && !query.startsWith("#")) {
        const exact = this.host.translationTags.some((tag) =>
          this.host.getTranslationTagPath(tag.id).toLocaleLowerCase() === lowered);
        if (!exact) {
          const create = results.createEl("button", { cls: "translation-tag-picker-row is-create" });
          setIcon(create.createSpan(), "plus-circle");
          create.createSpan({ text: nativeFilter ? `新建“${query}”并关联 ${nativeFilter}` : `新建“${query}”` });
          create.addEventListener("click", async () => {
            try {
              const tag = await this.host.saveTranslationTag(query, nativeFilter ? [nativeFilter] : []);
              await addTag(tag);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : String(error), 6000);
            }
          });
        }
      }
      if (!candidates.length && !query) {
        results.createDiv({
          cls: "translation-tag-picker-empty",
          text: nativeFilter ? "尚无关联标签；输入名称即可创建" : "输入名称创建第一个插件标签",
        });
      }
      finishResults();
    };
    input.addEventListener("input", renderResults);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const rows = getResultRows();
        if (!rows.length) return;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const next = activeResultIndex < 0
          ? 0
          : (activeResultIndex + direction + rows.length) % rows.length;
        activateResult(next);
        return;
      }
      if (event.key === "Enter") {
        const row = getResultRows()[activeResultIndex];
        if (!row) return;
        event.preventDefault();
        event.stopPropagation();
        row.click();
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        picker.remove();
      }
    });
    renderResults();
    input.focus();
  }

  private describeRelation(unit: TranslationUnit, relation: TranslationRelation, layer: TranslationRelationLayer): string {
    const pick = (text: string, ranges: TranslationTextRange[]): string =>
      ranges.map((range) => text.slice(range.from, range.to)).join(" … ");
    return `${pick(unit.sourceText, relation.leftRanges)}  ↔  ${pick(layer === "translation" ? unit.translation : unit.backTranslation, relation.rightRanges)}`;
  }

  private describeTranslationRelationRightSide(unit: TranslationUnit, relation: TranslationRelation): string {
    return relation.rightRanges
      .map((range) => unit.translation.slice(range.from, range.to))
      .join(" … ");
  }

  private renderComparisonNote(parent: HTMLElement, exercise: TranslationExercise, unit: TranslationUnit): void {
    const section = parent.createDiv({ cls: "translation-comparison-note" });
    section.createDiv({ cls: "translation-notes-title", text: "对照笔记" });
    const textarea = section.createEl("textarea", {
      cls: "translation-comparison-note-editor",
      placeholder: "记录这个条目的整体对照结论",
    });
    textarea.rows = 4;
    textarea.value = unit.comparisonNote;
    this.bindPersistentNoteHeight(textarea);
    let timer = 0;
    textarea.addEventListener("input", () => {
      unit.comparisonNote = textarea.value;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.persist(exercise, false), 320);
    });
    textarea.addEventListener("blur", () => {
      window.clearTimeout(timer);
      void this.persist(exercise, false);
    });
  }

  private renderSentenceNote(
    parent: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    stage: "translation" | "backTranslation",
    label: string,
  ): void {
    const notes = stage === "translation" ? unit.translationNotes : unit.backTranslationNotes;
    const section = parent.createDiv({ cls: "translation-sentence-note is-static" });
    const heading = section.createDiv({ cls: "translation-sentence-note-heading" });
    setIcon(heading.createSpan({ cls: "translation-sentence-note-icon" }), "message-square-text");
    heading.createSpan({ cls: "translation-sentence-note-label", text: label });

    const editorWrap = section.createDiv({ cls: "translation-sentence-note-editor-wrap" });
    const textarea = editorWrap.createEl("textarea", {
      cls: "translation-sentence-note-editor",
      placeholder: "记录这一句的整体提示或说明",
    });
    textarea.rows = 2;
    textarea.value = notes[0]?.text ?? "";
    if (stage === "translation") this.bindPersistentNoteHeight(textarea);
    let saveTimer = 0;
    textarea.addEventListener("input", () => {
      setTranslationNote(unit, stage, textarea.value);
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void this.persist(exercise, false), 320);
    });
    textarea.addEventListener("blur", () => {
      window.clearTimeout(saveTimer);
      void this.persist(exercise, false);
    });
  }

  private bindPersistentNoteHeight(textarea: HTMLTextAreaElement): void {
    const saved = this.host.getNoteEditorHeight();
    if (saved) textarea.style.height = `${saved}px`;
    let startHeight = 0;
    textarea.addEventListener("mousedown", () => {
      startHeight = textarea.offsetHeight;
    });
    textarea.addEventListener("mouseup", () => {
      const height = textarea.offsetHeight;
      if (height > 0 && height !== startHeight) void this.host.setNoteEditorHeight(height);
    });
  }

  private renderReadOnlyNotes(parent: HTMLElement, notes: readonly TranslationNote[]): void {
    if (!notes.length) return;
    const list = parent.createDiv({ cls: "translation-readonly-notes" });
    for (const note of notes) {
      const row = list.createDiv();
      setIcon(row.createSpan(), "message-square-text");
      row.createSpan({ text: note.text });
    }
  }

  private renderWorkbenchFooter(
    parent: HTMLElement,
    exercise: TranslationExercise,
    units: TranslationUnit[],
    activeIndex: number,
    stage: "translate" | "backTranslate" | "compare",
  ): void {
    const footer = parent.createDiv({ cls: "translation-work-footer" });
    const navigation = footer.createDiv({ cls: "translation-work-footer-navigation" });
    const previous = navigation.createEl("button", { cls: "translation-control-button is-navigation translation-previous-unit" });
    setIcon(previous.createSpan(), "arrow-left");
    previous.createSpan({ text: "上一项" });
    previous.disabled = activeIndex <= 0;
    previous.addEventListener("click", () => {
      const currentIndex = units.findIndex((unit) => unit.id === exercise.activeUnitId);
      this.moveToUnit(exercise, units, currentIndex - 1);
    });
    const next = navigation.createEl("button", { cls: "translation-control-button is-navigation translation-next-unit" });
    next.createSpan({ text: "下一项" });
    setIcon(next.createSpan(), "arrow-right");
    next.disabled = activeIndex >= units.length - 1;
    next.addEventListener("click", () => {
      const currentIndex = units.findIndex((unit) => unit.id === exercise.activeUnitId);
      this.moveToUnit(exercise, units, currentIndex + 1);
    });
    const progress = getTranslationStageProgress(exercise);
    footer.createDiv({ cls: "translation-work-footer-progress", text: `${activeIndex + 1} / ${progress.total}` });
    const complete = footer.createEl("button", { cls: "translation-control-button is-primary translation-stage-complete" });
    complete.createSpan({ text: stage === "translate" ? "完成初译" : stage === "backTranslate" ? "完成回译，开始对照" : "完成练习" });
    setIcon(complete.createSpan(), "arrow-right");
    complete.disabled = !progress.ready;
    complete.addEventListener("click", () => void this.completeCurrentStage(exercise, stage));
  }

  private refreshStageControls(exercise: TranslationExercise): void {
    const progress = getTranslationStageProgress(exercise);
    const progressEl = this.contentEl.querySelector<HTMLElement>(".translation-work-footer-progress");
    const activeIndex = getTranslationUnits(exercise).findIndex((unit) => unit.id === exercise.activeUnitId);
    if (progressEl) progressEl.textContent = `${Math.max(0, activeIndex) + 1} / ${progress.total}`;
    const complete = this.contentEl.querySelector<HTMLButtonElement>(".translation-stage-complete");
    if (complete) complete.disabled = !progress.ready;
    const previous = this.contentEl.querySelector<HTMLButtonElement>(".translation-previous-unit");
    const next = this.contentEl.querySelector<HTMLButtonElement>(".translation-next-unit");
    if (previous) previous.disabled = activeIndex <= 0;
    if (next) next.disabled = activeIndex < 0 || activeIndex >= getTranslationUnits(exercise).length - 1;
    const active = findTranslationUnit(exercise, exercise.activeUnitId);
    if (!active) return;
    const navItem = this.contentEl.querySelector<HTMLElement>(`.translation-unit-nav-item[data-unit-id="${active.id}"]`);
    if (!navItem) return;
    const hasContent = statusForStage(active, exercise.stage) !== "empty";
    navItem.toggleClass("has-content", hasContent);
    const state = navItem.querySelector<HTMLElement>(".translation-unit-check");
    if (state) {
      state.empty();
      if (hasContent) setIcon(state, "circle-dot");
    }
  }

  private moveToUnit(exercise: TranslationExercise, units: TranslationUnit[], index: number): void {
    const target = units[index];
    if (!target) return;
    exercise.activeUnitId = target.id;
    this.relationDraft = null;
    this.activeRelation = null;
    this.relationUndo = [];
    this.relationRedo = [];
    this.structuralUndoPending = false;
    this.render();
  }

  private async completeCurrentStage(
    exercise: TranslationExercise,
    stage: "translate" | "backTranslate" | "compare",
  ): Promise<void> {
    if (!getTranslationStageProgress(exercise).ready) return;
    if (stage === "translate") {
      new BackTranslationScheduleModal(this.app, this.host.defaultBackTranslationDelayDays, async (dueAt) => {
        scheduleBackTranslation(exercise, dueAt);
        this.relationDraft = null;
        this.activeRelation = null;
        this.relationUndo = [];
        this.relationRedo = [];
        this.structuralUndoPending = false;
        await this.persist(exercise);
      }).open();
      return;
    }
    if (stage === "backTranslate") {
      setTranslationStage(exercise, "compare");
      await this.persist(exercise);
      return;
    }
    setTranslationStage(exercise, "complete");
    this.page = "article";
    await this.persist(exercise);
  }

  private renderArticle(container: HTMLElement, exercise: TranslationExercise): void {
    const shell = container.createDiv({ cls: `translation-article-page is-${exercise.stage}` });
    const header = shell.createDiv({ cls: "translation-article-page-header" });
    const back = iconButton(header, "arrow-left", this.articleReturnPage === "records" ? "返回句子记录" : "返回文本列表");
    back.addEventListener("click", () => { this.page = this.articleReturnPage; this.render(); });
    const heading = header.createDiv({ cls: "translation-article-page-title" });
    heading.createDiv({ cls: "translation-eyebrow", text: STAGE_LABELS[exercise.stage] });
    heading.createEl("h1", { text: exercise.title });
    const units = getTranslationUnits(exercise);
    const relationCount = units.reduce(
      (sum, unit) => sum + unit.translationRelations.length + unit.comparisonRelations.length,
      0,
    );
    heading.createDiv({
      cls: "translation-article-page-meta",
      text: exercise.stage === "complete"
        ? `${LANGUAGE_LABELS[exercise.language]} · ${units.length} 个单位 · ${relationCount} 组关联 · 完成于 ${formatDate(exercise.completedAt)}`
        : `${LANGUAGE_LABELS[exercise.language]} · ${units.length} 个单位`,
    });
    const actions = header.createDiv({ cls: "translation-task-header-actions" });
    if (exercise.source) {
      const source = iconButton(actions, "file-text", "打开来源");
      source.addEventListener("click", () => void this.host.openTranslationSource(exercise));
    }
    const more = iconButton(actions, "ellipsis", "更多");
    more.addEventListener("click", (event) => this.openExerciseMenu(event, exercise));
    if (exercise.stage === "waitingBackTranslation") this.renderWaitingArticle(shell, exercise);
    else this.renderCompletedArticle(shell, exercise);
  }

  private renderWaitingArticle(shell: HTMLElement, exercise: TranslationExercise): void {
    const timing = getBackTranslationTiming(exercise);
    const hero = shell.createDiv({ cls: "translation-waiting-hero" });
    const calendar = hero.createDiv({ cls: "translation-waiting-calendar" });
    setIcon(calendar, "calendar-clock");
    const text = hero.createDiv();
    text.createDiv({ cls: "translation-waiting-date", text: formatDate(exercise.backTranslationDueAt) });
    text.createEl("h2", {
      text: timing?.kind === "future" ? `${timing.days} 天后开始回译`
        : timing?.kind === "overdue" ? `已超过计划 ${timing.days} 天`
          : "今天可以开始回译",
    });
    text.createDiv({ text: "初译内容与批注已经保存。开始后，原文会被隐藏。" });
    const start = hero.createEl("button", { text: timing?.kind === "future" ? "提前开始" : "开始回译", cls: "mod-cta" });
    start.addEventListener("click", async () => {
      setTranslationStage(exercise, "backTranslate");
      this.page = "task";
      await this.persist(exercise);
    });
    const summary = shell.createDiv({ cls: "translation-waiting-summary" });
    summary.createDiv({ cls: "translation-summary-stat", text: `${getTranslationUnits(exercise).length}` })
      .createSpan({ text: " 个单位" });
    summary.createDiv({ cls: "translation-summary-stat", text: `${getTranslationUnits(exercise).reduce((sum, unit) => sum + unit.translationRelations.length, 0)}` })
      .createSpan({ text: " 组关联" });
    summary.createDiv({ cls: "translation-summary-stat", text: `${getTranslationUnits(exercise).reduce((sum, unit) => sum + unit.translationNotes.length, 0)}` })
      .createSpan({ text: " 条批注" });
  }

  private renderCompletedArticle(shell: HTMLElement, exercise: TranslationExercise): void {
    const units = getTranslationUnits(exercise);
    let active = findTranslationUnit(exercise, exercise.activeUnitId);
    if (!active?.assigned) {
      active = units[0];
      exercise.activeUnitId = active?.id ?? null;
    }
    if (!active) return;

    const archive = shell.createDiv({ cls: "translation-completed-archive" });
    const toolbar = archive.createDiv({ cls: "translation-completed-toolbar" });
    const projections = toolbar.createDiv({ cls: "translation-completed-projections" });
    for (const [value, label] of [
      ["sourceText", "原文"],
      ["translation", "初译"],
      ["backTranslation", "回译"],
    ] as const) {
      const button = projections.createEl("button", { text: label });
      button.toggleClass("is-active", this.completedProjection === value);
      button.setAttr("aria-pressed", String(this.completedProjection === value));
      button.addEventListener("click", () => {
        this.completedProjection = value;
        if (value === "translation") this.completedDetailLayer = "translation";
        else if (value === "backTranslation") this.completedDetailLayer = "comparison";
        this.activeRelation = null;
        this.render();
      });
    }
    toolbar.createDiv({ cls: "translation-completed-toolbar-hint", text: "点击全文中的单位查看完整成果" });
    const layout = archive.createDiv({ cls: "translation-completed-layout" });
    this.renderCompletedDocument(layout, exercise, active);
    this.renderCompletedUnitDetail(layout, exercise, active);
  }

  private renderCompletedDocument(
    parent: HTMLElement,
    exercise: TranslationExercise,
    active: TranslationUnit,
  ): void {
    const document = parent.createDiv({ cls: "translation-completed-document" });
    const label = this.completedProjection === "sourceText"
      ? "原文全文"
      : this.completedProjection === "translation" ? "初译全文" : "回译全文";
    const heading = document.createDiv({ cls: "translation-completed-document-heading" });
    heading.createEl("strong", { text: label });
    heading.createSpan({ text: `${exercise.blocks.length} 个自然段` });
    const layer: TranslationRelationLayer = this.completedProjection === "translation"
      ? "translation"
      : this.completedProjection === "backTranslation" ? "comparison" : this.completedDetailLayer;
    const side: "left" | "right" = this.completedProjection === "sourceText" ? "left" : "right";

    for (const [blockIndex, block] of exercise.blocks.entries()) {
      const blockUnits = block.units.filter((unit) => unit.assigned);
      if (!blockUnits.length) continue;
      const sourceSeparators = getTranslationBlockUnitSeparators(block);
      const paragraph = document.createDiv({ cls: "translation-completed-paragraph" });
      paragraph.createDiv({ cls: "translation-completed-paragraph-number", text: `P${blockIndex + 1}` });
      const flow = paragraph.createDiv({ cls: "translation-completed-flow" });
      blockUnits.forEach((unit, index) => {
        const relations = layer === "translation" ? unit.translationRelations : unit.comparisonRelations;
        const text = unit[this.completedProjection];
        const wrapper = flow.createSpan({ cls: "translation-completed-unit" });
        wrapper.toggleClass("is-active", unit.id === active.id);
        wrapper.setAttr("data-unit-id", unit.id);
        wrapper.setAttr("tabindex", "0");
        wrapper.setAttr("aria-label", `查看 S${getTranslationUnits(exercise).indexOf(unit) + 1}`);
        if (unit.id === active.id) wrapper.setAttr("aria-current", "true");
        const surface = wrapper.createSpan({ cls: "translation-completed-unit-text" });
        const activeRelationId = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === layer
          ? this.activeRelation.relationId
          : undefined;
        renderRangeText(surface, text, relations, side, [], activeRelationId);
        const activate = (relationId?: string): void => {
          exercise.activeUnitId = unit.id;
          this.completedDetailLayer = layer;
          this.activeRelation = relationId ? { unitId: unit.id, layer, relationId } : null;
          this.render();
        };
        wrapper.addEventListener("click", (event) => {
          if (this.hasTextSelection()) return;
          const relationId = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-relation-id]")?.dataset.relationId
            : undefined;
          activate(relationId);
        });
        wrapper.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate();
        });
        const next = blockUnits[index + 1];
        if (next) {
          flow.createSpan({
            cls: "translation-completed-separator",
            text: fullTextSeparator(
              this.completedProjection,
              text,
              next[this.completedProjection],
              sourceSeparators[index] ?? "",
            ) || "\u200b",
          });
        }
      });
    }
  }

  private renderCompletedUnitDetail(
    parent: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
  ): void {
    const units = getTranslationUnits(exercise);
    const index = units.indexOf(unit);
    const detail = parent.createDiv({ cls: "translation-completed-detail" });
    const header = detail.createDiv({ cls: "translation-completed-detail-header" });
    const identity = header.createDiv({ cls: "translation-completed-detail-identity" });
    identity.createSpan({ text: "当前单位" });
    identity.createEl("strong", { text: `S${index + 1}` });
    const navigation = header.createDiv({ cls: "translation-completed-detail-navigation" });
    const previous = iconButton(navigation, "chevron-left", "上一项");
    previous.disabled = index <= 0;
    previous.addEventListener("click", () => {
      const target = units[index - 1];
      if (!target) return;
      exercise.activeUnitId = target.id;
      this.activeRelation = null;
      this.render();
    });
    const next = iconButton(navigation, "chevron-right", "下一项");
    next.disabled = index < 0 || index >= units.length - 1;
    next.addEventListener("click", () => {
      const target = units[index + 1];
      if (!target) return;
      exercise.activeUnitId = target.id;
      this.activeRelation = null;
      this.render();
    });

    const tabs = detail.createDiv({ cls: "translation-completed-detail-tabs" });
    for (const [layer, label] of [["translation", "初译成果"], ["comparison", "回译对照"]] as const) {
      const button = tabs.createEl("button", { text: label });
      button.toggleClass("is-active", this.completedDetailLayer === layer);
      button.setAttr("aria-pressed", String(this.completedDetailLayer === layer));
      button.addEventListener("click", () => {
        this.completedDetailLayer = layer;
        if (layer === "translation" && this.completedProjection === "backTranslation") this.completedProjection = "sourceText";
        if (layer === "comparison" && this.completedProjection === "translation") this.completedProjection = "sourceText";
        this.activeRelation = null;
        this.render();
      });
    }

    const relations = this.completedDetailLayer === "translation" ? unit.translationRelations : unit.comparisonRelations;
    const targetText = this.completedDetailLayer === "translation" ? unit.translation : unit.backTranslation;
    const targetLabel = this.completedDetailLayer === "translation" ? "初译" : "回译";
    this.renderCompletedTextLayer(detail, exercise, unit, "原文", unit.sourceText, relations, "left", this.completedDetailLayer);
    this.renderCompletedTextLayer(detail, exercise, unit, targetLabel, targetText, relations, "right", this.completedDetailLayer);
    if (this.completedDetailLayer === "comparison") this.renderCompletedInitialReference(detail, exercise, unit);
    this.renderCompletedRelationArchive(detail, exercise, unit, relations, this.completedDetailLayer);
    this.renderCompletedNotes(detail, unit, this.completedDetailLayer);
  }

  private renderCompletedTextLayer(
    parent: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    label: string,
    text: string,
    relations: TranslationRelation[],
    side: "left" | "right",
    layer: TranslationRelationLayer,
  ): void {
    const section = parent.createDiv({ cls: "translation-completed-text-layer" });
    section.createDiv({ cls: "translation-card-label", text: label });
    const content = section.createDiv({ cls: "translation-completed-text" });
    const activeId = this.activeRelation?.unitId === unit.id && this.activeRelation.layer === layer
      ? this.activeRelation.relationId
      : undefined;
    renderRangeText(content, text, relations, side, [], activeId);
    content.addEventListener("click", (event) => {
      if (this.hasTextSelection()) return;
      const relationId = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-relation-id]")?.dataset.relationId
        : undefined;
      if (!relationId) return;
      this.activeRelation = { unitId: unit.id, layer, relationId };
      this.completedDetailLayer = layer;
      exercise.activeUnitId = unit.id;
      this.render();
    });
  }

  private renderCompletedInitialReference(
    parent: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
  ): void {
    const reference = parent.createEl("details", { cls: "translation-completed-initial-reference" });
    reference.createEl("summary", { text: "初译参照" });
    const text = reference.createDiv({ cls: "translation-completed-reference-text" });
    renderRangeText(text, unit.translation, unit.translationRelations, "right");
    text.addEventListener("click", (event) => {
      if (this.hasTextSelection()) return;
      const relationId = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-relation-id]")?.dataset.relationId
        : undefined;
      if (!relationId) return;
      this.completedDetailLayer = "translation";
      this.completedProjection = "sourceText";
      this.activeRelation = { unitId: unit.id, layer: "translation", relationId };
      exercise.activeUnitId = unit.id;
      this.render();
    });
    const noteText = unit.translationNotes[0]?.text;
    if (noteText) {
      const note = reference.createDiv({ cls: "translation-completed-reference-note" });
      setIcon(note.createSpan(), "message-square-text");
      note.createSpan({ text: noteText });
    }
  }

  private renderCompletedRelationArchive(
    parent: HTMLElement,
    exercise: TranslationExercise,
    unit: TranslationUnit,
    relations: TranslationRelation[],
    layer: TranslationRelationLayer,
  ): void {
    const archive = parent.createDiv({ cls: "translation-completed-relations" });
    const heading = archive.createDiv({ cls: "translation-completed-section-heading" });
    heading.createEl("strong", { text: "关联" });
    heading.createSpan({ text: layer === "translation" ? "原文—初译" : "原文—回译" });
    if (!relations.length) {
      archive.createDiv({ cls: "translation-completed-empty", text: "没有建立关联" });
      return;
    }
    const list = archive.createDiv({ cls: "translation-completed-relation-list" });
    for (const [index, relation] of relations.entries()) {
      const row = list.createEl("button", { cls: "translation-completed-relation-row" });
      const active = this.activeRelation?.unitId === unit.id
        && this.activeRelation.layer === layer
        && this.activeRelation.relationId === relation.id;
      row.toggleClass("is-active", active);
      row.createSpan({ cls: "translation-completed-relation-number", text: String(index + 1) });
      row.createSpan({ text: this.describeRelation(unit, relation, layer) });
      row.addEventListener("click", () => {
        if (this.hasTextSelection()) return;
        this.activeRelation = active ? null : { unitId: unit.id, layer, relationId: relation.id };
        exercise.activeUnitId = unit.id;
        this.render();
      });
    }
    const activeRelation = relations.find((relation) =>
      this.activeRelation?.unitId === unit.id
      && this.activeRelation.layer === layer
      && this.activeRelation.relationId === relation.id);
    if (!activeRelation) return;
    const details = archive.createDiv({ cls: "translation-completed-relation-details" });
    this.renderReadOnlyTranslationRelationDetails(details, activeRelation);
  }

  private renderCompletedNotes(
    parent: HTMLElement,
    unit: TranslationUnit,
    layer: TranslationRelationLayer,
  ): void {
    const notes = parent.createDiv({ cls: "translation-completed-notes" });
    const rows = layer === "translation"
      ? unit.translationNotes.map((note) => ["句子批注", note.text] as const)
      : [
        ...unit.backTranslationNotes.map((note) => ["回译笔记", note.text] as const),
        ...(unit.comparisonNote.trim() ? [["对照笔记", unit.comparisonNote] as const] : []),
      ];
    if (!rows.length) {
      notes.createDiv({ cls: "translation-completed-empty", text: "没有句子级笔记" });
      return;
    }
    for (const [label, value] of rows) {
      const row = notes.createDiv({ cls: "translation-completed-note-row" });
      setIcon(row.createSpan(), label === "对照笔记" ? "scan-text" : "notebook-pen");
      const copy = row.createDiv();
      copy.createEl("strong", { text: label });
      copy.createDiv({ text: value });
    }
  }

  private renderRecords(container: HTMLElement): void {
    this.renderTopbar(container, "records");
    const page = container.createDiv({ cls: "translation-records-page" });
    const hero = page.createDiv({ cls: "translation-records-header" });
    const text = hero.createDiv();
    text.createDiv({ cls: "translation-eyebrow", text: "COMPLETED CORPUS" });
    text.createEl("h1", { text: "句子记录" });
    const complete = this.host.translationExercises.filter((exercise) => exercise.stage === "complete");
    const recordCount = complete.reduce((sum, exercise) => sum + getTranslationUnits(exercise).length, 0);
    text.createDiv({ text: `${recordCount} 条记录 · 来自 ${complete.length} 篇已完成文本`, cls: "translation-library-subtitle" });
    const searchWrap = hero.createDiv({ cls: "translation-search" });
    setIcon(searchWrap.createSpan(), "search");
    const search = searchWrap.createEl("input", { type: "search", placeholder: "搜索原文、译文、Tag 或评论" });
    search.value = this.query;
    const results = page.createDiv({ cls: "translation-record-grid" });
    const render = (): void => {
      this.query = search.value;
      results.empty();
      const query = this.query.trim().toLocaleLowerCase();
      const records = complete.flatMap((exercise) =>
        getTranslationUnits(exercise).map((unit, index) => ({ exercise, unit, index })))
        .filter(({ unit, exercise }) => {
          const relationText = [...unit.translationRelations, ...unit.comparisonRelations]
            .flatMap((relation) => [
              ...relation.tags,
              ...relation.tagIds.map((id) => this.host.getTranslationTagPath(id)),
              relation.note,
            ])
            .join("\n");
          const noteText = [
            ...unit.translationNotes.map((note) => note.text),
            ...unit.backTranslationNotes.map((note) => note.text),
            unit.comparisonNote,
          ].join("\n");
          return !query || `${exercise.title}\n${unit.sourceText}\n${unit.translation}\n${unit.backTranslation}\n${relationText}\n${noteText}`
            .toLocaleLowerCase().includes(query);
        });
      if (!records.length) {
        results.createDiv({ cls: "translation-empty-state", text: recordCount ? "没有符合条件的记录。" : "完成一篇文本后，句子记录会一次性出现在这里。" });
        return;
      }
      for (const { exercise, unit, index } of records) {
        const card = results.createDiv({ cls: "translation-record-card" });
        const top = card.createDiv({ cls: "translation-record-card-top" });
        top.createSpan({ text: `${exercise.title} · S${index + 1}` });
        top.createSpan({ text: LANGUAGE_LABELS[exercise.language] });
        card.createDiv({ cls: "translation-record-original", text: unit.sourceText });
        const pair = card.createDiv({ cls: "translation-record-pair" });
        const translation = pair.createDiv();
        translation.createSpan({ text: "初译" });
        translation.createDiv({ text: unit.translation });
        const back = pair.createDiv();
        back.createSpan({ text: "回译" });
        back.createDiv({ text: unit.backTranslation });
        const bottom = card.createDiv({ cls: "translation-record-bottom" });
        bottom.createSpan({ text: `${unit.translationRelations.length + unit.comparisonRelations.length} 组关联` });
        bottom.createSpan({ text: `${unit.translationNotes.length + unit.backTranslationNotes.length + (unit.comparisonNote.trim() ? 1 : 0)} 条批注` });
        card.addEventListener("click", () => {
          this.selectedExerciseId = exercise.id;
          exercise.activeUnitId = unit.id;
          this.completedProjection = "sourceText";
          this.completedDetailLayer = "translation";
          this.activeRelation = null;
          this.articleReturnPage = "records";
          this.page = "article";
          this.render();
        });
      }
    };
    search.addEventListener("input", render);
    render();
  }

  private handleKeydown(event: KeyboardEvent): void {
    const exercise = this.host.translationExercises.find((item) => item.id === this.selectedExerciseId);
    if (!exercise) return;
    if (this.page === "article" && exercise.stage === "complete") {
      if (event.key === "Escape" && this.activeRelation) {
        event.preventDefault();
        this.activeRelation = null;
        this.render();
        return;
      }
      if (event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        const units = getTranslationUnits(exercise);
        const index = units.findIndex((unit) => unit.id === exercise.activeUnitId);
        const target = units[index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1)];
        if (!target) return;
        event.preventDefault();
        exercise.activeUnitId = target.id;
        this.activeRelation = null;
        this.render();
      }
      return;
    }
    if (this.page !== "task") return;
    const mod = event.ctrlKey || event.metaKey;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const isTyping = Boolean(target?.matches("textarea, input") || target?.closest("[contenteditable='true']"));
    if (this.relationDraft && mod && event.key.toLocaleLowerCase() === "z" && !isTyping) {
      event.preventDefault();
      const unit = findTranslationUnit(exercise, exercise.activeUnitId);
      if (!unit) this.relationDraft = null;
      else this.undoRelationDraftSelection(unit);
      return;
    }
    if (
      exercise.stage !== "backTranslate"
      && mod
      && (event.key.toLocaleLowerCase() === "z" || event.key.toLocaleLowerCase() === "y")
      && (this.structuralUndoPending || !isTyping)
    ) {
      const redo = event.shiftKey || event.key.toLocaleLowerCase() === "y";
      if ((redo && this.relationRedo.length) || (!redo && this.relationUndo.length)) {
        event.preventDefault();
        if (redo) void this.redoRelationOperation(exercise);
        else void this.undoRelationOperation(exercise);
        return;
      }
    }
    if (exercise.stage === "prepare" && mod && (
      event.key.toLocaleLowerCase() === "z"
      || event.key.toLocaleLowerCase() === "y"
    )) {
      event.preventDefault();
      if (event.shiftKey || event.key.toLocaleLowerCase() === "y") void this.redoPreparation(exercise);
      else void this.undoPreparation(exercise);
      return;
    }
    if (exercise.stage === "prepare" && event.key === "Backspace" && this.selectedPrepareIds.size && !isTyping) {
      event.preventDefault();
      this.pushPrepareHistory(exercise);
      reopenTranslationUnits(exercise, [...this.selectedPrepareIds]);
      this.selectedPrepareIds.clear();
      void this.persist(exercise);
      return;
    }
    if (exercise.stage === "prepare" && mod && event.key === "Enter") {
      event.preventDefault();
      if (getTranslationStageProgress(exercise).ready) {
        setTranslationStage(exercise, "translate");
        this.prepareUndo = [];
        this.prepareRedo = [];
        void this.persist(exercise);
      }
      return;
    }
    if (event.key === "Escape" && this.relationDraft) {
      event.preventDefault();
      this.relationDraft = null;
      this.render();
      return;
    }
    if (event.key === "Escape" && this.activeRelation) {
      event.preventDefault();
      this.activeRelation = null;
      this.render();
      return;
    }
    if (event.key === "Escape" && exercise.stage === "prepare" && this.selectedPrepareIds.size) {
      event.preventDefault();
      this.selectedPrepareIds.clear();
      this.render();
      return;
    }
    if (isTyping) return;
    if (event.altKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const units = getTranslationUnits(exercise);
      const index = units.findIndex((unit) => unit.id === exercise.activeUnitId);
      event.preventDefault();
      this.moveToUnit(
        exercise,
        units,
        index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1),
      );
    }
  }
}
