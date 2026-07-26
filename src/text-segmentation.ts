export type SegmentationLanguage = "en" | "ja";

export interface TextRange {
  from: number;
  to: number;
  text: string;
}

export type ClauseBoundaryKind = "comma" | "semicolon" | "colon" | "dash";
export type BoundaryConfidence = "high" | "medium" | "low";

export interface ClauseBoundaryCandidate extends TextRange {
  kind: ClauseBoundaryKind;
  confidence: BoundaryConfidence;
  sentenceIndex: number;
}

const ENGLISH_ABBREVIATIONS = new Set([
  "a.m", "dr", "e.g", "etc", "fig", "i.e", "jr", "mr", "mrs", "ms",
  "mt", "no", "p.m", "prof", "sr", "st", "u.s", "vs",
]);

const CLOSING_MARKS = new Set(["\"", "'", "”", "’", "」", "』", ")", "]", "}", "）", "］", "｝"]);
const OPENING_MARKS = new Set(["(", "[", "{", "（", "［", "｛", "「", "『", "“", "‘"]);
const PAIRED_CLOSING_MARKS = new Set([")", "]", "}", "）", "］", "｝", "」", "』", "”", "’"]);

function trimRange(text: string, from: number, to: number): TextRange | null {
  while (from < to && /\s/u.test(text[from] ?? "")) from += 1;
  while (to > from && /\s/u.test(text[to - 1] ?? "")) to -= 1;
  return from < to ? { from, to, text: text.slice(from, to) } : null;
}

function englishPeriodEndsSentence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const after = text.slice(index + 1);
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (/\d/u.test(previous) && /\d/u.test(next)) return false;
  const token = before.match(/([A-Za-z](?:[A-Za-z.]*)?)$/u)?.[1]?.toLocaleLowerCase();
  if (token && ENGLISH_ABBREVIATIONS.has(token.replace(/\.$/u, ""))) return false;
  if (token && /^[a-z]$/iu.test(token) && /^\s+[A-Z][a-z]/u.test(after)) return false;
  return true;
}

function isSentenceTerminal(text: string, index: number, language: SegmentationLanguage): boolean {
  const char = text[index] ?? "";
  if (char === "?" || char === "!" || char === "？" || char === "！") return true;
  if (char === "。") return language === "ja";
  if (char === ".") return language === "en" ? englishPeriodEndsSentence(text, index) : englishPeriodEndsSentence(text, index);
  return false;
}

export function splitLanguageSentences(text: string, language: SegmentationLanguage): TextRange[] {
  const ranges: TextRange[] = [];
  let start = 0;
  const push = (to: number): void => {
    const range = trimRange(text, start, to);
    if (range) ranges.push(range);
    start = to;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "\n") {
      push(index);
      start = index + 1;
      continue;
    }
    if (!isSentenceTerminal(text, index, language)) continue;
    let end = index + 1;
    while (end < text.length && isSentenceTerminal(text, end, language)) end += 1;
    while (end < text.length && CLOSING_MARKS.has(text[end] ?? "")) end += 1;
    push(end);
    index = end - 1;
  }
  if (start < text.length) push(text.length);
  return ranges;
}

function countMeaningfulUnits(text: string, language: SegmentationLanguage): number {
  if (language === "en") return text.match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)*/gu)?.length ?? 0;
  return Array.from(text).filter((char) => !/[\s\p{P}\p{S}]/u.test(char)).length;
}

function collectRawCandidates(sentence: TextRange, language: SegmentationLanguage): Array<Omit<ClauseBoundaryCandidate, "confidence">> {
  const candidates: Array<Omit<ClauseBoundaryCandidate, "confidence">> = [];
  const stack: string[] = [];
  for (let local = 0; local < sentence.text.length; local += 1) {
    const char = sentence.text[local] ?? "";
    if (OPENING_MARKS.has(char)) {
      stack.push(char);
      continue;
    }
    if (PAIRED_CLOSING_MARKS.has(char)) {
      if (stack.length > 0) stack.pop();
      continue;
    }
    if (stack.length > 0) continue;

    let kind: ClauseBoundaryKind | null = null;
    if (char === "," || char === "，" || (language === "ja" && char === "、")) kind = "comma";
    else if (char === ";" || char === "；") kind = "semicolon";
    else if (char === ":" || char === "：") kind = "colon";
    else if (/[—–―─]/u.test(char) || (char === "-" && sentence.text[local + 1] === "-")) kind = "dash";
    if (!kind) continue;

    let end = local + 1;
    if (kind === "dash") {
      while (end < sentence.text.length && /[—–―─-]/u.test(sentence.text[end] ?? "")) end += 1;
    }
    const from = sentence.from + local;
    const to = sentence.from + end;
    candidates.push({ from, to, text: sentence.text.slice(local, end), kind, sentenceIndex: -1 });
    local = end - 1;
  }
  return candidates;
}

export function findClauseBoundaryCandidates(text: string, language: SegmentationLanguage): ClauseBoundaryCandidate[] {
  const sentences = splitLanguageSentences(text, language);
  const result: ClauseBoundaryCandidate[] = [];
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
    const sentence = sentences[sentenceIndex];
    if (!sentence) continue;
    const candidates = collectRawCandidates(sentence, language);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const previousTo = candidates[index - 1]?.to ?? sentence.from;
      const nextFrom = candidates[index + 1]?.from ?? sentence.to;
      const leftUnits = countMeaningfulUnits(text.slice(previousTo, candidate.from), language);
      const rightUnits = countMeaningfulUnits(text.slice(candidate.to, nextFrom), language);
      const minimum = language === "en" ? 3 : 6;
      let confidence: BoundaryConfidence;
      if ((candidate.kind === "semicolon" || candidate.kind === "colon") && leftUnits > 0 && rightUnits > 0) confidence = "high";
      else if (candidate.kind === "dash" && leftUnits > 0 && rightUnits > 0) confidence = "medium";
      else confidence = leftUnits >= minimum && rightUnits >= minimum ? "medium" : "low";
      result.push({ ...candidate, sentenceIndex, confidence });
    }
  }
  return result;
}

export function splitSourceLines(text: string): TextRange[] {
  const lines: TextRange[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    const range = trimRange(text, start, end);
    if (range) lines.push(range);
    start = index + 1;
  }
  return lines;
}

export const SEGMENTATION_PROFILE_VERSION = 1;
