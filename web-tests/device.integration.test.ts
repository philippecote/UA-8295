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
    "drives main P3.3 from the keyboard scan controller at the FUNCTION prompt",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: true });
      driver.runCoupledBoot();
      const before = driver.displayText();

      // At idle the main CPU sees P3.3 HIGH because no INT1 is pending. The IOP
      // no longer sees the keyboard at all (the dedicated controller chip drives
      // 0x8400 + P3.3 directly), so its P3 lines do not change with key state.
      expect(driver.machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0x08);

      driver.pressKey("2");
      // Pressed but the scheduler has not run service() yet, so the keyboard
      // controller is still IDLE and the firmware has not started the handshake.
      // Per the authentic pipeline P3.3 on the main CPU is driven LOW the moment
      // the key is depressed, signalling a pending INT1 to the firmware.
      expect(driver.machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0);

      driver.releaseKey("2");
      expect(driver.machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0x08);

      expect(driver.displayText()).toHaveLength(MANUAL_EXPECTATIONS.displayWidth);
      expect(driver.displayText()).toBe(before);
      expect(MANUAL_EXPECTATIONS.keyboard.keys).toEqual(driver.keyNames());
    },
    15_000
  );

  it(
    "turns a front-panel function key into a ROM workflow prompt",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: true });
      driver.runCoupledBoot();

      driver.pressAndWaitForDisplay("ENCR", "GIVE NUMBER OR FUNCTION?");

      expect(driver.displayHistory().some((line) => line.includes("GIVE NUMBER OR FUNCTION?"))).toBe(true);
      expect(driver.displayText()).toContain("GIVE NUMBER OR FUNCTION");
    },
    30_000
  );

  it.each(MANUAL_EXPECTATIONS.keyboard.topLevelPrompts)(
    "maps %s to its first ROM prompt",
    async (key, prompt) => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressAndWaitForDisplay(key, prompt);

      expect(driver.displayHistory().some((line) => line.includes(prompt))).toBe(true);
    },
    30_000
  );

  it(
    "reaches the COORDINATES message-template prompt from a digit key",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressAndWaitForDisplay("1", MANUAL_EXPECTATIONS.keyboard.numericTopLevelPrompt);

      expect(
        driver.displayHistory().some((line) => line.includes(MANUAL_EXPECTATIONS.keyboard.numericTopLevelPrompt))
      ).toBe(true);
      expect(driver.machine.mainCpu.iram[0x1c]).toBe(MANUAL_EXPECTATIONS.keyboard.expectedIramByte["1"]);
    },
    30_000
  );

  it(
    "classifies workflow hardware gaps reached by real ROM prompts",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: true });
      driver.runCoupledBoot();

      // Pressing a function key enters the deeper dispatcher at 0x080D from the
      // post-prompt wait loop at 0x0735, where the firmware writes the
      // currently-unmapped storage tag at XDATA 0x0000.
      driver.pressAndWaitForDisplay("KEY", "PRIVATE ADDRESS:");

      const summary = driver.summary();
      expect(summary.hardwareGaps.some(([key]) => key.startsWith("main:external-control-latch:0x0000"))).toBe(true);
    },
    30_000
  );
});
