import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the SHORT (SHIFT+SHORT_TERM, real-time clock) workflow.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press SHORT → "TIME:  0:00"  (iram[0x1C]=0x9C, ptr=0x7165)
 *
 *   The display shows the on-board clock. Probed digit input:
 *     - "1" → "TIME: 1 :00"   (overwrites the first digit position)
 *     - "2" → "TIME: 12: 0"   (second digit position, advances to seconds slot)
 *
 *   So digits *do* update the displayed time, in-place. Tested terminators:
 *     - "="   → "GIVE NUMBER OR FUNCTION"  (commit / save?)
 *     - "^"   → "GIVE NUMBER OR FUNCTION"  (cancel)
 *
 * Inferred semantics: SHORT is the "show and edit clock" function. The user
 * can poke up to 4 digits (HHMM) into the displayed slots, then `=` commits
 * the new clock value. We have no real RTC peripheral to verify the value
 * actually persists, but the prompt updates deterministically.
 */
describe("SHORT (TIME clock) workflow probe", () => {
  it("walks SHORT through the displayed clock", async () => {
    const driver = await HeadlessDeviceDriver.create({
      maxTraceEvents: 30_000,
      traceAllXdata: false
    });
    driver.runCoupledBoot();

    const log: string[] = [];
    const snap = (label: string): void => {
      const main = driver.machine.mainCpu;
      const display = driver.displayText().trimEnd();
      const iram1c = main.iram[0x1c].toString(16).padStart(2, "0");
      const iram20 = main.iram[0x20].toString(16).padStart(2, "0");
      const iram44 = main.iram[0x44].toString(16).padStart(2, "0");
      const iram45 = main.iram[0x45].toString(16).padStart(2, "0");
      const pc = main.snapshot().pc.toString(16).padStart(4, "0");
      log.push(
        `${label.padEnd(28)} | "${display}" | PC=${pc} 1C=${iram1c} 20=${iram20} ptr=${iram44}${iram45}`
      );
    };

    const press = (key: FrontPanelKey, holdSlices = 250, settleSlices = 80): void => {
      driver.pressKey(key);
      driver.runSchedulerSlices(holdSlices, 80);
      driver.releaseKey(key);
      driver.runSchedulerSlices(settleSlices, 80);
    };

    snap("BOOT");
    press("SHORT");
    snap("after SHORT (clock display)");

    for (const d of ["1", "2", "3", "4"] as const) {
      press(d);
      snap(`after digit ${d}`);
    }

    press("=");
    snap("after = (commit clock)");

    press("SHORT");
    snap("re-enter SHORT");
    press("^");
    snap("after ^ (cancel)");

    console.log("\n=== SHORT/CLOCK PROBE ===");
    for (const line of log) console.log(line);
    console.log("=== END SHORT/CLOCK PROBE ===\n");
  }, 240_000);
});
