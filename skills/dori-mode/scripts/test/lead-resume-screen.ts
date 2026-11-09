// What herdr showed for a real omo SIGSTOPped in a real pane (0.9.5, 2026-11-09): bash printed its job line and prompt
// over omo's screen, and omo's last status line stays below the prompt.
export const screenWith = (promptLine: string): string => ["────────", "❯", "[1]+  Stopped                 omo────────", promptLine, "(😺 OmO Native by Q Kim) done", ""].join("\n");
export const RESIDUE = "\u001b[0m\u001b[1m\u001b[38;5;2msoodori@ori0a83\u001b[0m:\u001b[0m\u001b[1m\u001b[38;5;4m/tmp\u001b[0m$ \u001b[0m\u001b[38;2;103;113;118mto)\u001b[0m        \u001b[0m\u001b[38;2;103;113;118m(anthropic-subscription) \u001b[0m\r";
export const AT_PROMPT = screenWith("soodori@ori0a83:/tmp$");
