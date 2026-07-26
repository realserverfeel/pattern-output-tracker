export type PatternLanguage = "en" | "ja" | "other";

/**
 * Maker modes are UI presets over one compositional coordinate model. They are
 * intentionally separate from the legacy stored structure kinds below.
 */
export type PatternMakerMode =
  | "within-sentence"
  | "clause-coordinate"
  | "cross-sentence"
  | "line-window";

export type PatternCoordinateUnit = "text" | "clause" | "sentence" | "source-line";
export type PatternComponentRole = "content" | "boundary";

export interface PatternCoordinateRelation {
  fromId: string;
  toId: string;
  unit: PatternCoordinateUnit;
  ordered: boolean;
  minIntervening: number;
  maxIntervening: number | null;
}

export interface PatternSlotContentGroup {
  id: string;
  componentIds: string[];
  ordered: boolean;
}

export interface PatternBoundaryComponent {
  id: string;
  role: "boundary";
  text: string;
  ranges: SourceRange[];
  required: boolean;
  matchMode: "exact" | "any-valid-boundary";
  beforeSlotId: string;
  afterSlotId: string;
}

export interface PatternContentComponentV2 {
  id: string;
  role: "content";
  label: string;
  text: string;
  ranges: SourceRange[];
  matchMode: PatternMatchMode;
  coordinateSlotId: string;
}

export interface PatternCoordinateSlot {
  id: string;
  unit: "clause" | "sentence" | "source-line";
  sourceIndex: number;
  allowsAnyNonEmptyContent: boolean;
  contentGroups: PatternSlotContentGroup[];
}

export interface PatternDefinitionV2 {
  mode: PatternMakerMode;
  coordinateUnit: PatternCoordinateUnit;
  sourceText: string;
  contentComponents: PatternContentComponentV2[];
  boundaryComponents: PatternBoundaryComponent[];
  slots: PatternCoordinateSlot[];
  relations: PatternCoordinateRelation[];
  lineWindow: { maxCharacters: number; ordered: boolean } | null;
  segmentationProfile: { language: PatternLanguage; version: number };
}

export const MAKER_MODE_LABELS: Record<PatternMakerMode, string> = {
  "within-sentence": "普通句内",
  "clause-coordinate": "句内分句",
  "cross-sentence": "跨句",
  "line-window": "同行窗口",
};

export type PatternStructureKind =
  | "contiguous"
  | "discontinuous"
  | "cross-sentence"
  | "move-sequence";

export type PatternUnit = "text" | "sentence" | "sentence-group";
export type PatternMatchMode = "exact" | "equivalent";
export type PatternScope =
  | "selection"
  | "same-sentence"
  | "same-paragraph"
  | "cross-sentence"
  | "sentence-group";
export type DistanceUnit = "characters" | "tokens" | "sentences";

export interface SourceRange {
  from: number;
  to: number;
}

export interface PatternComponent {
  id: string;
  label: string;
  unit: PatternUnit;
  text: string;
  ranges: SourceRange[];
  matchMode: PatternMatchMode;
}

export interface PatternConstraints {
  scope: PatternScope;
  ordered: boolean;
  adjacent: boolean;
  maxDistance: number | null;
  distanceUnit: DistanceUnit;
}

export interface PatternStructure {
  kind: PatternStructureKind;
  sourceText: string;
  components: PatternComponent[];
  constraints: PatternConstraints;
}

export interface SentenceRange extends SourceRange {
  text: string;
}

export const STRUCTURE_LABELS: Record<PatternStructureKind, string> = {
  contiguous: "连续片段",
  discontinuous: "断开组合",
  "cross-sentence": "句子序列",
  "move-sequence": "句组序列",
};

export const LANGUAGE_LABELS: Record<PatternLanguage, string> = {
  en: "英语",
  ja: "日语",
  other: "其他",
};

export function defaultConstraints(kind: PatternStructureKind): PatternConstraints {
  switch (kind) {
    case "contiguous":
      return { scope: "selection", ordered: true, adjacent: true, maxDistance: null, distanceUnit: "characters" };
    case "discontinuous":
      return { scope: "same-sentence", ordered: true, adjacent: false, maxDistance: 24, distanceUnit: "tokens" };
    case "cross-sentence":
      return { scope: "same-paragraph", ordered: true, adjacent: false, maxDistance: 2, distanceUnit: "sentences" };
    case "move-sequence":
      return { scope: "sentence-group", ordered: true, adjacent: true, maxDistance: 0, distanceUnit: "sentences" };
  }
}

