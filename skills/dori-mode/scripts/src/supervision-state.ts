export type Observation = {
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  readonly activity: string;
  readonly activeAt: number;
  readonly alerts: readonly string[];
};

export const ACTIVITY_FILES = 5000;
