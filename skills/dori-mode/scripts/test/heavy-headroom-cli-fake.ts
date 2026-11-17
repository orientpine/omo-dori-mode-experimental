import { mock } from "bun:test";

import * as headroom from "../src/heavy-headroom.ts";

// Only the helper subprocess preloads this: admission stays real, its host usage does not.
mock.module("../src/heavy-headroom.ts", () => ({
  ...headroom,
  sampleUsage: async (): Promise<headroom.UsageSample> => ({
    host: { gpu: null, gpuMem: null, cpu: 0, mem: 10 },
    unified: false,
    jobs: [],
    memTotalKb: 1e8,
  }),
}));
