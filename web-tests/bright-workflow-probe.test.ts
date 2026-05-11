import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the BRIGHT (SHIFT+TIME, ACK TO STATION) workflow.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press BRIGHT → "ACK TO STATION: ?"   (iram[0x1C]=0x8E confirms shift-bit
 *                                                 routing through the firmware lookup)
 *   first digit  → "ACK TO STATION:1"
 *   second digit → "ACK TO STATION:12"
 *   third digit  → "ACK TO STATION:12"  (REJECTED — same 2-digit address slot)
 *   fourth digit → "ACK TO STATION:12"  (still rejected)
 *   "="          → "GIVE NUMBER OR FUNCTION"  (commits the ACK target)
 *   "^"          → "GIVE NUMBER OR FUNCTION"  (cancel)
 *
 * Inferred semantics: BRIGHT is the SHIFT+TIME alias the photo confirms. The
 * firmware shares the 2-digit address-entry slot with NAK TO STATION, but
 * dispatches to the ACK frame builder instead of NAK. Pointer 0x72CF (visible
 * in the discovery trace) is shared with TIME/NAK.
 */
describe("BRIGHT (ACK TO STATION) workflow probe", () => {
  it("walks BRIGHT through the 2-digit ACK target entry", async () => {
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
    press("BRIGHT");
    snap("after BRIGHT (ACK prompt)");

    for (const d of ["5", "6", "7", "8"] as const) {
      press(d);
      snap(`after digit ${d}`);
    }

    press("=");
    snap("after = (commit ACK)");

    press("BRIGHT");
    snap("re-enter BRIGHT");
    press("^");
    snap("after ^ (cancel)");

    console.log("\n=== BRIGHT/ACK PROBE ===");
    for (const line of log) console.log(line);
    console.log("=== END BRIGHT/ACK PROBE ===\n");
  }, 240_000);
});
