import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { injectStateBar } from "./state-bar.ts";

test("a phone's one-finger drags pan the wider terminal and scroll herdr; a long press drags a selection; desktop is unchanged", async () => {
  // Given: the real injected page with a stand-in for ttyd's xterm that records the mouse and wheel events it receives.
  const loader = process.env.OMOWRIGHT_LOADER ?? join(homedir(),
    ".bun/install/global/node_modules/omo-ai/plugin/skills/browser/scripts/omowright.mjs");
  const { loadOmowright } = await import(pathToFileURL(loader).href);
  const { omowright } = await loadOmowright();
  const profile = mkdtempSync(join(tmpdir(), "herdr-web-touch-"));
  const html = injectStateBar(`<!doctype html><html><head><style>html,body{height:100%;margin:0;overflow:hidden}
.xterm,.xterm-screen{width:100%;height:100%}</style></head><body><div id="terminal-container"><div class="xterm">
<div class="xterm-screen"></div></div></div><script>
const events = [];
const element = document.querySelector(".xterm");
for (const type of ["mousedown", "mousemove", "mouseup", "wheel"]) element.addEventListener(type, (e) => {
  if (!e.isTrusted) events.push({ type, x: Math.round(e.clientX), y: Math.round(e.clientY), buttons: e.buttons, deltaY: e.deltaY ?? 0 });
});
window.term = { rows: 40, cols: 100, element, getSelection: () => "picked", focus() {}, paste() {} };
window.__events = events;
</script></body></html>`);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/__dori/state" ? Response.json([])
        : new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
  let browser;
  try {
    browser = await omowright.connectPipe({
      browserPath: process.env.HERDR_WEB_CHROMIUM ?? join(homedir(),
        ".cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell"),
      browserArgs: ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", `--user-data-dir=${profile}`],
      storageRoot: profile,
    });
    const page = await browser.newTab("about:blank");
    await page.goto(server.url.href, { waitUntil: "commit" });
    const send = async (method, params) => page.cdp.send(method, params, await page.resolveSessionId());
    const layout = () => page.evaluate(() => {
      const c = document.getElementById("terminal-container");
      return { width: c.getBoundingClientRect().width, left: c.getBoundingClientRect().left, inner: innerWidth,
        bar: getComputedStyle(document.getElementById("dori-pan")).display, mode: document.documentElement.dataset.doriTouch ?? "" };
    });
    const touch = (type, x, y) => send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
    const drag = async (from, to) => {
      await touch("touchStart", ...from);
      for (let i = 1; i <= 10; i++) await touch("touchMove", from[0] + (to[0] - from[0]) * i / 10, from[1] + (to[1] - from[1]) * i / 10);
      await touch("touchEnd");
    };
    const events = () => page.evaluate(() => window.__events.splice(0));
    const desktop = await layout();

    // When: the same page becomes a 390px touch screen (no navigation, so the browser keeps the override).
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const phone = await layout();
    await page.evaluate(() => navigator.clipboard && Object.defineProperty(navigator, "clipboard", { configurable: true,
      value: { writeText: async (v) => { window.__copied = v; } } }));
    await drag([200, 300], [200, 500]);
    const vertical = await events();
    await drag([300, 400], [100, 400]);
    const panned = await layout();
    await drag([380, 400], [10, 400]);
    await drag([380, 400], [10, 400]);
    const clamped = await layout();
    const sideways = await events();
    await drag([10, 400], [380, 400]);
    await drag([10, 400], [380, 400]);
    await touch("touchStart", 100, 300);
    await page.evaluate(() => new Promise((resolve) => {
      const wait = () => (document.documentElement.dataset.doriTouch === "select" ? resolve() : setTimeout(wait, 20));
      wait();
    }));
    await touch("touchMove", 140, 300);
    await touch("touchMove", 180, 300);
    await touch("touchEnd");
    const selected = await events();
    const copied = await page.evaluate(() => window.__copied);
    await touch("touchStart", 200, 600);
    await touch("touchEnd");
    const tapped = (await events()).filter((e) => e.type !== "mousemove");

    // Then: desktop keeps the full-width terminal; the phone lays it out 960px wide, pans and clamps it sideways,
    // sends up/down drags as wheel events at the finger, turns a long press into a mouse drag, and leaves a tap alone.
    expect(desktop).toEqual({ width: 1440, left: 0, inner: 1440, bar: "none", mode: "" });
    expect(phone).toEqual({ width: 960, left: 0, inner: 390, bar: "block", mode: "" });
    expect(vertical.length).toBeGreaterThanOrEqual(5);
    expect(vertical.every((e) => e.type === "wheel" && e.deltaY < 0 && e.x === 200)).toBe(true);
    expect(sideways).toEqual([]);
    expect(panned.left).toBe(-200);
    expect(clamped.left).toBe(390 - 960);
    expect(selected.map((e) => e.type)).toEqual(["mousedown", "mousemove", "mousemove", "mouseup"]);
    expect(selected.map((e) => [e.x, e.buttons])).toEqual([[100, 1], [140, 1], [180, 1], [180, 0]]);
    expect(copied).toBe("picked");
    expect(tapped).toEqual([]);
  } finally {
    try { await browser?.close(); } finally {
      server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }
}, 20000);
