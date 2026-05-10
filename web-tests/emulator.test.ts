import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ExternalBus } from "../src/memory";
import { MCS51 } from "../src/mcs51";
import { ROM_SPECS, validateImage, type RomSet } from "../src/roms";
import { summarizeTraceEvents } from "../src/trace";
import { MAIN_XRAM_BASE, TEXT_ROM_BASE, UA8295Machine } from "../src/ua8295";

async function loadTestRomSet(): Promise<RomSet> {
  const entries = await Promise.all(
    Object.values(ROM_SPECS).map(async (spec) => {
      const data = new Uint8Array(await readFile(`Nokia_DA8520_firmware/${spec.filename}`));
      return [spec.key, await validateImage(spec, data)] as const;
    })
  );
  return Object.fromEntries(entries) as unknown as RomSet;
}

describe("browser MCS-51 core", () => {
  it("executes basic arithmetic and calls", () => {
    const cpu = new MCS51(new ExternalBus(new Uint8Array([0x12, 0x00, 0x05, 0x00, 0x00, 0x74, 0x41, 0x24, 0x01, 0x22])));
    cpu.step();
    expect(cpu.pc).toBe(5);
    cpu.step();
    cpu.step();
    expect(cpu.a).toBe(0x42);
    cpu.step();
    expect(cpu.pc).toBe(3);
  });

  it("loads validated ROMs and runs both CPUs", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());
    expect(machine.mainBus.readXdata(TEXT_ROM_BASE)).toBe(machine.roms.text.data[0]);
    machine.mainBus.writeXdata(MAIN_XRAM_BASE, 0x5a);
    expect(machine.mainBus.readXdata(MAIN_XRAM_BASE)).toBe(0x5a);
    expect(machine.mainBus.readXdata(0)).toBe(0xff);

    machine.mainCpu.run(1000);
    expect(machine.mainCpu.snapshot().cycles).toBeGreaterThan(1000);
    expect(machine.mainCpu.snapshot().pc).toBeGreaterThan(0);

    machine.iopCpu.run(1000);
    expect(machine.iopCpu.snapshot().cycles).toBeGreaterThan(1000);
    expect(machine.iopCpu.snapshot().pc).toBeGreaterThan(0);
  });

  it("links SBUF writes between the main CPU and I/O processor", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());

    machine.mainCpu.writeDirect(0x98, 0x90);
    machine.iopCpu.writeDirect(0x98, 0x90);
    machine.mainCpu.writeDirect(0x99, 0x42);

    expect(machine.mainCpu.readDirect(0x98) & 0x02).toBe(0x02);
    expect(machine.iopCpu.readDirect(0x99)).toBe(0x42);
    expect(machine.iopCpu.readDirect(0x98) & 0x01).toBe(0x01);
  });

  it("advances timers using instruction cycles", () => {
    const cpu = new MCS51(
      new ExternalBus(
        new Uint8Array([
          0x75, 0x89, 0x01, // MOV TMOD, #mode1
          0x75, 0x8c, 0xff, // MOV TH0, #0xFF
          0x75, 0x8a, 0xfe, // MOV TL0, #0xFE
          0xd2, 0x8c // SETB TCON.4 (TR0)
        ])
      )
    );

    cpu.run(4);
    expect(cpu.readDirect(0x88) & 0x20).toBe(0x20);
    expect(cpu.snapshot().cycles).toBeGreaterThan(4);
  });

  it("dispatches timer interrupts and returns with RETI", () => {
    const code = new Uint8Array(0x40);
    code.set([0x02, 0x00, 0x30], 0x0000); // LJMP init
    code.set([0x74, 0x55, 0x32], 0x000b); // MOV A,#0x55 ; RETI
    code.set(
      [
        0x75, 0x89, 0x01, // MOV TMOD, #mode1
        0x75, 0x8c, 0xff, // MOV TH0, #0xFF
        0x75, 0x8a, 0xfe, // MOV TL0, #0xFE
        0x75, 0xa8, 0x82, // MOV IE, #EA|ET0
        0xd2, 0x8c, // SETB TR0
        0x80, 0xfe // SJMP -2
      ],
      0x0030
    );
    const cpu = new MCS51(new ExternalBus(code));

    cpu.run(8);
    expect(cpu.a).toBe(0x55);
    expect(cpu.sp).toBe(0x07);
    expect(cpu.snapshot().pc).toBeGreaterThanOrEqual(0x003e);
  });

  it("discovers deterministic boot I/O surfaces", async () => {
    const machine = new UA8295Machine(await loadTestRomSet(), {
      cpuTrace: {
        traceAllXdata: true,
        traceSfrReads: true,
        traceSfrWrites: true
      }
    });

    machine.runScheduler(500, 2);
    const summary = summarizeTraceEvents(machine.traceLog.events);
    const sfrKeys = summary.sfr.map(([key]) => key).sort();
    const xdataKeys = summary.xdata.map(([key]) => key).sort();
    const schedulerEvents = machine.traceLog.events.filter((event) => event.kind === "scheduler");

    expect(machine.traceLog.events.length).toBeGreaterThan(0);
    expect(schedulerEvents).toHaveLength(500);
    expect(sfrKeys).toEqual([
      "iop:IE",
      "iop:IP",
      "iop:P1",
      "iop:P3",
      "iop:SCON",
      "iop:TCON",
      "iop:TH0",
      "iop:TH1",
      "iop:TMOD",
      "main:IE"
    ]);
    expect(xdataKeys).toEqual([]);
  });

  it("uses hardware port hooks to pass the main CPU self-test path", async () => {
    const machine = new UA8295Machine(await loadTestRomSet(), {
      cpuTrace: {
        traceAllXdata: true,
        traceSfrReads: true,
        traceSfrWrites: true
      }
    });

    machine.runCpu("main", 250_000);
    const displayRegisters = machine.hardware.display.snapshot();

    expect(machine.mainCpu.snapshot().pc).not.toBe(0x0078);
    expect(displayRegisters.some((value) => value !== 0)).toBe(true);
    expect(machine.hardware.display.displayLine()).toContain("840");
    expect(machine.hardware.display.detailLines().join(" ")).toContain("840E");
  });

  it("renders the firmware display buffer from 0x7FE0-0x7FFF", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());
    const text = "HELLO UA-8295";

    for (const [index, char] of [...text].entries()) {
      machine.mainBus.writeXdata(0x7fe0 + index, char.charCodeAt(0));
      machine.hardware.writeXdata("main", 0x7fe0 + index, char.charCodeAt(0), "xram");
    }

    expect(machine.hardware.display.displayLine().startsWith(text)).toBe(true);
    expect(machine.hardware.display.textSnapshot().slice(0, 5)).toEqual([72, 69, 76, 76, 79]);
  });

  it("exposes front-panel key state through the main P3 input hook", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());

    expect(machine.mainCpu.readDirect(0xb0) & 0x20).toBe(0);
    expect(machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0x08);
    expect(machine.mainCpu.readDirect(0xb0) & 0x01).toBe(1);

    machine.hardware.keyboard.setPressed("1", true);
    expect(machine.mainCpu.readDirect(0xb0) & 0x02).toBe(0);
    expect(machine.hardware.keyboard.pressedKeys()).toEqual(["1"]);

    machine.mainCpu.writeDirect(0x90, 0xfb);
    expect(machine.mainCpu.readDirect(0xb0) & 0x02).toBe(0);
    machine.mainCpu.writeDirect(0x90, 0xf7);
    expect(machine.mainCpu.readDirect(0xb0) & 0x02).toBe(0x02);
    machine.hardware.keyboard.setPressed("5", true);
    expect(machine.mainCpu.readDirect(0xb0) & 0x02).toBe(0);
    expect(machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0x08);
  });
});
