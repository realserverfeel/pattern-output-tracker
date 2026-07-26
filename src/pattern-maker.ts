import { App, Modal, Notice, setIcon } from "obsidian";
import {
  buildPatternDisplayText,
  componentLabel,
  createComponent,
  defaultConstraints,
  LANGUAGE_LABELS,
  PatternComponent,
  PatternLanguage,
  PatternMatchMode,
  PatternScope,
  PatternStructure,
  PatternStructureKind,
  relabelComponents,
  SentenceRange,
  SourceRange,
  splitSentenceRanges,
  STRUCTURE_LABELS,
} from "./pattern-model";

export interface PatternMakerResult {
  language: PatternLanguage;
  structure: PatternStructure;
  displayText: string;
}

interface PatternMakerOptions {
  sourceText: string;
  language?: PatternLanguage;
  structure?: PatternStructure;
  onSave: (result: PatternMakerResult) => Promise<void>;
}

function trimRange(text: string, range: SourceRange): SourceRange | null {
  let from = Math.max(0, Math.min(range.from, text.length));
  let to = Math.max(from, Math.min(range.to, text.length));
  while (from < to && /\s/u.test(text[from] ?? "")) from += 1;
  while (to > from && /\s/u.test(text[to - 1] ?? "")) to -= 1;
  return from < to ? { from, to } : null;
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function selectionOffsets(root: HTMLElement): SourceRange | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const from = before.toString().length;
  const to = from + range.toString().length;
  selection.removeAllRanges();
  return { from, to };
}

function createIconButton(
  host: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = host.createEl("button", { cls: "pattern-maker-icon-button" });
  button.setAttr("type", "button");
  button.setAttr("aria-label", label);
  button.setAttr("title", label);
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  return button;
}

export class PatternMakerModal extends Modal {
  private readonly options: PatternMakerOptions;
  private readonly sourceText: string;
  private language: PatternLanguage | "";
  private kind: PatternStructureKind | "";
  private components: PatternComponent[];
  private constraints = defaultConstraints("contiguous");
  private activeComponentId: string | null = null;
  private pendingSentenceIndexes = new Set<number>();
  private saveButton?: HTMLButtonElement;

  constructor(app: App, options: PatternMakerOptions) {
    super(app);
    this.options = options;
    this.sourceText = options.sourceText;
    this.language = options.language ?? "";
    this.kind = options.structure?.kind ?? "";
    this.components = options.structure?.components.map((component) => ({
      ...component,
      ranges: component.ranges.map((range) => ({ ...range })),
    })) ?? [];
    if (options.structure) this.constraints = { ...options.structure.constraints };
    this.activeComponentId = this.components[0]?.id ?? null;
  }

  onOpen(): void {
    this.modalEl.addClass("pattern-maker-workbench");
    this.setTitle("Pattern Maker");
    this.render();
  }

