import { readFile } from "node:fs/promises";
import { FRONT_PANEL_KEYS, type FrontPanelKey } from "../src/devices";
import { ROM_SPECS, validateImage, type RomSet } from "../src/roms";
import { type DeviceTraceEvent, summarizeTraceEvents } from "../src/trace";
import { TraceLog } from "../src/trace";
import { UA8295Machine } from "../src/ua8295";

export async function loadTestRomSet(): Promise<RomSet> {
  const entries = await Promise.all(
    Object.values(ROM_SPECS).map(async (spec) => {
      const data = new Uint8Array(await readFile(`Nokia_DA8520_firmware/${spec.filename}`));
      return [spec.key, await validateImage(spec, data)] as const;
    })
  );
  return Object.fromEntries(entries) as unknown as RomSet;
}

export class HeadlessDeviceDriver {
  readonly machine: UA8295Machine;

  constructor(roms: RomSet, options: { maxTraceEvents?: number; traceAllXdata?: boolean } = {}) {
    this.machine = new UA8295Machine(roms, {
      traceLog: new TraceLog({ maxEvents: options.maxTraceEvents ?? 50_000 }),
      cpuTrace: {
        traceAllXdata: options.traceAllXdata ?? true,
        traceSfrReads: true,
        traceSfrWrites: true
      }
    });
  }

  static async create(options: { maxTraceEvents?: number; traceAllXdata?: boolean } = {}): Promise<HeadlessDeviceDriver> {
    return new HeadlessDeviceDriver(await loadTestRomSet(), options);
  }

  runFrames(frames: number, slicesPerFrame = 60, stepsPerCpu = 4): void {
    for (let frame = 0; frame < frames; frame += 1) {
      this.machine.runScheduler(slicesPerFrame, stepsPerCpu, false);
    }
  }

  runCoupledBoot(): void {
    this.machine.runScheduler(11_000, 80, false);
  }

  runMainInstructions(steps: number): void {
    this.machine.runCpu("main", steps, false);
  }

  pressKey(key: FrontPanelKey): void {
    this.machine.hardware.keyboard.setPressed(key, true);
  }

  releaseKey(key: FrontPanelKey): void {
    this.machine.hardware.keyboard.setPressed(key, false);
  }

  tapKey(key: FrontPanelKey, frames = 2): void {
    this.pressKey(key);
    this.runFrames(frames);
    this.releaseKey(key);
    this.runFrames(1);
  }

  displayText(): string {
    return this.machine.hardware.display.displayLine();
  }

  displayDetails(): string[] {
    return this.machine.hardware.display.detailLines();
  }

  traceEvents(): DeviceTraceEvent[] {
    return this.machine.traceLog.events;
  }

  summary() {
    return summarizeTraceEvents(this.traceEvents());
  }

  keyNames(): readonly FrontPanelKey[] {
    return FRONT_PANEL_KEYS;
  }
}
