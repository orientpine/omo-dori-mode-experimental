import type { RuntimeChoice } from "./run.ts";
import type { RelatedSettings } from "./related-thread.ts";
import type { StateGitSettings } from "./state-git.ts";
import type { SupervisionSettings } from "./supervision.ts";
import type { HeavyQueue } from "./config-heavy.ts";
import type { DiscordWords } from "./config-discord.ts";
import type { Stuck, Reviewers, MergeGate, Scorecard, Signals, Explore, AutoSignals, Handover, BacklogSettings } from "./config-workflow-types.ts";

export type UpdateService = {
  readonly unit: string;
  readonly paths: readonly string[];
  readonly log: string;
  readonly ready: string;
};
export type UpdateConfig = {
  readonly repo: string;
  readonly branch: string;
  readonly services: readonly UpdateService[];
  readonly readyTimeoutSec: number;
  readonly alertPane: string;
  readonly announce: string;
  // the maintenance Dori: its [UPDATE] from dori update ends with maintainerAnnounce instead of announce (owner 2026-11-03,
  // ledger update-notice-once: only it reports an update, once, after every Dori applied it)
  readonly maintainer: boolean;
  readonly maintainerAnnounce: string;
};

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type Backend = "herdr" | "aoe";

export type DoriConfig = {
  readonly backend: Backend;
  readonly runtime?: RuntimeChoice["kind"];
  readonly stateDir: string;
  readonly watchLog: string;
  readonly update: UpdateConfig;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  // variables every lane session starts with (aoe backend), e.g. {"CUDA_VISIBLE_DEVICES": ""} on a training node; a lane
  // launched with --use-gpu starts without them
  readonly launchEnv: Readonly<Record<string, string>>;
  // the directive ledger (src/directives.ts): common is the fork's references/directives.json (empty turns it off), local
  // the host's own file with its directives and links (empty: none); links a file of { id, source } rows another Dori
  // pushed, which only sets the source of fork entries (empty: none); linkPeers "<user>:<absolute path>" the Dori this one
  // pushes the links of its local ledger to (dori directives links --push, and freshness when the local ledger changed)
  // memory: the lead's omo memory repo dori directive-audit reads for directives kept twice (DIRECTIVE_DUPLICATE; empty:
  // the repo of a session in handover.cwd, else defaultCwd; "off": no check); dailyAudit false: the freshness loop does not
  // run the daily directive audit (another Dori audits this one, e.g. the SooDori timer soodori-daily-audit for ZzangDori);
  // pickModel: the small model dori launch asks which non-fixed entries a brief needs (empty: the scope rules decide)
  readonly directives: { readonly common: string; readonly local: string; readonly links?: string; readonly linkPeers?: readonly string[]; readonly memory?: string; readonly dailyAudit?: boolean; readonly pickModel?: string | undefined };
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  // dori watch: an idle lane waiting on background work it started (BG_WAITING) is LANE_BLOCKED idle after this long
  readonly blockedWaitMin: number;
  // dori watch: how many [LEAD] messages may lift one session's omo auto-turn pause (LANE_AUTOTURN_PAUSED) in 24 hours;
  // past it the pause is only reported, so omo's guard against an endless self-driven run still holds (0: never resume)
  readonly autoturnResumeMax: number;
  // dori watch: LANE_AUTOTURN_LONG each time a session has started this many more turns on its own since the last user
  // (or lead) message, only reported, never stopped; with engineTurns.maxPerUserInput 0 omo no longer pauses (0: off)
  readonly autoturnLongTurns: number;
  // dori watch: minutes an owner message may wait with no working reply from the lead before one LEAD_OWNER_WAITING line
  // is typed into the lead pane (lead-limit.ts; 0: never typed, the owner's limit notice still goes out)
  readonly leadWakeMin: number;
  // dori watch: minutes the lead's tmux session may be gone (or its pane dead) before dori watch starts it again in the same
  // conversation and tells the owner once (lead-down.ts; 0: never)
  readonly leadReviveMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  // dori heavy beside the first heavySlots jobs: up to heavyMaxSlots at once, a job only when GPU use, GPU (or unified)
  // memory, CPU and memory each keep heavyHeadroomPct percent free with it added, and none while a job taken less than
  // heavySettleSec ago has not shown its load. Owner 2026-10-16 20:52 KST: "한 번에 하나의 작업을 돌리라고 하긴 했지만 이렇게
  // 리소스가 30% 정도로 넉넉하게 남으면 한꺼번에 돌려도 돼" (speech-to-text wrote 리소스 as 리수 수). Owner 2026-10-22 02:15 KST lowered 30% to 10%: "30프로 여유 규칙 더 줄여 10%해".
  readonly heavyMaxSlots: number;
  readonly heavyHeadroomPct: number;
  readonly heavySettleSec: number;
  // GB of free memory a GPU job (the GPU line, plain dori heavy, --kind gpu) gets made before it starts: under a quarter of it, page
  // cache is pushed out within MemAvailable over the heavyHeadroomPct floor (heavy-mem.ts gpuRoom; 0: never). On a
  // unified-memory GPU (GB10) the driver fails a CUDA context when cache has left almost nothing free (2026-11-02).
  readonly heavyGpuFreeGb: number;
  readonly heavyQueue: HeavyQueue;
  // dori heavy hold-local: the directory every account on this host keeps its hold in (1777, sticky; heavy-hold.ts)
  readonly heavyHoldDir: string;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  readonly discord: DiscordWords;
  readonly stuck: Stuck;
  readonly reviewers: Reviewers;
  readonly mergeGate: MergeGate;
  readonly scorecard: Scorecard;
  readonly signals: Signals;
  readonly explore: Explore;
  readonly autoSignals: AutoSignals;
  readonly handover: Handover;
  // dori launch --thread new: related open threads shown first (src/related-thread.ts)
  readonly related: RelatedSettings;
  // dori state-git: this Dori's state in local git, committed by dori-lanes (src/state-git.ts)
  readonly stateGit: StateGitSettings;
  readonly backlog: BacklogSettings;
  // lane caps, hung calls and the cost record (src/supervision.ts): caps off by default, a cap or a hung call is told to the lead
  readonly supervision: SupervisionSettings;
  // the early-compaction trial (src/compaction-keep.ts, owner Q530): off while until is empty
  readonly compactionTrial: CompactionTrial;
  readonly instances: readonly InstanceRef[];
};

// from/until: ISO times; the trial runs while from <= now < until (until empty: off). atK: the early arm's point, in
// thousands of tokens of context. exclude: a regular expression over "<key> <tags>"; a matching lane joins no arm.
export type CompactionTrial = { readonly from: string; readonly until: string; readonly atK: number; readonly exclude: string };


// Another Dori on this host: its config file (whose defaultCwd marks its directory) and its dori.env (default: next to
// that config). A dori command run without DORI_CONFIG and DORI_ENV_FILE inside that directory acts as that Dori.
export type InstanceRef = { readonly config: string; readonly envFile?: string };
