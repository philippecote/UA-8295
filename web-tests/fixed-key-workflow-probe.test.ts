import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the SEND / RCV (FIXED KEY) confirmation workflow.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press SEND → "FIXED KEY  FUNCTION"      (iram[0x1C]=0x1E)
 *   IDLE → press RCV  → "FIXED KEY  FUNCTION"      (iram[0x1C]=0x9E — SHIFT+SEND
 *                                                    raw code, same dispatcher target)
 *
 *   The "FIXED KEY  FUNCTION" prompt is asking the operator to confirm or load
 *   the fixed encryption key. From the discovery probe:
 *     - "="   → "GIVE NUMBER OR FUNCTION"  (cancelled / rejected)
 *     - "Y"   → "GIVE NUMBER OR FUNCTION"  (rejected; not the expected confirm key)
 *     - digit "0" → flips iram[0x20] to 0xC1 and shows free-text mode "             *"
 *                   with ptr=0x6802 (text buffer base). The firmware appears to
 *                   accept the fixed key as a free-text input rather than a
 *                   yes/no confirmation.
 *
 * Stall: once free-text mode engages, every additional character writes into
 * an unmodelled storage region (likely the same MEMORY-FULL gap the SEND probe
 * hit before the XRAM init fix). Without the storage-control peripheral we
 * cannot drive the workflow further. Documented as a peripheral gap.
 */
describe("SEND/RCV (FIXED KEY) workflow probe", () => {
  it("walks SEND through the FIXED KEY prompt and probes confirm keys", async () => {
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
    press("SEND");
    snap("after SEND (FIXED KEY prompt)");

    press("=");
    snap("after = (probe: confirm?)");

    // Try Y/N as that's the documented manual confirm pattern for KEY workflows.
    snap("(reset to FUNCTION? before next probe)");

    press("SEND");
    snap("re-enter SEND");
    press("Y");
    snap("after Y (probe: yes-confirm?)");

    press("SEND");
    snap("re-enter SEND (third time)");
    press("0");
    snap("after 0 (free-text engages?)");

    // RCV is the SHIFT+SEND alias — verify it lands on the same prompt.
    press("^");
    snap("after ^ (cancel)");
    press("RCV");
    snap("after RCV (FIXED KEY via shift)");

    console.log("\n=== FIXED KEY PROBE ===");
    for (const line of log) console.log(line);
    console.log("=== END FIXED KEY PROBE ===\n");
  }, 240_000);
});
