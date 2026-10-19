// A text typed as "line one\nline two" inside shell double quotes reaches dori as a backslash and an n, and Discord shows
// those two characters instead of a line break (2026-10-19, GongDori's post in the E7 thread, 1561758859717115997). A text
// with no real line break that still holds a literal \n outside code is refused before anything is sent; \n inside a code
// block or inline code is meant as written, and a text that already has real line breaks is taken as it is.
export const literalNewlineProblem = (text: string): string | undefined => {
  if (text.includes("\n")) return undefined;
  const outsideCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  if (!outsideCode.includes("\\n")) return undefined;
  return "the text has a literal \\n (a backslash and an n) and no real line break, so the reader would see those two characters; write the text with real line breaks into a file and send it with --text-file FILE";
};
