import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Read-only probe that drives the SEND workflow step by step and snapshots the
 * display after each key. No specific outcome assertions; the goal is to map
 * the full state machine empirically. Run with:
 *   npx vitest run web-tests/send-workflow-probe.test.ts --disable-console-intercept
 */
describe("SEND workflow probe", () => {
  it("walks SEND step by step and snapshots state after every key", async () => {
    const driver = await HeadlessDeviceDriver.create({
      maxTraceEvents: 200_000,
      traceAllXdata: true
    });
    driver.runCoupledBoot();

    const log: string[] = [];
    const snap = (label: string): void => {
      const mainCpu = driver.machine.mainCpu;
      const iopCpu = driver.machine.iopCpu;
      const main = mainCpu.snapshot();
      const iop = iopCpu.snapshot();
      const display = driver.displayText();
      const iram1c = mainCpu.iram[0x1c].toString(16).padStart(2, "0");
      const iram20 = mainCpu.iram[0x20].toString(16).padStart(2, "0");
      const iram44 = mainCpu.iram[0x44].toString(16).padStart(2, "0");
      const iram45 = mainCpu.iram[0x45].toString(16).padStart(2, "0");
      const mainPc = main.pc.toString(16).padStart(4, "0");
      const iopPc = iop.pc.toString(16).padStart(4, "0");
      log.push(
        `${label}\n  display: "${display}"\n  mainPC=0x${mainPc}  iopPC=0x${iopPc}  iram[1C]=0x${iram1c}  iram[20]=0x${iram20}  iram[44]=0x${iram44}  iram[45]=0x${iram45}`
      );
    };

    /** Press a key, hold for a fixed budget letting the firmware run, then release and settle. */
    const pressAndSettle = (key: FrontPanelKey, holdSlices = 600, settleSlices = 200): void => {
      driver.pressKey(key);
      driver.runSchedulerSlices(holdSlices, 80);
      driver.releaseKey(key);
      driver.runSchedulerSlices(settleSlices, 80);
    };

    snap("BOOT");

    pressAndSettle("SEND");
    snap("after SEND");

    for (const ch of ["A", "I", "E", "H"] as const) {
      pressAndSettle(ch);
      snap(`after AIEH char ${ch}`);
    }

    pressAndSettle("=");
    snap("after = (post-AIEH)");

    // Try one more = in case there's a confirmation step.
    pressAndSettle("=");
    snap("after = (second)");

    // Branch A: try Y to confirm deletion of old message.
    pressAndSettle("Y");
    snap("after Y (delete old?)");

    pressAndSettle("=");
    snap("after = (post-Y)");

    // Type a recipient address.
    for (const ch of ["1", "2", "3"] as const) {
      pressAndSettle(ch);
      snap(`after recipient ${ch}`);
    }

    pressAndSettle("=");
    snap("after = (post recipient)");

    // Type a short message.
    for (const ch of ["H", "I"] as const) {
      pressAndSettle(ch);
      snap(`after msg ${ch}`);
    }

    pressAndSettle("=");
    snap("after = (post-message, attempt transmit)");

    driver.runSchedulerSlices(2000);
    snap("after extended idle (2000 slices)");

    const summary = driver.summary();
    const recentDisplays = driver.displayHistory().slice(-60);

    console.log("\n=== SEND PROBE ===");
    for (const line of log) console.log(line);
    console.log("\n--- recent displays (last 60) ---");
    for (const d of recentDisplays) console.log(`  "${d}"`);
    console.log("\n--- hardware gaps ---");
    console.log(JSON.stringify(summary.hardwareGaps, null, 2));
    console.log("\n--- top XDATA ranges ---");
    console.log(JSON.stringify(summary.xdata.slice(0, 20), null, 2));
    console.log("=== END SEND PROBE ===\n");
  }, 180_000);
});
