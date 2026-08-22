import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { HeadlessDeviceDriver } from "./device-driver";
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
    expect(machine.iopCpu.readDirect(0x98) & 0x01).toBe(0);
    expect(machine.hardware.serial.pendingTransfers()).toHaveLength(1);

    machine.hardware.service();

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

  it("restores a preempted low-priority ISR after high-priority RETI", () => {
    const code = new Uint8Array(0x80);
    code.set([0x02, 0x00, 0x40], 0x0000);
    code.set([0x00, 0x00, 0x32], 0x000b); // high-priority Timer 0 ISR
    code.set([0x00, 0x00, 0x00, 0x32], 0x001b); // low-priority Timer 1 ISR
    code.set([
      0x75, 0x89, 0x22, // both timers mode 2
      0x75, 0x8c, 0xff, 0x75, 0x8a, 0xff,
      0x75, 0x8d, 0xff, 0x75, 0x8b, 0xff,
      0x75, 0xb8, 0x02, // Timer 0 high priority
      0x75, 0xa8, 0x8a, // EA|ET0|ET1
      0x75, 0x88, 0x50, // start both timers
      0x80, 0xfe
    ], 0x0040);
    const cpu = new MCS51(new ExternalBus(code));

    cpu.run(500);
    // At an arbitrary instruction boundary either ISR may still be active,
    // but nesting must stay bounded to low + one high-priority preemption.
    expect(cpu.sp).toBeLessThanOrEqual(0x0b);
  });

  it("halts on the undefined 0xA5 opcode", () => {
    const cpu = new MCS51(new ExternalBus(new Uint8Array([0xa5, 0x00])));

    const entry = cpu.step();

    expect(entry.text).toBe("DB 0xA5");
    expect(() => cpu.step()).toThrow(/halted/);
  });

  it("updates bit-addressable internal RAM and carry paths", () => {
    const cpu = new MCS51(new ExternalBus(new Uint8Array([0xd2, 0x05, 0xa2, 0x05, 0xc2, 0x05, 0x92, 0x06])));

    cpu.run(4);

    expect(cpu.readDirect(0x20) & 0x20).toBe(0);
    expect(cpu.readDirect(0x20) & 0x40).toBe(0x40);
    expect(cpu.snapshot().psw & 0x80).toBe(0x80);
  });

  it("does not advance timers configured as external counters without input edges", () => {
    const cpu = new MCS51(
      new ExternalBus(
        new Uint8Array([
          0x75, 0x89, 0x05, // MOV TMOD, #mode1 counter
          0x75, 0x8c, 0x12, // MOV TH0, #0x12
          0x75, 0x8a, 0x34, // MOV TL0, #0x34
          0xd2, 0x8c, // SETB TR0
          0x00,
          0x00
        ])
      )
    );

    cpu.run(6);

    expect(cpu.readDirect(0x8c)).toBe(0x12);
    expect(cpu.readDirect(0x8a)).toBe(0x34);
    expect(cpu.readDirect(0x88) & 0x20).toBe(0);
  });

  it("preserves serial RB8 mode bit state on receive", () => {
    const cpu = new MCS51(new ExternalBus(new Uint8Array([0x00])));

    cpu.writeDirect(0x98, 0x90);
    cpu.receiveSerial(0x66, true);
    expect(cpu.readDirect(0x99)).toBe(0x66);
    expect(cpu.readDirect(0x98) & 0x05).toBe(0x05);

    cpu.receiveSerial(0x77, false);
    expect(cpu.readDirect(0x99)).toBe(0x77);
    expect(cpu.readDirect(0x98) & 0x05).toBe(0x01);
  });

  it("dispatches a high-priority serial interrupt before a low-priority timer interrupt", () => {
    const cpu = new MCS51(new ExternalBus(new Uint8Array(0x40)));

    cpu.writeDirect(0xa8, 0x92); // EA | ET0 | ES
    cpu.writeDirect(0xb8, 0x10); // PS high priority
    cpu.writeDirect(0x88, 0x20); // TF0 pending
    cpu.writeDirect(0x98, 0x01); // RI pending
    cpu.step();

    expect(cpu.snapshot().pc).toBe(0x0023);
    expect(cpu.readDirect(0x88) & 0x20).toBe(0x20);
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

  it("can schedule both CPUs by device cycles with service ticks", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());

    machine.runForCycles(120, { serviceCycles: 12 });

    expect(machine.mainCpu.snapshot().cycles).toBeGreaterThanOrEqual(120);
    expect(machine.iopCpu.snapshot().cycles).toBeGreaterThanOrEqual(120);
    expect(machine.traceLog.events.filter((event) => event.kind === "scheduler")).toHaveLength(10);
  });

  it("saves and restores CPU and external memory state", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());
    machine.runForCycles(120);
    machine.mainBus.writeXdata(MAIN_XRAM_BASE, 0x5a);
    const saved = machine.saveState();

    machine.runForCycles(120);
    machine.mainBus.writeXdata(MAIN_XRAM_BASE, 0xa5);
    machine.loadState(saved);

    expect(machine.mainCpu.snapshot()).toMatchObject({
      pc: saved.mainCpu.pc,
      cycles: saved.mainCpu.cycles,
      a: saved.mainCpu.a,
      dptr: saved.mainCpu.dptr
    });
    expect(machine.mainBus.readXdata(MAIN_XRAM_BASE)).toBe(0x5a);
    expect(machine.iopCpu.snapshot().pc).toBe(saved.iopCpu.pc);
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
    machine.mainBus.writeXdata(0x7fe0 + text.length, 0x1e);
    machine.hardware.writeXdata("main", 0x7fe0 + text.length, 0x1e, "xram");

    expect(machine.hardware.display.displayLine().startsWith(`${text}^`)).toBe(true);
    expect(machine.hardware.display.textSnapshot().slice(0, 5)).toEqual([72, 69, 76, 76, 79]);
  });

  it("exposes front-panel key state through the main P3 input hook", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());

    // Idle: P3.5 (controller-ready) forced LOW for the main CPU self-test, P3.3
    // HIGH because no INT1 is in flight, P3.0 follows the latch HIGH default.
    expect(machine.mainCpu.readDirect(0xb0) & 0x20).toBe(0);
    expect(machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0x08);
    expect(machine.mainCpu.readDirect(0xb0) & 0x01).toBe(1);

    machine.hardware.keyboard.setPressed("1", true);
    expect(machine.hardware.keyboard.pressedKeys()).toEqual(["1"]);
    // The authentic controller drives P3.3 LOW the moment a key is depressed so the
    // main CPU's INT1 (P3.3 falling-edge) handler can fire on the next tick.
    expect(machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0);

    // Adding a second pressed key does NOT alter any P3 column bits - the IOP
    // chip drives 0x8400 + P3.3 directly, the legacy P1 row-select / P3 column
    // matrix model has been retired.
    machine.hardware.keyboard.setPressed("5", true);
    expect(machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0);

    machine.hardware.keyboard.setPressed("1", false);
    machine.hardware.keyboard.setPressed("5", false);
    machine.hardware.service();
    expect(machine.mainCpu.readDirect(0xb0) & 0x08).toBe(0x08);
  });

  it("keeps I/O processor peripheral XDATA in a named modem/radio model", async () => {
    const machine = new UA8295Machine(await loadTestRomSet());

    machine.hardware.writeXdata("iop", 0x1800, 0x5a);

    expect(machine.hardware.readXdata("iop", 0x1800, 0xff, "unmapped")).toBe(0x5a);
    expect(machine.hardware.modemRadio.snapshot()).toEqual([{ address: 0x1800, value: 0x5a }]);
  });
});

