// Touch for herdr on a phone. herdr turns on mouse tracking, and ttyd 1.7.7's xterm.js then drops touch input entirely
// (it scrolls only its own scrollback, and only without mouse tracking), while the page fits the terminal to the phone's
// width with page overflow hidden. On a touch-first screen narrower than 960px this page code lays the terminal out
// 960px wide and turns one-finger gestures into what herdr already understands from a mouse:
// - a sideways drag pans the wider terminal (a thin bar at the bottom shows where you are);
// - an up/down drag sends wheel events at the finger, so herdr scrolls the pane under it;
// - a long press, then a drag, selects the cells from the press to the finger with xterm's own selection, so it works
//   when the pane's program (an agent TUI) has taken the mouse and nothing reaches that program; the text is copied
//   when the finger lifts or the gesture is cancelled (clipboard.ts shows Tap to copy when the browser refuses);
// - a tap is left to the browser, so it still focuses the terminal and brings up the keyboard; two fingers still zoom.
// Desktop browsers and touchscreen laptops (a fine primary pointer) are unchanged.
const width = 960;

const style = `<style>
#dori-pan{display:none}
@media (pointer: coarse) and (max-width: ${width - 1}px) {
html #terminal-container{width:${width}px!important;transform:translateX(calc(-1 * var(--dori-pan, 0px)));
touch-action:pinch-zoom;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
#dori-pan{display:block;position:fixed;left:0;right:0;bottom:0;height:3px;z-index:15;pointer-events:none;background:#0e1118}
#dori-pan span{position:absolute;top:0;bottom:0;background:#89919d;border-radius:2px}
}
</style>`;

const script = `<div id="dori-pan" aria-hidden="true"><span></span></div>
<script>
(() => {
  const narrowTouch = matchMedia("(pointer: coarse) and (max-width: ${width - 1}px)");
  const root = document.documentElement;
  const thumb = document.querySelector("#dori-pan span");
  const container = () => document.getElementById("terminal-container");
  const screen = () => window.term?.element?.querySelector(".xterm-screen");
  const longPress = 450, slop = 8;
  let pan = 0, gesture = null;
  const setPan = (x) => {
    const c = container();
    if (!c) return;
    const max = narrowTouch.matches ? Math.max(0, c.offsetWidth - innerWidth) : 0;
    pan = Math.min(max, Math.max(0, x));
    root.style.setProperty("--dori-pan", pan + "px");
    thumb.style.width = (100 * innerWidth / Math.max(innerWidth, c.offsetWidth)) + "%";
    thumb.style.left = (100 * pan / Math.max(innerWidth, c.offsetWidth)) + "%";
  };
  addEventListener("resize", () => setPan(pan));
  narrowTouch.addEventListener("change", () => setPan(pan));
  setPan(0);
  const at = (point) => ({ bubbles: true, cancelable: true, view: window, clientX: point.clientX, clientY: point.clientY });
  const cellAt = (point) => {
    const t = window.term, r = screen().getBoundingClientRect();
    const col = Math.floor((point.clientX - r.left) / (r.width / t.cols));
    const row = Math.floor((point.clientY - r.top) / (r.height / t.rows));
    return { col: Math.min(t.cols - 1, Math.max(0, col)), row: t.buffer.active.viewportY + Math.min(t.rows - 1, Math.max(0, row)) };
  };
  const select = (from, to) => {
    const [a, b] = [cellAt(from), cellAt(to)].sort((x, y) => x.row - y.row || x.col - y.col);
    window.term.select(a.col, a.row, (b.row - a.row) * window.term.cols + b.col - a.col + 1);
  };
  const copySelection = () => {
    const text = window.term?.getSelection?.();
    if (text) window.__doriClip.copy(text);
  };
  const wheel = (deltaY, point) => screen()?.dispatchEvent(new WheelEvent("wheel", { ...at(point), deltaY, deltaMode: 0 }));
  const lineHeight = () => Math.max(8, (screen()?.getBoundingClientRect().height ?? 0) / (window.term?.rows || 1));
  const setMode = (mode) => { if (mode) root.dataset.doriTouch = mode; else delete root.dataset.doriTouch; };
  const clear = () => { if (gesture) clearTimeout(gesture.timer); gesture = null; setMode(""); };
  // A selection that ends without a lift (a second finger, touchcancel) is still copied.
  const cancel = () => {
    if (gesture?.mode === "select") copySelection();
    clear();
  };
  document.addEventListener("touchstart", (event) => {
    if (!narrowTouch.matches || !container()?.contains(event.target)) return;
    if (event.touches.length !== 1) return cancel();
    const t = event.touches[0];
    gesture = { x: t.clientX, y: t.clientY, last: { clientX: t.clientX, clientY: t.clientY }, mode: "wait", rest: 0 };
    gesture.timer = setTimeout(() => {
      if (gesture?.mode !== "wait") return;
      gesture.mode = "select";
      setMode("select");
      navigator.vibrate?.(15);
      select(gesture.last, gesture.last);
    }, longPress);
    setMode("wait");
  }, { capture: true, passive: true });
  document.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    if (event.touches.length !== 1) return cancel();
    event.preventDefault();
    event.stopPropagation();
    const t = event.touches[0];
    if (gesture.mode === "wait") {
      if (Math.hypot(t.clientX - gesture.x, t.clientY - gesture.y) < slop) return;
      clearTimeout(gesture.timer);
      gesture.mode = Math.abs(t.clientX - gesture.x) > Math.abs(t.clientY - gesture.y) ? "pan-x" : "pan-y";
      setMode(gesture.mode);
    }
    if (gesture.mode === "select") select({ clientX: gesture.x, clientY: gesture.y }, t);
    else if (gesture.mode === "pan-x") setPan(pan - (t.clientX - gesture.last.clientX));
    else {
      gesture.rest += gesture.last.clientY - t.clientY;
      const step = lineHeight();
      while (Math.abs(gesture.rest) >= step) {
        const delta = Math.sign(gesture.rest) * step;
        wheel(delta, t);
        gesture.rest -= delta;
      }
    }
    gesture.last = { clientX: t.clientX, clientY: t.clientY };
  }, { capture: true, passive: false });
  const finish = (event) => {
    if (!gesture) return;
    const { mode } = gesture;
    clear();
    if (mode === "wait") return;
    event.preventDefault();
    if (mode === "select") copySelection();
  };
  document.addEventListener("touchend", finish, { capture: true, passive: false });
  document.addEventListener("touchcancel", cancel, { capture: true });
  document.addEventListener("contextmenu", (event) => { if (gesture) event.preventDefault(); }, true);
})();
</script>`;

export const touchHead = style;
export const touchBody = script;
