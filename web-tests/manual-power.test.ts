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

async function bootWithSupply(): Promise<HeadlessDeviceDriver> {
  const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
  driver.machine.hardware.charger.externalSupply = true;
  driver.runCoupledBoot();
  return driver;
}

/** Feed the charger timer one INT0 pulse at a time until the ROM ends charging. */
function runChargeTimer(driver: HeadlessDeviceDriver, maxPulses: number): number {
  const charger = driver.machine.hardware.charger;
  for (let pulse = 1; pulse <= maxPulses; pulse += 1) {
    driver.machine.hardware.advanceSeconds(1);
    driver.runSchedulerSlices(1, 60);
    if (charger.mode() === "off") return pulse;
  }
  return Number.POSITIVE_INFINITY;
}

describe("manual section 3.2.1 switching on and off", () => {
  it("blanks the terminal when switched off and repeats the check-out with SRAM retained", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    press(driver, "0");
    for (const key of ["O", "K"] as FrontPanelKey[]) press(driver, key);
    press(driver, "SHORT_TERM");
    const sram = [...driver.machine.mainBus.xram.slice(0, 0x1fe0)];

    driver.machine.setPowered(false);
    driver.runSchedulerSlices(200);
    expect(driver.machine.isPowered()).toBe(false);
    expect(driver.displayText().trim()).toBe("");

    driver.machine.setPowered(true);
    driver.waitForDisplay("TERMINAL OK", 12_000, 80, 20);
    driver.bootUntilReady();
    expect([...driver.machine.mainBus.xram.slice(0, 0x1fe0)]).toEqual(sram);
  }, 30_000);
});

describe("manual section 3.3.1 terminal does not respond when switched on", () => {
  it("stays dark on a flat battery until an external supply is connected", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    const charger = driver.machine.hardware.charger;
    driver.machine.setPowered(false);
    charger.battery = "flat";
    driver.machine.setPowered(true);
    expect(driver.machine.isPowered()).toBe(false);
    driver.runSchedulerSlices(400);
    expect(driver.displayText().trim()).toBe("");

    charger.externalSupply = true;
    driver.machine.setPowered(true);
    expect(driver.machine.isPowered()).toBe(true);
    driver.waitForDisplay("TERMINAL OK", 12_000, 80, 20);
  }, 30_000);
});

describe("manual section 3.2.2 battery charging", () => {
  it("selects normal charging, which continues until the sequence is repeated", async () => {
    const driver = await bootWithSupply();
    const charger = driver.machine.hardware.charger;
    expect(charger.isCharging()).toBe(false);

    press(driver, "C", true);
    expect(driver.displayText()).toContain("CHARGING (Y/N)");
    press(driver, "Y");
    // The prompt's trailing "?" is the blinking cursor.
    driver.waitForDisplay("FUNCTION");
    expect(charger.mode()).toBe("normal");
    expect(charger.isCharging()).toBe(true);
    expect(runChargeTimer(driver, 40)).toBe(Number.POSITIVE_INFINITY);
    expect(charger.mode()).toBe("normal");

    // Repeating the sequence and declining every mode terminates charging.
    press(driver, "C", true);
    expect(charger.mode()).toBe("off");
    press(driver, "N");
    expect(driver.displayText()).toContain("QUICK CHARGING (Y/N)");
    press(driver, "N");
    expect(driver.displayText()).toContain("FAST CHARGING (Y/N)");
    press(driver, "N");
    expect(driver.displayText()).toContain("NO CHARGING");
    expect(charger.isCharging()).toBe(false);
  }, 60_000);

  it("ends fast charging automatically after the ROM's 512 timer pulses", async () => {
    const driver = await bootWithSupply();
    press(driver, "C", true);
    press(driver, "N");
    press(driver, "N");
    expect(driver.displayText()).toContain("FAST CHARGING (Y/N)");
    press(driver, "Y");
    expect(driver.machine.hardware.charger.mode()).toBe("fast");
    expect(runChargeTimer(driver, 600)).toBe(0x0200);
    expect(driver.machine.hardware.charger.isCharging()).toBe(false);
  }, 60_000);

  it("ends quick charging automatically after the ROM's 6,912 timer pulses", async () => {
    const driver = await bootWithSupply();
    press(driver, "C", true);
    press(driver, "N");
    expect(driver.displayText()).toContain("QUICK CHARGING (Y/N)");
    press(driver, "Y");
    expect(driver.machine.hardware.charger.mode()).toBe("quick");
    expect(runChargeTimer(driver, 7_000)).toBe(0x1b00);
  }, 120_000);

  it("lights the CHARGE indicator only while an external supply is connected", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    press(driver, "C", true);
    press(driver, "Y");
    const charger = driver.machine.hardware.charger;
    expect(charger.mode()).toBe("normal");
    expect(charger.isCharging()).toBe(false);
    charger.externalSupply = true;
    expect(charger.isCharging()).toBe(true);
  }, 30_000);
});
