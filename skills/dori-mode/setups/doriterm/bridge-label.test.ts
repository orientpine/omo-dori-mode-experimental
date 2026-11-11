import { expect, test } from "bun:test";
import { bridgeCommand, ensureBridges, stopBridges } from "./bridge.ts";
import type { Runner } from "../../scripts/src/run.ts";

type Row = {
  readonly address: string;
  readonly name: string;
  readonly argv: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  state: string;
};
const bridge = { name: "zzangdori" };
const labels = { "dori.doriterm": "bridge", "dori.row": bridge.name };
const foreign = (name: string, address = "t1"): Row => ({ address, name, argv: ["sleep", "600"], labels: {}, state: "live" });

// Stateful hc boundary: ls deliberately omits argv AND labels, as the real 0.1.18 binary does.
function core(initial: readonly Row[] = [], lanes: { key: string; terminal: string }[] = []) {
  const rows = [...initial];
  const run: Runner = async (args) => {
    if (args[0] === "/bin/sh") return { code: 0, out: JSON.stringify(lanes), err: "" };
    let out = "";
    switch (args[1]) {
      case "ls": {
        const filters = args.flatMap((a, i) => a === "--label" ? [args[i + 1] ?? ""] : []);
        out = JSON.stringify({ terminals: rows.filter((r) => filters.every((f) => {
          const [k = "", v] = f.split("=");
          return r.labels[k] === v;
        })).map(({ address, name, state }) => ({ address, name, state })) });
        break;
      }
      case "get":
        out = JSON.stringify(rows.find((r) => r.address === args[3]));
        break;
      case "run": {
        const separator = args.indexOf("--");
        const name = args[args.indexOf("--name") + 1] ?? "";
        if (rows.some((r) => r.name === name && r.state === "live")) return { code: 1, out: "", err: "name held" };
        const entries = args.slice(0, separator).flatMap((a, i) => a === "--label" ? [args[i + 1] ?? ""] : []);
        rows.push({ address: `t${rows.length + 10}`, name, argv: args.slice(separator + 1), labels: Object.fromEntries(entries.map((f) => f.split("="))), state: "live" });
        break;
      }
      case "kill": {
        const row = rows.find((r) => r.address === args[2]);
        if (row) row.state = "finished";
        break;
      }
      case "rm": {
        const index = rows.findIndex((r) => r.address === args[2]);
        if (index >= 0) rows.splice(index, 1);
        break;
      }
      default:
        throw new Error(`unexpected hc call ${args.join(" ")}`);
    }
    return { code: 0, out, err: "" };
  };
  return { rows, run, lanes };
}

test("new bridges carry ownership and row labels", async () => {
  const hc = core();
  await ensureBridges(hc.run, [bridge]);
  expect(hc.rows.map((r) => ({ name: r.name, labels: r.labels, argv: r.argv }))).toEqual([
    { name: bridge.name, labels, argv: bridgeCommand(bridge) },
  ]);
});

test.each(["zzangdori", "a".repeat(32)])("a foreign holder of %s survives while a labeled fallback row stays visible across timer runs", async (name) => {
  const own = { name };
  const lane = foreign(name);
  const fallback = `${name.slice(0, 28)}-row`;
  const hc = core([lane, foreign(fallback, "t2")]);
  await ensureBridges(hc.run, [own]);
  await ensureBridges(hc.run, [own]);
  expect(hc.rows.map((r) => r.name)).toEqual([name, fallback, `${name.slice(0, 26)}-row-2`]);
  expect(hc.rows[2]?.labels).toEqual({ ...labels, "dori.row": name });
  await stopBridges(hc.run, [own]);
  expect(hc.rows).toEqual([lane, foreign(fallback, "t2")]);
});

test("a bridge found by its row label is kept and stopped even under an unrelated name", async () => {
  const row: Row = { ...foreign("renamed"), argv: bridgeCommand(bridge), labels };
  const hc = core([row]);
  await ensureBridges(hc.run, [bridge]);
  expect(hc.rows).toEqual([row]);
  await stopBridges(hc.run, [bridge]);
  expect(hc.rows).toEqual([]);
});

test("labels without the exact command never grant bridge ownership", async () => {
  const lane = { ...foreign("zzangdori"), labels };
  const hc = core([lane]);
  await ensureBridges(hc.run, [bridge]);
  expect(hc.rows.map((r) => r.name)).toEqual(["zzangdori", "zzangdori-row"]);
  await stopBridges(hc.run, [bridge]);
  expect(hc.rows).toEqual([lane]);
});

test("open hc lanes get distinct labeled rows even when sanitized names collide", async () => {
  const hc = core([], [{ key: "work.one", terminal: "t7" }, { key: "work-one", terminal: "t8" }]);
  await ensureBridges(hc.run, [bridge]);
  expect(hc.rows.map((r) => ({ name: r.name, argv: r.argv, labels: r.labels }))).toEqual([
    { name: "zzangdori", argv: bridgeCommand(bridge), labels },
    { name: "zzangdori-work-one", argv: [...bridgeCommand(bridge), "", "t7"], labels: { ...labels, "dori.lane": "work.one" } },
    { name: "zzangdori-work-one-row", argv: [...bridgeCommand(bridge), "", "t8"], labels: { ...labels, "dori.lane": "work-one" } },
  ]);
});

test("a closed or ended lane row is removed while the lead and foreign labeled terminals stay live", async () => {
  const lane = { ...foreign("unrelated"), labels: { ...labels, "dori.lane": "work-one" } };
  const ended = { ...foreign("old-row", "t2"), argv: [...bridgeCommand(bridge), "", "t7"], labels: { ...labels, "dori.lane": "work-one" } };
  const hc = core([lane, ended]);
  await ensureBridges(hc.run, [bridge]);
  expect(hc.rows.map((r) => r.name)).toEqual(["unrelated", "zzangdori"]);
});

test("a lane moving to another hc terminal replaces its old row and stop removes all owned rows", async () => {
  const hc = core([], [{ key: "work-one", terminal: "t7" }]);
  await ensureBridges(hc.run, [bridge]);
  hc.lanes.splice(0, 1, { key: "work-one", terminal: "t9" });
  await ensureBridges(hc.run, [bridge]);
  expect(hc.rows.filter((r) => r.labels["dori.lane"] === "work-one").map((r) => r.argv.at(-1))).toEqual(["t9"]);
  await stopBridges(hc.run, [bridge]);
  expect(hc.rows).toEqual([]);
});
