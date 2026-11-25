import { expect, test } from "bun:test";
import { terminal } from "./fake-hc.ts";
import { rig, T1 } from "./hc-rig.ts";

const WRAPPER = 'sh -c . "$0" /w/omo-linux.sh --append-system-prompt /w/prompt';
const login = "900 900 950 pts/10 -zsh";
const front = (args: string) => `950 950 950 pts/10 ${args}`;
const missing = terminal({ foreground: null });

test.each([
  ["an executable in the foreground job", [login, front("/bin/omo --resume"), "951 950 950 pts/11 -zsh"]],
  ["a launcher that runs its $0", [login, front(WRAPPER)]],
  ["an executable that is the terminal root", ["900 900 900 pts/10 /bin/omo-linux"]],
])("when hc omits foreground, %s permits delivery", async (_, rows) => {
  const { fake, rt } = rig({ t1: missing });
  fake.knobs.ps = rows.join("\n");
  expect((await rt.deliver(T1, "next")).kind).toBe("delivered");
  expect(fake.sent).toEqual([{ id: "t1", text: "next" }]);
});

test.each([
  ["a suspended agent", ["900 900 900 pts/10 -zsh", "950 950 900 pts/10 /bin/omo"]],
  ["an agent on another tty", [login, "950 950 950 pts/11 /bin/omo"]],
  ["an interactive shell in the foreground group", [login, front(WRAPPER), "951 950 950 pts/10 bash"]],
  ["an editor with an agent-like filename", [login, front("vim /w/omo.md")]],
  ["a shell reading an agent-like filename", [login, front("sh -c tail -f /var/log/omo-2026.log")]],
  ["a shell editing the $0 argument", [login, front('sh -c vim "$0" /w/omo.md')]],
  ["a shell printing the $0 argument", [login, front("sh -c echo $0 /w/omo-linux.sh")]],
  ["no terminal", ["900 900 -1 ? /bin/omo"]],
  ["a missing root", [front(WRAPPER)]],
  ["an empty group", [login]],
  ["a failed ps", undefined],
] as const)("when hc omits foreground, %s holds delivery", async (_, rows) => {
  const { fake, rt } = rig({ t1: missing });
  if (rows !== undefined) fake.knobs.ps = rows.join("\n");
  expect(await rt.deliver(T1, "next")).toEqual({ kind: "no-agent" });
  expect(fake.sent).toEqual([]);
});

test("a shell hc names is authoritative even if ps shows the agent", async () => {
  const { fake, rt } = rig({ t1: terminal({ foreground: { name: "zsh", argv: ["-zsh"], pid: 900 } }) });
  fake.knobs.ps = [login, front(WRAPPER)].join("\n");
  expect(await rt.deliver(T1, "next")).toEqual({ kind: "no-agent" });
  expect(fake.sent).toEqual([]);
});
