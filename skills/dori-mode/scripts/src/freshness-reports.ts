// Any status word counts as hearing from the lane (pingpong-analytics reports "| working |"); the footer's placeholder
// "| <milestone|...> | <one plain line ..." never does, nor a template line a lane's code prints before filling it in
// (echo "[REPORT] <key> | milestone | ${message}", f"... | {message}"): issue #22 of dori-superagent
// (https://github.com/sisyphuslabs/dori-superagent/issues/22, MIT), where the template on screen was posted as the report.
// A plain line that is one bare placeholder ($message, %s, quoted or not) is a template too: issue #29 of dori-superagent
// (https://github.com/sisyphuslabs/dori-superagent/issues/29, MIT), while "set $HOME in docs" or "100% of checks green" is real.
const reportGrammar = (key: string): RegExp => new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| [a-z]+ \\| (?!<)(?!.*(?:\\$\\{\\w|\\{\\w+\\}))(?!["']?(?:\\$\\w+|%[sd])(?:\\\\n)?["'\\])\\],;\\s]*$)\\S`);

// A report counts only where a lane puts one: first on its line (after omo's "│ " cell border), as an argv element
// right after --text ("--text","[REPORT] ...", --text "[REPORT] ..."); a line that quotes the grammar after other words (echo "[REPORT] ...",
// printf, a sentence citing it) is not one (#29).
const anchored = (line: string): boolean => {
  const before = line.slice(0, line.indexOf("[REPORT]")).replace(/^[\s│]+/, "").trimEnd();
  return before === "" || /--text["']?(?:\s*,)?\s*["']?$/.test(before);
};

// A report the agent UI wrapped over several lines continues until the next blank line.
export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = reportGrammar(key);
  const lines = screen.split("\n");
  const at = lines.findLastIndex((l) => grammar.test(l) && anchored(l));
  if (at < 0) return null;
  const parts = [lines[at]?.slice(lines[at]?.indexOf("[REPORT]")) ?? ""];
  for (const l of lines.slice(at + 1, at + 8)) {
    if (!l.trim() || l.includes("[REPORT]")) break;
    parts.push(l);
  }
  return parts.map((p) => p.trim()).join(" ").replace(/["'\])\s,]+$/, "");
};

// A report a lane typed into the lead (dori type) is a user message of the lead's transcript, whole and unwrapped, while
// the lead's screen is omo's alternate screen: tmux keeps no history there, so a report is gone from it once omo's tail
// under a turn fills the rows. The newest one counts, its first line only (the evidence sits below it); a line the lead
// wrote or a [DORI] note quoting a report is not one.
export const transcriptReport = (lines: readonly string[], key: string): string | null => {
  const head = `[REPORT] ${key} |`;
  const grammar = reportGrammar(key);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.includes(head)) continue;
    let said = "";
    try {
      const o = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
      if (o.message?.role !== "user") continue;
      const c = o.message.content;
      said = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("\n") : "";
    } catch {
      continue;
    }
    const hit = said.split("\n").findLast((l) => l.trimStart().startsWith(head) && grammar.test(l));
    if (hit) return hit.trim();
  }
  return null;
};
