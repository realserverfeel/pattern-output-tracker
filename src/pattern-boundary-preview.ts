import { App, Menu, Modal, Notice, setIcon } from "obsidian";
import {
  buildPatternDefinition,
  describeCoordinateRelation,
  PatternContentDraft,
  relationKey,
} from "./pattern-definition";
import {
  MAKER_MODE_LABELS,
  PatternCoordinateRelation,
  PatternDefinitionV2,
  PatternMakerMode,
} from "./pattern-model";
import {
  ClauseBoundaryCandidate,
  findClauseBoundaryCandidates,
  SegmentationLanguage,
  splitLanguageSentences,
  splitSourceLines,
  TextRange,
} from "./text-segmentation";

interface BoundaryPreviewOptions {
  sourceText: string;
  language?: SegmentationLanguage;
}

type ContentDraft = PatternContentDraft;

type BoundaryRole = "boundary" | "required";

interface PreviewSnapshot {
  contents: ContentDraft[];
  boundaries: Array<[string, BoundaryRole]>;
  relations: Array<[string, PatternCoordinateRelation]>;
  unorderedGroups: string[][];
  activeId: string | null;
  activeRelationKey: string | null;
  lockedScopeIndex: number | null;
  lineWindow: { maxCharacters: number; ordered: boolean };
}

const LANGUAGE_LABELS: Record<SegmentationLanguage, string> = { en: "英语", ja: "日语" };

function boundaryKey(boundary: ClauseBoundaryCandidate): string {
  return `${boundary.from}:${boundary.to}`;
}

function componentLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function rangesOverlap(left: { from: number; to: number }, right: { from: number; to: number }): boolean {
  return left.from < right.to && right.from < left.to;
}

function trimSourceRange(text: string, from: number, to: number): TextRange | null {
  while (from < to && /\s/u.test(text[from] ?? "")) from += 1;
  while (to > from && /\s/u.test(text[to - 1] ?? "")) to -= 1;
  return from < to ? { from, to, text: text.slice(from, to) } : null;
}

export class PatternBoundaryPreviewModal extends Modal {
  private readonly sourceText: string;
  private language: SegmentationLanguage | "";
  private mode: PatternMakerMode | "" = "";
  private contents: ContentDraft[] = [];
  private boundaryRoles = new Map<string, BoundaryRole>();
  private relationOverrides = new Map<string, PatternCoordinateRelation>();
  private unorderedGroups: string[][] = [];
  private groupSelection: string[] = [];
  private activeId: string | null = null;
  private activeRelationKey: string | null = null;
  private lockedScopeIndex: number | null = null;
  private lineWindow = { maxCharacters: 30, ordered: true };
  private history: PreviewSnapshot[] = [];
  private future: PreviewSnapshot[] = [];
  private sequence = 0;

  constructor(app: App, options: BoundaryPreviewOptions) {
    super(app);
    this.sourceText = options.sourceText;
    this.language = options.language ?? "";
  }

  onOpen(): void {
    this.modalEl.addClass("pattern-boundary-preview");
    this.setTitle("Pattern Maker");
    this.modalEl.addEventListener("keydown", this.handleKeyDown);
    this.render();
  }

