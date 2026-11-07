// Serves the patched doriterm web build (build.sh) on loopback with the headers its own _headers file gives the hosted
// app: the same CSP (scripts from this origin only, connections to this origin and the public relay), no-store on the
// shell, immutable hashed assets. Unknown paths get index.html (the app routes /pair and the rest itself).
import { join, normalize } from "node:path";

type Rule = { readonly pattern: string; readonly headers: readonly (readonly [string, string])[]; readonly unset: readonly string[] };

export function parseHeaders(text: string): Rule[] {
  const rules: { pattern: string; headers: [string, string][]; unset: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ pattern: line.trim(), headers: [], unset: [] });
    else if (rules.length > 0) {
      const rule = rules[rules.length - 1]!;
      const body = line.trim();
      if (body.startsWith("! ")) rule.unset.push(body.slice(2).trim().toLowerCase());
      else {
        const colon = body.indexOf(":");
        if (colon > 0) rule.headers.push([body.slice(0, colon).trim(), body.slice(colon + 1).trim()]);
      }
    }
  }
  return rules;
}

const matches = (pattern: string, path: string) =>
  pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;

/** Cloudflare's order: every matching rule in file order; a later `! Name` drops what an earlier one set. */
export function headersFor(rules: readonly Rule[], path: string): Headers {
  const headers = new Headers();
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    for (const name of rule.unset) headers.delete(name);
    for (const [name, value] of rule.headers) headers.set(name, value);
  }
  return headers;
}

export async function handler(dist: string): Promise<(req: Request) => Promise<Response>> {
  const rules = parseHeaders(await Bun.file(join(dist, "_headers")).text());
  return async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const relative = normalize(path.endsWith("/") ? `${path}index.html` : path);
    const inside = !relative.startsWith("..") && relative !== "/_headers";
    let file = inside ? Bun.file(join(dist, relative)) : null;
    let served = path;
    if (file === null || !(await file.exists())) {
      file = Bun.file(join(dist, "index.html"));
      served = "/";
    }
    return new Response(file, { headers: headersFor(rules, served === "/" ? path : served) });
  };
}

if (import.meta.main) {
  const dist = process.argv[2] ?? `${process.env.HOME}/.local/share/doriterm-web/current`;
  const port = Number(process.env.DORITERM_WEB_PORT ?? 7780);
  Bun.serve({ hostname: "127.0.0.1", port, fetch: await handler(dist) });
  console.log(`doriterm web: ${dist} on http://127.0.0.1:${port}`);
}
