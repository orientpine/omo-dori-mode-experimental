import { expect, test } from "bun:test";

import { verdictOf } from "../src/merge-gate.ts";

// upstream sisyphuslabs/dori-superagent#231 (https://github.com/sisyphuslabs/dori-superagent/pull/231)
test("markdown emphasis on the VERDICT keyword itself still reads as the verdict; a longer word does not", () => {
  expect(verdictOf("findings\n**VERDICT**: CLEAR")).toBe("CLEAR");
  expect(verdictOf("findings\n__VERDICT__: BLOCK")).toBe("BLOCK");
  expect(verdictOf("findings\n`VERDICT`: CLEAR")).toBe("CLEAR");
  expect(verdictOf("findings\nVERDICT : BLOCK")).toBe("BLOCK");
  expect(verdictOf("findings\n**VERDICT:** CLEAR")).toBe("CLEAR");
  expect(verdictOf("findings\nVERDICT: CLEARLY fine")).toBeUndefined();
  expect(verdictOf("findings\nVERDICTS: CLEAR")).toBeUndefined();
});
