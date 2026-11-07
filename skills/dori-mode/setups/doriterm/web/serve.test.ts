import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handler } from "./serve.ts";

const HEADERS = `# comment
/*
  Cache-Control: public, max-age=0, must-revalidate, no-transform
  Content-Security-Policy: default-src 'none'; connect-src 'self' wss://relay-doriface.omo.dev

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`;
let dist = "";
let serve: (req: Request) => Promise<Response>;
beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "doriterm-web-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "_headers"), HEADERS);
  writeFileSync(join(dist, "index.html"), "<!doctype html>app");
  writeFileSync(join(dist, "assets", "index-abc.js"), "js");
  serve = await handler(dist);
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));
const get = (path: string) => serve(new Request(`http://127.0.0.1${path}`));

test("the shell carries the hosted app's CSP and revalidates", async () => {
  const res = await get("/");
  expect(await res.text()).toBe("<!doctype html>app");
  expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' wss://relay-doriface.omo.dev");
  expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate, no-transform");
});

test("a hashed asset is immutable and keeps the CSP", async () => {
  const res = await get("/assets/index-abc.js");
  expect(await res.text()).toBe("js");
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("content-security-policy")).not.toBeNull();
});

test("a client route such as /pair gets the shell", async () => {
  expect(await (await get("/pair")).text()).toBe("<!doctype html>app");
});

test("_headers and paths outside the build are not served", async () => {
  expect(await (await get("/_headers")).text()).toBe("<!doctype html>app");
  expect(await (await get("/../../etc/passwd")).text()).toBe("<!doctype html>app");
  expect(await (await get("/..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fhostname")).text()).toBe("<!doctype html>app");
});
