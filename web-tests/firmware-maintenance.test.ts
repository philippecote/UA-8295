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

function composeFreeMessage(driver: HeadlessDeviceDriver, text: string): void {
  press(driver, "0");
  for (const character of text) press(driver, character as FrontPanelKey);
  press(driver, "SHORT_TERM");
}

function selectDaysKey(driver: HeadlessDeviceDriver): void {
  press(driver, "CONF");
  for (let page = 0; page < 4; page += 1) press(driver, "=");
  expect(driver.displayText()).toContain("DAY'S");
  expect(driver.displayText()).toContain("FIXED KEY");
  press(driver, "DEL");
  press(driver, "SHORT_TERM");
}

describe("manual section 3.2.12 complete-memory deletion", () => {
  it("requires SHIFT+T then SHIFT+K and clears every persistent SRAM byte", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    composeFreeMessage(driver, "HI");

    expect(driver.machine.mainBus.xram.some((byte) => byte !== 0xff)).toBe(true);

    press(driver, "T", true);
    expect(driver.displayText()).toContain("GIVE ^K TO CLEAR THE MEMORY");
    expect(driver.machine.mainBus.xram.some((byte) => byte !== 0xff)).toBe(true);

    press(driver, "K", true);
    driver.runSchedulerSlices(1_200);
    // 0x7FE0-0x7FFF is the live 32-character display workspace. Firmware
    // rewrites that window after clearing all persistent SRAM below it.
    expect([...driver.machine.mainBus.xram.slice(0, 0x1fe0)]).toEqual(new Array(0x1fe0).fill(0));
  }, 30_000);
});

describe("manual section 3.2.14 key replacement", () => {
  it("accepts a keyword in day's-key mode and retains its generated ID across reset", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    selectDaysKey(driver);

    press(driver, "KEY", true);
    expect(driver.displayText()).toContain("NEW KEY:");
    for (const character of "ALPHA") press(driver, character as FrontPanelKey);
    press(driver, "=");
    driver.runSchedulerSlices(1_200);

    expect(driver.displayText()).toContain("KEY: AIEH");
    expect([...driver.machine.mainBus.xram.slice(0x12e6, 0x12f6)]).toEqual([
      0x01, 0x0c, 0x10, 0x08, 0x01,
      0x27, 0x27, 0x27, 0x27, 0x27,
      0x27, 0x27, 0x27, 0x27, 0x27, 0xfe
    ]);

    driver.machine.reset();
    driver.bootUntilReady();
    press(driver, "KEY");
    expect(driver.displayText()).toContain("KEY: AIEH");
  }, 30_000);
});
