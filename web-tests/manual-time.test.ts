import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

function press(driver: HeadlessDeviceDriver, key: FrontPanelKey): void {
  driver.pressKey(key);
  driver.runSchedulerSlices(250);
  driver.releaseKey(key);
  driver.runSchedulerSlices(80);
}

describe("manual section 3.2.5 time workflow", () => {
  it("retains a newly entered time when TIME is opened again", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();

    for (const key of ["TIME", "1", "2", "3", "4", "="] as FrontPanelKey[]) press(driver, key);
    expect([...driver.machine.mainBus.xram.slice(0x1165, 0x1169)]).toEqual([0x31, 0x32, 0x33, 0x34]);

    // The clock represents a day in 0x9000 ticks (one tick is 2.34375 s).
    // Advancing past the first tick mirrors the time needed for an operator to
    // release ACCEPT and reopen TIME, and avoids the ROM's fixed-point value
    // rounding 12:34:00 down to 12:33 at the exact zero-second boundary.
    driver.machine.hardware.advanceSeconds(3);
    press(driver, "TIME");
    expect(driver.displayText()).toContain("TIME: 12:34");
  }, 20_000);
});
