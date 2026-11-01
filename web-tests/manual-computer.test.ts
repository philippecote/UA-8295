import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { decodeSerialSettings } from "../src/serial-port";
import type { UA8295Machine } from "../src/ua8295";
import { HeadlessDeviceDriver } from "./device-driver";
import { configurePrivateAddress, createLinkedContext } from "./linked-driver";

// Computer-port frames (main code 0x1612): LF, a command character, a two-digit
// hex length, that many data characters, a two-digit hex checksum of every
// character from the command through the data, and CR. "LF 2 CR" and
// "LF 1 CR" are the short ACK and NAK frames.
function frame(command: string, data = ""): string {
  const length = data.length.toString(16).toUpperCase().padStart(2, "0");
  const body = `${command}${length}${data}`;
  const checksum = [...body].reduce((sum, character) => sum + character.charCodeAt(0), 0) & 0xff;
  return `\n${body}${checksum.toString(16).toUpperCase().padStart(2, "0")}\r`;
}

const ACK = "\n2\r";
const NAK = "\n1\r";

function attachComputer(machine: UA8295Machine): void {
  const computer = machine.hardware.computer;
  computer.settings = decodeSerialSettings(machine.mainBus.xram[0x130f], "computer");
  computer.characterGapBits = 4;
}

function computerOutput(machine: UA8295Machine): string {
  return machine.hardware.computer.received().map(({ character }) => character).join("");
}

function press(driver: HeadlessDeviceDriver, key: FrontPanelKey, shifted = false): void {
  if (shifted) driver.pressKey("^");
  driver.pressKey(key);
  driver.runSchedulerSlices(250);
  driver.releaseKey(key);
  if (shifted) driver.releaseKey("^");
  driver.runSchedulerSlices(80);
}

describe("manual section 3.2.16 external computer", () => {
  it("enters remote mode with SHIFT+R, rejects unknown commands and returns on the exit command", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    driver.runCoupledBoot();
    press(driver, "CONF", true);
    press(driver, "SHORT_TERM");
    attachComputer(driver.machine);
    expect(driver.machine.hardware.computer.settings).toEqual({ baud: 1200, format: "ascii", parity: "space" });

    press(driver, "R", true);
    driver.waitForCondition("remote-mode announcement", () => computerOutput(driver.machine) === frame("8"), 4_000);

    const computer = driver.machine.hardware.computer;
    computer.clearReceived();
    computer.send(frame("9"));
    driver.waitForCondition("NAK", () => computerOutput(driver.machine) === NAK, 8_000);

    // A frame with a wrong checksum is ignored.
    computer.clearReceived();
    computer.send("\n50000\r");
    driver.runSchedulerSlices(3_000);
    expect(computerOutput(driver.machine)).toBe("");
    expect(driver.machine.mainCpu.iram[0x24] & 0x04).toBe(0x04);

    // The display keeps its last prompt in remote mode; leaving restarts the
    // terminal through its check-out display.
    computer.send(frame("5"));
    driver.waitForCondition("leaving remote mode", () => (driver.machine.mainCpu.iram[0x24] & 0x04) === 0, 8_000);
    driver.waitForDisplay("TERMINAL OK", 8_000);
  }, 60_000);

  it("transmits a computer-supplied message and uploads it to the receiving computer", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");
    for (const machine of [context.left, context.right]) {
      attachComputer(machine);
      context.press(machine, "R", true);
    }
    context.run(2_000);
    expect(computerOutput(context.left)).toBe(frame("8"));
    expect(computerOutput(context.right)).toBe(frame("8"));
    context.left.hardware.computer.clearReceived();
    context.right.hardware.computer.clearReceived();

    // Receiver address 12, then the text.
    context.left.hardware.computer.send(frame("0", "12HI"));
    let rightUpload = "";
    for (let chunk = 0; chunk < 20_000; chunk += 1) {
      context.run(10, 40);
      rightUpload = computerOutput(context.right);
      if (rightUpload.endsWith("\r") && rightUpload.length > 1) break;
    }
    expect(computerOutput(context.left).startsWith(ACK)).toBe(true);

    // The receiving terminal hands its stored message to its computer, which
    // acknowledges it; the terminal then deletes it from receive memory.
    expect(rightUpload.startsWith("\n0")).toBe(true);
    expect(rightUpload).toContain("34");
    expect(rightUpload).toContain("HI");
    expect(context.right.mainBus.xram[1]).toBe(0x26);
    context.right.hardware.computer.send(ACK);
    for (let chunk = 0; chunk < 4_000 && context.right.mainBus.xram[1] === 0x26; chunk += 1) context.run(10, 40);
    expect(context.right.mainBus.xram[1]).not.toBe(0x26);

    // The sender reports the automatic acknowledgement with status frame 4
    // and repeats it until its computer acknowledges.
    for (let chunk = 0; chunk < 20_000 && !computerOutput(context.left).includes(frame("4")); chunk += 1) context.run(10, 40);
    expect(computerOutput(context.left)).toContain(frame("4"));
    context.left.hardware.computer.send(ACK);
    context.run(2_000, 40);
  }, 300_000);
});
