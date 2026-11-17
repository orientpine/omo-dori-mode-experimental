import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Directive, Gap } from "./directives.ts";

// A directive the code enforces (owner 2026-11-16, "장부를 줄이고 검사코드로 올리는 방안"): enforced names the code that
// refuses or warns ({ by: "<file>[:<symbol>]", token: "<the refusal or warning token, or the symbol>" }). Mode code: the
// entry stays on record with his words and goes into no brief and no lead hint, because the check teaches the rule when
// it fires. Another mode with enforced (a built-in block, a require entry, a lead check) keeps its mode: its mode is the
// check. The token is looked up in the file at every ledger load: a check that is gone (its file or its token) turns a
// code entry back into inject at once, and dori directive-audit names it (DIRECTIVE_ENFORCER_GONE).

export type Enforced = { readonly by: string; readonly token: string };

// the fork checkout: a relative by is a path from its root (skills/dori-mode/scripts/src/...)
const FORK_ROOT = join(import.meta.dir, "../../../..");

const fileOf = (by: string): string => {
  const path = by.replace(/:[A-Za-z_$][\w$.]*$/, "");
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(FORK_ROOT, path);
};

// Why the check of an entry is no longer in the code, or undefined while it is.
export const enforcerGone = (enforced: Enforced): string | undefined => {
  const file = fileOf(enforced.by);
  if (!existsSync(file)) return `${file} is not there`;
  return readFileSync(file, "utf8").includes(enforced.token) ? undefined : `token ${enforced.token} is no longer in ${file}`;
};

// The entries as a launch reads them: a code entry whose check is gone is inject again, with the reason in gone.
export const withEnforcers = (entries: readonly Directive[]): Directive[] =>
  entries.map((e) => {
    if (e.mode !== "code" || !e.enforced?.by || !e.enforced.token) return e;
    const gone = enforcerGone(e.enforced);
    return gone ? { ...e, mode: "inject", gone } : e;
  });

export const enforcedProblems = (e: Directive, at: string): string[] => {
  const out: string[] = [];
  if (e.mode === "code" && !e.enforced) out.push(`${at}: a code directive needs enforced { by, token } (the check that enforces it)`);
  if (e.mode === "code" && !e.words && !e.rule) out.push(`${at}: a code directive needs words or a rule (it goes into briefs again when its check is gone)`);
  if (e.enforced === undefined) return out;
  const { by, token } = e.enforced;
  if (typeof by !== "string" || !by.trim()) out.push(`${at}: enforced.by must name the file (and symbol) of the check`);
  if (typeof token !== "string" || !/^[A-Za-z_$][\w$.-]{2,}$/.test(token)) out.push(`${at}: enforced.token must be the check's refusal or warning token (letters, digits, _ . -)`);
  if (e.layer === "common" && typeof by === "string" && (isAbsolute(by) || by.startsWith("~"))) out.push(`${at}: enforced.by of a fork entry is a path from the fork's root`);
  return out;
};

// The daily audit's line for every entry whose check is gone (a code entry is inject again until it is back).
export const enforcerGaps = (entries: readonly Directive[]): Gap[] =>
  entries.flatMap((e) => {
    const gone = e.gone ?? (e.enforced?.by && e.enforced.token ? enforcerGone(e.enforced) : undefined);
    if (!gone || !e.enforced) return [];
    const what = e.gone ? "it goes into briefs as inject again" : `it keeps mode ${e.mode}`;
    return [{ lane: "enforcer-gone", id: e.id, line: `DIRECTIVE_ENFORCER_GONE ${e.id}: ${gone} (enforced by ${e.enforced.by}); ${what} until the check is back or the ledger names the new one` }];
  });

export const enforcedLabel = (e: Directive): string | undefined =>
  e.gone ? `검사 사라짐(${e.gone})` : e.enforced ? `코드가 강제함(${e.enforced.token})` : undefined;
