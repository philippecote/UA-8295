import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the TIME (NAK TO STATION) workflow.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press TIME → "NAK TO STATION: ?"   (iram[0x20] stays 0x41)
 *   first digit  → "NAK TO STATION:1"
 *   second digit → "NAK TO STATION:12"
 *   third digit  → "NAK TO STATION:12"  (REJECTED — 2-digit station address cap)
 *   fourth digit → "NAK TO STATION:12"  (still rejected)
 *   "="          → "GIVE NUMBER OR FUNCTION"  (commits the NAK target)
 *   "^"          → "GIVE NUMBER OR FUNCTION"  (cancel)
 *
 * Inferred semantics: the firmware reuses the same 2-digit-address entry slot
 * the BRIGHT (ACK TO STATION) and ACK_NAK (RECEIVER) workflows use — same
 * iram pointer 0x72CF in TIME/BRIGHT. Pressing `=` schedules a NAK frame to
 * the entered station id; the actual modem transmit is not modeled, so the
 * UI just bounces back to FUNCTION? without showing a TX countdown.
 */
describe("TIME (NAK TO STATION) workflow probe", () => {
  it("walks TIME through the 2-digit NAK target entry", async () => {
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
    press("TIME");
    snap("after TIME (NAK prompt)");

    for (const d of ["1", "2", "3", "4"] as const) {
      press(d);
      snap(`after digit ${d}`);
    }

    press("=");
    snap("after = (commit NAK)");

    press("TIME");
    snap("re-enter TIME");
    press("^");
    snap("after ^ (cancel)");

    console.log("\n=== TIME/NAK PROBE ===");
    for (const line of log) console.log(line);
    console.log("=== END TIME/NAK PROBE ===\n");
  }, 240_000);
});
