import { expect, it } from "vitest";
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

function editorPointer(driver: HeadlessDeviceDriver): number {
  const iram = driver.machine.mainCpu.iram;
  return (iram[0x44] << 8) | iram[0x45];
}

it(
  "supports long-message scrolling, held repeat, BEGIN, END, and line breaks",
  async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();

    for (const key of ["0", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] as FrontPanelKey[]) {
      press(driver, key);
    }

    expect(driver.displayText()).toContain("VWXYZ0123456789*");

    press(driver, "SCROLL_LEFT");
    expect(driver.displayText()).toContain("UVWXYZ012345678*9");

    press(driver, "SCROLL_RIGHT");
    expect(driver.displayText()).toContain("VWXYZ0123456789*");

    press(driver, "=");
    expect(driver.displayText()).toContain("WXYZ0123456789/*");
    expect([...driver.machine.mainBus.xram.slice(0x800, 0x850)]).toContain(0x2f);

    press(driver, "SCROLL_LEFT", true);
    expect(driver.displayText()).toContain("*ABCDEFGHIJKLMNOP");

    press(driver, "SCROLL_RIGHT", true);
    expect(driver.displayText()).toContain("*VWXYZ0123456789/");

    const beforeRepeat = editorPointer(driver);
    driver.pressKey("SCROLL_LEFT");
    driver.runSchedulerSlices(5_000);
    driver.releaseKey("SCROLL_LEFT");
    driver.runSchedulerSlices(80);
    const repeatedMoves = beforeRepeat - editorPointer(driver);

    expect(repeatedMoves).toBeGreaterThan(1);
  },
  90_000
);

it(
  "DEL erases a character so replacement text closes the gap",
  async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();

    for (const key of ["0", "A", "B", "C", "DEL", "X"] as FrontPanelKey[]) {
      press(driver, key);
    }

    expect(driver.displayText()).toContain("ABX*");
    expect([...driver.machine.mainBus.xram.slice(0x800, 0x808)]).toEqual([
      0xfe, 0xff, 0x01, 0x02, 0x18, 0xff, 0xff, 0xff
    ]);
  },
  20_000
);
