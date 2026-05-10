import { describe, expect, it } from "vitest";
import { HeadlessDeviceDriver } from "./device-driver";
import { MANUAL_EXPECTATIONS } from "./manual-expectations";

describe("headless UA-8295 device workflow", () => {
  it(
    "boots the coupled ROMs through initial check-out to the terminal OK prompt",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: true });

      driver.runCoupledBoot();

      expect(driver.displayText()).toHaveLength(MANUAL_EXPECTATIONS.displayWidth);
      expect(driver.displayText()).toContain(MANUAL_EXPECTATIONS.powerUp.currentExpectedDisplayPrefix);
      expect(driver.displayText()).toContain(MANUAL_EXPECTATIONS.readyState.currentExpectedDisplaySuffix);
      expect(driver.displayText()).not.toContain("ERROR");
      expect(driver.summary().xdata.some(([range]) => range === "main:0x7F00-xram")).toBe(true);
    },
    15_000
  );

  it(
    "exposes front-panel keys to the I/O processor at the FUNCTION prompt",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: true });
      driver.runCoupledBoot();
      const before = driver.displayText();

      driver.pressKey("2");
      expect(driver.machine.iopCpu.readDirect(0xb0) & 0x04).toBe(0);
      driver.releaseKey("2");
      expect(driver.machine.iopCpu.readDirect(0xb0) & 0x04).toBe(0x04);

      expect(driver.displayText()).toHaveLength(MANUAL_EXPECTATIONS.displayWidth);
      expect(driver.displayText()).toBe(before);
      expect(MANUAL_EXPECTATIONS.keyboard.keys).toEqual(driver.keyNames());
    },
    15_000
  );
});
