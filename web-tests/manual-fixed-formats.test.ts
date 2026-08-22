import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

function press(driver: HeadlessDeviceDriver, key: FrontPanelKey): void {
  driver.pressKey(key);
  driver.runSchedulerSlices(250);
  driver.releaseKey(key);
  driver.runSchedulerSlices(80);
}

function pressAll(driver: HeadlessDeviceDriver, keys: readonly FrontPanelKey[]): void {
  for (const key of keys) press(driver, key);
}

describe("manual section 3.2.6B installed fixed formats", () => {
  it("completes format 1 and opens its optional free-format tail", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();

    pressAll(driver, ["1", "1", "2", "3", "4", "="]);
    expect(driver.displayText()).toContain("Y:");
    pressAll(driver, ["5", "6", "7", "8", "="]);
    expect(driver.displayText()).toContain("BEARING:");
    pressAll(driver, ["9", "0", "="]);
    expect(driver.displayText()).toContain("RANGE:");
    pressAll(driver, ["1", "2", "3", "="]);
    expect(driver.displayText()).toContain("*");
    pressAll(driver, ["A", "B"]);
    expect(driver.displayText()).toContain("AB*");
  }, 30_000);

  it("completes format 2 through its coordinate-derived bearing/range path", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();

    pressAll(driver, ["2", "1", "2", "3", "4", "5", "=", "6", "7", "8", "9", "0", "="]);
    expect(driver.displayText()).toContain("BEARING RANGE (OR C):");
    pressAll(driver, ["C", "1", "2", "3", "4", "5", "=", "6", "7", "8", "9", "0", "="]);
    expect(driver.displayText()).toContain("BEARING RANGE=");
    press(driver, "Y");
    expect(driver.displayText()).toContain("GIVE NUMBER OR FUNCTION");
  }, 30_000);

  it.each(["3", "4", "5", "6", "7", "8", "9"] as FrontPanelKey[])(
    "reports selector %s as not installed",
    async (selector) => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();
      press(driver, selector);
      expect(driver.displayText()).toContain("NOT DEFINED");
    },
    15_000
  );
});
