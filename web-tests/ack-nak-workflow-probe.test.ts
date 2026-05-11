import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the ACK_NAK (RECEIVER) workflow.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press ACK_NAK → "RECEIVER: ?"   (ptr 0x7102, distinct from the NAK/ACK
 *                                             station slot at 0x72CF)
 *   first digit  → "RECEIVER:1"
 *   second digit → "RECEIVER:12"
 *   third digit  → "RECEIVER:12"  (REJECTED — 2-digit address cap)
 *   fourth digit → "RECEIVER:12"  (still rejected)
 *   "="          → "GIVE NUMBER OR FUNCTION"  (commits the receiver address)
 *   "^"          → "GIVE NUMBER OR FUNCTION"  (cancel)
 *
 * Inferred semantics: the receiver address is what the firmware will use as
 * the destination for outgoing message frames. ptr=0x7102 is a separate slot
 * from PRIVATE ADDRESS (0x7300) and the per-NAK/ACK station target (0x72CF),
 * so the operator can pre-set the default receiver, then later compose ACK
 * or NAK frames addressed to other stations.
 */
describe("ACK_NAK (RECEIVER) workflow probe", () => {
  it("walks ACK_NAK through the 2-digit receiver address entry", async () => {
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
    press("ACK_NAK");
    snap("after ACK_NAK (RECEIVER prompt)");

    for (const d of ["1", "2", "3", "4"] as const) {
      press(d);
      snap(`after digit ${d}`);
    }

    press("=");
    snap("after = (commit receiver)");

    press("ACK_NAK");
    snap("re-enter ACK_NAK");
    press("^");
    snap("after ^ (cancel)");

    console.log("\n=== ACK_NAK/RECEIVER PROBE ===");
    for (const line of log) console.log(line);
    console.log("=== END ACK_NAK/RECEIVER PROBE ===\n");
  }, 240_000);
});