  private render(): void {
    const content = this.contentEl;
    content.empty();

    const topbar = content.createDiv({ cls: "pattern-maker-topbar" });
    const kindSelect = topbar.createEl("select", { cls: "pattern-maker-select" });
    kindSelect.createEl("option", { text: "结构类型", value: "" });
    for (const kind of Object.keys(STRUCTURE_LABELS) as PatternStructureKind[]) {
      kindSelect.createEl("option", { text: STRUCTURE_LABELS[kind], value: kind });
    }
    kindSelect.value = this.kind;
    kindSelect.addEventListener("change", () => {
      const next = kindSelect.value as PatternStructureKind | "";
      if (next !== this.kind) {
        this.kind = next;
        this.components = [];
        this.activeComponentId = null;
        this.pendingSentenceIndexes.clear();
        if (next) this.constraints = defaultConstraints(next);
        this.render();
      }
    });

    const languageSelect = topbar.createEl("select", { cls: "pattern-maker-select pattern-maker-language" });
    languageSelect.createEl("option", { text: "语言", value: "" });
    for (const language of Object.keys(LANGUAGE_LABELS) as PatternLanguage[]) {
      languageSelect.createEl("option", { text: LANGUAGE_LABELS[language], value: language });
    }
    languageSelect.value = this.language;
    languageSelect.addEventListener("change", () => {
      this.language = languageSelect.value as PatternLanguage | "";
      this.updateSaveState();
    });

    const toolbar = topbar.createDiv({ cls: "pattern-maker-toolbar" });
    if (this.kind === "move-sequence") {
      const groupButton = createIconButton(toolbar, "combine", "把所选句子组成下一组", () => this.commitSentenceGroup());
      groupButton.disabled = this.pendingSentenceIndexes.size === 0;
    }
    createIconButton(toolbar, "undo-2", "撤销最后一个组成部分", () => {
      if (this.components.length > 0) {
        this.components = relabelComponents(this.components.slice(0, -1));
        this.activeComponentId = this.components.at(-1)?.id ?? null;
        this.render();
      }
    }).disabled = this.components.length === 0;
    createIconButton(toolbar, "eraser", "清空临时标注", () => {
      this.components = [];
      this.activeComponentId = null;
      this.pendingSentenceIndexes.clear();
      this.render();
    }).disabled = this.components.length === 0 && this.pendingSentenceIndexes.size === 0;

    const canvas = content.createDiv({ cls: `pattern-maker-canvas${this.kind ? " is-ready" : ""}` });
    if (this.kind === "cross-sentence" || this.kind === "move-sequence") {
      this.renderSentenceCanvas(canvas, splitSentenceRanges(this.sourceText));
    } else {
      this.renderTextCanvas(canvas);
    }

    if (this.kind) {
      const lower = content.createDiv({ cls: "pattern-maker-lower" });
      this.renderComponentStrip(lower);
      this.renderConstraintStrip(lower);
      const preview = lower.createDiv({ cls: "pattern-maker-preview" });
      preview.createSpan({ cls: "pattern-maker-preview-label", text: "⌁" });
      preview.createSpan({ text: buildPatternDisplayText(this.currentStructure()) || "—" });
    }

    const actions = content.createDiv({ cls: "pattern-modal-actions pattern-maker-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    this.saveButton = actions.createEl("button", { text: "保存", cls: "mod-cta" });
    this.saveButton.addEventListener("click", () => void this.submit());
    this.updateSaveState();
  }

  private renderTextCanvas(canvas: HTMLElement): void {
    const ranges = this.components.flatMap((component) =>
      component.ranges.map((range) => ({ ...range, component })),
    ).sort((left, right) => left.from - right.from);
    let cursor = 0;
    for (const item of ranges) {
      if (item.from > cursor) canvas.appendText(this.sourceText.slice(cursor, item.from));
      const mark = canvas.createEl("mark", { cls: `pattern-maker-mark${item.component.id === this.activeComponentId ? " is-active" : ""}` });
      mark.setAttr("data-label", item.component.label);
      mark.appendText(this.sourceText.slice(item.from, item.to));
      mark.addEventListener("click", (event) => {
        event.stopPropagation();
        this.activeComponentId = item.component.id;
        this.render();
      });
      cursor = item.to;
    }
    if (cursor < this.sourceText.length) canvas.appendText(this.sourceText.slice(cursor));

    if (!this.kind) return;
    canvas.addEventListener("mouseup", () => {
      window.setTimeout(() => {
        const raw = selectionOffsets(canvas);
        const selected = raw ? trimRange(this.sourceText, raw) : null;
        if (!selected) return;
        if (this.kind === "contiguous") {
          this.components = [createComponent(this.sourceText, [selected], 0, "text")];
        } else if (this.kind === "discontinuous") {
          if (this.components.some((component) => component.ranges.some((range) => rangesOverlap(range, selected)))) {
            new Notice("选取范围发生重叠。");
            return;
          }
          this.components = relabelComponents([
            ...this.components,
            createComponent(this.sourceText, [selected], this.components.length, "text"),
          ]);
        }
        this.activeComponentId = this.components.find((component) => component.ranges.some((range) => range.from === selected.from && range.to === selected.to))?.id ?? null;
        this.render();
      }, 0);
    });
  }

  private renderSentenceCanvas(canvas: HTMLElement, sentences: SentenceRange[]): void {
    canvas.addClass("pattern-maker-sentence-canvas");
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index];
      if (!sentence) continue;
      const component = this.components.find((item) => item.ranges.some((range) => range.from === sentence.from && range.to === sentence.to));
      const row = canvas.createEl("button", {
        cls: `pattern-maker-sentence${component ? " is-marked" : ""}${this.pendingSentenceIndexes.has(index) ? " is-pending" : ""}`,
      });
      row.setAttr("type", "button");
      if (component) row.setAttr("data-label", component.label);
      row.createSpan({ cls: "pattern-maker-sentence-number", text: String(index + 1).padStart(2, "0") });
      row.createSpan({ cls: "pattern-maker-sentence-text", text: sentence.text });
      row.addEventListener("click", () => {
        if (this.kind === "cross-sentence") this.toggleSentenceComponent(sentence);
        if (this.kind === "move-sequence") this.togglePendingSentence(index);
      });
    }
  }

