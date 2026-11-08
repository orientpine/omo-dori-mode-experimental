// From upstream dori-superagent test/fake.ts (https://github.com/sisyphuslabs/dori-superagent/blob/7ac0ed761dfb6aa0b3a81e8740a29cde5cbd0444/test/fake.ts): only its
// herdr pane World, the recorder the runtime tests drive; the harness deps, store and usage recorders stay upstream.
import type { Exec } from "../src/runtime/exec.ts";
import type { AgentStatus } from "../src/runtime/types.ts";

/**
 * `screen` is what `pane read` returns; undefined makes the read fail. `agent` is the agent name `pane get` reports
 * (default "pi"), `pgid` the foreground process group `pane process-info` reports (default 101).
 */
type Pane = {
  status: AgentStatus;
  received: string[];
  ran: string[];
  screen?: string | undefined;
  foreground?: string | { name: string; argv: string[] }[] | undefined;
  agent?: string;
  pgid?: number;
};

export class World {
  panes = new Map<string, Pane>();
  calls: { cmd: string; argv: readonly string[] }[] = [];
  next = 1;
  /** pane id -> herdr error text returned by `agent prompt` (exit 1) */
  promptFails = new Map<string, string>();
  /** pane id -> called with the 1-based count of `pane get` calls for that pane, before it answers */
  getHook = new Map<string, (n: number) => void>();
  private gets = new Map<string, number>();
  /** `pane process-info` fails (exit 1) for every pane */
  processInfoFails = false;
  /** number of upcoming `pane send-keys` calls that fail (exit 1) */
  keyFails = 0;

  addPane(id: string, status: AgentStatus = "idle"): Pane {
    const p = { status, received: [], ran: [] };
    this.panes.set(id, p);
    return p;
  }

  exec: Exec = async (cmd, argv) => {
    this.calls.push({ cmd, argv });
    if (cmd !== "herdr") return { code: 1, stdout: "", stderr: `unhandled ${cmd}` };
    const ok = (result: unknown) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
    const [group, verb, id] = argv;
    if (group === "pane" && verb === "process-info") {
      const target = this.panes.get(String(argv[3]));
      if (!target || this.processInfoFails) return { code: 1, stdout: "", stderr: "process-info failed" };
      const fg = target.foreground ?? (target.status === "shell" ? "-bash" : "omo");
      const procs = typeof fg === "string" ? [{ name: fg, argv: [fg] }] : fg;
      return ok({
        process_info: {
          pane_id: argv[3],
          shell_pid: 100,
          foreground_process_group_id: target.pgid ?? 101,
          foreground_processes: procs.map((x, i) => ({ ...x, pid: 101 + i })),
        },
      });
    }
    if ((group === "tab" || group === "workspace") && verb === "create") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ root_pane: { pane_id: pane, tab_id: `w1:t${this.next}`, workspace_id: "w1" } });
    }
    if (group === "pane" && verb === "split") {
      const pane = `w1:p${++this.next}`;
      this.addPane(pane, "shell");
      return ok({ pane: { pane_id: pane, tab_id: "w1:t1", workspace_id: "w1" } });
    }
    const pane = id ? this.panes.get(id) : undefined;
    if (!pane) return { code: 1, stdout: "", stderr: `pane_not_found ${id}` };
    if (group === "pane" && verb === "get") {
      const n = (this.gets.get(id!) ?? 0) + 1;
      this.gets.set(id!, n);
      this.getHook.get(id!)?.(n);
      return ok({
        pane: { pane_id: id, agent: pane.status === "shell" ? null : (pane.agent ?? "pi"), agent_status: pane.status },
      });
    }
    if (group === "pane" && verb === "read") {
      return pane.screen === undefined
        ? { code: 1, stdout: "", stderr: "read failed" }
        : { code: 0, stdout: pane.screen, stderr: "" };
    }
    if (group === "pane" && verb === "run") {
      pane.ran.push(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "send-text") {
      pane.received.push(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "send-keys") {
      if (this.keyFails > 0) {
        this.keyFails--;
        return { code: 1, stdout: "", stderr: "key press failed" };
      }
      return ok({});
    }
    if (group === "agent" && verb === "prompt") {
      const fail = this.promptFails.get(id!);
      if (fail) return { code: 1, stdout: "", stderr: fail };
      pane.received.push(String(argv[3]));
      return ok({});
    }
    if (group === "pane" && verb === "close") {
      this.panes.delete(id!);
      return ok({});
    }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };
}
