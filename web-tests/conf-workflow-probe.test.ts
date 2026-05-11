import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the CONF (NO MESSAGES) workflow.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press CONF → "NO MESSAGES FUNCTION"   (iram[0x1C]=0x1B)
 *
 *   The list is empty (no stored messages), so navigation/scroll keys have
 *   nothing to do:
 *     - DISPL → "GIVE NUMBER OR FUNCTION"  (no message to display, falls back)
 *     - "="   → "GIVE NUMBER OR FUNCTION"  (commit / nothing to do)
 *     - "^"   → "GIVE NUMBER OR FUNCTION"  (cancel)
 *     - digit 1 → falls through to the main dispatcher and opens COORDINATES X
 *
 * Inferred semantics: CONF lists stored messages — when none are stored the
 * firmware shows the "NO MESSAGES" hint with a trailing FUNCTION token,
 * meaning "your function key was accepted but there is nothing to enumerate".
 * To meaningfully drive deeper we would need a stored message; without a
 * peripheral storage path we cannot inject one. Documented as a stall point.
 */
describe("CONF (NO MESSAGES) workflow probe", () => {
  it("walks CONF and probes navigation keys against the empty list", async () => {
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
    press("CONF");
    snap("after CONF (NO MESSAGES)");

    press("DISPL");
    snap("after DISPL (probe: scroll?)");

    press("CONF");
    snap("re-enter CONF");
    press("=");
    snap("after = (probe: commit?)");

    press("CONF");
    snap("re-enter CONF (third)");
    press("^");
    snap("after ^ (cancel)");

    console.log("\n=== CONF/NO MESSAGES PROBE ===");
    for (const line of log) console.log(line);
    console.log("=== END CONF/NO MESSAGES PROBE ===\n");
  }, 240_000);
});
