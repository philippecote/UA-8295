import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the COORDINATES X message-template workflow (entered by pressing
 * digit 1 from idle) one step at a time, snapshotting display + iram state
 * after every key. Read-only probe; no assertions on specific outcomes.
 */
describe("COORDINATES workflow probe", () => {
  it("walks COORDINATES from template selection through coordinate entry", async () => {
    const driver = await HeadlessDeviceDriver.create({
      maxTraceEvents: 200_000,
      traceAllXdata: true
    });
    driver.runCoupledBoot();

    const log: string[] = [];
    const snap = (label: string): void => {
      const main = driver.machine.mainCpu;
      const display = driver.displayText();
      const iram1c = main.iram[0x1c].toString(16).padStart(2, "0");
      const iram20 = main.iram[0x20].toString(16).padStart(2, "0");
      const iram44 = main.iram[0x44].toString(16).padStart(2, "0");
      const iram45 = main.iram[0x45].toString(16).padStart(2, "0");
      const pc = main.snapshot().pc.toString(16).padStart(4, "0");
      log.push(
        `${label}\n  display: "${display.trimEnd()}"\n  PC=0x${pc}  iram[1C]=0x${iram1c}  iram[20]=0x${iram20}  ptr=0x${iram44}${iram45}`
      );
    };

    const press = (key: FrontPanelKey, holdSlices = 600, settleSlices = 200): void => {
      driver.pressKey(key);
      driver.runSchedulerSlices(holdSlices, 80);
      driver.releaseKey(key);
      driver.runSchedulerSlices(settleSlices, 80);
    };

    snap("BOOT");
    press("1");
    snap("after 1 (COORDINATES X template selected)");

    // Try entering 4 digits for the X coordinate.
    for (const d of ["1", "2", "3", "4"] as const) {
      press(d);
      snap(`after X-coord digit ${d}`);
    }

    // Try advancing with =.
    press("=");
    snap("after = (terminator after X coord)");

    // Try entering 4 digits for the Y coordinate (if a Y prompt appeared).
    for (const d of ["5", "6", "7", "8"] as const) {
      press(d);
      snap(`after Y-coord digit ${d}`);
    }

    press("=");
    snap("after = (terminator after Y coord)");

    // Try a recipient.
    for (const d of ["9", "9", "9", "9"] as const) {
      press(d);
      snap(`after recipient digit ${d}`);
    }

    press("=");
    snap("after = (terminator after recipient)");

    // Try sending.
    press("SEND");
    snap("after SEND (attempt transmit)");

    driver.runSchedulerSlices(2000);
    snap("after extended idle (transmit attempt)");

    const summary = driver.summary();
    const recentDisplays = driver.displayHistory().slice(-50);

    console.log("\n=== COORDINATES PROBE ===");
    for (const line of log) console.log(line);
    console.log("\n--- recent displays (last 50) ---");
    for (const d of recentDisplays) console.log(`  "${d.trimEnd()}"`);
    console.log("\n--- hardware gaps ---");
    console.log(JSON.stringify(summary.hardwareGaps, null, 2));
    console.log("\n--- top XDATA ranges ---");
    console.log(JSON.stringify(summary.xdata.slice(0, 12), null, 2));
    console.log("=== END COORDINATES PROBE ===\n");
  }, 240_000);
});
