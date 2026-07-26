import {
  findClauseBoundaryCandidates,
  splitLanguageSentences,
  splitSourceLines,
} from "../src/text-segmentation";

function equal<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(actual)}`);
  }
}

const japanese = "『ハイウエスト』には『ローライズ』しか。『ローライズ』には『ハイウエスト』しか。見えていないんじゃないかと思う──視線上にありながら、まったく無視されているみたいな気分だった";
equal(splitLanguageSentences(japanese, "ja").length, 3, "Japanese sentence count");

const english = "Dr. Smith stayed. The value was 3.14. However, we left.";
equal(splitLanguageSentences(english, "en").map((item) => item.text), [
  "Dr. Smith stayed.",
  "The value was 3.14.",
  "However, we left.",
], "English abbreviations and decimals");

const clauseSource = "这是大胆的；我来了——但事情还没有结束";
equal(findClauseBoundaryCandidates(clauseSource, "ja").map((item) => item.text), ["；", "——"], "Strong clause punctuation");

const listSource = "りんご、みかん、バナナを買った。結果は予想を下回ったが、方針を直ちに変える必要はない。";
equal(findClauseBoundaryCandidates(listSource, "ja").filter((item) => item.kind === "comma").map((item) => item.confidence), ["low", "low", "medium"], "Japanese comma candidates use adjacent segment length");

equal(splitSourceLines("first line\nsecond line\n\nthird line").map((item) => item.text), ["first line", "second line", "third line"], "Stable source lines");

console.log("text segmentation tests passed");
