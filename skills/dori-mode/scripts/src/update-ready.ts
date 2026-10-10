import type { UpdateService } from "./config.ts";
import type { Clock, Runner } from "./run.ts";

export type RestartDeps = { readonly systemctl: Runner; readonly clock: Clock; readonly timeoutSec: number };

export const restartService = async (deps: RestartDeps, service: UpdateService): Promise<string | undefined> => {
  const pattern = service.ready ? new RegExp(service.ready) : undefined;
  const file = Bun.file(service.log);
  let offset = service.log && await file.exists() ? file.size : 0;
  let partial = offset > 0 && await file.slice(offset - 1, offset).text() !== "\n";
  const deadline = deps.clock.now() + deps.timeoutSec * 1000;
  const restarted = await deps.systemctl(["systemctl", "--user", "restart", service.unit], { timeoutMs: Math.max(1, deadline - deps.clock.now()) });
  if (restarted.code !== 0) return `restart: ${restarted.err || restarted.out || `exit ${restarted.code}`}`;
  for (;;) {
    if (pattern) {
      const log = Bun.file(service.log);
      if (await log.exists()) {
        if (log.size < offset) { offset = 0; partial = false; }
        const text = await log.slice(offset).text();
        const end = text.lastIndexOf("\n");
        if (end >= 0) {
          const complete = text.slice(0, end);
          const lines = partial ? complete.split("\n").slice(1) : complete.split("\n");
          offset += Buffer.byteLength(text.slice(0, end + 1));
          partial = false;
          if (lines.some((line) => pattern.test(line))) return undefined;
        }
      }
    } else {
      const active = await deps.systemctl(["systemctl", "--user", "is-active", service.unit], { timeoutMs: Math.max(1, deadline - deps.clock.now()) });
      if (active.code === 0) return undefined;
    }
    const remaining = deadline - deps.clock.now();
    if (remaining <= 0) return `ready timeout after ${deps.timeoutSec}s`;
    await deps.clock.sleep(Math.min(250, remaining));
  }
};
