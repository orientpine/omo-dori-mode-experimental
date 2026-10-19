import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane, LaunchError, RelatedThreadError, relatedFor, ThreadMissingError, type LaunchInput } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

// The 10-19 cases with made-up names: three lanes of one fix in one thread, three install guides (mac, then Linux, then
// Windows) that each opened a thread, and a migration step that opened a new thread instead of the work thread its plan
// is in.
const NOW = Date.parse("2026-01-02T03:00:00.000Z");
const MIN = 60_000;
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();
const BRIDGE = "discord:200000000000000001";
const MAC = "discord:200000000000000002";
const WORK = "discord:200000000000000003";
const OLD = "discord:200000000000000004";
const BOARD = "discord:200000000000000005";
const LINUX = "discord:200000000000000006";
const CHANNEL = "100000000000000009";

type Seed = Omit<Lane, "brief" | "done" | "openedAt"> & { readonly text: string; readonly opened: number; readonly closed?: number };
const seeds: readonly Seed[] = [
  { key: "bridge-fix", title: "교량 시뮬레이터: 정 소장 지적 3가지 고치고 GUI로 확인·사진", thread: BRIDGE, cwd: "/work", opened: 120, closed: 40, text: "[목표] 정 소장(가온설계)이 지적한 교량 시뮬레이터 3가지(TEST1 json 가져오기, 거더 위치 표, BIM 가져오기)를 고치고 GUI로 확인해 사진을 찍는다.\n[끝난 상태] ~/.dori/qa/bridge-fix/REPORT.md 와 PR 머지." },
  { key: "bridge-mail-old", title: "정 소장 메일·교량 시뮬레이터 검토", thread: OLD, cwd: "/work", opened: 3000, closed: 2900, text: "[목표] 정 소장 메일의 교량 시뮬레이터 질문에 답할 초안을 만든다." },
  { key: "bridge-note", title: "교량 시뮬레이터 메모", thread: `discord:${CHANNEL}`, cwd: "/work", opened: 60, text: "[목표] 교량 시뮬레이터 거더 위치 표 메모." },
  { key: "app-mac-guide", title: "김 박사님 맥 누리앱 설치 안내문", thread: MAC, cwd: "/app", opened: 160, closed: 120, text: "[목표] 옥돌이 카톡으로 김 박사님(맥 사용자)께 누리앱(공개 설치본) 설치를 단계별로 안내할 수 있게 맥 설치 안내문을 만든다.\n[끝난 상태] ~/.dori/qa/app-mac-guide/MAC-GUIDE.md: 카톡에 한 단계씩 붙일 짧은 단계(Homebrew, 저장소 받기, 서명 확인, --dry-run, wizard)." },
  { key: "migrate-plan", title: "누리앱 → 도리 이전 계획", thread: WORK, cwd: "/app", opened: 1500, closed: 1200, text: "[목표] 누리앱 기능을 모두 목록으로 만들고 도리 기반으로 옮기는 이전 계획을 세운다." },
  { key: "port-audit", title: "누리앱 서비스 이식 전수 확인", thread: WORK, cwd: "/app", opened: 900, closed: 180, text: "[목표] 노드의 서비스가 도리로 빠짐없이 이식되었는지 확인하고 ~/.dori/qa/port-audit/MAIN-PLAN.md 에 이전 단계 계획을 쓴다." },
  { key: "release-timers", title: "도리 이전 P2: cron → 타이머 릴리스", thread: WORK, cwd: "/app", status: "working", opened: 700, text: "[목표] cron 작업을 사용자 타이머로 옮겨 다음 릴리스에 넣는다." },
  { key: "gate-gaps", title: "유돌 통로 빠진 기능 6개(메일 전달·공유 메일·위키)", thread: WORK, cwd: "/app", status: "working", opened: 600, text: "[목표] 유돌 통로에 빠진 메일 전달, 공유 메일, 위키 기능을 넣는다." },
  { key: "board-serve", title: "세션 현황판 상시 서비스", thread: BOARD, cwd: "/home", status: "working", opened: 90, text: "[목표] 세션 현황판을 테일스케일 주소로 늘 켜 둔다." },
  { key: "eth-baseline", title: "기준선 대비 개선 실험", thread: "none", cwd: "/rl", opened: 9000, closed: 8000, text: "[목표] 강화학습 기준선 대비 개선을 실험한다." },
  { key: "digest-emoji", title: "다이제스트 이모지 즉시 반응", thread: "none", cwd: "/app", opened: 9000, closed: 8500, text: "[목표] 메일 다이제스트에 이모지를 바로 단다." },
  { key: "state-git", title: "도리 상태 파일 깃 관리", thread: "none", cwd: "/home", opened: 9000, closed: 8600, text: "[목표] 도리 상태 파일을 로컬 깃으로 관리한다." },
];

let state: ReturnType<typeof withState>;
let world: World;
let opened: string[];
let warned: string[];