  onClose(): void {
    this.modalEl.removeEventListener("keydown", this.handleKeyDown);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target;
    const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    const modifier = event.ctrlKey || event.metaKey;
    if (!editable && modifier && event.key.toLocaleLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (!editable && event.ctrlKey && event.key.toLocaleLowerCase() === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (!editable && event.key === "Escape" && (this.groupSelection.length > 0 || this.activeRelationKey)) {
      event.preventDefault();
      event.stopPropagation();
      this.groupSelection = [];
      this.activeRelationKey = null;
      this.render();
      return;
    }
    if (!editable && event.key === "Delete" && this.activeId) {
      event.preventDefault();
      this.removeContent(this.activeId);
    }
  };

  private render(): void {
    this.contentEl.empty();
    const topbar = this.contentEl.createDiv({ cls: "pattern-preview-topbar" });
    this.createPicker(
      topbar,
      this.language ? LANGUAGE_LABELS[this.language] : "选择语言",
      (["en", "ja"] as SegmentationLanguage[]).map((value) => ({ value, label: LANGUAGE_LABELS[value] })),
      (value) => {
        if (value !== this.language) this.resetAnnotations();
        this.language = value as SegmentationLanguage;
        this.render();
      },
    );
    this.createPicker(
      topbar,
      this.mode ? MAKER_MODE_LABELS[this.mode] : "选择模式",
      (Object.keys(MAKER_MODE_LABELS) as PatternMakerMode[]).map((value) => ({ value, label: MAKER_MODE_LABELS[value] })),
      (value) => {
        if (value !== this.mode) this.resetAnnotations();
        this.mode = value as PatternMakerMode;
        this.render();
      },
    );
    topbar.createSpan({ cls: "pattern-preview-badge", text: "α3.3.2" });
    const toolbar = topbar.createDiv({ cls: "pattern-preview-toolbar" });
    this.createIconButton(toolbar, "undo-2", "撤销", () => this.undo(), this.history.length === 0);
    this.createIconButton(toolbar, "redo-2", "重做", () => this.redo(), this.future.length === 0);
    this.createIconButton(toolbar, "eraser", "清空临时标注", () => this.clearAnnotations(), this.contents.length === 0 && this.boundaryRoles.size === 0);

    const canvas = this.contentEl.createDiv({ cls: "pattern-preview-canvas" });
    if (!this.language || !this.mode) {
      canvas.createDiv({ cls: "pattern-preview-raw", text: this.sourceText });
    } else if (this.mode === "clause-coordinate") {
      this.renderClauseCanvas(canvas);
    } else if (this.mode === "line-window") {
      this.renderRows(canvas, splitSourceLines(this.sourceText), "L");
    } else {
      this.renderRows(canvas, splitLanguageSentences(this.sourceText, this.language), "S");
    }
    canvas.addEventListener("mouseup", () => window.setTimeout(() => this.captureContentSelection(canvas), 0));

    this.renderComponentStrip();
    this.renderRelationEditor();
    this.renderLineWindowControls();
    const footer = this.contentEl.createDiv({ cls: "pattern-preview-footer" });
    if (this.language && this.mode) {
      const count = this.mode === "line-window"
        ? splitSourceLines(this.sourceText).length
        : splitLanguageSentences(this.sourceText, this.language).length;
      const scopeLabel = this.lockedScopeIndex === null
        ? (this.mode === "line-window" ? `${count} 行` : `${count} 句`)
        : (this.mode === "line-window" ? `L${this.lockedScopeIndex}` : `S${this.lockedScopeIndex}`);
      footer.createSpan({ text: scopeLabel });
      footer.createSpan({ text: `${this.contents.length} 个内容元素` });
      if (this.mode === "clause-coordinate") footer.createSpan({ text: `${this.boundaryRoles.size} 个分句边界` });
    }
    footer.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
  }

  private createPicker(
    host: HTMLElement,
    label: string,
    options: Array<{ value: string; label: string }>,
    onChoose: (value: string) => void,
  ): void {
    const button = host.createEl("button", { cls: "pattern-preview-picker" });
    button.setAttr("type", "button");
    button.createSpan({ text: label });
    const icon = button.createSpan({ cls: "pattern-preview-picker-icon" });
    setIcon(icon, "chevron-down");
    button.addEventListener("click", (event) => {
      const menu = new Menu();
      for (const option of options) {
        menu.addItem((item) => item
          .setTitle(option.label)
          .setChecked(option.label === label)
          .onClick(() => onChoose(option.value)));
      }
      menu.showAtMouseEvent(event);
    });
  }

  private createIconButton(host: HTMLElement, iconName: string, label: string, onClick: () => void, disabled: boolean): void {
    const button = host.createEl("button", { cls: "pattern-preview-icon-button" });
    button.setAttr("type", "button");
    button.setAttr("aria-label", label);
    button.setAttr("title", label);
    button.disabled = disabled;
    setIcon(button, iconName);
    button.addEventListener("click", onClick);
  }

  private renderRows(host: HTMLElement, rows: TextRange[], prefix: "S" | "L"): void {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const outsideScope = this.mode !== "cross-sentence" && this.lockedScopeIndex !== null && index !== this.lockedScopeIndex;
      const line = host.createDiv({ cls: `pattern-preview-row${outsideScope ? " is-outside-scope" : ""}` });
      line.createSpan({ cls: "pattern-preview-coordinate", text: `${prefix}${index}` });
      const textHost = line.createSpan({ cls: "pattern-preview-row-text" });
      this.renderSourceSlice(textHost, row.from, row.to);
    }
  }

  private renderClauseCanvas(host: HTMLElement): void {
    if (!this.language) return;
    const sentences = splitLanguageSentences(this.sourceText, this.language);
    const candidates = findClauseBoundaryCandidates(this.sourceText, this.language);
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex];
      if (!sentence) continue;
      const outsideScope = this.lockedScopeIndex !== null && sentenceIndex !== this.lockedScopeIndex;
      const sentenceHost = host.createDiv({ cls: `pattern-preview-clause-sentence${outsideScope ? " is-outside-scope" : ""}` });
      sentenceHost.createSpan({ cls: "pattern-preview-coordinate", text: `S${sentenceIndex}` });
      const body = sentenceHost.createDiv({ cls: "pattern-preview-clause-body" });
      const localCandidates = candidates.filter((candidate) => candidate.sentenceIndex === sentenceIndex);
      let cursor = sentence.from;
      let clauseIndex = 0;
      body.createSpan({ cls: "pattern-preview-clause-label", text: `C${clauseIndex}` });
      for (const candidate of localCandidates) {
        if (candidate.from > cursor) this.renderSourceSlice(body, cursor, candidate.from);
        const key = boundaryKey(candidate);
        const role = this.boundaryRoles.get(key);
        const token = body.createEl("button", {
          cls: `pattern-preview-boundary is-${candidate.confidence}${role ? " is-selected" : ""}${role === "required" ? " is-required" : ""}`,
          text: candidate.text,
        });
        token.setAttr("type", "button");
        token.setAttr("title", role === "required" ? "严格 Pattern 元素" : role === "boundary" ? "仅作分句边界" : "选为分句边界");
        token.addEventListener("click", (event) => this.handleBoundaryClick(event, candidate));
        if (role) this.bindMiddleClick(token, () => this.removeBoundary(candidate));
        cursor = candidate.to;
        if (role) {
          clauseIndex += 1;
          body.createSpan({ cls: "pattern-preview-clause-label", text: `C${clauseIndex}` });
        }
      }
      if (cursor < sentence.to) this.renderSourceSlice(body, cursor, sentence.to);
    }
  }

  private renderSourceSlice(host: HTMLElement, from: number, to: number): void {
    const components = this.contents
      .filter((component) => component.from >= from && component.to <= to)
      .sort((left, right) => left.from - right.from);
    let cursor = from;
    for (const component of components) {
      if (component.from > cursor) this.appendSourceText(host, cursor, component.from);
      const mark = host.createEl("mark", {
        cls: `pattern-preview-content-mark${component.id === this.activeId ? " is-active" : ""}`,
        text: this.sourceText.slice(component.from, component.to),
      });
      mark.setAttr("data-source-from", String(component.from));
      mark.setAttr("data-source-to", String(component.to));
      mark.setAttr("data-label", component.label);
      mark.addEventListener("click", () => {
        this.activeId = component.id;
        this.render();
      });
      this.bindMiddleClick(mark, () => this.removeContent(component.id));
      cursor = component.to;
    }
    if (cursor < to) this.appendSourceText(host, cursor, to);
  }

  private appendSourceText(host: HTMLElement, from: number, to: number): void {
    const span = host.createSpan({ cls: "pattern-preview-source-text", text: this.sourceText.slice(from, to) });
    span.setAttr("data-source-from", String(from));
    span.setAttr("data-source-to", String(to));
  }

  private captureContentSelection(canvas: HTMLElement): void {
    if (!this.language || !this.mode) return;
    const selection = canvas.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!canvas.contains(range.startContainer) || !canvas.contains(range.endContainer)) return;
    const from = this.sourceOffsetAt(range.startContainer, range.startOffset, "start");
    const to = this.sourceOffsetAt(range.endContainer, range.endOffset, "end");
    if (from === null || to === null) {
      new Notice("没有识别到有效的原文字段，请重新拖选。", 3000);
      return;
    }
    selection.removeAllRanges();
    const selected = trimSourceRange(this.sourceText, Math.min(from, to), Math.max(from, to));
    if (!selected) return;
    if (this.mode === "clause-coordinate" && findClauseBoundaryCandidates(this.sourceText, this.language)
      .some((candidate) => rangesOverlap(candidate, selected))) {
      new Notice("分句标点请作为边界单独选择。", 3500);
      return;
    }
    if (!this.fitsSingleCoordinate(selected)) {
      new Notice("一个内容元素不能跨越当前坐标边界。", 3500);
      return;
    }
    const scopeIndex = this.scopeIndexForRange(selected);
    if (this.mode !== "cross-sentence") {
      if (scopeIndex === null) return;
      if (this.lockedScopeIndex !== null && scopeIndex !== this.lockedScopeIndex) {
        new Notice(this.mode === "line-window" ? `同行窗口已限定在 L${this.lockedScopeIndex}。` : `这个 Pattern 已限定在 S${this.lockedScopeIndex}。`, 3500);
        return;
      }
    }
    if (this.contents.some((component) => rangesOverlap(component, selected))) {
      new Notice("内容元素不能互相重叠。", 3500);
      return;
    }
    this.pushHistory();
    if (this.mode !== "cross-sentence" && this.lockedScopeIndex === null) this.lockedScopeIndex = scopeIndex;
    const component: ContentDraft = {
      id: `draft-${Date.now()}-${this.sequence++}`,
      label: componentLabel(this.contents.length),
      from: selected.from,
      to: selected.to,
      text: selected.text,
    };
    this.contents.push(component);
    this.contents.sort((left, right) => left.from - right.from || left.to - right.to);
    this.relabelContents();
    if (this.mode === "line-window") {
      this.lineWindow.maxCharacters = Math.max(this.lineWindow.maxCharacters, this.currentLineWindowSpan());
    }
    this.activeId = component.id;
    this.activeRelationKey = null;
    this.render();
  }

  private sourceOffsetAt(node: Node, offset: number, edge: "start" | "end"): number | null {
    const parent = node instanceof Element ? node : node.parentElement;
    const directSource = parent?.closest<HTMLElement>("[data-source-from]");
    if (directSource && (directSource === node || directSource.contains(node))) {
      const from = Number(directSource.getAttribute("data-source-from"));
      const to = Number(directSource.getAttribute("data-source-to"));
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
      try {
        const prefix = directSource.ownerDocument.createRange();
        prefix.selectNodeContents(directSource);
        prefix.setEnd(node, offset);
        return Math.max(from, Math.min(to, from + prefix.toString().length));
      } catch {
        return edge === "start" ? from : to;
      }
    }

    const children = Array.from(node.childNodes);
    const preferred = edge === "start"
      ? children[offset] ?? children[offset - 1]
      : children[offset - 1] ?? children[offset];
    const fallback = edge === "start"
      ? children.find((child) => this.findSourceElement(child, "first"))
      : [...children].reverse().find((child) => this.findSourceElement(child, "last"));
    const source = this.findSourceElement(preferred ?? fallback ?? node, edge === "start" ? "first" : "last");
    if (!source) return null;
    const from = Number(source.getAttribute("data-source-from"));
    const to = Number(source.getAttribute("data-source-to"));
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return edge === "start" ? from : to;
  }

  private findSourceElement(node: Node, direction: "first" | "last"): HTMLElement | null {
    if (node instanceof HTMLElement && node.matches("[data-source-from]")) return node;
    if (!(node instanceof Element)) return null;
    const matches = node.querySelectorAll<HTMLElement>("[data-source-from]");
    return direction === "first" ? matches.item(0) : matches.item(matches.length - 1);
  }

  private fitsSingleCoordinate(range: TextRange): boolean {
    const units = this.coordinateRanges();
    return units.some((unit) => range.from >= unit.from && range.to <= unit.to);
  }

  private scopeIndexForRange(range: TextRange): number | null {
    if (!this.language || !this.mode || this.mode === "cross-sentence") return null;
    const scopes = this.mode === "line-window"
      ? splitSourceLines(this.sourceText)
      : splitLanguageSentences(this.sourceText, this.language);
    const index = scopes.findIndex((scope) => range.from >= scope.from && range.to <= scope.to);
    return index >= 0 ? index : null;
  }

  private coordinateRanges(): TextRange[] {
    if (!this.language || !this.mode) return [];
    if (this.mode === "line-window") return splitSourceLines(this.sourceText);
    const sentences = splitLanguageSentences(this.sourceText, this.language);
    if (this.mode !== "clause-coordinate") return sentences;
    const candidates = findClauseBoundaryCandidates(this.sourceText, this.language);
    const clauses: TextRange[] = [];
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      const sentence = sentences[sentenceIndex];
      if (!sentence) continue;
      const boundaries = candidates
        .filter((candidate) => candidate.sentenceIndex === sentenceIndex && this.boundaryRoles.has(boundaryKey(candidate)))
        .sort((left, right) => left.from - right.from);
      let start = sentence.from;
      for (const boundary of boundaries) {
        const clause = trimSourceRange(this.sourceText, start, boundary.from);
        if (clause) clauses.push(clause);
        start = boundary.to;
      }
      const clause = trimSourceRange(this.sourceText, start, sentence.to);
      if (clause) clauses.push(clause);
    }
    return clauses;
  }

  private handleBoundaryClick(event: MouseEvent, candidate: ClauseBoundaryCandidate): void {
    const key = boundaryKey(candidate);
    const role = this.boundaryRoles.get(key);
    if (!role) {
      if (this.lockedScopeIndex !== null && candidate.sentenceIndex !== this.lockedScopeIndex) {
        new Notice(`句内分句 Pattern 已限定在 S${this.lockedScopeIndex}。`, 3500);
        return;
      }
      if (this.contents.some((component) => rangesOverlap(component, candidate))) {
        new Notice("这个标点已经包含在内容元素中，请先删除该元素。", 3500);
        return;
      }
      this.pushHistory();
      if (this.lockedScopeIndex === null) this.lockedScopeIndex = candidate.sentenceIndex;
      this.boundaryRoles.set(key, "boundary");
      this.relationOverrides.clear();
      this.activeRelationKey = null;
      this.pruneUnorderedGroups();
      this.render();
      return;
    }
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("符号不限").setChecked(role === "boundary").onClick(() => {
      if (role === "boundary") return;
      this.pushHistory();
      this.boundaryRoles.set(key, "boundary");
      this.render();
    }));
    menu.addItem((item) => item.setTitle(`严格符号：${candidate.text}`).setChecked(role === "required").onClick(() => {
      if (role === "required") return;
      this.pushHistory();
      this.boundaryRoles.set(key, "required");
      this.render();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("取消边界").setIcon("x").onClick(() => {
      if (this.contents.some((component) => component.from < candidate.from && component.to > candidate.to)) {
        new Notice("请先删除跨越该边界的内容元素。", 3500);
        return;
      }
      this.pushHistory();
      this.boundaryRoles.delete(key);
      this.relationOverrides.clear();
      this.activeRelationKey = null;
      this.pruneUnorderedGroups();
      this.refreshScopeLock();
      this.render();
    }));
    menu.showAtMouseEvent(event);
  }

  private renderComponentStrip(): void {
    if (!this.language || !this.mode || (this.contents.length === 0 && this.boundaryRoles.size === 0)) return;
    const definition = this.currentDefinition();
    const operation = this.contentEl.createDiv({ cls: "pattern-preview-operation" });
    if (this.mode === "clause-coordinate" && definition.mode === "within-sentence") {
      operation.createDiv({ cls: "pattern-preview-normalization-note", text: "未选分句边界，按普通句内处理" });
    }
    const strip = operation.createDiv({ cls: "pattern-preview-components pattern-preview-slot-chain" });
    this.renderSlotChain(strip, definition);
    if (this.groupSelection.length === 1) {
      strip.createSpan({ cls: "pattern-preview-group-hint", text: "Ctrl/Cmd 继续选择" });
    }
  }

  private renderSlotChain(host: HTMLElement, definition: PatternDefinitionV2): void {
    for (let index = 0; index < definition.slots.length; index += 1) {
      const slot = definition.slots[index];
      if (!slot) continue;
      if (index > 0) {
        const previous = definition.slots[index - 1];
        if (previous) this.renderSlotConnector(host, definition, previous.id, slot.id);
      }
      const slotHost = host.createDiv({ cls: `pattern-preview-slot${this.slotContainsGroupSelection(slot) ? " is-grouping" : ""}` });
      slotHost.createSpan({ cls: "pattern-preview-slot-label", text: this.slotLabel(slot.unit, slot.sourceIndex) });
      const contentsHost = slotHost.createDiv({ cls: "pattern-preview-slot-contents" });
      if (slot.allowsAnyNonEmptyContent) {
        contentsHost.createSpan({ cls: "pattern-preview-any-content", text: "任意非空" });
      }
      for (let groupIndex = 0; groupIndex < slot.contentGroups.length; groupIndex += 1) {
        const group = slot.contentGroups[groupIndex];
        if (!group) continue;
        if (groupIndex > 0) contentsHost.createSpan({ cls: "pattern-preview-intra-order", text: "…" });
        const groupHost = contentsHost.createSpan({ cls: group.ordered ? "pattern-preview-ordered-group" : "pattern-preview-unordered-group" });
        if (!group.ordered) groupHost.createSpan({ cls: "pattern-preview-group-brace", text: "{" });
        for (let componentIndex = 0; componentIndex < group.componentIds.length; componentIndex += 1) {
          const component = definition.contentComponents.find((item) => item.id === group.componentIds[componentIndex]);
          if (!component) continue;
          if (componentIndex > 0) groupHost.createSpan({ cls: "pattern-preview-group-separator", text: group.ordered ? "…" : "·" });
          this.renderContentChip(groupHost, component.id);
        }
        if (!group.ordered) groupHost.createSpan({ cls: "pattern-preview-group-brace", text: "}" });
      }
    }
  }

  private renderContentChip(host: HTMLElement, id: string): void {
    const component = this.contents.find((item) => item.id === id);
    if (!component) return;
    const selectedForGroup = this.groupSelection.includes(component.id);
    const chip = host.createEl("button", {
      cls: `pattern-preview-component${component.id === this.activeId ? " is-active" : ""}${selectedForGroup ? " is-group-selected" : ""}`,
    });
    chip.setAttr("type", "button");
    chip.setAttr("title", "Ctrl/Cmd 组成无序组；中键或 Delete 删除");
    chip.createSpan({ cls: "pattern-preview-component-label", text: component.label });
    chip.createSpan({ cls: "pattern-preview-component-text", text: component.text });
    chip.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey) this.toggleGroupSelection(component.id);
      else {
        this.groupSelection = [];
        this.activeId = component.id;
        this.activeRelationKey = null;
        this.render();
      }
    });
    chip.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      const group = this.unorderedGroups.find((item) => item.includes(component.id));
      if (group) menu.addItem((entry) => entry.setTitle("恢复顺序").setIcon("list-ordered").onClick(() => this.dissolveUnorderedGroup(group)));
      menu.addItem((entry) => entry.setTitle("删除元素").setIcon("trash-2").onClick(() => this.removeContent(component.id)));
      menu.showAtMouseEvent(event);
    });
    this.bindMiddleClick(chip, () => this.removeContent(component.id));
  }

  private renderSlotConnector(
    host: HTMLElement,
    definition: PatternDefinitionV2,
    fromSlotId: string,
    toSlotId: string,
  ): void {
    const connector = host.createDiv({ cls: "pattern-preview-slot-connector" });
    const boundary = definition.boundaryComponents.find((item) => item.beforeSlotId === fromSlotId && item.afterSlotId === toSlotId);
    const key = relationKey(fromSlotId, toSlotId);
    const relation = definition.relations.find((item) => relationKey(item.fromId, item.toId) === key);
    if (!relation) return;
    this.renderConstraintAnnotation(connector, key, relation, boundary);
  }

  private boundaryCandidateForRange(from: number | undefined, to: number | undefined): ClauseBoundaryCandidate | undefined {
    if (!this.language || from === undefined || to === undefined) return undefined;
    return findClauseBoundaryCandidates(this.sourceText, this.language).find((item) => item.from === from && item.to === to);
  }

  private renderConstraintAnnotation(
    host: HTMLElement,
    key: string,
    relation: PatternCoordinateRelation,
    boundary: PatternDefinitionV2["boundaryComponents"][number] | undefined,
  ): void {
    const annotation = host.createSpan({
      cls: `pattern-preview-constraint is-interactive${this.activeRelationKey === key ? " is-active" : ""}`,
    });
    annotation.createSpan({ cls: "pattern-preview-constraint-relation", text: describeCoordinateRelation(relation) });
    if (boundary?.required) {
      annotation.createSpan({ cls: "pattern-preview-constraint-boundary", text: `（${boundary.text}）` });
    }
    annotation.setAttr("role", "button");
    annotation.setAttr("tabindex", "0");
    annotation.setAttr("title", boundary ? "点击调整位置关系；右键设置严格符号" : "调整位置关系");
    annotation.addEventListener("click", () => {
      this.activeRelationKey = this.activeRelationKey === key ? null : key;
      this.activeId = null;
      this.render();
    });
    annotation.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      annotation.click();
    });
    if (boundary) {
      const candidate = this.boundaryCandidateForRange(boundary.ranges[0]?.from, boundary.ranges[0]?.to);
      if (candidate) {
        annotation.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          this.handleBoundaryClick(event, candidate);
        });
        this.bindMiddleClick(annotation, () => this.removeBoundary(candidate));
      }
    }
  }

  private renderRelationEditor(): void {
    if (!this.activeRelationKey) return;
    const definition = this.currentDefinition();
    const relation = definition.relations.find((item) => relationKey(item.fromId, item.toId) === this.activeRelationKey);
    const defaults = this.currentDefinition(false);
    const actual = defaults.relations.find((item) => relationKey(item.fromId, item.toId) === this.activeRelationKey);
    if (!relation || !actual) {
      this.activeRelationKey = null;
      return;
    }
    const editor = this.contentEl.createDiv({ cls: "pattern-preview-relation-editor" });
    const heading = editor.createDiv({ cls: "pattern-preview-relation-heading" });
    const fromSlot = definition.slots.find((item) => item.id === relation.fromId);
    const toSlot = definition.slots.find((item) => item.id === relation.toId);
    if (!fromSlot || !toSlot) return;
    const boundary = definition.boundaryComponents.find((item) => item.beforeSlotId === relation.fromId && item.afterSlotId === relation.toId);
    const currentText = `${describeCoordinateRelation(relation)}${boundary?.required ? `（${boundary.text}）` : ""}`;
    heading.createSpan({ text: `${this.slotLabel(fromSlot.unit, fromSlot.sourceIndex)} 与 ${this.slotLabel(toSlot.unit, toSlot.sourceIndex)}` });
    heading.createSpan({ cls: "pattern-preview-relation-current", text: currentText });
    const presets = editor.createDiv({ cls: "pattern-preview-relation-presets" });
    const apply = (next: PatternCoordinateRelation): void => {
      this.pushHistory();
      this.relationOverrides.set(this.activeRelationKey ?? relationKey(next.fromId, next.toId), next);
      this.render();
    };
    this.createRelationPreset(presets, "相邻", relation.maxIntervening === 0, actual.minIntervening > 0, () => {
      apply({ ...relation, minIntervening: 0, maxIntervening: 0 });
    });
    this.createRelationPreset(presets, "范围", relation.maxIntervening !== null && relation.maxIntervening > 0, false, () => {
      apply({
        ...relation,
        minIntervening: 0,
        maxIntervening: Math.max(1, actual.maxIntervening ?? 1),
      });
    });
    this.createRelationPreset(presets, "任意后方", relation.maxIntervening === null, false, () => {
      apply({ ...relation, minIntervening: 0, maxIntervening: null });
    });

    if (relation.maxIntervening !== null && relation.maxIntervening > 0) {
      const detail = editor.createDiv({ cls: "pattern-preview-relation-detail" });
      detail.createSpan({ text: "中间可隔" });
      const minimum = detail.createEl("input", { type: "number" });
      minimum.min = "0";
      minimum.max = String(actual.minIntervening);
      minimum.value = String(relation.minIntervening);
      detail.createSpan({ text: "至" });
      const maximum = detail.createEl("input", { type: "number" });
      maximum.min = String(actual.minIntervening);
      maximum.value = String(relation.maxIntervening);
      detail.createSpan({ text: relation.unit === "clause" ? "个分句" : "句" });
      const updateRange = (): void => {
        const min = Math.max(0, Math.floor(Number(minimum.value)));
        const max = Math.max(min, Math.floor(Number(maximum.value)));
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > actual.minIntervening || max < actual.minIntervening) {
          new Notice("关系范围必须包含当前原文实例。", 3500);
          this.render();
          return;
        }
        apply({ ...relation, minIntervening: min, maxIntervening: max });
      };
      minimum.addEventListener("change", updateRange);
      maximum.addEventListener("change", updateRange);
    }
  }

  private createRelationPreset(
    host: HTMLElement,
    label: string,
    active: boolean,
    disabled: boolean,
    onClick: () => void,
  ): void {
    const button = host.createEl("button", { cls: `pattern-preview-relation-preset${active ? " is-active" : ""}`, text: label });
    button.setAttr("type", "button");
    button.disabled = disabled;
    button.addEventListener("click", onClick);
  }

  private renderLineWindowControls(): void {
    if (this.mode !== "line-window" || !this.language) return;
    const panel = this.contentEl.createDiv({ cls: "pattern-preview-window-controls" });
    panel.createSpan({ cls: "pattern-preview-window-label", text: "同一原文行" });
    panel.createSpan({ text: "最小覆盖窗口 ≤" });
    const input = panel.createEl("input", { type: "number" });
    const actualSpan = this.currentLineWindowSpan();
    input.min = String(Math.max(1, actualSpan));
    input.value = String(this.lineWindow.maxCharacters);
    input.setAttr("title", actualSpan > 0 ? `当前实例覆盖 ${actualSpan} 字符` : "最大字符窗口");
    input.addEventListener("change", () => {
      const value = Math.floor(Number(input.value));
      if (!Number.isFinite(value) || value < Math.max(1, actualSpan)) {
        new Notice(`窗口不能小于当前实例的 ${Math.max(1, actualSpan)} 字符。`, 3500);
        this.render();
        return;
      }
      this.pushHistory();
      this.lineWindow.maxCharacters = value;
      this.render();
    });
    panel.createSpan({ text: "字" });
    const fixed = panel.createEl("button", { cls: `pattern-preview-window-order${this.lineWindow.ordered ? " is-active" : ""}`, text: "顺序固定" });
    const any = panel.createEl("button", { cls: `pattern-preview-window-order${!this.lineWindow.ordered ? " is-active" : ""}`, text: "顺序不限" });
    fixed.setAttr("type", "button");
    any.setAttr("type", "button");
    fixed.addEventListener("click", () => this.setLineWindowOrder(true));
    any.addEventListener("click", () => this.setLineWindowOrder(false));
  }

  private setLineWindowOrder(ordered: boolean): void {
    if (this.lineWindow.ordered === ordered) return;
    this.pushHistory();
    this.lineWindow.ordered = ordered;
    this.render();
  }

  private currentDefinition(includeOverrides = true): PatternDefinitionV2 {
    if (!this.language || !this.mode) throw new Error("尚未选择语言或模式。");
    const candidates = this.mode === "clause-coordinate"
      ? findClauseBoundaryCandidates(this.sourceText, this.language)
      : [];
    const boundaries = [...this.boundaryRoles.entries()].flatMap(([key, role]) => {
      const candidate = candidates.find((item) => boundaryKey(item) === key);
      return candidate ? [{ candidate, role }] : [];
    });
    let coordinates = this.coordinateRanges();
    if (this.mode === "clause-coordinate" && this.lockedScopeIndex !== null) {
      const sentence = splitLanguageSentences(this.sourceText, this.language)[this.lockedScopeIndex];
      if (sentence) coordinates = coordinates.filter((item) => item.from >= sentence.from && item.to <= sentence.to);
    }
    return buildPatternDefinition({
      sourceText: this.sourceText,
      language: this.language,
      requestedMode: this.mode,
      contents: this.contents,
      boundaries,
      coordinateRanges: coordinates,
      relationOverrides: includeOverrides ? this.relationOverrides : new Map(),
      unorderedGroups: this.unorderedGroups,
      lineWindow: this.lineWindow,
    });
  }

  private slotLabel(unit: "clause" | "sentence" | "source-line", sourceIndex: number): string {
    return `${unit === "clause" ? "C" : unit === "source-line" ? "L" : "S"}${sourceIndex}`;
  }

  private slotContainsGroupSelection(slot: PatternDefinitionV2["slots"][number]): boolean {
    return slot.contentGroups.some((group) => group.componentIds.some((id) => this.groupSelection.includes(id)));
  }

  private toggleGroupSelection(id: string): void {
    if (this.mode === "line-window") {
      new Notice("同行窗口请使用顺序固定／不限。", 3000);
      return;
    }
    const definition = this.currentDefinition();
    const component = definition.contentComponents.find((item) => item.id === id);
    if (!component?.coordinateSlotId) return;
    const existingGroup = this.unorderedGroups.find((group) => group.includes(id));
    if (this.groupSelection.length === 0) {
      this.groupSelection = existingGroup ? [...existingGroup] : [id];
      this.activeId = null;
      this.render();
      return;
    }
    const selectedSlotId = definition.contentComponents.find((item) => item.id === this.groupSelection[0])?.coordinateSlotId;
    if (selectedSlotId !== component.coordinateSlotId) {
      new Notice("只能组合同一坐标内的元素。", 3000);
      return;
    }
    const next = this.groupSelection.includes(id)
      ? this.groupSelection.filter((item) => item !== id)
      : [...this.groupSelection, id];
    const slotContents = definition.contentComponents
      .filter((item) => item.coordinateSlotId === component.coordinateSlotId)
      .sort((left, right) => (left.ranges[0]?.from ?? 0) - (right.ranges[0]?.from ?? 0));
    const indexes = next.map((member) => slotContents.findIndex((item) => item.id === member)).sort((left, right) => left - right);
    const contiguous = indexes.every((index, offset) => index >= 0 && index === (indexes[0] ?? 0) + offset);
    if (!contiguous) {
      new Notice("无序组必须由相邻元素组成。", 3000);
      return;
    }
    this.pushHistory();
    this.unorderedGroups = this.unorderedGroups.filter((group) => !group.some((member) => this.groupSelection.includes(member) || member === id));
    if (next.length >= 2) this.unorderedGroups.push(next.sort((left, right) => slotContents.findIndex((item) => item.id === left) - slotContents.findIndex((item) => item.id === right)));
    this.groupSelection = next;
    this.render();
  }

  private dissolveUnorderedGroup(group: string[]): void {
    this.pushHistory();
    this.unorderedGroups = this.unorderedGroups.filter((item) => item !== group);
    this.groupSelection = [];
    this.render();
  }

  private currentLineWindowSpan(): number {
    const first = this.contents[0];
    const last = this.contents.at(-1);
    if (!first || !last) return 0;
    return Array.from(this.sourceText.slice(first.from, last.to)).length;
  }

  private removeContent(id: string): void {
    if (!this.contents.some((component) => component.id === id)) return;
    this.pushHistory();
    this.contents = this.contents.filter((component) => component.id !== id);
    this.relabelContents();
    this.unorderedGroups = this.unorderedGroups
      .map((group) => group.filter((member) => member !== id))
      .filter((group) => group.length >= 2);
    this.groupSelection = this.groupSelection.filter((member) => member !== id);
    this.activeRelationKey = null;
    this.refreshScopeLock();
    this.activeId = this.contents.at(-1)?.id ?? null;
    this.render();
  }

  private relabelContents(): void {
    this.contents = this.contents.map((component, index) => ({ ...component, label: componentLabel(index) }));
  }

  private pushHistory(): void {
    this.history.push(this.createSnapshot());
    this.future = [];
    if (this.history.length > 40) this.history.shift();
  }

  private createSnapshot(): PreviewSnapshot {
    return {
      contents: this.contents.map((component) => ({ ...component })),
      boundaries: [...this.boundaryRoles.entries()],
      relations: [...this.relationOverrides.entries()].map(([key, relation]) => [key, { ...relation }]),
      unorderedGroups: this.unorderedGroups.map((group) => [...group]),
      activeId: this.activeId,
      activeRelationKey: this.activeRelationKey,
      lockedScopeIndex: this.lockedScopeIndex,
      lineWindow: { ...this.lineWindow },
    };
  }

  private restoreSnapshot(snapshot: PreviewSnapshot): void {
    this.contents = snapshot.contents.map((component) => ({ ...component }));
    this.boundaryRoles = new Map(snapshot.boundaries);
    this.relationOverrides = new Map(snapshot.relations.map(([key, relation]) => [key, { ...relation }]));
    this.unorderedGroups = snapshot.unorderedGroups.map((group) => [...group]);
    this.groupSelection = [];
    this.activeId = snapshot.activeId;
    this.activeRelationKey = snapshot.activeRelationKey;
    this.lockedScopeIndex = snapshot.lockedScopeIndex;
    this.lineWindow = { ...snapshot.lineWindow };
  }

  private undo(): void {
    const snapshot = this.history.pop();
    if (!snapshot) return;
    this.future.push(this.createSnapshot());
    this.restoreSnapshot(snapshot);
    this.render();
  }

  private redo(): void {
    const snapshot = this.future.pop();
    if (!snapshot) return;
    this.history.push(this.createSnapshot());
    this.restoreSnapshot(snapshot);
    this.render();
  }

  private clearAnnotations(): void {
    if (this.contents.length === 0 && this.boundaryRoles.size === 0) return;
    this.pushHistory();
    this.contents = [];
    this.boundaryRoles.clear();
    this.relationOverrides.clear();
    this.unorderedGroups = [];
    this.groupSelection = [];
    this.activeId = null;
    this.activeRelationKey = null;
    this.lockedScopeIndex = null;
    this.lineWindow = { maxCharacters: 30, ordered: true };
    this.render();
  }

  private resetAnnotations(): void {
    this.contents = [];
    this.boundaryRoles.clear();
    this.relationOverrides.clear();
    this.unorderedGroups = [];
    this.groupSelection = [];
    this.activeId = null;
    this.activeRelationKey = null;
    this.lockedScopeIndex = null;
    this.lineWindow = { maxCharacters: 30, ordered: true };
    this.history = [];
    this.future = [];
  }

  private removeBoundary(candidate: ClauseBoundaryCandidate): void {
    const key = boundaryKey(candidate);
    if (!this.boundaryRoles.has(key)) return;
    this.pushHistory();
    this.boundaryRoles.delete(key);
    this.relationOverrides.clear();
    this.activeRelationKey = null;
    this.pruneUnorderedGroups();
    this.refreshScopeLock();
    this.render();
  }

  private refreshScopeLock(): void {
    if (!this.language || !this.mode || this.mode === "cross-sentence") {
      this.lockedScopeIndex = null;
      return;
    }
    const firstContent = this.contents[0];
    if (firstContent) {
      this.lockedScopeIndex = this.scopeIndexForRange({ from: firstContent.from, to: firstContent.to, text: firstContent.text });
      return;
    }
    if (this.mode === "clause-coordinate" && this.boundaryRoles.size > 0) {
      const candidates = findClauseBoundaryCandidates(this.sourceText, this.language);
      const firstKey = this.boundaryRoles.keys().next().value as string | undefined;
      this.lockedScopeIndex = firstKey ? candidates.find((candidate) => boundaryKey(candidate) === firstKey)?.sentenceIndex ?? null : null;
      return;
    }
    this.lockedScopeIndex = null;
  }

  private pruneUnorderedGroups(): void {
    if (!this.language || !this.mode || this.unorderedGroups.length === 0) return;
    const definition = this.currentDefinition();
    const valid = new Set(definition.slots.flatMap((slot) => slot.contentGroups
      .filter((group) => !group.ordered)
      .map((group) => group.componentIds.join("|"))));
    this.unorderedGroups = this.unorderedGroups.filter((group) => valid.has(group.join("|")));
    this.groupSelection = this.groupSelection.filter((id) => this.unorderedGroups.some((group) => group.includes(id)));
  }

  private bindMiddleClick(element: HTMLElement, action: () => void): void {
    element.addEventListener("mousedown", (event) => {
      if (event.button === 1) event.preventDefault();
    });
    element.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    });
  }
}
