import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the KEY workflow (operator's PRIVATE ADDRESS entry).
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press KEY → "PRIVATE ADDRESS: ?"        (iram[0x20] stays 0x41 — NOT
 *                                                   the free-text 0xC1 mode)
 *   first digit  → "PRIVATE ADDRESS:1"
 *   second digit → "PRIVATE ADDRESS:12"
 *   third digit  → "PRIVATE ADDRESS:12"  (REJECTED — field is capped at 2 chars)
 *   fourth digit → "PRIVATE ADDRESS:12"  (still rejected)
 *   "="          → "GIVE NUMBER OR FUNCTION"  (commit/return to idle)
 *   "^"          → "GIVE NUMBER OR FUNCTION"  (cancel)
 *
 * Inferred semantics: the firmware keeps a 2-byte address in private storage at
 * iram[0x44/0x45]=ptr 0x7300 (visible in the discovery probe). After 2 digits
 * the input slot is full so further digits are silently dropped. `=` commits
 * the value (no visible confirmation) and bounces to FUNCTION?.
 */
describe("KEY (PRIVATE ADDRESS) workflow probe", () => {
  it("walks KEY through the 2-digit private address entry", async () => {
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
    press("KEY");
    snap("after KEY (PRIVATE ADDRESS prompt)");

    for (const d of ["1", "2", "3", "4"] as const) {
      press(d);
      snap(`after digit ${d}`);
    }

    press("=");
    snap("after = (commit)");

    // Re-enter and try cancel instead of commit.
    press("KEY");
    snap("re-enter KEY");
    press("9");
    snap("after digit 9");
    press("^");
    snap("after ^ (cancel)");

    console.log("\n=== KEY/PRIVATE ADDRESS PROBE ===");
    for (const line of log) console.log(line);
    console.log("=== END KEY/PRIVATE ADDRESS PROBE ===\n");
  }, 240_000);
});
