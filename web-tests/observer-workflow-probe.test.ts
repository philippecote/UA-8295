import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the OBSERVER X,Y message-template workflow (entered by pressing
 * digit 2 from idle). Captures display + iram state after each key.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press "2" → "OBSERVER X,Y=?"   (entry mode flag iram[0x20]=0x41 — note:
 *                                          NOT the same 0xC1 free-text flag the
 *                                          COORDINATES template flips on)
 *   each digit appends right-aligned: "OBSERVER X,Y=?1", "...12", "...123", "...1234"
 *   "=" → returns to "GIVE NUMBER OR FUNCTION"
 *
 * Read-only probe; no specific assertions.
 */
describe("OBSERVER workflow probe", () => {
  it("walks OBSERVER from template selection through coordinate entry", async () => {
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
    press("2");
    snap("after 2 (OBSERVER X,Y selected)");

    for (const d of ["1", "2", "3", "4"] as const) {
      press(d);
      snap(`after coord digit ${d}`);
    }

    press("=");
    snap("after = (terminator)");

    // After =, the workflow is back at FUNCTION?. Probe whether further input
    // continues the OBSERVER message or treats us as idle.
    press("5");
    snap("after 5 (post-terminator)");

    // Cancel from wherever we are.
    press("^");
    snap("after ^ (cancel)");

    console.log("\n=== OBSERVER PROBE ===");
    for (const line of log) console.log(line);
    const recent = driver.displayHistory().slice(-30);
    console.log("\n--- recent displays ---");
    for (const d of recent) console.log(`  "${d.trimEnd()}"`);
    console.log("=== END OBSERVER PROBE ===\n");
  }, 240_000);
});