const deps = (): FlowDeps => ({
  ...depsFor(world, fakeClock(NOW), state.dir, { backend: "aoe", leadPane: "aoe_Dori_0a1b2c3d", watchLog: join(state.dir, "watch.log") }),
  channels: [CHANNEL],
  openThread: async (title: string) => (opened.push(title), "discord:200000000000000099"),
});

const seed = async (s: Seed): Promise<void> => {
  const brief = join(state.dir, "briefs", `${s.key}.md`);
  await Bun.write(brief, `ulw\n\n${s.text}\n`);
  const { text: _text, opened: o, closed, ...lane } = s;
  await deps().registry.write({ ...lane, brief, done: "merged acme/app#1", openedAt: ago(o), ...(closed === undefined ? {} : { status: "closed", closedAt: ago(closed) }) });
};

const input = async (key: string, title: string, text: string, extra: Partial<LaunchInput> = {}): Promise<LaunchInput> => {
  const brief = join(state.dir, `${key}.md`);
  await Bun.write(brief, `ulw\n\n${text}\n`);
  return { key, title, brief, done: "merged acme/app#2", thread: "new", ...extra };
};

beforeEach(async () => {
  state = withState();
  world = newWorld();
  opened = [];
  warned = [];
  for (const s of seeds) await seed(s);
});
afterEach(() => state.done());

const threadsOf = async (i: LaunchInput) => (await relatedFor(deps(), i)).map((t) => t.thread);

test("the next lane of the same fix is shown the thread the fix is in; an old thread and a channel are not offered", async () => {
  const i = await input("bridge-exe-reply", "정 소장 회신: 고친 교량 시뮬레이터 새 exe + 메일 초안", "[목표] 정 소장(가온설계)께 보낼, 지적 3건을 고친 교량 시뮬레이터 새 윈도우 실행 파일과 회신 메일 초안을 만든다.\n[끝난 상태] ~/.dori/qa/bridge-exe-reply/REPORT.md: 빌드, zip, 사용 안내(TEST1 json 가져오기, 거더 위치 표, BIM 가져오기).", { cwd: "/work" });
  expect(await threadsOf(i)).toEqual([BRIDGE]);
});

test("an owner message the brief links that is in a lane's thread puts that thread first, above closer words", async () => {
  const text = "[목표] 정 소장(가온설계)이 보낸 pptx를 검토해 교량 시뮬레이터를 더 고치고(거더 위치 표, BIM 가져오기) GUI 사진과 회신 초안을 다시 만든다.\n형 원문: https://discord.com/channels/1/200000000000000005/300000000000000001";
  const found = await relatedFor(deps(), await input("bridge-pptx", "정 소장 pptx 검토 → 교량 시뮬레이터 추가 수정", text));
  expect(found.map((t) => t.thread)).toEqual([BOARD, BRIDGE]);
  expect(found[0]?.link).toBe(2);
  expect(found[0]?.reasons[0]).toBe("owner message 200000000000000005/300000000000000001 the brief links is in this thread");
});

test("an owner message the brief links in an older thread brings that thread back, though its lanes closed long ago", async () => {
  const text = "[목표] 정 소장 메일에 답한다.\n형 원문: https://discord.com/channels/1/200000000000000004/300000000000000002";
  const found = await relatedFor(deps(), await input("bridge-mail-new", "정 소장 메일 답장", text));
  expect(found[0]?.thread).toBe(OLD);
  expect(found[0]?.link).toBe(2);
});

test("the second install guide is shown the first one's thread, the third both guides' threads", async () => {
  const linux = await input("app-linux-guide", "이 박사님 리눅스 누리앱 설치 + 무도리 안내문", "[목표] 옥돌이 카톡으로 이 박사님(리눅스)께 누리앱(공개 설치본) 설치와 무도리 역할로 쓰는 법을 한 단계씩 안내할 리눅스 안내문을 만든다.\n[끝난 상태] ~/.dori/qa/app-linux-guide/LINUX-GUIDE.md: 카톡에 한 단계씩 붙일 짧은 단계(apt, 저장소 받기, 서명 확인, --dry-run, wizard).", { cwd: "/app" });
  expect(await threadsOf(linux)).toEqual([MAC]);
  await seed({ key: "app-linux-guide", title: linux.title, thread: LINUX, cwd: "/app", opened: 50, closed: 30, text: await Bun.file(linux.brief).text() });
  const win = await input("app-win-guide", "박 박사님 윈도우(WSL2) 누리앱 + 무도리 안내문", "[목표] 옥돌이 카톡으로 박 박사님(윈도우)께 누리앱(공개 설치본)을 WSL2에서 쓰는 법과 무도리 역할로 쓰는 법을 한 단계씩 안내할 윈도우 안내문을 만든다.\n[끝난 상태] ~/.dori/qa/app-win-guide/WIN-GUIDE.md: 카톡에 한 단계씩 붙일 짧은 단계(WSL2, apt, 서명 확인, --dry-run, 무도리 wizard).", { cwd: "/app" });
  expect((await threadsOf(win)).sort()).toEqual([MAC, LINUX].sort());
});