  private toggleSentenceComponent(sentence: SentenceRange): void {
    const existing = this.components.find((component) => component.ranges.some((range) => range.from === sentence.from && range.to === sentence.to));
    if (existing) {
      this.components = relabelComponents(this.components.filter((component) => component.id !== existing.id));
      this.activeComponentId = this.components.at(-1)?.id ?? null;
    } else {
      const component = createComponent(this.sourceText, [sentence], this.components.length, "sentence");
      this.components = relabelComponents([...this.components, component]);
      this.activeComponentId = component.id;
    }
    this.render();
  }

  private togglePendingSentence(index: number): void {
    if (this.pendingSentenceIndexes.has(index)) this.pendingSentenceIndexes.delete(index);
    else this.pendingSentenceIndexes.add(index);
    this.render();
  }

  private commitSentenceGroup(): void {
    const sentences = splitSentenceRanges(this.sourceText);
    const ranges = [...this.pendingSentenceIndexes]
      .sort((left, right) => left - right)
      .flatMap((index): SourceRange[] => {
        const sentence = sentences[index];
        return sentence ? [{ from: sentence.from, to: sentence.to }] : [];
      });
    if (ranges.length === 0) return;
    if (this.components.some((component) => component.ranges.some((existing) => ranges.some((range) => rangesOverlap(existing, range))))) {
      new Notice("同一句不能同时属于两个句组。");
      return;
    }
    const component = createComponent(this.sourceText, ranges, this.components.length, "sentence-group");
    this.components = relabelComponents([...this.components, component]);
    this.activeComponentId = component.id;
    this.pendingSentenceIndexes.clear();
    this.render();
  }

  private renderComponentStrip(host: HTMLElement): void {
    const strip = host.createDiv({ cls: "pattern-maker-components" });
    for (const component of this.components) {
      const chip = strip.createEl("button", {
        cls: `pattern-maker-component-chip${component.id === this.activeComponentId ? " is-active" : ""}`,
      });
      chip.setAttr("type", "button");
      chip.setAttr("title", component.text);
      chip.createSpan({ cls: "pattern-maker-component-label", text: component.label });
      chip.createSpan({ cls: "pattern-maker-component-text", text: component.text });
      chip.addEventListener("click", () => {
        this.activeComponentId = component.id;
        this.render();
      });
    }
    if (this.components.length > 0) {
      const matchSelect = strip.createEl("select", { cls: "pattern-maker-mini-select" });
      matchSelect.createEl("option", { text: "原文", value: "exact" });
      matchSelect.createEl("option", { text: "语法等价", value: "equivalent" });
      matchSelect.value = this.activeComponent()?.matchMode ?? "exact";
      matchSelect.setAttr("title", "当前组成部分的匹配方式");
      matchSelect.addEventListener("change", () => {
        const active = this.activeComponent();
        if (active) active.matchMode = matchSelect.value as PatternMatchMode;
      });
    }
  }

