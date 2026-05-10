import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ExternalBus } from "../src/memory";
import { MCS51 } from "../src/mcs51";
import { ROM_SPECS, validateImage, type RomSet } from "../src/roms";
import { summarizeTraceEvents } from "../src/trace";
import { TEXT_ROM_BASE, UA8295Machine } from "../src/ua8295";

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

    machine.mainCpu.run(1000);
    expect(machine.mainCpu.snapshot().cycles).toBe(1000);
    expect(machine.mainCpu.snapshot().pc).toBeGreaterThan(0);

    machine.iopCpu.run(1000);
    expect(machine.iopCpu.snapshot().cycles).toBe(1000);
    expect(machine.iopCpu.snapshot().pc).toBeGreaterThan(0);
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
});