export function componentLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export function createComponent(
  sourceText: string,
  ranges: SourceRange[],
  index: number,
  unit: PatternUnit,
): PatternComponent {
  const normalizedRanges = [...ranges].sort((left, right) => left.from - right.from);
  return {
    id: `component-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
    label: componentLabel(index),
    unit,
    text: normalizedRanges.map((range) => sourceText.slice(range.from, range.to).trim()).filter(Boolean).join(" "),
    ranges: normalizedRanges,
    matchMode: "exact",
  };
}

export function relabelComponents(components: PatternComponent[]): PatternComponent[] {
  return components
    .sort((left, right) => (left.ranges[0]?.from ?? 0) - (right.ranges[0]?.from ?? 0))
    .map((component, index) => ({ ...component, label: componentLabel(index) }));
}

export function buildPatternDisplayText(structure: PatternStructure): string {
  const parts = structure.components.map((component) => component.text.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  if (structure.kind === "contiguous") return parts[0] ?? "";
  if (structure.kind === "discontinuous") return parts.join(" ⟨…⟩ ");
  return parts.map((part, index) => `${componentLabel(index)}:${part}`).join(" → ");
}

export function splitSentenceRanges(text: string): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  let start = 0;
  const push = (end: number): void => {
    let from = start;
    let to = end;
    while (from < to && /\s/u.test(text[from] ?? "")) from += 1;
    while (to > from && /\s/u.test(text[to - 1] ?? "")) to -= 1;
    if (from < to) ranges.push({ from, to, text: text.slice(from, to) });
    start = end;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (/[.!?。！？]/u.test(char)) {
      let end = index + 1;
      while (end < text.length && /[.!?。！？]/u.test(text[end] ?? "")) end += 1;
      push(end);
      index = end - 1;
    } else if (char === "\n") {
      push(index);
      start = index + 1;
    }
  }
  if (start < text.length) push(text.length);
  return ranges;
}

export function normalizeStoredStructure(value: unknown, fallbackText: string): PatternStructure {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const kind = raw.kind;
    if (kind === "contiguous" || kind === "discontinuous" || kind === "cross-sentence" || kind === "move-sequence") {
      const sourceText = typeof raw.sourceText === "string" ? raw.sourceText : fallbackText;
      const rawComponents = Array.isArray(raw.components) ? raw.components : [];
      const components = rawComponents.flatMap((item, index): PatternComponent[] => {
        if (!item || typeof item !== "object") return [];
        const component = item as Record<string, unknown>;
        const ranges = Array.isArray(component.ranges)
          ? component.ranges.flatMap((range): SourceRange[] => {
              if (!range || typeof range !== "object") return [];
              const value = range as Record<string, unknown>;
              return typeof value.from === "number" && typeof value.to === "number" && value.from < value.to
                ? [{ from: value.from, to: value.to }]
                : [];
            })
          : [];
        return [{
          id: typeof component.id === "string" ? component.id : `component-${index}`,
          label: typeof component.label === "string" ? component.label : componentLabel(index),
          unit: component.unit === "sentence" || component.unit === "sentence-group" ? component.unit : "text",
          text: typeof component.text === "string" ? component.text : fallbackText,
          ranges,
          matchMode: component.matchMode === "equivalent" ? "equivalent" : "exact",
        }];
      });
      const rawConstraints = raw.constraints && typeof raw.constraints === "object"
        ? raw.constraints as Record<string, unknown>
        : {};
      const defaults = defaultConstraints(kind);
      const scope = rawConstraints.scope;
      const constraints: PatternConstraints = {
        scope: scope === "selection" || scope === "same-sentence" || scope === "same-paragraph" || scope === "cross-sentence" || scope === "sentence-group" ? scope : defaults.scope,
        ordered: typeof rawConstraints.ordered === "boolean" ? rawConstraints.ordered : defaults.ordered,
        adjacent: typeof rawConstraints.adjacent === "boolean" ? rawConstraints.adjacent : defaults.adjacent,
        maxDistance: typeof rawConstraints.maxDistance === "number" ? rawConstraints.maxDistance : defaults.maxDistance,
        distanceUnit: rawConstraints.distanceUnit === "tokens" || rawConstraints.distanceUnit === "sentences" ? rawConstraints.distanceUnit : "characters",
      };
      return {
        kind,
        sourceText,
        components: components.length > 0 ? relabelComponents(components) : [createComponent(sourceText, [{ from: 0, to: sourceText.length }], 0, "text")],
        constraints,
      };
    }
  }
  return {
    kind: "contiguous",
    sourceText: fallbackText,
    components: [createComponent(fallbackText, [{ from: 0, to: fallbackText.length }], 0, "text")],
    constraints: defaultConstraints("contiguous"),
  };
}