test("a migration step that uses the plan in another lane's QA folder is shown that lane's work thread", async () => {
  const i = await input("gate-step", "이전 1단계: 게이트 하나로 — 설계·코드 준비", "[목표] 이전 1단계 '게이트 하나로'를 준비한다: 열쇠를 노드 게이트 하나로 모으는 설계·코드·시험.\n[넘으면 안 되는 선] 이전 계획 ~/.dori/qa/port-audit/MAIN-PLAN.md 의 1단계 범위만, release-timers 와 겹치는 파일은 맞춰서.", { cwd: "/app" });
  const found = await relatedFor(deps(), i);
  expect(found.map((t) => t.thread)).toEqual([WORK]);
  expect(found[0]?.reasons).toContain("the brief uses ~/.dori/qa/port-audit/ of lane port-audit");
  expect(found[0]?.reasons).toContain("the brief names lane release-timers");
});

test("unrelated work is shown nothing and --thread new opens its thread as before", async () => {
  const i = await input("ckpt-prune", "학습 체크포인트 정리", "[목표] 학습 체크포인트 폴더에서 일주일 넘은 파일을 지우고 남은 용량을 적는다.", { cwd: "/rl" });
  expect(await threadsOf(i)).toEqual([]);
  const r = await launchLane(deps(), i, (l) => warned.push(l));
  expect(opened).toEqual(["학습 체크포인트 정리"]);
  expect(r.lane.thread).toBe("discord:200000000000000099");
  expect(warned.some((l) => l.startsWith("LAUNCH_RELATED_THREAD"))).toBe(false);
});

const related = () => input("app-linux-guide", "이 박사님 리눅스 누리앱 설치 안내문", "[목표] 옥돌이 카톡으로 이 박사님께 누리앱(공개 설치본) 설치를 한 단계씩 안내할 리눅스 설치 안내문을 만든다.", { cwd: "/app" });

test("--thread new with a related open thread is refused with LAUNCH_RELATED_THREAD lines: nothing opened, written or registered", async () => {
  const i = await related();
  const e = await launchLane(deps(), i).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(RelatedThreadError);
  expect(e).toBeInstanceOf(ThreadMissingError);
  const lines = (e as Error).message.split("\n");
  expect(lines[0]).toStartWith(`LAUNCH_RELATED_THREAD app-linux-guide ${MAC} 1/1 "김 박사님 맥 누리앱 설치 안내문" (score `);
  expect(lines).toContain("  - lanes there: app-mac-guide (closed 2 h ago)");
  expect(lines.at(-1)).toStartWith(`LAUNCH_RELATED_THREAD_CHOOSE app-linux-guide: nothing was opened. Continue the work in its thread: --thread ${MAC}.`);
  expect(opened).toEqual([]);
  expect(world.calls).toEqual([]);
  expect(await deps().registry.read("app-linux-guide")).toBeNull();
  expect(await Bun.file(i.brief).text()).toStartWith("ulw\n\n[목표]");
  expect(await Bun.file(join(state.dir, "watch.log")).text()).toMatch(/^\S+ launch LAUNCH_RELATED_THREAD app-linux-guide /m);
});

test("--why-new opens the new thread anyway and keeps the reason; --thread <ref> is not looked at", async () => {
  const r = await launchLane(deps(), { ...(await related()), whyNew: "another product's guide" }, (l) => warned.push(l));
  expect(opened).toHaveLength(1);
  expect((await deps().registry.read("app-linux-guide"))?.whyNew).toBe("another product's guide");
  expect(warned).toContain(`LAUNCH_NEW_THREAD_WHY app-linux-guide: a new thread though 1 related open thread(s) were found (${MAC}), on the lead's word: another product's guide`);
  expect(r.lane.thread).toBe("discord:200000000000000099");
  const joined = await launchLane(deps(), { ...(await related()), key: "app-linux-guide2", thread: MAC });
  expect(joined.lane.thread).toBe(MAC);
  expect(opened).toHaveLength(1);
});

test("--why-new needs a reason and goes with --thread new only; the thread rules before it are unchanged", async () => {
  for (const extra of [{ whyNew: "  " }, { whyNew: "why", thread: MAC }] as const) {
    const e = await launchLane(deps(), { ...(await related()), ...extra }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LaunchError);
    expect(e).not.toBeInstanceOf(ThreadMissingError);
  }
  const none = await launchLane(deps(), { ...(await related()), thread: undefined }).catch((x: unknown) => x);
  expect((none as Error).message).toStartWith("LAUNCH_NO_THREAD app-linux-guide: ");
  const channel = await launchLane(deps(), { ...(await related()), thread: `discord:${CHANNEL}` }).catch((x: unknown) => x);
  expect((channel as Error).message).toStartWith(`LAUNCH_THREAD_IS_CHANNEL app-linux-guide: discord:${CHANNEL} is a channel`);
  expect(opened).toEqual([]);
  expect(world.calls).toEqual([]);
});
