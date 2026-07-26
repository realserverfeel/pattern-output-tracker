import {
  SegmentationLanguage,
  splitLanguageSentences,
} from "./text-segmentation";

export const TRANSLATION_SCHEMA_VERSION = 5;

export type TranslationLanguage = "en" | "ja";
export type TranslationStage =
  | "prepare"
  | "translate"
  | "waitingBackTranslation"
  | "backTranslate"
  | "compare"
  | "complete";
export type TranslationUnitStatus = "empty" | "draft" | "confirmed";
export type TranslationTextField = "source" | "translation" | "backTranslation";
export type TranslationRelationLayer = "translation" | "comparison";
export type TranslationNoteStage = "translation" | "backTranslation" | "comparison";

export interface TranslationSource {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  capturedAt: string;
}

export interface TranslationTextRange {
  from: number;
  to: number;
}

export interface TranslationRelation {
  id: string;
  leftRanges: TranslationTextRange[];
  rightRanges: TranslationTextRange[];
  note: string;
  tags: string[];
  tagIds: string[];
  createdAt: string;
}

export interface TranslationNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface TranslationUnit {
  id: string;
  sourceText: string;
  separatorAfter: string;
  assigned: boolean;
  translation: string;
  translationStatus: TranslationUnitStatus;
  backTranslation: string;
  backTranslationStatus: TranslationUnitStatus;
  comparisonStatus: TranslationUnitStatus;
  translationRelations: TranslationRelation[];
  comparisonRelations: TranslationRelation[];
  translationNotes: TranslationNote[];
  backTranslationNotes: TranslationNote[];
  comparisonNote: string;
}

export interface TranslationBlock {
  id: string;
  units: TranslationUnit[];
}

