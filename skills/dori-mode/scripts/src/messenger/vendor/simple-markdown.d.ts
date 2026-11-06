// The part of simple-markdown.js (vendored, MIT) that discord-markdown.ts uses.
export type Capture = RegExpExecArray;
export type State = { inline?: boolean; [key: string]: unknown };
export type NestedParse = (source: string, state: State) => unknown[];
export type Rule = {
  order: number;
  match: (source: string, state: State, prevCapture: string) => Capture | null;
  quality?: (capture: Capture, state: State, prevCapture: string) => number;
  parse: (capture: Capture, parse: NestedParse, state: State) => unknown;
};
declare const SimpleMarkdown: {
  parserFor: (rules: Record<string, Rule>, defaultState?: State) => (source: string, state?: State) => unknown[];
  defaultRules: Record<"escape" | "autolink" | "mailto" | "url" | "link" | "em" | "strong" | "u" | "del" | "inlineCode" | "br" | "text", Rule>;
  inlineRegex: (regex: RegExp) => Rule["match"];
};
export default SimpleMarkdown;
