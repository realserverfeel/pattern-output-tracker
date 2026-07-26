import {
  buildPatternDefinition,
  createDefaultRelation,
  describeCoordinateRelation,
  effectiveMakerMode,
  relationContainsSource,
  relationKey,
} from "../src/pattern-definition";
import { PatternCoordinateRelation } from "../src/pattern-model";
import { findClauseBoundaryCandidates, splitLanguageSentences, splitSourceLines, TextRange } from "../src/text-segmentation";

function equal<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
  }
}

equal(effectiveMakerMode("clause-coordinate", 0), "within-sentence", "Clause mode without boundaries normalizes");
equal(effectiveMakerMode("clause-coordinate", 1), "clause-coordinate", "Clause mode with a boundary remains clause mode");

const source = "First sentence. Second sentence. Third sentence.";
const sentences = splitLanguageSentences(source, "en");
const contents = [
  { id: "a", label: "A", from: 0, to: 5, text: "First" },
  { id: "b", label: "B", from: 16, to: 22, text: "Second" },
  { id: "c", label: "C", from: 33, to: 38, text: "Third" },
];
const anyLater: PatternCoordinateRelation = {
  fromId: "slot-sentence-1",
  toId: "slot-sentence-2",
  unit: "sentence",
  ordered: true,
  minIntervening: 0,
  maxIntervening: null,
};
const crossSentence = buildPatternDefinition({
  sourceText: source,
  language: "en",
  requestedMode: "cross-sentence",
  contents,
  boundaries: [],
  coordinateRanges: sentences,
  relationOverrides: new Map([[relationKey("slot-sentence-1", "slot-sentence-2"), anyLater]]),
  unorderedGroups: [],
  lineWindow: { maxCharacters: 30, ordered: true },
});
equal(crossSentence.relations.map(describeCoordinateRelation), ["相邻", "任意后方"], "Cross-sentence relations are independently editable");
equal(crossSentence.slots.map((slot) => slot.sourceIndex), [0, 1, 2], "Cross-sentence slots follow source coordinates");

const grouped = buildPatternDefinition({
  sourceText: source,
  language: "en",
  requestedMode: "cross-sentence",
  contents: [
    { id: "a", label: "A", from: 0, to: 5, text: "First" },
    { id: "b", label: "B", from: 6, to: 14, text: "sentence" },
    { id: "c", label: "C", from: 16, to: 22, text: "Second" },
  ],
  boundaries: [],
  coordinateRanges: sentences,
  relationOverrides: new Map(),
  unorderedGroups: [["a", "b"]],
  lineWindow: { maxCharacters: 30, ordered: true },
});
equal(grouped.slots[0]?.contentGroups.map((group) => ({ members: group.componentIds, ordered: group.ordered })), [
  { members: ["a", "b"], ordered: false },
], "Same-slot elements can form one unordered group");
equal(grouped.relations.map((relation) => [relation.fromId, relation.toId]), [["slot-sentence-0", "slot-sentence-1"]], "Relations connect distinct slots, not same-slot elements");

const skippedMemberGroup = buildPatternDefinition({
  sourceText: "Alpha Beta Gamma.",
  language: "en",
  requestedMode: "within-sentence",
  contents: [
    { id: "a", label: "A", from: 0, to: 5, text: "Alpha" },
    { id: "b", label: "B", from: 6, to: 10, text: "Beta" },
    { id: "c", label: "C", from: 11, to: 16, text: "Gamma" },
  ],
  boundaries: [],
  coordinateRanges: splitLanguageSentences("Alpha Beta Gamma.", "en"),
  relationOverrides: new Map(),
  unorderedGroups: [["a", "c"]],
  lineWindow: { maxCharacters: 30, ordered: true },
});
equal(skippedMemberGroup.slots[0]?.contentGroups.every((group) => group.ordered), true, "An unordered group cannot skip a same-slot element");

const clauseSource = "Alpha is clear; beta remains limited.";
const boundary = findClauseBoundaryCandidates(clauseSource, "en").find((item) => item.text === ";");
if (!boundary) throw new Error("Missing semicolon test boundary");
const clauseCoordinates: TextRange[] = [
  { from: 0, to: boundary.from, text: clauseSource.slice(0, boundary.from) },
  { from: boundary.to + 1, to: clauseSource.length, text: clauseSource.slice(boundary.to + 1) },
];
const clause = buildPatternDefinition({
  sourceText: clauseSource,
  language: "en",
  requestedMode: "clause-coordinate",
  contents: [
    { id: "a", label: "A", from: 0, to: 5, text: "Alpha" },
    { id: "b", label: "B", from: 16, to: 20, text: "beta" },
  ],
  boundaries: [{ candidate: boundary, role: "required" }],
  coordinateRanges: clauseCoordinates,
  relationOverrides: new Map(),
  unorderedGroups: [],
  lineWindow: { maxCharacters: 30, ordered: true },
});
equal(clause.mode, "clause-coordinate", "Selected boundary creates clause structure");
equal(clause.boundaryComponents[0]?.required, true, "Strict boundary remains required");
equal(describeCoordinateRelation(clause.relations[0]!), "相邻", "Adjacent source clauses derive an adjacent relation");

const dashSource = "Alpha——Beta";
const dashBoundary = findClauseBoundaryCandidates(dashSource, "en").find((item) => item.text === "——");
if (!dashBoundary) throw new Error("Missing dash test boundary");
const strictDash = buildPatternDefinition({
  sourceText: dashSource,
  language: "en",
  requestedMode: "clause-coordinate",
  contents: [
    { id: "a", label: "A", from: 0, to: 5, text: "Alpha" },
    { id: "b", label: "B", from: 7, to: 11, text: "Beta" },
  ],
  boundaries: [{ candidate: dashBoundary, role: "required" }],
  coordinateRanges: [
    { from: 0, to: 5, text: "Alpha" },
    { from: 7, to: 11, text: "Beta" },
  ],
  relationOverrides: new Map(),
  unorderedGroups: [],
  lineWindow: { maxCharacters: 30, ordered: true },
});
equal(strictDash.boundaryComponents[0]?.text, "——", "Strict repeated dash remains visible as its exact source text");

const sourceGap = createDefaultRelation("slot-sentence-0", "slot-sentence-2", "sentence", 0, 2);
const invalidAdjacent = { ...sourceGap, minIntervening: 0, maxIntervening: 0 };
equal(relationContainsSource(invalidAdjacent, sourceGap), false, "Relation cannot exclude the source instance");

const lineSource = "Alpha and Beta appear here.";
const line = buildPatternDefinition({
  sourceText: lineSource,
  language: "en",
  requestedMode: "line-window",
  contents: [
    { id: "a", label: "A", from: 0, to: 5, text: "Alpha" },
    { id: "b", label: "B", from: 10, to: 14, text: "Beta" },
  ],
  boundaries: [],
  coordinateRanges: splitSourceLines(lineSource),
  relationOverrides: new Map(),
  unorderedGroups: [],
  lineWindow: { maxCharacters: 20, ordered: false },
});
equal(line.lineWindow, { maxCharacters: 20, ordered: false }, "Line window uses one overall constraint");
equal(line.relations.length, 0, "Line window does not create pairwise distance relations");

console.log("pattern definition tests passed");
