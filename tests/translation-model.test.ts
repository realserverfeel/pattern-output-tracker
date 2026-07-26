import {
  addTranslationNote,
  addTranslationRelation,
  assignTranslationBlockRange,
  assignTranslationRange,
  autoAssignTranslationExercise,
  createTranslationExercise,
  getBackTranslationTiming,
  getTranslationStageProgress,
  getTranslationBlockUnitSeparators,
  getTranslationUnits,
  hasUnassignedTranslationText,
  mergeAssignedTranslationUnits,
  mergeTranslationBlockWithPrevious,
  normalizeTranslationData,
  reopenTranslationUnits,
  resetTranslationSegmentation,
  scheduleBackTranslation,
  setTranslationNote,
  setTranslationStage,
  splitTranslationBlockAtUnit,
  updateTranslationUnitText,
} from "../src/translation-model";

function equal<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
  }
}

function throws(action: () => unknown, label: string): void {
  let thrown = false;
  try { action(); } catch { thrown = true; }
  equal(thrown, true, label);
}

let nextId = 0;
const idFactory = (prefix: string): string => `${prefix}-${++nextId}`;
const now = "2026-07-24T00:00:00.000Z";

const article = createTranslationExercise(
  "First sentence. Second sentence.\n\nThird paragraph.",
  { title: "Proposal", language: "en", idFactory, now },
);
equal(article.blocks.length, 2, "Blank lines create blocks");
equal(article.stage, "prepare", "A new article starts in preparation");
equal(getTranslationUnits(article).length, 0, "Imported source begins unassigned");
equal(hasUnassignedTranslationText(article), true, "Imported source still needs carving");
equal(autoAssignTranslationExercise(article, idFactory), true, "Automatic carving assigns remaining source");
equal(getTranslationUnits(article).map((unit) => unit.sourceText), [
  "First sentence.",
  "Second sentence.",
  "Third paragraph.",
], "Sentence suggestions create units");
equal(getTranslationStageProgress(article).ready, true, "A fully carved article is ready for translation");

const poem = createTranslationExercise(
  "First poetic line\nSecond poetic line\n\nThird poetic line",
  { title: "Poem", language: "en", idFactory, now },
);
const firstSegment = poem.blocks[0]?.units[0];
equal(
  assignTranslationRange(
    poem,
    firstSegment?.id ?? "",
    0,
    "First poetic line\nSecond poetic line".length,
    idFactory,
  ) !== null,
  true,
  "A multiline selection becomes one unit",
);
equal(getTranslationUnits(poem)[0]?.sourceText, "First poetic line\nSecond poetic line", "Manual carving preserves line breaks");
equal(hasUnassignedTranslationText(poem), true, "Other paragraphs remain available for carving");

const blockSelection = createTranslationExercise(
  "Alpha beta. Gamma delta.",
  { title: "Block selection", language: "en", idFactory, now },
);
const blockId = blockSelection.blocks[0]?.id ?? "";
equal(
  assignTranslationBlockRange(blockSelection, blockId, 0, "Alpha beta.".length, idFactory) !== null,
  true,
  "A selection measured from the whole paragraph maps into its unassigned segment",
);
equal(
  assignTranslationBlockRange(
    blockSelection,
    blockId,
    "Alpha beta. ".length,
    "Alpha beta. Gamma delta.".length,
    idFactory,
  ) !== null,
  true,
  "A later paragraph-level selection still maps correctly after an earlier unit was carved",
);
equal(
  assignTranslationBlockRange(blockSelection, blockId, 0, "Alpha beta. Gamma".length, idFactory),
  null,
  "A selection cannot cross an already carved unit",
);
equal(
  resetTranslationSegmentation(blockSelection, idFactory),
  true,
  "Restarting segmentation removes every carved unit",
);
equal(getTranslationUnits(blockSelection).length, 0, "Restarted source has no assigned units");
equal(
  blockSelection.blocks[0]?.units[0]?.sourceText,
  "Alpha beta. Gamma delta.",
  "Restarting segmentation restores the paragraph as continuous source",
);

