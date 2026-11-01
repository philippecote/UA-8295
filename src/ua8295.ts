import { UA8295Hardware } from "./devices";
import { ExternalBus } from "./memory";
import { MCS51, type CpuTraceOptions, type MCS51State, type TraceEntry } from "./mcs51";
import { mainCode, type RomSet } from "./roms";
import { TraceLog, type CpuName } from "./trace";

export const MAIN_XRAM_SIZE = 0x2000;
export const MAIN_XRAM_BASE = 0x6000;
export const IOP_XRAM_SIZE = 0x0800;
export const TEXT_ROM_BASE = 0x8000;

/**
 * Faults the initial check-out (manual Section 3, paragraph 3.2) can detect.
 * Each is injected at the hardware boundary; the original ROMs perform the
 * checksums, SRAM and timer tests, and IOP handshake that report them.
 */
export type HardwareFault = "main-rom-low" | "main-rom-high" | "sram" | "clock" | "modem-processor" | "modem-rom";

export const HARDWARE_FAULTS: Record<HardwareFault, { label: string; errorCode: string }> = {
  "main-rom-low": { label: "IC24 main program EPROM", errorCode: "PR1" },
  "main-rom-high": { label: "IC18 main program EPROM", errorCode: "PR2" },
  sram: { label: "SRAM address line A12 open", errorCode: "RAM" },
  clock: { label: "Display/timer oscillator stopped", errorCode: "CLOCK" },
  "modem-processor": { label: "Modem processor held in reset", errorCode: "MOD" },
  "modem-rom": { label: "IC03 modem program EPROM", errorCode: "PRM" }
};

// Corrupted bytes sit in unused 0xFF filler so the faulty image still runs and
// only the firmware's own additive EPROM checksums can notice the change.
const ROM_FAULT_BYTES: Partial<Record<HardwareFault, { cpu: CpuName; address: number }>> = {
  "main-rom-low": { cpu: "main", address: 0x000e },
  "main-rom-high": { cpu: "main", address: 0x3800 },
  "modem-rom": { cpu: "iop", address: 0x1000 }
};

export interface UA8295MachineOptions {
  traceLog?: TraceLog;
  cpuTrace?: CpuTraceOptions;
}

export interface SchedulerRunResult {
  main: TraceEntry[];
  iop: TraceEntry[];
}

export interface CycleSchedulerOptions {
  mainRatio?: number;
  iopRatio?: number;
  serviceCycles?: number;
  trace?: boolean;
}

export interface UA8295MachineState {
  mainCpu: MCS51State;
  iopCpu: MCS51State;
  mainXram: number[];
  iopXram: number[];
  schedulerSlices: number;
}

export class UA8295Machine {
  readonly mainBus: ExternalBus;
  readonly iopBus: ExternalBus;
  readonly mainCpu: MCS51;
  readonly iopCpu: MCS51;
  readonly traceLog: TraceLog;
  readonly traceOptions: Required<CpuTraceOptions>;
  readonly hardware: UA8295Hardware;
  private schedulerSlices = 0;
  private readonly faults = new Set<HardwareFault>();
  private powered = true;

  constructor(
    readonly roms: RomSet,
    options: UA8295MachineOptions = {}
  ) {
    this.traceLog = options.traceLog ?? new TraceLog();
    this.traceOptions = {
      traceAllXdata: false,
      traceSfrReads: true,
      traceSfrWrites: true,
      ...options.cpuTrace
    };
    this.hardware = new UA8295Hardware();
    // The day's-key routines (0x1A9A, 0x1C79) read the key back from SRAM with
    // MOVC, so the SRAM window is decoded in code space as well as data space.
    this.mainBus = new ExternalBus(mainCode(roms), {
      xramBase: MAIN_XRAM_BASE,
      xramSize: MAIN_XRAM_SIZE,
      textRom: roms.text.data,
      xramInCodeSpace: true
    });
    this.iopBus = new ExternalBus(roms.iop.data, { xramSize: IOP_XRAM_SIZE });
    this.mainCpu = new MCS51(this.mainBus, "main", this.traceLog, this.traceOptions, this.hardware);
    this.iopCpu = new MCS51(this.iopBus, "iop", this.traceLog, this.traceOptions, this.hardware);
    this.hardware.connectSerialEndpoints(this.mainCpu, this.iopCpu);
  }

