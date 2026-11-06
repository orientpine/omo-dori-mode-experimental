import { expect, test } from "bun:test";

import { defaultDiscordWords } from "../src/config.ts";
import { Discord } from "../src/messenger/discord.ts";
import { QuestionCards, QuestionStore } from "../src/messenger/discord-cards.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { fakeClock, withState } from "./fakes.ts";

// Discord's markdown pairs two underscores in a word as italics: "1_Project/2026_크레인" showed "Project/2026" slanted
// and both underscores gone (the owner, 2026-11-05). Every post and edit escapes them; only the fake API is called.
const discord = () => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: '{"id":"M1"}' };
  };
  const posted = () => seen.filter((r) => r.method !== "GET").map((r) => (JSON.parse(String(r.body)) as { content: string }).content);
  return { dc: new Discord(http, fakeClock(0), "b"), posted };
};

const sent = async (text: string): Promise<string> => {
  const { dc, posted } = discord();
  await dc.send("T1", text);
  return posted()[0] ?? "";
};

test("an underscore in a file name or path goes out escaped, so no two of them pair as italics", async () => {
  expect(await sent("1_Project/2026_크레인 폴더에 넣었어")).toBe("1\\_Project/2026\\_크레인 폴더에 넣었어");
  expect(await sent("a_b_c.txt 와 snake_case_name")).toBe("a\\_b\\_c.txt 와 snake\\_case\\_name");
  expect(await sent("__init__.py 와 _private_name, _Project_/x")).toBe("\\_\\_init\\_\\_.py 와 \\_private\\_name, \\_Project\\_/x");
  expect(await sent("C:\\Users\\a_b\\file_x")).toBe("C:\\Users\\a\\_b\\file\\_x");
});

test("an underscore already escaped is not escaped twice; an escaped backslash before one is not an escape", async () => {
  expect(await sent("a\\_b_c")).toBe("a\\_b\\_c");
  expect(await sent("a\\\\_b")).toBe("a\\\\\\_b");
});

test("emphasis written on purpose at word edges stays: _italic_ and __underline__", async () => {
  expect(await sent("이건 _중요_ 하고 __꼭__ 봐. (_x_)")).toBe("이건 _중요_ 하고 __꼭__ 봐. (_x_)");
  expect(await sent("_a_b_ 와 _a _")).toBe("\\_a\\_b\\_ 와 \\_a \\_");
});

test("code, code blocks, URLs, masked link addresses and Discord tokens go out as written", async () => {
  const kept = [
    "`a_b_c.txt` 를 봐",
    "```\n1_Project/2026_크레인\nx_y_z\n```",
    "https://example.com/a_b/c_d?x_y=1 참고",
    "<https://example.com/a_b_c>",
    "<:my_emoji:123456789012345678> <@123456789012345678> <#123456789012345678> </run_job:123456789012345678>",
  ];
  for (const t of kept) expect(await sent(t)).toBe(t);
  expect(await sent("[my_file_name](<https://example.com/a_b_c>) 와 [x_y_z](https://example.com/d_e_f)")).toBe("[my\\_file\\_name](<https://example.com/a_b_c>) 와 [x\\_y\\_z](https://example.com/d_e_f)");
  expect(await sent("`a_b` 다음 c_d_e 그리고 ```x_y_z```")).toBe("`a_b` 다음 c\\_d\\_e 그리고 ```x_y_z```");
  // review 1 of #358: a double-backtick span and a span over lines are code too; two masked links side by side keep
  // only their addresses, so the second label is escaped
  for (const t of ["``a_b `x` c_d``", "`a_b\nc_d`"]) expect(await sent(t)).toBe(t);
  expect(await sent("[one](https://example.com)[a_b_c](https://example.org/x_y) e_f")).toBe("[one](https://example.com)[a\\_b\\_c](https://example.org/x_y) e\\_f");
  // review 2 of #358: emphasis in a link label stays; an escaped backtick opens no code, so the real span after it stays
  expect(await sent("[__word__](https://example.com) [_x_](<https://example.com>)")).toBe("[__word__](https://example.com) [_x_](<https://example.com>)");
  expect(await sent("\\` then `a_b_c` and d_e")).toBe("\\` then `a_b_c` and d\\_e");
  expect(await sent("\\\\`a_b`")).toBe("\\\\`a_b`");
  // review 3 of #358: an escaped bracket still bounds emphasis; a code span closes only on a run as long as its opener
  expect(await sent("\\[_word_] and a_b")).toBe("\\[_word_] and a\\_b");
  for (const t of ["` ``` ` then ``a_b_c``", "```a_b `` c_d```", "``a_b`c_d``"]) expect(await sent(t)).toBe(t);
  // a run with no closing run is text one backtick at a time, as simple-markdown reads it: "`a_b`" after it is code
  expect(await sent("``a_b` c_d")).toBe("``a_b` c\\_d");
  // an unclosed backtick is no code to Discord: its text is escaped
  expect(await sent("`a_b c_d")).toBe("`a\\_b c\\_d");
});