export interface TranslationExercise {
  id: string;
  title: string;
  language: TranslationLanguage;
  sourceSnapshot: string;
  source?: TranslationSource;
  blocks: TranslationBlock[];
  stage: TranslationStage;
  activeUnitId: string | null;
  backTranslationDueAt?: string;
  stageStartedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationDataFile {
  schemaVersion: number;
  exercises: TranslationExercise[];
}

export interface TranslationStageProgress {
  completed: number;
  total: number;
  ready: boolean;
}

export function createTranslationId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function detectTranslationLanguage(text: string): TranslationLanguage {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(text) ? "ja" : "en";
}

export function suggestTranslationTitle(sourceText: string): string {
  const firstLine = sourceText.replace(/\r\n?/gu, "\n").split("\n").find((line) => line.trim())?.trim() ?? "";
  if (firstLine.length <= 42) return firstLine || "未命名";
  return `${firstLine.slice(0, 41).trimEnd()}…`;
}

function splitSourceBlocks(sourceText: string): string[] {
  return sourceText
    .replace(/\r\n?/gu, "\n")
    .trim()
    .split(/\n[ \t]*\n+/gu)
    .filter((block) => Boolean(block.trim()));
}

function emptyUnit(
  sourceText: string,
  assigned: boolean,
  idFactory: (prefix: string) => string,
): TranslationUnit {
  return {
    id: idFactory("unit"),
    sourceText,
    separatorAfter: "",
    assigned,
    translation: "",
    translationStatus: "empty",
    backTranslation: "",
    backTranslationStatus: "empty",
    comparisonStatus: "empty",
    translationRelations: [],
    comparisonRelations: [],
    translationNotes: [],
    backTranslationNotes: [],
    comparisonNote: "",
  };
}

export function createTranslationExercise(
  sourceText: string,
  options: {
    title?: string;
    language?: TranslationLanguage;
    source?: TranslationSource;
    now?: string;
    idFactory?: (prefix: string) => string;
  } = {},
): TranslationExercise {
  const normalizedSource = sourceText.replace(/\r\n?/gu, "\n").trim();
  if (!normalizedSource) throw new Error("原文不能为空。");
  const title = options.title?.trim();
  if (!title) throw new Error("标题不能为空。");
  const idFactory = options.idFactory ?? createTranslationId;
  const blocks = splitSourceBlocks(normalizedSource).map((blockText) => ({
    id: idFactory("block"),
    units: [emptyUnit(blockText, false, idFactory)],
  }));
  const now = options.now ?? new Date().toISOString();
  return {
    id: idFactory("translation"),
    title,
    language: options.language ?? detectTranslationLanguage(normalizedSource),
    sourceSnapshot: normalizedSource,
    source: options.source,
    blocks,
    stage: "prepare",
    activeUnitId: null,
    stageStartedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export function getTranslationUnits(exercise: TranslationExercise): TranslationUnit[] {
  return exercise.blocks.flatMap((block) => block.units.filter((unit) => unit.assigned));
}

export function getTranslationSegments(exercise: TranslationExercise): TranslationUnit[] {
  return exercise.blocks.flatMap((block) => block.units);
}

/**
 * Returns the exact source material that originally sat between each pair of
 * assigned units in a block. Whitespace-only unassigned segments remain in the
 * model after preparation so that prose spacing and poetic line breaks can be
 * reconstructed without becoming translation units themselves.
 */
export function getTranslationBlockUnitSeparators(block: TranslationBlock): string[] {
  const separators: string[] = [];
  let hasAssignedUnit = false;
  let pending = "";
  for (const segment of block.units) {
    if (segment.assigned) {
      if (hasAssignedUnit) separators.push(pending);
      hasAssignedUnit = true;
      pending = segment.separatorAfter;
      continue;
    }
    if (hasAssignedUnit) pending += `${segment.sourceText}${segment.separatorAfter}`;
  }
  return separators;
}

export function findTranslationUnit(
  exercise: TranslationExercise,
  unitId: string | null,
): TranslationUnit | undefined {
  if (!unitId) return undefined;
  return getTranslationSegments(exercise).find((unit) => unit.id === unitId);
}

export function getTranslationStageProgress(exercise: TranslationExercise): TranslationStageProgress {
  const units = getTranslationUnits(exercise);
  if (exercise.stage === "prepare") {
    const ready = units.length > 0 && !hasUnassignedTranslationText(exercise);
    return { completed: ready ? units.length : 0, total: units.length, ready };
  }
  const completed = units.filter((unit) => {
    if (exercise.stage === "translate" || exercise.stage === "waitingBackTranslation") {
      return Boolean(unit.translation.trim());
    }
    if (exercise.stage === "backTranslate") return Boolean(unit.backTranslation.trim());
    if (exercise.stage === "compare" || exercise.stage === "complete") {
      return true;
    }
    return false;
  }).length;
  return { completed, total: units.length, ready: units.length > 0 && completed === units.length };
}

export function setTranslationStage(
  exercise: TranslationExercise,
  stage: TranslationStage,
  now = new Date().toISOString(),
): void {
  exercise.stage = stage;
  exercise.stageStartedAt = now;
  exercise.updatedAt = now;
  if (stage === "complete") exercise.completedAt = now;
  const units = getTranslationUnits(exercise);
  const firstIncomplete = units.find((unit) => {
    if (stage === "translate") return !unit.translation.trim();
    if (stage === "backTranslate") return !unit.backTranslation.trim();
    return false;
  });
  exercise.activeUnitId = firstIncomplete?.id ?? units[0]?.id ?? null;
}

export function scheduleBackTranslation(
  exercise: TranslationExercise,
  dueAt: string,
  now = new Date().toISOString(),
): void {
  if (!getTranslationStageProgress(exercise).ready || exercise.stage !== "translate") {
    throw new Error("请先完成全部初译单位。");
  }
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) throw new Error("回译日期无效。");
  exercise.backTranslationDueAt = parsed.toISOString();
  setTranslationStage(exercise, "waitingBackTranslation", now);
}

export function getBackTranslationTiming(
  exercise: TranslationExercise,
  now = new Date(),
): { kind: "future" | "today" | "overdue"; days: number } | null {
  if (!exercise.backTranslationDueAt) return null;
  const due = new Date(exercise.backTranslationDueAt);
  if (Number.isNaN(due.getTime())) return null;
  const day = 86_400_000;
  const localDate = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const difference = Math.round((localDate(due) - localDate(now)) / day);
  if (difference > 0) return { kind: "future", days: difference };
  if (difference < 0) return { kind: "overdue", days: Math.abs(difference) };
  return { kind: "today", days: 0 };
}

function compactUnassignedSegments(block: TranslationBlock): void {
  const compacted: TranslationUnit[] = [];
  for (const segment of block.units) {
    const previous = compacted[compacted.length - 1];
    if (previous && !previous.assigned && !segment.assigned) {
      previous.sourceText += `${previous.separatorAfter}${segment.sourceText}`;
      previous.separatorAfter = segment.separatorAfter;
    } else {
      compacted.push(segment);
    }
  }
  block.units = compacted;
}

export function assignTranslationRange(
  exercise: TranslationExercise,
  segmentId: string,
  start: number,
  end: number,
  idFactory: (prefix: string) => string = createTranslationId,
): string | null {
  if (exercise.stage !== "prepare") return null;
  for (const block of exercise.blocks) {
    const index = block.units.findIndex((segment) => segment.id === segmentId);
    const segment = block.units[index];
    if (index < 0 || !segment || segment.assigned) continue;
    const safeStart = Math.max(0, Math.min(start, end, segment.sourceText.length));
    const safeEnd = Math.max(safeStart, Math.min(Math.max(start, end), segment.sourceText.length));
    const rawSelection = segment.sourceText.slice(safeStart, safeEnd);
    const selectedText = rawSelection.trim();
    if (!selectedText) return null;
    const leadingWhitespace = rawSelection.length - rawSelection.trimStart().length;
    const trailingWhitespace = rawSelection.length - rawSelection.trimEnd().length;
    const selectionStart = safeStart + leadingWhitespace;
    const selectionEnd = safeEnd - trailingWhitespace;
    const before = segment.sourceText.slice(0, selectionStart);
    const after = segment.sourceText.slice(selectionEnd);
    const assigned = emptyUnit(selectedText, true, idFactory);
    const replacement: TranslationUnit[] = [];
    if (before) replacement.push(emptyUnit(before, false, idFactory));
    replacement.push(assigned);
    if (after) replacement.push(emptyUnit(after, false, idFactory));
    const last = replacement[replacement.length - 1];
    if (last) last.separatorAfter = segment.separatorAfter;
    block.units.splice(index, 1, ...replacement);
    exercise.activeUnitId = assigned.id;
    return assigned.id;
  }
  return null;
}

export function assignTranslationBlockRange(
  exercise: TranslationExercise,
  blockId: string,
  start: number,
  end: number,
  idFactory: (prefix: string) => string = createTranslationId,
): string | null {
  if (exercise.stage !== "prepare") return null;
  const block = exercise.blocks.find((candidate) => candidate.id === blockId);
  if (!block) return null;
  const blockText = block.units
    .map((segment) => `${segment.sourceText}${segment.separatorAfter}`)
    .join("");
  const safeStart = Math.max(0, Math.min(start, end, blockText.length));
  const safeEnd = Math.max(safeStart, Math.min(Math.max(start, end), blockText.length));
  const rawSelection = blockText.slice(safeStart, safeEnd);
  if (!rawSelection.trim()) return null;
  const selectionStart = safeStart + (rawSelection.length - rawSelection.trimStart().length);
  const selectionEnd = safeEnd - (rawSelection.length - rawSelection.trimEnd().length);
  let cursor = 0;
  for (const segment of block.units) {
    const textStart = cursor;
    const textEnd = textStart + segment.sourceText.length;
    if (
      !segment.assigned
      && selectionStart >= textStart
      && selectionEnd <= textEnd
    ) {
      return assignTranslationRange(
        exercise,
        segment.id,
        selectionStart - textStart,
        selectionEnd - textStart,
        idFactory,
      );
    }
    cursor = textEnd + segment.separatorAfter.length;
  }
  return null;
}

export function autoAssignTranslationExercise(
  exercise: TranslationExercise,
  idFactory: (prefix: string) => string = createTranslationId,
): boolean {
  if (exercise.stage !== "prepare") return false;
  const language: SegmentationLanguage = exercise.language;
  let changed = false;
  for (const block of exercise.blocks) {
    const replacement: TranslationUnit[] = [];
    for (const segment of block.units) {
      if (segment.assigned || !segment.sourceText.trim()) {
        replacement.push(segment);
        continue;
      }
      const ranges = splitLanguageSentences(segment.sourceText, language);
      if (ranges.length === 0) {
        replacement.push(segment);
        continue;
      }
      let cursor = 0;
      for (const range of ranges) {
        if (range.from > cursor) replacement.push(emptyUnit(segment.sourceText.slice(cursor, range.from), false, idFactory));
        replacement.push(emptyUnit(range.text, true, idFactory));
        cursor = range.to;
      }
      if (cursor < segment.sourceText.length) replacement.push(emptyUnit(segment.sourceText.slice(cursor), false, idFactory));
      const last = replacement[replacement.length - 1];
      if (last) last.separatorAfter += segment.separatorAfter;
      changed = true;
    }
    block.units = replacement;
    compactUnassignedSegments(block);
  }
  exercise.activeUnitId = getTranslationUnits(exercise)[0]?.id ?? null;
  return changed;
}

export function reopenTranslationUnits(
  exercise: TranslationExercise,
  unitIds: readonly string[],
): boolean {
  if (exercise.stage !== "prepare" || unitIds.length === 0) return false;
  const wanted = new Set(unitIds);
  let changed = false;
  for (const block of exercise.blocks) {
    for (const segment of block.units) {
      if (!segment.assigned || !wanted.has(segment.id)) continue;
      const separatorAfter = segment.separatorAfter;
      Object.assign(segment, emptyUnit(segment.sourceText, false, () => segment.id));
      segment.separatorAfter = separatorAfter;
      changed = true;
    }
    compactUnassignedSegments(block);
  }
  if (changed) exercise.activeUnitId = null;
  return changed;
}

export function resetTranslationSegmentation(
  exercise: TranslationExercise,
  idFactory: (prefix: string) => string = createTranslationId,
): boolean {
  if (exercise.stage !== "prepare") return false;
  const changed = exercise.blocks.some((block) =>
    block.units.length !== 1 || block.units.some((unit) => unit.assigned));
  if (!changed) return false;
  for (const block of exercise.blocks) {
    const sourceText = block.units
      .map((unit) => `${unit.sourceText}${unit.separatorAfter}`)
      .join("");
    block.units = [emptyUnit(sourceText, false, idFactory)];
  }
  exercise.activeUnitId = null;
  return true;
}

export function mergeAssignedTranslationUnits(
  exercise: TranslationExercise,
  unitIds: readonly string[],
  idFactory: (prefix: string) => string = createTranslationId,
): boolean {
  if (exercise.stage !== "prepare" || unitIds.length < 2) return false;
  const wanted = new Set(unitIds);
  for (const block of exercise.blocks) {
    const indexes = block.units
      .map((segment, index) => segment.assigned && wanted.has(segment.id) ? index : -1)
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    if (indexes.length !== unitIds.length) continue;
    const firstIndex = indexes[0];
    const lastIndex = indexes[indexes.length - 1];
    if (firstIndex === undefined || lastIndex === undefined) return false;
    const range = block.units.slice(firstIndex, lastIndex + 1);
    if (range.some((segment) => (segment.assigned && !wanted.has(segment.id)) || (!segment.assigned && segment.sourceText.trim()))) return false;
    const last = range[range.length - 1];
    if (!last) return false;
    const combined = range.map((segment) => `${segment.sourceText}${segment.separatorAfter}`).join("");
    const merged = emptyUnit(last.separatorAfter ? combined.slice(0, -last.separatorAfter.length) : combined, true, idFactory);
    merged.separatorAfter = last.separatorAfter;
    block.units.splice(firstIndex, range.length, merged);
    exercise.activeUnitId = merged.id;
    return true;
  }
  return false;
}

export function hasUnassignedTranslationText(exercise: TranslationExercise): boolean {
  return getTranslationSegments(exercise).some((segment) => !segment.assigned && Boolean(segment.sourceText.trim()));
}

export function splitTranslationUnit(
  exercise: TranslationExercise,
  unitId: string,
  offset: number,
  idFactory: (prefix: string) => string = createTranslationId,
): boolean {
  if (exercise.stage !== "prepare") return false;
  for (const block of exercise.blocks) {
    const index = block.units.findIndex((unit) => unit.id === unitId);
    const unit = block.units[index];
    if (index < 0 || !unit) continue;
    const safeOffset = Math.max(0, Math.min(offset, unit.sourceText.length));
    const rawLeft = unit.sourceText.slice(0, safeOffset);
    const rawRight = unit.sourceText.slice(safeOffset);
    const left = rawLeft.trimEnd();
    const right = rawRight.trimStart();
    if (!left || !right) return false;
    const separator = `${rawLeft.slice(left.length)}${rawRight.slice(0, rawRight.length - right.length)}`;
    const next = emptyUnit(right, unit.assigned, idFactory);
    next.separatorAfter = unit.separatorAfter;
    unit.sourceText = left;
    unit.separatorAfter = separator;
    block.units.splice(index + 1, 0, next);
    exercise.activeUnitId = next.id;
    return true;
  }
  return false;
}

export function mergeTranslationUnits(
  exercise: TranslationExercise,
  unitIds: readonly string[],
): boolean {
  return mergeAssignedTranslationUnits(exercise, unitIds);
}

export function splitTranslationBlockAtUnit(
  exercise: TranslationExercise,
  unitId: string,
  idFactory: (prefix: string) => string = createTranslationId,
): boolean {
  if (exercise.stage !== "prepare") return false;
  const blockIndex = exercise.blocks.findIndex((block) => block.units.some((unit) => unit.id === unitId));
  const block = exercise.blocks[blockIndex];
  if (blockIndex < 0 || !block) return false;
  const unitIndex = block.units.findIndex((unit) => unit.id === unitId);
  if (unitIndex <= 0) return false;
  exercise.blocks.splice(blockIndex + 1, 0, { id: idFactory("block"), units: block.units.splice(unitIndex) });
  return true;
}

export function mergeTranslationBlockWithPrevious(exercise: TranslationExercise, blockId: string): boolean {
  if (exercise.stage !== "prepare") return false;
  const blockIndex = exercise.blocks.findIndex((block) => block.id === blockId);
  if (blockIndex <= 0) return false;
  const previous = exercise.blocks[blockIndex - 1];
  const current = exercise.blocks[blockIndex];
  if (!previous || !current) return false;
  previous.units.push(...current.units);
  exercise.blocks.splice(blockIndex, 1);
  return true;
}

export function normalizeTextRanges(
  ranges: readonly TranslationTextRange[],
  textLength: number,
): TranslationTextRange[] {
  const normalized = ranges
    .map(({ from, to }) => ({
      from: Math.max(0, Math.min(from, to, textLength)),
      to: Math.max(0, Math.min(Math.max(from, to), textLength)),
    }))
    .filter(({ from, to }) => to > from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: TranslationTextRange[] = [];
  for (const range of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

export function relationOverlaps(
  relations: readonly TranslationRelation[],
  leftRanges: readonly TranslationTextRange[],
  rightRanges: readonly TranslationTextRange[],
): boolean {
  const overlaps = (a: TranslationTextRange, b: TranslationTextRange): boolean => a.from < b.to && b.from < a.to;
  return relations.some((relation) =>
    relation.leftRanges.some((existing) => leftRanges.some((range) => overlaps(existing, range)))
    || relation.rightRanges.some((existing) => rightRanges.some((range) => overlaps(existing, range))),
  );
}

export function addTranslationRelation(
  unit: TranslationUnit,
  layer: TranslationRelationLayer,
  leftRanges: readonly TranslationTextRange[],
  rightRanges: readonly TranslationTextRange[],
  note = "",
  now = new Date().toISOString(),
  idFactory: (prefix: string) => string = createTranslationId,
): TranslationRelation {
  const leftLength = unit.sourceText.length;
  const rightText = layer === "translation" ? unit.translation : unit.backTranslation;
  const safeLeft = normalizeTextRanges(leftRanges, leftLength);
  const safeRight = normalizeTextRanges(rightRanges, rightText.length);
  if (safeLeft.length === 0 || safeRight.length === 0) throw new Error("关联两侧都需要至少选择一个片段。");
  const target = layer === "translation" ? unit.translationRelations : unit.comparisonRelations;
  if (relationOverlaps(target, safeLeft, safeRight)) throw new Error("这个片段已属于本层的其他关联。");
  const relation: TranslationRelation = {
    id: idFactory("relation"),
    leftRanges: safeLeft,
    rightRanges: safeRight,
    note: note.trim(),
    tags: [],
    tagIds: [],
    createdAt: now,
  };
  target.push(relation);
  return relation;
}

export function addTranslationNote(
  unit: TranslationUnit,
  stage: TranslationNoteStage,
  text: string,
  now = new Date().toISOString(),
  idFactory: (prefix: string) => string = createTranslationId,
): TranslationNote {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("批注不能为空。");
  const target = stage === "translation"
    ? unit.translationNotes
    : stage === "backTranslation"
      ? unit.backTranslationNotes
      : null;
  if (target) {
    const existing = target[0];
    const note = existing ?? { id: idFactory("note"), text: "", createdAt: now };
    note.text = trimmed;
    target.splice(0, target.length, note);
    return note;
  }
  const note = { id: idFactory("note"), text: trimmed, createdAt: now };
  unit.comparisonNote = trimmed;
  return note;
}

export function setTranslationNote(
  unit: TranslationUnit,
  stage: "translation" | "backTranslation",
  text: string,
  now = new Date().toISOString(),
  idFactory: (prefix: string) => string = createTranslationId,
): TranslationNote | null {
  const target = stage === "translation" ? unit.translationNotes : unit.backTranslationNotes;
  const trimmed = text.trim();
  if (!trimmed) {
    target.splice(0, target.length);
    return null;
  }
  const existing = target[0];
  const note = existing ?? { id: idFactory("note"), text: "", createdAt: now };
  note.text = text.trimEnd();
  target.splice(0, target.length, note);
  return note;
}

function remapRangesAfterEdit(
  ranges: readonly TranslationTextRange[],
  previousText: string,
  nextText: string,
): TranslationTextRange[] {
  if (previousText === nextText) return ranges.map((range) => ({ ...range }));
  let prefix = 0;
  while (
    prefix < previousText.length
    && prefix < nextText.length
    && previousText[prefix] === nextText[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < previousText.length - prefix
    && suffix < nextText.length - prefix
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix += 1;
  const oldEnd = previousText.length - suffix;
  const newEnd = nextText.length - suffix;
  const delta = nextText.length - previousText.length;
  const mapFrom = (position: number): number => {
    if (position <= prefix) return position;
    if (position >= oldEnd) return position + delta;
    return prefix;
  };
  const mapTo = (position: number): number => {
    if (position <= prefix) return position;
    if (position >= oldEnd) return position + delta;
    return newEnd;
  };
  return normalizeTextRanges(ranges.map((range) => ({
    from: mapFrom(range.from),
    to: mapTo(range.to),
  })), nextText.length);
}

export function updateTranslationUnitText(
  unit: TranslationUnit,
  field: "translation" | "backTranslation",
  nextText: string,
): void {
  const previousText = field === "translation" ? unit.translation : unit.backTranslation;
  const relations = field === "translation" ? unit.translationRelations : unit.comparisonRelations;
  for (const relation of relations) {
    relation.rightRanges = remapRangesAfterEdit(relation.rightRanges, previousText, nextText);
  }
  for (let index = relations.length - 1; index >= 0; index -= 1) {
    if (relations[index]?.rightRanges.length === 0) relations.splice(index, 1);
  }
  if (field === "translation") {
    unit.translation = nextText;
    unit.translationStatus = nextText.trim() ? "draft" : "empty";
  } else {
    unit.backTranslation = nextText;
    unit.backTranslationStatus = nextText.trim() ? "draft" : "empty";
    unit.comparisonStatus = "empty";
  }
}

function normalizeStatus(raw: unknown, text = ""): TranslationUnitStatus {
  if (raw === "confirmed") return "confirmed";
  if (raw === "draft" || text.trim()) return "draft";
  return "empty";
}

function normalizeRanges(raw: unknown, length: number): TranslationTextRange[] {
  if (!Array.isArray(raw)) return [];
  return normalizeTextRanges(raw.filter((item): item is TranslationTextRange =>
    Boolean(item) && typeof item === "object"
    && typeof (item as TranslationTextRange).from === "number"
    && typeof (item as TranslationTextRange).to === "number"), length);
}

function normalizeRelations(raw: unknown, leftLength: number, rightLength: number, now: string): TranslationRelation[] {
  if (!Array.isArray(raw)) return [];
  const result: TranslationRelation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const leftRanges = normalizeRanges(value.leftRanges, leftLength);
    const rightRanges = normalizeRanges(value.rightRanges, rightLength);
    if (leftRanges.length === 0 || rightRanges.length === 0) continue;
    result.push({
      id: typeof value.id === "string" ? value.id : createTranslationId("relation"),
      leftRanges,
      rightRanges,
      note: typeof value.note === "string" ? value.note : "",
      tags: Array.isArray(value.tags)
        ? value.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
          .map((tag) => tag.trim())
        : [],
      tagIds: Array.isArray(value.tagIds) ? value.tagIds.filter((id): id is string => typeof id === "string") : [],
      createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    });
  }
  return result;
}

function normalizeNotes(raw: unknown, now: string): TranslationNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): TranslationNote[] => {
    if (typeof item === "string" && item.trim()) {
      return [{ id: createTranslationId("note"), text: item.trim(), createdAt: now }];
    }
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.text !== "string" || !value.text.trim()) return [];
    return [{
      id: typeof value.id === "string" ? value.id : createTranslationId("note"),
      text: value.text.trim(),
      createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    }];
  });
}

function normalizeSingleNote(raw: unknown, now: string): TranslationNote[] {
  const notes = normalizeNotes(raw, now);
  if (notes.length <= 1) return notes;
  return [{
    id: notes[0]!.id,
    text: notes.map((note) => note.text).join("\n\n"),
    createdAt: notes[0]!.createdAt,
  }];
}

function normalizeUnit(raw: unknown, now: string): TranslationUnit | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.sourceText !== "string") return null;
  const translation = typeof value.translation === "string" ? value.translation : "";
  const backTranslation = typeof value.backTranslation === "string" ? value.backTranslation : "";
  return {
    id: value.id,
    sourceText: value.sourceText,
    separatorAfter: typeof value.separatorAfter === "string" ? value.separatorAfter : "",
    assigned: typeof value.assigned === "boolean" ? value.assigned : true,
    translation,
    translationStatus: normalizeStatus(value.translationStatus ?? value.status, translation),
    backTranslation,
    backTranslationStatus: normalizeStatus(value.backTranslationStatus, backTranslation),
    comparisonStatus: normalizeStatus(value.comparisonStatus),
    translationRelations: normalizeRelations(value.translationRelations, value.sourceText.length, translation.length, now),
    comparisonRelations: normalizeRelations(value.comparisonRelations, value.sourceText.length, backTranslation.length, now),
    translationNotes: normalizeSingleNote(value.translationNotes, now),
    backTranslationNotes: normalizeSingleNote(value.backTranslationNotes, now),
    comparisonNote: typeof value.comparisonNote === "string"
      ? value.comparisonNote.trim()
      : normalizeNotes(value.comparisonNotes, now).map((note) => note.text).join("\n\n"),
  };
}

