import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

function press(driver: HeadlessDeviceDriver, key: FrontPanelKey): void {
  driver.pressKey(key);
  driver.runSchedulerSlices(250);
  driver.releaseKey(key);
  driver.runSchedulerSlices(80);
}

describe("manual section 3.2.4 configuration workflow", () => {
  it("walks all configuration features while accepting their current values", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();

    press(driver, "CONF");
    expect(driver.displayText()).toContain("PRIVATE ADDRESS:");

    const followingFeatures = [
      "GROUP ADDRESES",
      "GROUP ADDRESES",
      "GROUP ADDRESES",
      "KEY",
      "AUTOACKNOWLEDGEMENT",
      "SOUND ALARM",
      "TRANSMISSION SPEED",
      "OUTPUT LEVEL",
      "PRINTER:",
      "PRINTER I/F:",
      "COMPUTER I/F:",
      "GIVE NUMBER OR FUNCTION"
    ];
    for (const feature of followingFeatures) {
      press(driver, "=");
      expect(driver.displayText()).toContain(feature);
    }
  }, 30_000);

  it("changes addresses and every selectable configuration page", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();

    const sequence = [
      "CONF", "1", "2", "=",
      "3", "4", "=", "5", "6", "=", "7", "8", "=",
      "DEL", "=", "DEL", "=", "DEL", "=", "DEL", "=", "DEL", "=",
      "DEL", "=", "DEL", "P", "T", "=", "DEL", "P", "="
    ] as FrontPanelKey[];
    for (const key of sequence) press(driver, key);

    expect(driver.displayText()).toContain("GIVE NUMBER OR FUNCTION");
    expect([...driver.machine.mainBus.xram.slice(0x1300, 0x1308)]).toEqual([
      0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38
    ]);
    expect([...driver.machine.mainBus.xram.slice(0x1308, 0x1310)]).toEqual([
      0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xf0, 0xe4, 0xf4
    ]);

    press(driver, "CONF");
    expect(driver.displayText()).toContain("PRIVATE ADDRESS:");
    expect([...driver.machine.mainBus.xram.slice(0x1300, 0x1302)]).toEqual([0x31, 0x32]);
  }, 30_000);
});