  cpu(name: CpuName): MCS51 {
    return name === "main" ? this.mainCpu : this.iopCpu;
  }

  /**
   * The receive-memory directory stores up to eight variable-length records.
   * Each record starts with its type byte and is terminated by 0xFE; bit 2 of
   * the following status byte is set after the operator has displayed the
   * complete body. This is the firmware state that drives the MESSAGE lamp.
   */
  receiveMessageIndicatorLit(): boolean {
    let recordOffset = 1;
    for (let message = 0; message < 8; message += 1) {
      if (this.mainBus.xram[recordOffset] === 0x00 || this.mainBus.xram[recordOffset] === 0xff) return false;
      if ((this.mainBus.xram[recordOffset + 1] & 0x04) === 0) return true;
      while (recordOffset < this.mainBus.xram.length && this.mainBus.xram[recordOffset] !== 0xfe) {
        recordOffset += 1;
      }
      recordOffset += 1;
    }
    return false;
  }

  hasFault(fault: HardwareFault): boolean {
    return this.faults.has(fault);
  }

  activeFaults(): HardwareFault[] {
    return [...this.faults];
  }

  /**
   * Inject or repair a hardware fault. The firmware only reports faults during
   * its power-up check-out, so callers normally follow this with reset().
   */
  setFault(fault: HardwareFault, active: boolean): void {
    if (this.faults.has(fault) === active) return;
    if (active) this.faults.add(fault);
    else this.faults.delete(fault);
    const romByte = ROM_FAULT_BYTES[fault];
    if (romByte) {
      this.cpu(romByte.cpu).bus.codeMem[romByte.address] ^= 0x01;
      return;
    }
    switch (fault) {
      case "sram":
        this.mainBus.xramAddressMask = active ? 0xefff : 0xffff;
        return;
      case "clock":
        this.hardware.clock.stopped = active;
        return;
      case "modem-processor":
        this.iopCpu.stalled = active;
        return;
    }
  }

  reset(): void {
    this.resetCpus();
    this.hardware.reset();
  }

  isPowered(): boolean {
    return this.powered;
  }

  /**
   * The ON/OFF switch (manual Section 3, paragraph 2.1). Switching off stops
   * both processors and blanks the display; battery-backed SRAM and the
   * real-time counter are retained. Switching on runs the power-up check-out.
   */
  setPowered(on: boolean): void {
    if (this.powered === on) return;
    if (on && !this.hardware.charger.canPowerTerminal()) return;
    this.powered = on;
    this.hardware.display.powered = on;
    if (!on) {
      // Removing power drops the modem's transmit key and any held keys.
      this.hardware.modemRadio.reset();
      this.hardware.keyboard.clear();
      return;
    }
    this.resetCpus();
    this.hardware.reset({ retainClock: true });
  }

  private resetCpus(): void {
    this.mainCpu.reset();
    this.iopCpu.reset();
    this.traceLog.clear();
    this.schedulerSlices = 0;
  }

  saveState(): UA8295MachineState {
    return {
      mainCpu: this.mainCpu.saveState(),
      iopCpu: this.iopCpu.saveState(),
      mainXram: [...this.mainBus.xram],
      iopXram: [...this.iopBus.xram],
      schedulerSlices: this.schedulerSlices
    };
  }

  loadState(state: UA8295MachineState): void {
    this.mainCpu.loadState(state.mainCpu);
    this.iopCpu.loadState(state.iopCpu);
    this.mainBus.xram.set(state.mainXram.slice(0, this.mainBus.xram.length));
    this.iopBus.xram.set(state.iopXram.slice(0, this.iopBus.xram.length));
    this.schedulerSlices = state.schedulerSlices;
  }

