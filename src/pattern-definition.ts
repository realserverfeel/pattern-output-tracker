import {
  PatternBoundaryComponent,
  PatternContentComponentV2,
  PatternCoordinateRelation,
  PatternCoordinateSlot,
  PatternCoordinateUnit,
  PatternDefinitionV2,
  PatternMakerMode,
  PatternSlotContentGroup,
} from "./pattern-model";
import {
  ClauseBoundaryCandidate,
  SEGMENTATION_PROFILE_VERSION,
  SegmentationLanguage,
  splitLanguageSentences,
  splitSourceLines,
  TextRange,
} from "./text-segmentation";

export interface PatternContentDraft {
  id: string;
  label: string;
  from: number;
  to: number;
  text: string;
}

export interface PatternBoundaryDraft {
  candidate: ClauseBoundaryCandidate;
  role: "boundary" | "required";
}

export interface PatternLineWindowDraft {
  maxCharacters: number;
  ordered: boolean;
}

export interface PatternDefinitionDraft {
  sourceText: string;
  language: SegmentationLanguage;
  requestedMode: PatternMakerMode;
  contents: PatternContentDraft[];
  boundaries: PatternBoundaryDraft[];
  coordinateRanges: TextRange[];
  relationOverrides: ReadonlyMap<string, PatternCoordinateRelation>;
  unorderedGroups: readonly string[][];
  lineWindow: PatternLineWindowDraft;
}

export function relationKey(fromId: string, toId: string): string {
  return `${fromId}->${toId}`;
}

export function effectiveMakerMode(requestedMode: PatternMakerMode, boundaryCount: number): PatternMakerMode {
  return requestedMode === "clause-coordinate" && boundaryCount === 0 ? "within-sentence" : requestedMode;
}

export function relationUnitForMode(mode: PatternMakerMode): "clause" | "sentence" | null {
  if (mode === "clause-coordinate") return "clause";
  if (mode === "cross-sentence") return "sentence";
  return null;
}

export function createDefaultRelation(
  fromId: string,
  toId: string,
  unit: "clause" | "sentence",
  fromCoordinate: number,
  toCoordinate: number,
): PatternCoordinateRelation {
  const intervening = Math.max(0, toCoordinate - fromCoordinate - 1);
  return {
    fromId,
    toId,
    unit,
    ordered: true,
    minIntervening: intervening,
    maxIntervening: intervening,
  };
}

export function describeCoordinateRelation(relation: PatternCoordinateRelation): string {
  const noun = relation.unit === "clause" ? "分句" : "句";
  if (relation.minIntervening === 0 && relation.maxIntervening === 0) return "相邻";
  if (relation.maxIntervening === null) {
    return relation.minIntervening === 0 ? "任意后方" : `至少隔 ${relation.minIntervening} ${noun}`;
  }
  if (relation.minIntervening === relation.maxIntervening) return `隔 ${relation.minIntervening} ${noun}`;
  return `隔 ${relation.minIntervening}～${relation.maxIntervening} ${noun}`;
}

export function relationContainsSource(
  relation: PatternCoordinateRelation,
  sourceRelation: PatternCoordinateRelation,
): boolean {
  if (relation.unit !== sourceRelation.unit) return false;
  const actual = sourceRelation.minIntervening;
  return relation.minIntervening <= actual && (relation.maxIntervening === null || relation.maxIntervening >= actual);
}

function containingCoordinateIndex(range: { from: number; to: number }, coordinates: TextRange[]): number {
  return coordinates.findIndex((coordinate) => range.from >= coordinate.from && range.to <= coordinate.to);
}

function sentenceIndexForRange(sourceText: string, language: SegmentationLanguage, range: { from: number; to: number }): number {
  return containingCoordinateIndex(range, splitLanguageSentences(sourceText, language));
}

function lineIndexForRange(sourceText: string, range: { from: number; to: number }): number {
  return containingCoordinateIndex(range, splitSourceLines(sourceText));
}

function slotUnitForMode(mode: PatternMakerMode): PatternCoordinateSlot["unit"] {
  if (mode === "clause-coordinate") return "clause";
  if (mode === "line-window") return "source-line";
  return "sentence";
}

function sourceIndexForRange(
  sourceText: string,
  language: SegmentationLanguage,
  mode: PatternMakerMode,
  coordinates: TextRange[],
  range: { from: number; to: number },
): number {
  if (mode === "clause-coordinate") return containingCoordinateIndex(range, coordinates);
  if (mode === "line-window") return lineIndexForRange(sourceText, range);
  return sentenceIndexForRange(sourceText, language, range);
}

function slotId(unit: PatternCoordinateSlot["unit"], sourceIndex: number): string {
  return `slot-${unit}-${sourceIndex}`;
}

function boundarySlotIds(candidate: ClauseBoundaryCandidate, coordinates: TextRange[]): { beforeSlotId: string; afterSlotId: string } | null {
  let beforeIndex = -1;
  for (let index = 0; index < coordinates.length; index += 1) {
    if ((coordinates[index]?.to ?? Number.POSITIVE_INFINITY) <= candidate.from) beforeIndex = index;
  }
  const afterIndex = coordinates.findIndex((coordinate) => coordinate.from >= candidate.to);
  if (beforeIndex < 0 || afterIndex < 0) return null;
  return {
    beforeSlotId: slotId("clause", beforeIndex),
    afterSlotId: slotId("clause", afterIndex),
  };
}