  private renderConstraintStrip(host: HTMLElement): void {
    if (!this.kind || this.kind === "contiguous") return;
    const strip = host.createDiv({ cls: "pattern-maker-constraints" });
    const scopeSelect = strip.createEl("select", { cls: "pattern-maker-mini-select" });
    const scopes: Array<{ value: PatternScope; text: string }> = this.kind === "discontinuous"
      ? [{ value: "same-sentence", text: "同句" }, { value: "same-paragraph", text: "同段" }]
      : this.kind === "cross-sentence"
        ? [{ value: "same-paragraph", text: "同段" }, { value: "cross-sentence", text: "跨段" }]
        : [{ value: "sentence-group", text: "句组" }, { value: "same-paragraph", text: "同段" }];
    for (const scope of scopes) scopeSelect.createEl("option", { value: scope.value, text: scope.text });
    scopeSelect.value = this.constraints.scope;
    scopeSelect.setAttr("title", "匹配范围");
    scopeSelect.addEventListener("change", () => { this.constraints.scope = scopeSelect.value as PatternScope; });

    const distance = strip.createEl("input", { type: "number", cls: "pattern-maker-distance" });
    distance.min = "0";
    distance.value = String(this.constraints.maxDistance ?? 0);
    distance.setAttr("title", "最大间隔");
    distance.addEventListener("change", () => {
      const parsed = Number(distance.value);
      this.constraints.maxDistance = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    });
    const unit = strip.createEl("select", { cls: "pattern-maker-mini-select" });
    if (this.kind === "discontinuous") {
      unit.createEl("option", { value: "characters", text: "字" });
      unit.createEl("option", { value: "tokens", text: "词" });
    } else {
      unit.createEl("option", { value: "sentences", text: "句" });
    }
    unit.value = this.constraints.distanceUnit;
    unit.setAttr("title", "距离单位");
    unit.addEventListener("change", () => { this.constraints.distanceUnit = unit.value as "characters" | "tokens" | "sentences"; });

    const adjacent = strip.createEl("button", {
      cls: `pattern-maker-toggle${this.constraints.adjacent ? " is-active" : ""}`,
      text: "相邻",
    });
    adjacent.setAttr("type", "button");
    adjacent.setAttr("aria-pressed", String(this.constraints.adjacent));
    adjacent.addEventListener("click", () => {
      this.constraints.adjacent = !this.constraints.adjacent;
      this.render();
    });
  }

  private activeComponent(): PatternComponent | undefined {
    return this.components.find((component) => component.id === this.activeComponentId) ?? this.components[0];
  }

  private currentStructure(): PatternStructure {
    if (!this.kind) throw new Error("尚未选择结构类型。");
    return {
      kind: this.kind,
      sourceText: this.sourceText,
      components: this.components.map((component) => ({ ...component, ranges: component.ranges.map((range) => ({ ...range })) })),
      constraints: { ...this.constraints },
    };
  }

  private canSave(): boolean {
    if (!this.language || !this.kind) return false;
    if (this.kind === "contiguous") return this.components.length === 1;
    return this.components.length >= 2;
  }

  private updateSaveState(): void {
    if (this.saveButton) this.saveButton.disabled = !this.canSave();
  }

  private async submit(): Promise<void> {
    if (!this.canSave() || !this.language || !this.kind) return;
    const structure = this.currentStructure();
    try {
      await this.options.onSave({
        language: this.language,
        structure,
        displayText: buildPatternDisplayText(structure),
      });
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }
}
