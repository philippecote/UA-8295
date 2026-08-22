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
