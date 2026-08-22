import { describe, expect, it } from "vitest";
import { UA8295LinkedPair, UA8295RadioLink } from "../src/radio-link";
import { UA8295Machine } from "../src/ua8295";
import { loadTestRomSet } from "./device-driver";

describe("UA-8295 terminal radio link", () => {
  it("derives the MESSAGE indicator from unread receive-directory records", async () => {
    const roms = await loadTestRomSet();
    const machine = new UA8295Machine(roms);

    expect(machine.receiveMessageIndicatorLit()).toBe(false);
    machine.mainBus.xram[1] = 0x26;
    machine.mainBus.xram[2] = 0x00;
    machine.mainBus.xram[3] = 0xfe;
    expect(machine.receiveMessageIndicatorLit()).toBe(true);
    machine.mainBus.xram[2] = 0x0c;
    expect(machine.receiveMessageIndicatorLit()).toBe(false);
    machine.mainBus.xram[4] = 0x40;
    machine.mainBus.xram[5] = 0x00;
    expect(machine.receiveMessageIndicatorLit()).toBe(true);
  });

  it("carries the IOP transmit waveform to the peer receive pin and detects collisions", async () => {
    const roms = await loadTestRomSet();
    const left = new UA8295Machine(roms);
    const right = new UA8295Machine(roms);
    const link = new UA8295RadioLink(left, right);

    // P3.4 low selects transmit. P3.6 is the mark/space waveform.
    left.iopCpu.writeDirect(0xb0, 0xef);
    link.service();
    expect(left.hardware.modemRadio.isTransmitting()).toBe(true);
    expect(right.hardware.modemRadio.hasCarrier()).toBe(true);
    expect(right.iopCpu.readDirect(0xb0) & 0x20).toBe(0x20);

    left.iopCpu.writeDirect(0xb0, 0xaf);
    link.service();
    expect(left.hardware.modemRadio.transmitMark()).toBe(false);
    expect(right.iopCpu.readDirect(0xb0) & 0x20).toBe(0);

    right.iopCpu.writeDirect(0xb0, 0xaf);
    link.service();
    expect(link.collision).toBe(true);
    expect(left.hardware.modemRadio.hasCarrier()).toBe(false);
    expect(right.hardware.modemRadio.hasCarrier()).toBe(false);
  });

  it("boots two complete dual-CPU terminals under one linked scheduler", async () => {
    const roms = await loadTestRomSet();
    const left = new UA8295Machine(roms);
    const right = new UA8295Machine(roms);
    left.traceLog.setRecording(false);
    right.traceLog.setRecording(false);
    const pair = new UA8295LinkedPair(left, right);

    for (let chunk = 0; chunk < 600; chunk += 1) {
      pair.runScheduler(20, 80, false);
      if (
        left.hardware.display.displayLine().includes("FUNCTION?") &&
        right.hardware.display.displayLine().includes("FUNCTION?")
      ) break;
    }

    expect(left.hardware.display.displayLine()).toContain("FUNCTION?");
    expect(right.hardware.display.displayLine()).toContain("FUNCTION?");
    expect(pair.link.status()).toBe("connected");
  }, 30_000);
});