describe("authentic INT1 keyboard pipeline", () => {
  function captureFirmwareLookup(
    driver: HeadlessDeviceDriver,
    maxSlices = 6000
  ): { iramByte: number; readyBitObserved: boolean } {
    let readyBitObserved = false;
    let observedIramByte = driver.machine.mainCpu.iram[0x1c];
    for (let i = 0; i < maxSlices; i += 1) {
      driver.runSchedulerSlices(1, 1);
      const iram = driver.machine.mainCpu.iram;
      if ((iram[0x20] & 0x20) !== 0 && !readyBitObserved) {
        readyBitObserved = true;
        observedIramByte = iram[0x1c];
        return { iramByte: observedIramByte, readyBitObserved };
      }
    }
    return { iramByte: driver.machine.mainCpu.iram[0x1c], readyBitObserved };
  }

  it(
    "raises INT1 on a fresh key press and reaches the firmware lookup",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("SHORT_TERM");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x0d);
    },
    20_000
  );

  it(
    "firmware lookup produces ASCII for a digit key",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("1");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x31);
    },
    20_000
  );

  it(
    "firmware lookup produces the character-erase byte for DEL",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("DEL");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x5f);
    },
    20_000
  );

  it(
    "KeyboardScanController records strobe writes",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("SHORT_TERM");
      driver.runSchedulerSlices(40, 80);

      const strobes = driver.machine.hardware.keyboardScan.recentStrobes();
      expect(strobes.length).toBeGreaterThanOrEqual(8);
      expect(strobes.some((value) => (value & 0x80) !== 0)).toBe(true);
      expect(strobes.some((value) => (value & 0x80) === 0)).toBe(true);
    },
    20_000
  );

  it(
    "requires key release before re-firing INT1",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("SHORT_TERM");
      driver.runSchedulerSlices(40, 80);
      expect(driver.machine.mainCpu.iram[0x1c]).toBe(0x0d);

      // Stash a marker into iram[0x1C] so we can detect a re-arm. The firmware will
      // overwrite it via the lookup at 0x044A only if INT1 fires again.
      driver.machine.mainCpu.iram[0x1c] = 0xa5;
      driver.runSchedulerSlices(120, 80);
      expect(driver.machine.mainCpu.iram[0x1c]).toBe(0xa5);

      driver.releaseKey("SHORT_TERM");
      driver.runSchedulerSlices(40, 80);
      driver.pressKey("SHORT_TERM");
      driver.runSchedulerSlices(80, 80);
      expect(driver.machine.mainCpu.iram[0x1c]).toBe(0x0d);
    },
    20_000
  );

  it(
    "produces ASCII for letter A",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("A");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x41);
    },
    20_000
  );

  it(
    "produces ASCII for letter Z",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("Z");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x5a);
    },
    20_000
  );

  it(
    "produces space character for SPACE key",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("SPACE");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x20);
    },
    20_000
  );

  it(
    "produces the slash/accept byte for the = key",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("=");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x2f);
    },
    20_000
  );

  it(
    "SHIFT modifier produces the shifted byte (^+BRIGHT → TIME 0x9C)",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      // Press SHIFT first, then BRIGHT, so updateKeyboardScan sees both held when
      // it next services the scan controller.
      driver.pressKey("^");
      driver.pressKey("BRIGHT");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      expect(iramByte).toBe(0x9c);
    },
    20_000
  );

  it(
    "SHIFT held alone remains a modifier and does not arm a scan",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("^");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(false);
      expect(iramByte).toBe(0x00);
    },
    20_000
  );

  it(
    "SHIFT modifier triggers the firmware shift-A → '[' CJNE special",
    async () => {
      const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
      driver.runCoupledBoot();

      driver.pressKey("^");
      driver.pressKey("A");
      const { iramByte, readyBitObserved } = captureFirmwareLookup(driver);

      expect(readyBitObserved).toBe(true);
      // Raw 0xC1 (= 0x41 | 0x40 once bit 7 lookup adds the shift bit back) is
      // remapped at 0x043E to 0x5B '[' before being stored at iram[0x1C].
      expect(iramByte).toBe(0x5b);
    },
    20_000
  );

  it.todo("ON_OFF exercises the electrical power path rather than a firmware scan code");
});
