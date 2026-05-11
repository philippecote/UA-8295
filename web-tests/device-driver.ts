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
  private readonly displays: string[] = [];

  constructor(roms: RomSet, options: { maxTraceEvents?: number; traceAllXdata?: boolean } = {}) {
    this.machine = new UA8295Machine(roms, {
      traceLog: new TraceLog({ maxEvents: options.maxTraceEvents ?? 50_000 }),
      cpuTrace: {
        traceAllXdata: options.traceAllXdata ?? true,
        traceSfrReads: true,
        traceSfrWrites: true
      }
    });
    this.recordDisplay();
  }

  static async create(options: { maxTraceEvents?: number; traceAllXdata?: boolean } = {}): Promise<HeadlessDeviceDriver> {
    return new HeadlessDeviceDriver(await loadTestRomSet(), options);
  }

  runFrames(frames: number, slicesPerFrame = 60, stepsPerCpu = 4): void {
    for (let frame = 0; frame < frames; frame += 1) {
      this.machine.runScheduler(slicesPerFrame, stepsPerCpu, false);
      this.recordDisplay();
    }
  }

  runCoupledBoot(): void {
    this.bootUntilReady();
  }

  runSchedulerSlices(slices: number, stepsPerCpu = 80): void {
    if (slices <= 0) return;
    this.machine.runScheduler(slices, stepsPerCpu, false);
    this.recordDisplay();
  }

  bootUntilReady(maxSlices = 12_000): string {
    return this.waitForDisplay("FUNCTION?", maxSlices, 80, 20);
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

  tapSequence(keys: readonly FrontPanelKey[], framesPerKey = 2): void {
    for (const key of keys) {
      this.tapKey(key, framesPerKey);
    }
  }

  holdKey(key: FrontPanelKey, slices: number, stepsPerCpu = 80): void {
    this.pressKey(key);
    this.runSchedulerSlices(slices, stepsPerCpu);
    this.releaseKey(key);
  }

  pressAndWaitForDisplay(key: FrontPanelKey, expected: string | RegExp, options: { holdSlices?: number; settleSlices?: number } = {}): string {
    this.pressKey(key);
    const matched = this.waitForDisplay(expected, options.holdSlices ?? 400);
    this.releaseKey(key);
    this.runSchedulerSlices(options.settleSlices ?? 80);
    return matched;
  }

  waitForDisplay(expected: string | RegExp, maxSlices = 400, stepsPerCpu = 80, slicesPerPoll = 1): string {
    for (let slice = 0; slice < maxSlices; slice += slicesPerPoll) {
      this.runSchedulerSlices(Math.min(slicesPerPoll, maxSlices - slice), stepsPerCpu);
      const text = this.displayText();
      if (matchesDisplay(text, expected)) return text;
    }
    const pc = {
      main: this.machine.mainCpu.snapshot().pc.toString(16).padStart(4, "0"),
      iop: this.machine.iopCpu.snapshot().pc.toString(16).padStart(4, "0")
    };
    throw new Error(
      `Timed out waiting for display ${String(expected)}. Recent: ${this.displayHistory().slice(-8).join(" | ")}. PCs: ${JSON.stringify(pc)}. Trace: ${JSON.stringify(this.summary())}`
    );
  }

  waitForCondition(description: string, predicate: () => boolean, maxSlices = 400, stepsPerCpu = 80, slicesPerPoll = 1): void {
    for (let slice = 0; slice < maxSlices; slice += slicesPerPoll) {
      if (predicate()) return;
      this.runSchedulerSlices(Math.min(slicesPerPoll, maxSlices - slice), stepsPerCpu);
    }
    throw new Error(`Timed out waiting for ${description}. Recent displays: ${this.displayHistory().slice(-8).join(" | ")}`);
  }

  displayText(): string {
    return this.machine.hardware.display.displayLine();
  }

  displayHistory(): readonly string[] {
    return this.displays;
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

  private recordDisplay(): void {
    const text = this.displayText();
    if (this.displays[this.displays.length - 1] !== text) {
      this.displays.push(text);
    }
  }
}

function matchesDisplay(text: string, expected: string | RegExp): boolean {
  return typeof expected === "string" ? text.includes(expected) : expected.test(text);
}
