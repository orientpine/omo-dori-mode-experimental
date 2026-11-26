import { expect, test } from "bun:test";

import { launchOf, missingMonitors } from "../src/handover.ts";

const HOME = "/home/test";
const rearmed = (command: string) => [{ description: "w", command, persistent: true, runtime: { pid: 7 } }];
const rejectsSameCommand = (command: string) => {
  const launch = launchOf(command, HOME, () => undefined);
  if (!launch) throw new Error(`not work: ${command}`);
  expect(missingMonitors([{ description: "w", command, persistent: true, launch }], rearmed(command), () => true, HOME, 0)).toEqual(["w (armed again with the command that starts work; arm a watch-only one instead)"]);
};

// moodori lead handover 2026-11-26 (hc:t1r, t1s, t1v): three read-only loops of the lead note fell back as LAUNCHES_WORK
// and failed the check: an inbox poll (for over literal folders, ls | md5sum, case), a weekday clock (TZ= date) and a
// remote device count (ssh, a PowerShell Get- read, tr -dc). They only read and echo, so the new session arms them again.
test("read-only loops of the moodori lead note stay watches the new session may arm again", () => {
  for (const command of [
    "seen=''; first=1; while true; do for d in ~/inbox/kaist ~/inbox/h200 ~/inbox/mail; do [ -d \"$d\" ] || continue; n=$(ls -A \"$d\" 2>/dev/null | md5sum); k=\"$d:$n\"; case \"$seen\" in *\"$k\"*) ;; *) [ -z \"$first\" ] && [ -n \"$(ls -A \"$d\")\" ] && echo \"INBOX_CHANGED $d\"; seen=\"$seen $k\";; esac; done; first=''; sleep 20; done",
    "while true; do h=$(TZ=Asia/Seoul date +%H%M); d=$(TZ=Asia/Seoul date +%u); if [ \"$d\" -le 5 ] && { [ \"$h\" = \"0830\" ] || [ \"$h\" = \"1430\" ]; }; then echo \"CARD1124_CHECK $(TZ=Asia/Seoul date +%F_%H:%M)\"; sleep 70; fi; sleep 30; done",
    "while true; do n=$(ssh -o ConnectTimeout=10 orien@100.70.29.48 'powershell -NoProfile -Command \"@(Get-PnpDevice -Class Monitor -PresentOnly -ErrorAction SilentlyContinue).Count\"' 2>/dev/null | tr -dc 0-9); if [ -n \"$n\" ] && [ \"$n\" -gt 0 ]; then echo \"MONITOR_PRESENT $n\"; break; fi; sleep 60; done",
  ]) {
    expect([command, launchOf(command, HOME, () => undefined)]).toEqual([command, undefined]);
    expect(missingMonitors([{ description: "w", command, persistent: true }], rearmed(command), () => true, HOME, 0)).toEqual([]);
  }
  // the same shapes holding work, or words the list cannot read, stay work and keep their watch
  for (const command of [
    "case x in a) bun test;; esac",
    "case x in a) echo a;& b) echo b;; esac",
    "case x in a) echo a;;& esac",
    "case x in (a) echo a;; esac",
    "case x in a) echo a",
    "case $(bun test) in a) echo a;; esac",
    "case x in $(bun test)) echo a;; esac",
    "for d in /tmp/a; do bun test; done",
    "for d in /tmp/*; do ls -A \"$d\"; done",
    "for d in $(cat /tmp/list); do ls -A \"$d\"; done",
    "for d in -R /tmp; do ls \"$d\"; done",
    "for PATH in /tmp/x; do ls; done",
    "d='-R /'; ls $d",
    "d=/tmp; ls $d",
    "d=$(cat /tmp/f); ls \"$d\"",
    "for d in /tmp/a; do ls \"$d\" > /tmp/out; done",
    "ls --hyperlink=x /tmp",
    "md5sum -c /tmp/sums > /tmp/out",
    "TZ=Asia/Seoul bun test",
    "TZ=$(bun test) date",
    "LD_PRELOAD=/tmp/x.so date",
    "TZ=Asia/Seoul date -s 2026-01-01",
    "ssh host 'powershell -NoProfile -Command \"Remove-Item C:/x\"'",
    "ssh host 'powershell -NoProfile -Command \"Get-Content C:/x; Remove-Item C:/x\"'",
    "ssh host 'powershell -NoProfile -Command \"Get-ChildItem | Remove-Item\"'",
    "ssh host 'powershell -NoProfile -Command \"Get-Item $(Remove-Item C:/x)\"'",
    "ssh host 'powershell -NoProfile -File C:/x.ps1'",
    "ssh host 'powershell -NoProfile -Command \"Get-Help -Online\"'",
    "ssh host 'powershell -NoProfile -Command \"Get-Process\" -File C:/x.ps1'",
    "ssh host 'powershell -Command \"Get-Process\" & del C:\\x'",
    "tr -dc 0-9 < /tmp/a > /tmp/b",
    // review 1 of #532: an escaped word is never a reserved word, and a loop variable that also holds a state file or a
    // git hash is neither once the loop gives it another value
    "echo \"$(case esac in \\esac) bun test;; esac)\"",
    "f=\"$SENPI_MONITOR_STATE_DIR/state\"; for f in /tmp/result; do echo reset > \"$f\"; done",
    "x=$(git rev-parse --verify HEAD); for x in --output=/tmp/x; do git log $x; done",
    // review 2 of #532: a comment never starts a case pattern, and a literal variable never reaches a remote shell, which
    // reads its value as commands (H399, H400)
    "echo \"$(case echo in #) ;; esac\necho) bun test;; esac)\"\ntail -F /tmp/watch.log",
    "arg='ok; bun test'; ssh host echo \"$arg\"; tail -F /tmp/watch.log",
    "arg='ok; bun test'; node-dori-do okdori echo \"$arg\"",
    // review 3 of #532: a line continuation the lexer does not model, the shell-managed $_, and an empty loop; a literal
    // variable is trusted only inside its own for body, where the loop binds it (H403, H405)
    "echo \"$(case echo in \\\n#) ;; esac\necho) bun test;; esac)\"\ntail -F /tmp/watch.log",
    "tail -F /tmp/x.log \\\n | grep X",
    "_=safe\necho --output=/tmp/replayed\ngit log -1 \"$_\"\ntail -F /tmp/watch.log",
    "for _ in /tmp/a; do echo --output=/tmp/x; git log -1 \"$_\"; done",
    "for f in; do true; done\necho reset > \"$f\"\ntail -F /tmp/watch.log",
    "[ -n \"$x\" ] && d=/tmp; ls \"$d\"; tail -F /tmp/watch.log",
    "ls \"$d\"; d=/tmp; tail -F /tmp/watch.log",
    "ls \"$d\"; for d in /tmp; do true; done",
    "for d in /tmp; do true; done; ls \"$d\"",
    "for d in /tmp; do d=-R; ls \"$d\"; done",
    "for d in /tmp; do for d in -R; do true; done; ls \"$d\"; done",
    "echo \"a\\\nb\"; tail -F /tmp/watch.log",
    // dori challenge of plan-r3: an assignment in a case arm may not run, so it makes no state file or hash
    "case no in\n  yes) f=\"$SENPI_MONITOR_STATE_DIR/x\";;\nesac\necho reset > \"$f\"",
    "case no in yes) x=$(git rev-parse --verify HEAD);; esac; git log -1 $x",
  ]) rejectsSameCommand(command);
});
