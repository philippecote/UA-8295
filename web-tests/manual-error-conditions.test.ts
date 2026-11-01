import { describe, expect, it } from "vitest";
import { HARDWARE_FAULTS, type HardwareFault } from "../src/ua8295";
import { HeadlessDeviceDriver } from "./device-driver";

describe("manual section 3.3.2 initial check-out errors", () => {
  const cases: Array<[HardwareFault, string]> = [
    ["main-rom-low", "PR1"],
    ["main-rom-high", "PR2"],
    ["sram", "RAM"],
    ["clock", "CLOCK"],
    ["modem-processor", "MOD"],
    ["modem-rom", "PRM"]
  ];

  for (const [fault, code] of cases) {
    it(`reports ${code} for ${HARDWARE_FAULTS[fault].label} and resumes on a keystroke`, async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.machine.setFault(fault, true);
      driver.machine.reset();
      const error = driver.waitForDisplay("ERROR", 12_000, 80, 20);
      expect(error).toContain(code);
      expect(error).not.toContain("TERMINAL OK");
      expect(HARDWARE_FAULTS[fault].errorCode).toBe(code);

      // Paragraph 3.2: after an error display the terminal resumes normal
      // operation upon any keystroke.
      driver.runSchedulerSlices(400);
      expect(driver.displayText()).toContain("ERROR");
      driver.pressKey("SPACE");
      driver.waitForDisplay("FUNCTION?", 2_000, 80, 10);
      driver.releaseKey("SPACE");
    }, 30_000);
  }

  it("boots cleanly again once the fault is repaired and power is cycled", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.machine.setFault("clock", true);
    driver.machine.reset();
    expect(driver.waitForDisplay("ERROR", 12_000, 80, 20)).toContain("CLOCK");

    driver.machine.setFault("clock", false);
    driver.machine.reset();
    expect(driver.bootUntilReady()).toContain("FUNCTION?");
    expect(driver.displayHistory().some((line) => line.includes("TERMINAL OK"))).toBe(true);
    expect(driver.machine.activeFaults()).toEqual([]);
  }, 30_000);
});