function normalizeStage(value: Record<string, unknown>): TranslationStage {
  const known: TranslationStage[] = ["prepare", "translate", "waitingBackTranslation", "backTranslate", "compare", "complete"];
  if (typeof value.stage === "string" && known.includes(value.stage as TranslationStage)) return value.stage as TranslationStage;
  return value.phase === "translate" ? "translate" : "prepare";
}

export function normalizeTranslationData(raw: unknown): TranslationDataFile {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const now = new Date().toISOString();
  const exercises: TranslationExercise[] = [];
  for (const rawExercise of Array.isArray(value.exercises) ? value.exercises : []) {
    if (!rawExercise || typeof rawExercise !== "object") continue;
    const exercise = rawExercise as Record<string, unknown>;
    if (typeof exercise.id !== "string" || typeof exercise.sourceSnapshot !== "string") continue;
    const blocks: TranslationBlock[] = [];
    for (const rawBlock of Array.isArray(exercise.blocks) ? exercise.blocks : []) {
      if (!rawBlock || typeof rawBlock !== "object") continue;
      const block = rawBlock as Record<string, unknown>;
      if (typeof block.id !== "string") continue;
      const units = (Array.isArray(block.units) ? block.units : [])
        .map((unit) => normalizeUnit(unit, now))
        .filter((unit): unit is TranslationUnit => unit !== null);
      if (units.length > 0) blocks.push({ id: block.id, units });
    }
    if (blocks.length === 0) continue;
    const stage = normalizeStage(exercise);
    const assignedIds = new Set(blocks.flatMap((block) => block.units.filter((unit) => unit.assigned).map((unit) => unit.id)));
    const activeUnitId = typeof exercise.activeUnitId === "string" && assignedIds.has(exercise.activeUnitId)
      ? exercise.activeUnitId
      : [...assignedIds][0] ?? null;
    const source = exercise.source && typeof exercise.source === "object"
      ? exercise.source as TranslationSource
      : undefined;
    const createdAt = typeof exercise.createdAt === "string" ? exercise.createdAt : now;
    exercises.push({
      id: exercise.id,
      title: typeof exercise.title === "string" && exercise.title.trim()
        ? exercise.title.trim()
        : suggestTranslationTitle(exercise.sourceSnapshot),
      language: exercise.language === "ja" ? "ja" : exercise.language === "en"
        ? "en"
        : detectTranslationLanguage(exercise.sourceSnapshot),
      sourceSnapshot: exercise.sourceSnapshot,
      source,
      blocks,
      stage,
      activeUnitId,
      backTranslationDueAt: typeof exercise.backTranslationDueAt === "string" ? exercise.backTranslationDueAt : undefined,
      stageStartedAt: typeof exercise.stageStartedAt === "string" ? exercise.stageStartedAt : createdAt,
      completedAt: typeof exercise.completedAt === "string" ? exercise.completedAt : undefined,
      createdAt,
      updatedAt: typeof exercise.updatedAt === "string" ? exercise.updatedAt : createdAt,
    });
  }
  return { schemaVersion: TRANSLATION_SCHEMA_VERSION, exercises };
}