const poemUnit = getTranslationUnits(poem)[0];
equal(reopenTranslationUnits(poem, [poemUnit?.id ?? ""]), true, "A unit can return to the unassigned source");
equal(getTranslationUnits(poem).length, 0, "Reopened source is no longer a unit");
equal(autoAssignTranslationExercise(poem, idFactory), true, "Automatic carving can fill reopened source");
const poemUnits = getTranslationUnits(poem);
equal(poemUnits.length, 3, "Automatic carving respects poem lines");
equal(
  mergeAssignedTranslationUnits(poem, [poemUnits[0]?.id ?? "", poemUnits[1]?.id ?? ""], idFactory),
  true,
  "Adjacent carved units merge",
);
equal(getTranslationUnits(poem)[0]?.sourceText, "First poetic line\nSecond poetic line", "Merge preserves line break");

const fullTextPoem = createTranslationExercise(
  "Line one\nLine two\nLine three",
  { title: "Full text poem", language: "en", idFactory, now },
);
equal(autoAssignTranslationExercise(fullTextPoem, idFactory), true, "Poem can be prepared for full-text display");
equal(
  getTranslationBlockUnitSeparators(fullTextPoem.blocks[0] ?? { id: "", units: [] }),
  ["\n", "\n"],
  "Full-text display preserves poetic line breaks between assigned units",
);

const fullTextProse = createTranslationExercise(
  "First sentence. Second sentence.",
  { title: "Full text prose", language: "en", idFactory, now },
);
equal(autoAssignTranslationExercise(fullTextProse, idFactory), true, "Prose can be prepared for full-text display");
equal(
  getTranslationBlockUnitSeparators(fullTextProse.blocks[0] ?? { id: "", units: [] }),
  [" "],
  "Full-text display preserves prose spacing between assigned units",
);

const secondUnit = getTranslationUnits(article)[1];
equal(splitTranslationBlockAtUnit(article, secondUnit?.id ?? "", idFactory), true, "Unit starts a new block");
equal(article.blocks.length, 3, "Block split adds a block");
equal(mergeTranslationBlockWithPrevious(article, article.blocks[1]?.id ?? ""), true, "Block merges upward");
equal(article.blocks.length, 2, "Block merge removes the extra block");

setTranslationStage(article, "translate", now);
equal(reopenTranslationUnits(article, [getTranslationUnits(article)[0]?.id ?? ""]), false, "Locked exercise cannot reopen");
for (const unit of getTranslationUnits(article)) {
  updateTranslationUnitText(unit, "translation", `T: ${unit.sourceText}`);
}
equal(getTranslationStageProgress(article).ready, true, "Every non-empty initial translation unlocks scheduling");
scheduleBackTranslation(article, "2026-07-27T12:00:00.000Z", now);
equal(article.stage, "waitingBackTranslation", "Finishing initial translation enters waiting");
equal(
  getBackTranslationTiming(article, new Date("2026-07-25T09:00:00.000Z")),
  { kind: "future", days: 2 },
  "Waiting time is derived in calendar days",
);
equal(
  getBackTranslationTiming(article, new Date("2026-07-30T09:00:00.000Z")),
  { kind: "overdue", days: 3 },
  "Overdue days are derived without creating a new state",
);

setTranslationStage(article, "backTranslate", now);
for (const unit of getTranslationUnits(article)) {
  updateTranslationUnitText(unit, "backTranslation", unit.sourceText.replace("sentence", "line"));
}
equal(getTranslationStageProgress(article).ready, true, "Every non-empty back translation unlocks comparison");
setTranslationStage(article, "compare", now);
const relationUnit = getTranslationUnits(article)[0]!;
const sourceFirst = relationUnit.sourceText.indexOf("First");
const sourceSentence = relationUnit.sourceText.indexOf("sentence");
const targetFirst = relationUnit.translation.indexOf("First");
const targetSentence = relationUnit.translation.indexOf("sentence");
const forward = addTranslationRelation(
  relationUnit,
  "translation",
  [
    { from: sourceFirst, to: sourceFirst + 5 },
    { from: sourceSentence, to: sourceSentence + 8 },
  ],
  [
    { from: targetFirst, to: targetFirst + 5 },
    { from: targetSentence, to: targetSentence + 8 },
  ],
  "Discontinuous relation",
  now,
  idFactory,
);
equal(forward.leftRanges.length, 2, "One relation can contain discontinuous source fragments");
equal(forward.rightRanges.length, 2, "One relation can contain discontinuous target fragments");
forward.tags.push("语序", "词汇选择");
forward.tagIds.push("tag-grammar");
forward.note = "Compare the determiner and information structure.";
throws(() => addTranslationRelation(
  relationUnit,
  "translation",
  [{ from: sourceFirst, to: sourceFirst + 5 }],
  [{ from: targetFirst, to: targetFirst + 5 }],
), "Overlaps are rejected inside the same relation layer");
equal(addTranslationRelation(
  relationUnit,
  "comparison",
  [{ from: sourceFirst, to: sourceFirst + 5 }],
  [{ from: 0, to: 5 }],
  "",
  now,
  idFactory,
).leftRanges.length, 1, "The independent comparison layer may reuse source fragments");

