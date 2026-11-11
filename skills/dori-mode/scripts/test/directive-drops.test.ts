import { expect, test } from "bun:test";
import { COMMON_LEDGER, ledgerProblems, loadLedger } from "../src/directives.ts";

// An entry's drops: phrases of his original with no directive in them (a complaint, a question tail, a card number) that
// its words may leave out mid-sentence, like fillers but in that entry only.
test("drops let an entry's words leave out a phrase mid-sentence, in that entry only; a drop not in original is a problem", () => {
  const fork = loadLedger({ directives: { common: COMMON_LEDGER, local: "" } });
  const owner = fork.entries.find((e) => e.by === "owner" && e.words)!;
  const original = "이건 너무 지저분해 저것도 정리해 / 그것도 너무 지저분해 정리해";
  const dropped = { ...owner, original, fixes: [], words: "저것도 정리해", drops: ["이건 너무 지저분해"] };
  const check = (entries: (typeof owner)[]) => ledgerProblems({ ...fork, fillers: [], entries });
  const { drops: _, ...noDrops } = dropped;
  expect(check([noDrops])[0]).toContain("words is not his original");
  expect(check([dropped])).toEqual([]);
  // the same phrase in another entry is not dropped there
  expect(check([dropped, { ...owner, id: "other", original, fixes: [], words: "그것도 정리해" }])[0]).toContain("directive other: words is not his original");
  expect(check([{ ...dropped, drops: ["이건 너무 지저분해", "없는 말"] }])).toEqual([`directive ${owner.id}: drop "없는 말" is not in original`]);
  // a drop is matched in original after its fixes
  expect(check([{ ...dropped, original: "이건 너무 지저분헤 저것도 정리해", fixes: [["지저분헤", "지저분해"]] }])).toEqual([]);
});