function buildContentGroups(
  slotContents: PatternContentDraft[],
  unorderedGroups: readonly string[][],
  slotIdValue: string,
): PatternSlotContentGroup[] {
  const positions = new Map(slotContents.map((content, index) => [content.id, index]));
  const validGroups = unorderedGroups.flatMap((group): string[][] => {
    const members = [...new Set(group)].filter((id) => positions.has(id)).sort((left, right) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0));
    if (members.length < 2) return [];
    const indexes = members.map((id) => positions.get(id) ?? -1);
    const first = indexes[0] ?? -1;
    const contiguous = indexes.every((index, offset) => index === first + offset);
    return contiguous ? [members] : [];
  });
  const groupByMember = new Map<string, string[]>();
  for (const group of validGroups) for (const id of group) groupByMember.set(id, group);

  const result: PatternSlotContentGroup[] = [];
  const emitted = new Set<string>();
  for (const content of slotContents) {
    const group = groupByMember.get(content.id);
    if (!group) {
      result.push({ id: `${slotIdValue}-group-${content.id}`, componentIds: [content.id], ordered: true });
      continue;
    }
    const key = group.join("|");
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.push({ id: `${slotIdValue}-unordered-${result.length}`, componentIds: group, ordered: false });
  }
  return result;
}

function buildSlots(
  draft: PatternDefinitionDraft,
  mode: PatternMakerMode,
): { slots: PatternCoordinateSlot[]; contentSlotIds: Map<string, string> } {
  const unit = slotUnitForMode(mode);
  const contentSlotIds = new Map<string, string>();
  const indexes = new Set<number>();
  for (const content of draft.contents) {
    const sourceIndex = sourceIndexForRange(draft.sourceText, draft.language, mode, draft.coordinateRanges, content);
    if (sourceIndex < 0) continue;
    indexes.add(sourceIndex);
    contentSlotIds.set(content.id, slotId(unit, sourceIndex));
  }

  if (mode === "clause-coordinate") {
    for (const { candidate } of draft.boundaries) {
      const adjacent = boundarySlotIds(candidate, draft.coordinateRanges);
      if (!adjacent) continue;
      indexes.add(Number(adjacent.beforeSlotId.replace("slot-clause-", "")));
      indexes.add(Number(adjacent.afterSlotId.replace("slot-clause-", "")));
    }
  }

  const slots = [...indexes].sort((left, right) => left - right).map((sourceIndex) => {
    const id = slotId(unit, sourceIndex);
    const slotContents = draft.contents.filter((content) => contentSlotIds.get(content.id) === id);
    return {
      id,
      unit,
      sourceIndex,
      allowsAnyNonEmptyContent: slotContents.length === 0,
      contentGroups: buildContentGroups(slotContents, draft.unorderedGroups, id),
    };
  });
  return { slots, contentSlotIds };
}

export function buildPatternDefinition(draft: PatternDefinitionDraft): PatternDefinitionV2 {
  const mode = effectiveMakerMode(draft.requestedMode, draft.boundaries.length);
  const coordinateUnit: PatternCoordinateUnit = mode === "within-sentence"
    ? "text"
    : mode === "clause-coordinate"
      ? "clause"
      : mode === "cross-sentence"
        ? "sentence"
        : "source-line";
  const { slots, contentSlotIds } = buildSlots(draft, mode);
  const contentComponents: PatternContentComponentV2[] = draft.contents.map((content) => ({
    id: content.id,
    role: "content",
    label: content.label,
    text: content.text,
    ranges: [{ from: content.from, to: content.to }],
    matchMode: "exact",
    coordinateSlotId: contentSlotIds.get(content.id) ?? "",
  }));
  const boundaryComponents: PatternBoundaryComponent[] = draft.boundaries.flatMap(({ candidate, role }) => {
    const adjacentSlots = boundarySlotIds(candidate, draft.coordinateRanges);
    if (!adjacentSlots) return [];
    return [{
      id: `boundary-${candidate.from}-${candidate.to}`,
      role: "boundary" as const,
      text: candidate.text,
      ranges: [{ from: candidate.from, to: candidate.to }],
      required: role === "required",
      matchMode: role === "required" ? "exact" as const : "any-valid-boundary" as const,
      ...adjacentSlots,
    }];
  });

  const relations: PatternCoordinateRelation[] = [];
  const relationUnit = relationUnitForMode(mode);
  if (relationUnit) {
    for (let index = 1; index < slots.length; index += 1) {
      const from = slots[index - 1];
      const to = slots[index];
      if (!from || !to) continue;
      const key = relationKey(from.id, to.id);
      const sourceRelation = createDefaultRelation(from.id, to.id, relationUnit, from.sourceIndex, to.sourceIndex);
      const override = draft.relationOverrides.get(key);
      relations.push(override && relationContainsSource(override, sourceRelation) ? { ...override } : sourceRelation);
    }
  }

  return {
    mode,
    coordinateUnit,
    sourceText: draft.sourceText,
    contentComponents,
    boundaryComponents,
    slots,
    relations,
    lineWindow: mode === "line-window" ? { ...draft.lineWindow } : null,
    segmentationProfile: { language: draft.language, version: SEGMENTATION_PROFILE_VERSION },
  };
}
