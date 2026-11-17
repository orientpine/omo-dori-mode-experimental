import { ownerText } from "./owner-text-warning.ts";

// Only the repeated announcement is checkable here; rollout verification, batching and a single final report still need the directive.
export const updateNoticeProblem = (text: string, maintainer: boolean): string | undefined => {
  if (maintainer) return undefined;
  const prose = ownerText(text);
  const marked = /^[ \t]*\[UPDATE\][ \t]+\S/m.test(prose);
  // announceChange's guidance and restart/config headings also identify a forwarded notice whose marker was removed.
  const shape = /^Changed guidance:[ \t]*$/m.test(prose) && /^(?:Restarts:[ \t]*$|CONFIG_NEW_KEY:[ \t]*\S)/m.test(prose);
  return marked || shape ? "non-maintainer update summary to its own owner channel" : undefined;
};
