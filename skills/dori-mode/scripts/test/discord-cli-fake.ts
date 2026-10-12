// HTTP boundary fake for CLI subprocesses; thread state survives separate commands.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.env.DORI_TEST_HTTP ?? "";
type State = { name: string; archived: boolean; calls: { method: string; path: string; body: Record<string, unknown> }[] };
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const state: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { name: "", archived: false, calls: [] };
  const path = String(input).replace("https://discord.com/api/v10", "");
  const method = init?.method ?? "GET";
  const body: Record<string, unknown> = JSON.parse(String(init?.body ?? "{}"));
  state.calls.push({ method, path, body });
  let result: unknown = {};
  if (method === "POST" && path.endsWith("/threads")) {
    state.name = String(body.name);
    result = { id: "300000000000000003" };
  } else if (method === "GET" && path === "/channels/300000000000000003") {
    result = { name: state.name, thread_metadata: { archived: state.archived } };
  } else if (method === "PATCH" && path === "/channels/300000000000000003") {
    if (typeof body.name === "string") state.name = body.name;
    if (typeof body.archived === "boolean") state.archived = body.archived;
  } else if (method === "POST" && path.endsWith("/messages")) result = { id: "900" };
  else if (method !== "POST" || !path.endsWith("/typing")) throw new Error(`unexpected Discord request: ${method} ${path}`);
  writeFileSync(file, JSON.stringify(state));
  return Response.json(result);
}, { preconnect: () => {} });
