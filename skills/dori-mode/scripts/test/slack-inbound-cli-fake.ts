// every() sleeps only after a completed tick. Advance once and exit after the second, without wall-clock timing.
let ticks = 0;
Bun.sleep = async () => {
  if (++ticks === 2) {
    console.log("TEST_TICKS 2");
    process.exit(0);
  }
};
