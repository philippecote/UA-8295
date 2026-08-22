import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { UA8295LinkedPair } from "../src/radio-link";
import { UA8295Machine } from "../src/ua8295";
import { loadTestRomSet } from "./device-driver";

describe("complete firmware transmission", () => {
  it("composes, encrypts, transmits, receives, decrypts and displays A to B", async () => {
    const roms = await loadTestRomSet();
    const left = new UA8295Machine(roms);
    const right = new UA8295Machine(roms);
    left.traceLog.setRecording(false);
    right.traceLog.setRecording(false);
    const pair = new UA8295LinkedPair(left, right);
    const run = (slices: number, steps = 80): void => { pair.runScheduler(slices, steps, false); };
    const press = (machine: UA8295Machine, key: FrontPanelKey, hold = 250, settle = 80): void => {
      machine.hardware.keyboard.setPressed(key, true);
      run(hold);
      machine.hardware.keyboard.setPressed(key, false);
      run(settle);
    };
    const pressShifted = (machine: UA8295Machine, key: FrontPanelKey): void => {
      machine.hardware.keyboard.setPressed("^", true);
      machine.hardware.keyboard.setPressed(key, true);
      run(250);
      machine.hardware.keyboard.setPressed(key, false);
      machine.hardware.keyboard.setPressed("^", false);
      run(80);
    };

    for (let chunk = 0; chunk < 600; chunk += 1) {
      run(20);
      if (left.hardware.display.displayLine().includes("FUNCTION?") && right.hardware.display.displayLine().includes("FUNCTION?")) break;
    }
    expect(left.hardware.display.displayLine()).toContain("FUNCTION?");
    expect(right.hardware.display.displayLine()).toContain("FUNCTION?");

    // SHIFT+CONF loads the firmware's defaults, including matching crypto
    // settings and broadcast receiver address 00.
    for (const machine of [left, right]) {
      pressShifted(machine, "CONF");
      press(machine, "SHORT_TERM");
    }

    for (const key of ["0", "H", "I"] as FrontPanelKey[]) press(left, key);
    press(left, "SHORT_TERM");
    press(left, "SEND");
    press(left, "0");
    press(left, "0");
    press(left, "=", 600, 100);

    let sawTransmit = false;
    for (let chunk = 0; chunk < 12_000; chunk += 1) {
      run(10, 40);
      sawTransmit ||= left.hardware.modemRadio.isTransmitting();
      if (sawTransmit && !left.hardware.modemRadio.isTransmitting() && left.mainCpu.iram[0x1f] === 0) break;
    }
    expect(sawTransmit).toBe(true);
    expect(left.hardware.display.displayLine()).toContain("SENT");

    press(right, "DISPL", 400, 100);
    expect(right.hardware.display.displayLine()).toContain("MESSAGE 1");
    press(right, "1", 400, 100);
    expect(right.hardware.display.displayLine()).toContain("MSG1");
    press(right, "SCROLL_LEFT", 400, 100);
    expect(right.hardware.display.displayLine().trim()).toBe("HI");
    expect([...right.mainBus.xram].some((byte, index, ram) => byte === 0x08 && ram[index + 1] === 0x09)).toBe(true);
  }, 60_000);
});
