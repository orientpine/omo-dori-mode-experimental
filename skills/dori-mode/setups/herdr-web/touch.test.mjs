import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { injectStateBar } from "./state-bar.ts";

test("a phone's one-finger drags pan the wider terminal and scroll herdr; a long press selects and copies; desktop is unchanged", async () => {
  // Given: the real injected page with a stand-in for ttyd's xterm that records the mouse and wheel events it receives
  // and the selections asked of it.
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
const selections = [];
window.term = { rows: 40, cols: 100, element, buffer: { active: { viewportY: 5 } }, focus() {}, paste() {},
  select: (col, row, length) => selections.push([col, row, length]), getSelection: () => (selections.length ? "picked" : "") };
window.__events = events;
window.__selections = selections;
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
    const selections = await page.evaluate(() => window.__selections.splice(0));
    const cell = await page.evaluate(() => {
      const r = document.querySelector(".xterm-screen").getBoundingClientRect();
      return { row: 5 + Math.floor((300 - r.top) / (r.height / 40)), w: r.width / 100 };
    });
    const copied = await page.evaluate(() => window.__copied);
    await page.evaluate(() => { window.__copied = undefined; });
    const longPress = async (x, y) => {
      await touch("touchStart", x, y);
      await page.evaluate(() => new Promise((resolve) => {
        const wait = () => (document.documentElement.dataset.doriTouch === "select" ? resolve() : setTimeout(wait, 20));
        wait();
      }));
      await touch("touchMove", x + 30, y);
    };
    await longPress(100, 300);
    await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 130, y: 300, id: 1 }, { x: 250, y: 500, id: 2 }] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const zoomed = { events: await events(), copied: await page.evaluate(() => window.__copied) };
    await page.evaluate(() => { window.__copied = undefined; });
    await longPress(100, 300);
    await send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    const cancelled = { events: await events(), copied: await page.evaluate(() => window.__copied) };
    // A browser that refuses the clipboard write (no user activation) gets the Tap to copy retry instead of silence.
    await page.evaluate(() => {
      let calls = 0;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v) => {
        if (calls++ === 0) throw new DOMException("not allowed", "NotAllowedError");
        window.__retried = v;
      } } });
    });
    await longPress(100, 300);
    await touch("touchEnd");
    const offered = await page.evaluate(() => new Promise((resolve) => {
      const wait = () => {
        const button = document.querySelector("#dori-clip-toast button");
        if (button) return resolve({ text: document.getElementById("dori-clip-toast").textContent, hidden: document.getElementById("dori-clip-toast").hidden });
        setTimeout(wait, 20);
      };
      wait();
    }));
    await page.evaluate(() => document.querySelector("#dori-clip-toast button").click());
    const retried = await page.evaluate(() => new Promise((resolve) => {
      const wait = () => (window.__retried ? resolve(window.__retried) : setTimeout(wait, 20));
      wait();
    }));
    await touch("touchStart", 200, 600);
    await touch("touchEnd");
    const tapped = (await events()).filter((e) => e.type !== "mousemove");

    // Then: desktop keeps the full-width terminal; the phone lays it out 960px wide, pans and clamps it sideways,
    // sends up/down drags as wheel events at the finger, selects from the press to the finger with xterm's own selection
    // (no mouse event reaches the pane program), copies on lift and on cancel, offers a retry, and leaves a tap alone.
    expect(desktop).toEqual({ width: 1440, left: 0, inner: 1440, bar: "none", mode: "" });
    expect(phone).toEqual({ width: 960, left: 0, inner: 390, bar: "block", mode: "" });
    expect(vertical.length).toBeGreaterThanOrEqual(5);
    expect(vertical.every((e) => e.type === "wheel" && e.deltaY < 0 && e.x === 200)).toBe(true);
    expect(sideways).toEqual([]);
    expect(panned.left).toBe(-200);
    expect(clamped.left).toBe(390 - 960);
    expect(selected).toEqual([]);
    // Cells from the press (x 100) to the finger (x 140, then 180), both included, on the viewport row under them.
    const from = Math.floor(100 / cell.w);
    expect(selections).toEqual([[from, cell.row, 1], [from, cell.row, Math.floor(140 / cell.w) - from + 1],
      [from, cell.row, Math.floor(180 / cell.w) - from + 1]]);
    expect(copied).toBe("picked");
    expect(zoomed).toEqual({ events: [], copied: "picked" });
    expect(cancelled).toEqual({ events: [], copied: "picked" });
    expect(offered).toEqual({ text: "Selection readyTap to copy", hidden: false });
    expect(retried).toBe("picked");
    expect(tapped).toEqual([]);
  } finally {
    try { await browser?.close(); } finally {
      server.stop(true);
      rmSync(profile, { recursive: true, force: true });
    }
  }
}, 20000);