test("a question card shows a path in its question and options as written", async () => {
  const state = withState();
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: '{"id":"M1"}' };
  };
  try {
    const dc = new Discord(http, fakeClock(0), "b");
    await new QuestionCards(dc, new QuestionStore(`${state.dir}/discord`), { channel: "C1", owner: "1", words: defaultDiscordWords }, () => 0).ask("1_Project/2026_크레인 에 둘까?", ["a_b_c.txt 로", "`x_y_z` 그대로"]);
    const texts = JSON.stringify(seen.filter((r) => r.method === "POST").map((r) => JSON.parse(String(r.body)).components));
    expect(texts).toContain(JSON.stringify("1\\_Project/2026\\_크레인 에 둘까?").slice(1, -1));
    expect(texts).toContain(JSON.stringify("a\\_b\\_c.txt 로").slice(1, -1));
    expect(texts).toContain("`x_y_z` 그대로");
  } finally {
    state.done();
  }
});

test("a card that fits Discord's 4000 characters of text only unescaped goes out unescaped (review 1 of #358)", async () => {
  const state = withState();
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: '{"id":"M1"}' };
  };
  try {
    const dc = new Discord(http, fakeClock(0), "b");
    const options = Array.from({ length: 8 }, () => "a_".repeat(200));
    await new QuestionCards(dc, new QuestionStore(`${state.dir}/discord`), { channel: "C1", owner: "1", words: defaultDiscordWords }, () => 0).ask("q_x_y?", options);
    const texts = JSON.stringify(seen.filter((r) => r.method === "POST").map((r) => JSON.parse(String(r.body)).components));
    expect({ escaped: texts.includes("a\\\\_"), plain: texts.includes("a_".repeat(200)) }).toEqual({ escaped: false, plain: true });
  } finally {
    state.done();
  }
});

test("a card option or answered card that fits its slot only unescaped keeps all its text (review 2 of #358)", async () => {
  const state = withState();
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return { status: 200, headers: {}, body: '{"id":"M1"}' };
  };
  try {
    const dc = new Discord(http, fakeClock(0), "b");
    const cards = new QuestionCards(dc, new QuestionStore(`${state.dir}/discord`), { channel: "C1", owner: "1", words: defaultDiscordWords }, () => 0);
    const long = `${"a_".repeat(400)}KEEP`;
    const q = await cards.ask(`${"q_".repeat(950)}?`, [long, "b_c"], { thread: "T9" });
    await cards.resolve(q.id, "ANSWER_SHOWN");
    // a card asked in its thread folds there; one in the channel leaves the summary line in the thread
    await cards.afterAnswer({ ...q, channel: "C1", status: "answered", answer: "ANSWER_SHOWN", answerKind: "reply", answeredAt: "2026-01-01T00:00:00Z" });
    const bodies = seen.filter((r) => r.method !== "GET" && /messages/.test(r.url)).map((r) => String(r.body));
    expect({ option: bodies[0]?.includes("KEEP"), answer: bodies.slice(1).map((b) => b.includes("ANSWER")) }).toEqual({ option: true, answer: [true, true] });
  } finally {
    state.done();
  }
});

test("an edit escapes the same way", async () => {
  const { dc, posted } = discord();
  await dc.edit("T1", "M1", "고침: 1_Project/2026_크레인 `a_b`");
  expect(posted()).toEqual(["고침: 1\\_Project/2026\\_크레인 `a_b`"]);
});

test("a text that fits Discord's 2000 characters only unescaped goes out unescaped rather than refused", async () => {
  const text = `${"x".repeat(1985)} a_b_c_d_e_f`;
  expect(text.length).toBe(1997);
  expect(await sent(text)).toBe(text);
  const short = `${"x".repeat(1980)} a_b_c`;
  expect(await sent(short)).toBe(`${"x".repeat(1980)} a\\_b\\_c`);
});
