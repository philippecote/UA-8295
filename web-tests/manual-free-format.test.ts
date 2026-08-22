import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

function press(driver: HeadlessDeviceDriver, key: FrontPanelKey, shifted = false): void {
  if (shifted) driver.pressKey("^");
  driver.pressKey(key);
  driver.runSchedulerSlices(250);
  driver.releaseKey(key);
  if (shifted) driver.releaseKey("^");
  driver.runSchedulerSlices(80);
}

function pressAll(driver: HeadlessDeviceDriver, keys: readonly FrontPanelKey[]): void {
  for (const key of keys) press(driver, key);
}

function composeFormatOne(driver: HeadlessDeviceDriver): void {
  pressAll(driver, [
    "1", "1", "2", "3", "4", "=", "5", "6", "7", "8", "=",
    "9", "0", "=", "1", "2", "3", "=", "A", "B"
  ]);
}

describe("manual section 3.2.6A free-format memory handling", () => {
  it("keeps an existing fixed message and composes in the small memory", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    composeFormatOne(driver);
    const largeMessage = driver.machine.mainBus.xram.slice(0x800, 0x818);

    press(driver, "SHORT_TERM");
    expect(driver.displayText()).toContain("GIVE NUMBER OR FUNCTION");
    press(driver, "0");
    expect(driver.displayText()).toContain("DELETE THE OLD MESSAGE (Y/N)");
    press(driver, "N");
    expect(driver.displayText()).toContain("COORDINATES X:");

    press(driver, "SHORT_TERM");
    press(driver, "SHORT_TERM", true);
    expect(driver.displayText()).toContain("SHORT MEMORY, FUNCTION");
    pressAll(driver, ["0", "X"]);

    expect(driver.displayText()).toContain("X*");
    expect(driver.machine.mainBus.xram[0x1002]).toBe(0x18);
    expect(driver.machine.mainBus.xram.slice(0x800, 0x818)).toEqual(largeMessage);
  }, 30_000);

  it("replaces an existing fixed message and supports whole-message deletion", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    composeFormatOne(driver);

    pressAll(driver, ["SHORT_TERM", "0"]);
    expect(driver.displayText()).toContain("DELETE THE OLD MESSAGE (Y/N)");
    pressAll(driver, ["Y", "X"]);
    expect(driver.displayText()).toContain("X*");
    expect(driver.machine.mainBus.xram[0x802]).toBe(0x18);

    press(driver, "DEL", true);
    expect(driver.displayText().trim()).toBe("*");
    expect([...driver.machine.mainBus.xram.slice(0x800, 0x804)]).toEqual([
      0xfe, 0xff, 0xfe, 0xff
    ]);

    pressAll(driver, ["SHORT_TERM", "0"]);
    expect(driver.displayText().trim()).toBe("*");
  }, 30_000);
});
