const READ_API = /\b(?:Bun\.file|readFileSync|readFile|createReadStream|openSync|tool\.read)\s*\(/;
// A shell command reading an interpolated path; a bare pipe reads no file.
const SHELL_VAR = /(?:^|[\n;&|(`"']|\$\()\s*(?:cat|sed|head|tail|less|more|bat|nl|awk)\b[^\n;&|`]*?\s["']?\$\{/;

// A real read tool or eval/shell file read, shared by the research-start and claim-done checks.
// The default preserves research-start's existing contract.
export const skillRead = (name: string | undefined, args: unknown, skill = "ulw-research"): boolean => {
  const path = `(?<![\\w.-])${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]SKILL\\.md`;
  const skillPath = new RegExp(`${path}(?![\\w.-])`);
  const literal = new RegExp("([\"'`])(?:\\/|~|\\.|\\$\\{)[^\"'`\\s]*" + path + "\\1");
  const shell = new RegExp("(?:^|[\\n;&|(`\"']|\\$\\()\\s*(?:cat|sed|head|tail|less|more|bat|nl|awk)\\b[^\\n;&|`]*?[\\s\"'][^\\s\"';&|`]*" + path + "(?![\\w.-])");
  const a = (args ?? {}) as Record<string, unknown>;
  if (name?.toLowerCase() === "read") return [a["path"], a["file_path"], a["filePath"]].some((p) => typeof p === "string" && skillPath.test(p));
  const code = [a["code"], a["command"], a["cmd"]].find((c): c is string => typeof c === "string");
  if (!code) return false;
  return (literal.test(code) && (READ_API.test(code) || SHELL_VAR.test(code))) || shell.test(code);
};
