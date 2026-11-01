import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { decodeSerialSettings } from "../src/serial-port";
import { HeadlessDeviceDriver } from "./device-driver";

// Interface settings bytes in battery-backed SRAM (XDATA 0x730D-0x730F).
const PRINTER_MODE = 0x130d;
const PRINTER_INTERFACE = 0x130e;

function press(driver: HeadlessDeviceDriver, key: FrontPanelKey, shifted = false): void {
  if (shifted) driver.pressKey("^");
  driver.pressKey(key);
  driver.runSchedulerSlices(250);
  driver.releaseKey(key);
  if (shifted) driver.releaseKey("^");
  driver.runSchedulerSlices(80);
}

function composeFree(driver: HeadlessDeviceDriver, text: string): void {
  press(driver, "0");
  for (const character of text) press(driver, character === " " ? "SPACE" : character as FrontPanelKey);
  press(driver, "SHORT_TERM");
}

/** Boot with the ROM defaults and set the printer to match the terminal's PRTR-I page. */
async function bootWithPrinter(): Promise<HeadlessDeviceDriver> {
  const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
  driver.runCoupledBoot();
  press(driver, "CONF", true);
  press(driver, "SHORT_TERM");
  matchPrinterToTerminal(driver);
  return driver;
}

function matchPrinterToTerminal(driver: HeadlessDeviceDriver): void {
  driver.machine.hardware.printer.settings = decodeSerialSettings(driver.machine.mainBus.xram[PRINTER_INTERFACE]);
}

function runUntilPrinterIdle(driver: HeadlessDeviceDriver, maxSlices = 200_000): string {
  const printer = driver.machine.hardware.printer;
  let idleSlices = 0;
  let lastCount = -1;
  for (let slice = 0; slice < maxSlices && idleSlices < 3_000; slice += 100) {
    driver.runSchedulerSlices(100);
    const count = printer.received().length;
    idleSlices = count > 0 && count === lastCount ? idleSlices + 100 : 0;
    lastCount = count;
  }
  return printer.transcript();
}

describe("manual section 3.2.15 printer", () => {
  it("prints the displayed message with the PRINT key at the configured speed and parity", async () => {
    const driver = await bootWithPrinter();
    expect(driver.machine.hardware.printer.settings).toEqual({ baud: 300, format: "ascii", parity: "space" });
    composeFree(driver, "HI");
    press(driver, "0");
    expect(driver.displayText()).toContain("*HI");

    press(driver, "INPUT_PRINT");
    expect(runUntilPrinterIdle(driver)).toBe("\nHI.\n");
    const received = driver.machine.hardware.printer.received();
    expect(received.every(({ framingError, parityError }) => !framingError && !parityError)).toBe(true);
  }, 60_000);

  it("holds output while the printer signals BUSY", async () => {
    const driver = await bootWithPrinter();
    composeFree(driver, "OK");
    press(driver, "0");
    driver.machine.hardware.printer.busy = true;
    press(driver, "INPUT_PRINT");
    driver.runSchedulerSlices(4_000);
    expect(driver.machine.hardware.printer.received()).toHaveLength(0);

    driver.machine.hardware.printer.busy = false;
    expect(runUntilPrinterIdle(driver)).toBe("\nOK.\n");
  }, 60_000);

  it("prints off-line ciphertext when printer output is requested", async () => {
    const driver = await bootWithPrinter();
    composeFree(driver, "HELLO");
    press(driver, "0");
    press(driver, "ENCR", true);
    expect(driver.displayText()).toContain("PRINTER OUTPUT (Y/N)?");
    press(driver, "Y");
    const printed = runUntilPrinterIdle(driver);
    const groups = printed.trim().split(/\s+/);
    expect(groups).toHaveLength(3);
    for (const group of groups) expect(group).toMatch(/^[A-Z]{5}$/);
    expect(driver.displayText()).toContain(groups.join(" "));
  }, 60_000);

  it("feeds a free-format message from a printer terminal with echo control and erase", async () => {
    const driver = await bootWithPrinter();
    const printer = driver.machine.hardware.printer;
    press(driver, "0");
    press(driver, "INPUT_PRINT", true);
    expect(driver.machine.mainCpu.iram[0x20] & 0x04).toBe(0x04);

    // CTRL-O starts echoing, DEL erases the previous character, CTRL-N stops
    // echoing and CTRL-C terminates the input operation. Characters are typed
    // one at a time, as on a printer terminal keyboard.
    for (const character of "\x0fABC\x7fD\x0eEF\x03") {
      printer.send(character);
      driver.waitForCondition("printer keystroke", () => printer.pendingInput() === 0, 20_000);
      driver.runSchedulerSlices(1_000);
    }
    expect(driver.machine.mainCpu.iram[0x20] & 0x04).toBe(0);

    expect(printer.transcript()).toBe("ABC_D");
    expect(driver.displayText()).toContain("*ABDEF");
  }, 60_000);

  it("prints in 50-baud ITA2 telex mode", async () => {
    const driver = await bootWithPrinter();
    press(driver, "CONF");
    for (let page = 0; page < 10; page += 1) press(driver, "=");
    expect(driver.displayText()).toContain("PRINTER I/F:");
    press(driver, "T");
    expect(driver.displayText()).toContain("TELEX");
    press(driver, "SHORT_TERM");
    matchPrinterToTerminal(driver);
    expect(driver.machine.hardware.printer.settings.format).toBe("telex");

    composeFree(driver, "HI 42");
    press(driver, "0");
    press(driver, "INPUT_PRINT");
    expect(runUntilPrinterIdle(driver)).toBe("\nHI 42.\n");
  }, 120_000);

  it("prints every transmitted message automatically in XMT mode", async () => {
    const driver = await bootWithPrinter();
    press(driver, "CONF");
    for (let page = 0; page < 9; page += 1) press(driver, "=");
    while (!/PRINTER:XMT {2}/.test(driver.displayText())) press(driver, "DEL");
    press(driver, "SHORT_TERM");
    expect(driver.machine.mainBus.xram[PRINTER_MODE] & 0x0f).toBe(0x02);

    composeFree(driver, "HI");
    press(driver, "SEND");
    press(driver, "1");
    press(driver, "2");
    press(driver, "=");
    expect(runUntilPrinterIdle(driver)).toBe("\nTRANSMITTED TO STATION, TIME: 12 0000\nHI.\n");
    expect(driver.displayText()).toContain("SENT");
  }, 120_000);
});