updateTranslationUnitText(relationUnit, "translation", `Really ${relationUnit.translation}`);
equal(
  relationUnit.translationRelations[0]?.rightRanges[0]?.from,
  targetFirst + "Really ".length,
  "Editing before a linked fragment shifts its stored range",
);
addTranslationNote(relationUnit, "translation", "Remember the determiner.", now, idFactory);
equal(relationUnit.translationNotes.length, 1, "Stage annotations are stored on the fixed record");
setTranslationNote(relationUnit, "translation", "One revised sentence note.", now, idFactory);
equal(relationUnit.translationNotes.length, 1, "A stage keeps exactly one sentence note");
equal(relationUnit.translationNotes[0]?.text, "One revised sentence note.", "Editing replaces the sentence note in place");
setTranslationNote(relationUnit, "translation", "", now, idFactory);
equal(relationUnit.translationNotes.length, 0, "Clearing the editor removes the sentence note");
addTranslationNote(relationUnit, "comparison", "Compare the whole sentence.", now, idFactory);
equal(relationUnit.comparisonNote, "Compare the whole sentence.", "Comparison uses one whole-record note field");

setTranslationStage(article, "complete", now);
equal(article.stage, "complete", "Comparison completes the same article object");
equal(Boolean(article.completedAt), true, "Completion time is retained");

const migrated = normalizeTranslationData({
  schemaVersion: 2,
  exercises: [{
    id: "legacy",
    title: "Legacy",
    sourceSnapshot: "Legacy sentence.",
    phase: "translate",
    activeUnitId: "legacy-unit",
    createdAt: now,
    updatedAt: now,
    blocks: [{
      id: "legacy-block",
      units: [{
        id: "legacy-unit",
        sourceText: "Legacy sentence.",
        separatorAfter: "",
        assigned: true,
        translation: "旧译文",
        status: "confirmed",
        translationNotes: ["第一条旧句子批注", "第二条旧句子批注"],
        comparisonNotes: ["第一条旧对照笔记", "第二条旧对照笔记"],
      }],
    }],
  }],
});
equal(migrated.schemaVersion, 5, "Old files migrate to the new schema");
equal(migrated.exercises[0]?.stage, "translate", "Legacy phase maps to the article lifecycle");
equal(migrated.exercises[0]?.language, "en", "Legacy language is inferred");
equal(migrated.exercises[0]?.blocks[0]?.units[0]?.translationStatus, "confirmed", "Legacy confirmation is preserved");
equal(
  migrated.exercises[0]?.blocks[0]?.units[0]?.translationNotes.map((note) => note.text),
  ["第一条旧句子批注\n\n第二条旧句子批注"],
  "Legacy sentence note arrays merge into one note without losing text",
);
equal(
  migrated.exercises[0]?.blocks[0]?.units[0]?.comparisonNote,
  "第一条旧对照笔记\n\n第二条旧对照笔记",
  "Legacy comparison note arrays merge without losing text",
);

const relationReload = normalizeTranslationData({ schemaVersion: 5, exercises: [article] });
equal(
  relationReload.exercises[0]?.blocks[0]?.units[0]?.translationRelations[0]?.tags,
  ["语序", "词汇选择"],
  "Relation-level tags survive persistence",
);
equal(
  relationReload.exercises[0]?.blocks[0]?.units[0]?.translationRelations[0]?.note,
  "Compare the determiner and information structure.",
  "Relation-level comments survive persistence",
);
equal(
  relationReload.exercises[0]?.blocks[0]?.units[0]?.translationRelations[0]?.tagIds,
  ["tag-grammar"],
  "Plugin tag references survive persistence",
);

console.log("translation model tests passed");