  stepCpu(name: CpuName): TraceEntry {
    return this.cpu(name).step();
  }

  runCpu(name: CpuName, steps: number, trace = false): TraceEntry[] {
    if (!this.powered) {
      this.cpu(name).cycles += steps;
      return [];
    }
    return this.cpu(name).run(steps, trace);
  }

  runScheduler(slices: number, stepsPerCpu = 1, trace = false): SchedulerRunResult {
    const result: SchedulerRunResult = { main: [], iop: [] };
    if (!this.powered) return result;
    for (let index = 0; index < slices; index += 1) {
      this.schedulerSlices += 1;
      this.traceLog.record({
        kind: "scheduler",
        cpu: "device",
        pc: 0,
        cycle: this.schedulerSlices,
        operation: "slice",
        steps: stepsPerCpu
      });
      this.hardware.service();
      const mainCyclesBefore = this.mainCpu.snapshot().cycles;
      result.main.push(...this.mainCpu.run(stepsPerCpu, trace));
      result.iop.push(...this.iopCpu.run(stepsPerCpu, trace));
      this.hardware.advanceCpuCycles(this.mainCpu.snapshot().cycles - mainCyclesBefore);
    }
    return result;
  }

  runForCycles(deviceCycles: number, options: CycleSchedulerOptions = {}): SchedulerRunResult {
    const result: SchedulerRunResult = { main: [], iop: [] };
    const serviceCycles = Math.max(1, Math.floor(options.serviceCycles ?? 12));
    const mainRatio = options.mainRatio ?? 1;
    const iopRatio = options.iopRatio ?? 1;
    const trace = options.trace ?? false;
    if (!this.powered) return result;

    for (let elapsed = 0; elapsed < deviceCycles; elapsed += serviceCycles) {
      const tickCycles = Math.min(serviceCycles, deviceCycles - elapsed);
      this.schedulerSlices += 1;
      this.traceLog.record({
        kind: "scheduler",
        cpu: "device",
        pc: 0,
        cycle: this.schedulerSlices,
        operation: "slice",
        steps: tickCycles
      });
      this.hardware.service();
      const mainCyclesBefore = this.mainCpu.snapshot().cycles;
      result.main.push(...this.runCpuForCycles(this.mainCpu, tickCycles * mainRatio, trace));
      result.iop.push(...this.runCpuForCycles(this.iopCpu, tickCycles * iopRatio, trace));
      this.hardware.advanceCpuCycles(this.mainCpu.snapshot().cycles - mainCyclesBefore);
    }

    return result;
  }

  describeMemoryMap(): string[] {
    return [
      "main code 0x0000-0x1FFF: IC24 lower firmware EPROM",
      "main code 0x2000-0x3FFF: IC18 upper firmware EPROM",
      `main xdata 0x${MAIN_XRAM_BASE.toString(16).toUpperCase()}-0x${(MAIN_XRAM_BASE + MAIN_XRAM_SIZE - 1).toString(16).toUpperCase()}: emulated SRAM`,
      `main xdata 0x${TEXT_ROM_BASE.toString(16).toUpperCase()}-0x${(TEXT_ROM_BASE + this.roms.text.data.length - 1).toString(16).toUpperCase()}: IC15 text ROM`,
      "main xdata other addresses: traceable keyboard/display/serial/radio stubs",
      "iop code 0x0000-0x1FFF: IC03 I/O processor firmware EPROM",
      `iop xdata 0x0000-0x${(IOP_XRAM_SIZE - 1).toString(16).toUpperCase().padStart(4, "0")}: scratch RAM`,
      "iop xdata other addresses: traceable modem/peripheral stubs"
    ];
  }

  private runCpuForCycles(cpu: MCS51, targetCycles: number, trace: boolean): TraceEntry[] {
    const entries: TraceEntry[] = [];
    const startCycles = cpu.snapshot().cycles;
    while (cpu.snapshot().cycles - startCycles < targetCycles) {
      const entry = cpu.step(trace);
      if (trace) entries.push(entry);
    }
    return entries;
  }
}
