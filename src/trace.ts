import { hex } from "./memory";

export type CpuName = "main" | "iop";
export type TraceEventKind = "movx" | "sfr" | "port" | "timer" | "interrupt" | "scheduler";
export type TraceOperation = "read" | "write" | "tick" | "dispatch" | "return" | "slice";
export type XdataRegion = "xram" | "text-rom" | "unmapped";

interface BaseTraceEvent {
  kind: TraceEventKind;
  cpu: CpuName | "device";
  pc: number;
  cycle: number;
  operation: TraceOperation;
  instruction?: string;
}

export interface MovxTraceEvent extends BaseTraceEvent {
  kind: "movx";
  operation: "read" | "write";
  address: number;
  value: number;
  region: XdataRegion;
  bus: "@DPTR" | "@R0" | "@R1";
}

export interface SfrTraceEvent extends BaseTraceEvent {
  kind: "sfr" | "port";
  operation: "read" | "write";
  address: number;
  name: string;
  value: number;
  previous?: number;
}

export interface TimerTraceEvent extends BaseTraceEvent {
  kind: "timer";
  timer: "T0" | "T1";
  value?: number;
}

export interface InterruptTraceEvent extends BaseTraceEvent {
  kind: "interrupt";
  vector: number;
  priority?: "low" | "high";
}

export interface SchedulerTraceEvent extends BaseTraceEvent {
  kind: "scheduler";
  operation: "slice";
  steps: number;
}

export type DeviceTraceEvent =
  | MovxTraceEvent
  | SfrTraceEvent
  | TimerTraceEvent
  | InterruptTraceEvent
  | SchedulerTraceEvent;

export interface HardwareAccessClassification {
  device: string;
  status: "modeled" | "gap";
  note: string;
}

export interface TraceLogOptions {
  maxEvents?: number;
}

export class TraceLog {
  readonly events: DeviceTraceEvent[] = [];
  private readonly maxEvents: number;
  /**
   * When false, `record()` is a no-op. Used by the live web UI to skip the
   * substantial cost of pushing a structured event for every scheduler slice,
   * MOVX, and SFR access. Headless tests, the developer panel, and any code
   * that needs the trace stream should set this to true.
   */
  private recording = true;

  constructor(options: TraceLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? 50_000;
  }

  setRecording(enabled: boolean): void {
    this.recording = enabled;
  }

  isRecording(): boolean {
    return this.recording;
  }

  record(event: DeviceTraceEvent): void {
    if (!this.recording) return;
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  clear(): void {
    this.events.length = 0;
  }

  recent(limit = 200, filter: TraceEventFilter = {}): DeviceTraceEvent[] {
    return filterTraceEvents(this.events, filter).slice(-limit);
  }
}

export interface TraceEventFilter {
  cpu?: CpuName | "device" | "all";
  kind?: TraceEventKind | "all";
}

export function filterTraceEvents(events: DeviceTraceEvent[], filter: TraceEventFilter): DeviceTraceEvent[] {
  return events.filter((event) => {
    if (filter.cpu && filter.cpu !== "all" && event.cpu !== filter.cpu) return false;
    if (filter.kind && filter.kind !== "all" && event.kind !== filter.kind) return false;
    return true;
  });
}

export function formatTraceEvent(event: DeviceTraceEvent): string {
  const prefix = `${event.cpu.padEnd(6)} ${event.kind.padEnd(9)} ${event.operation.padEnd(6)} PC=${hex(event.pc, 4)} CYC=${event.cycle}`;
  if (event.kind === "movx") {
    return `${prefix} ${event.bus} ${event.region} 0x${hex(event.address, 4)} = 0x${hex(event.value, 2)}`;
  }
  if (event.kind === "sfr" || event.kind === "port") {
    const previous = event.previous === undefined ? "" : ` prev=0x${hex(event.previous, 2)}`;
    return `${prefix} ${event.name}(${hex(event.address, 2)}) = 0x${hex(event.value, 2)}${previous}`;
  }
  if (event.kind === "scheduler") {
    return `${prefix} steps=${event.steps}`;
  }
  if (event.kind === "interrupt") {
    return `${prefix} vector=0x${hex(event.vector, 4)}${event.priority ? ` priority=${event.priority}` : ""}`;
  }
  if (event.kind === "timer") {
    return `${prefix} ${event.timer}${event.value === undefined ? "" : ` value=0x${hex(event.value, 4)}`}`;
  }
  return prefix;
}

export function summarizeTraceEvents(events: DeviceTraceEvent[]): {
  sfr: Array<[string, number]>;
  xdata: Array<[string, number]>;
  hardwareGaps: Array<[string, number]>;
} {
  const sfr = new Map<string, number>();
  const xdata = new Map<string, number>();
  const hardwareGaps = new Map<string, number>();

  for (const event of events) {
    if (event.kind === "sfr" || event.kind === "port") {
      const key = `${event.cpu}:${event.name}`;
      sfr.set(key, (sfr.get(key) ?? 0) + 1);
    } else if (event.kind === "movx") {
      const bucket = `0x${hex(event.address & 0xff00, 4)}-${event.region}`;
      const key = `${event.cpu}:${bucket}`;
      xdata.set(key, (xdata.get(key) ?? 0) + 1);
    }
    const classification = classifyHardwareAccess(event);
    if (classification.status === "gap") {
      const address = "address" in event ? `:0x${hex(event.address, event.kind === "sfr" || event.kind === "port" ? 2 : 4)}` : "";
      const key = `${event.cpu}:${classification.device}${address}`;
      hardwareGaps.set(key, (hardwareGaps.get(key) ?? 0) + 1);
    }
  }

  const sortEntries = (entries: Map<string, number>) => [...entries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    sfr: sortEntries(sfr),
    xdata: sortEntries(xdata),
    hardwareGaps: sortEntries(hardwareGaps)
  };
}

export function classifyHardwareAccess(event: DeviceTraceEvent): HardwareAccessClassification {
  if (event.kind === "scheduler" || event.kind === "interrupt" || event.kind === "timer") {
    return { device: "cpu-core", status: "modeled", note: "Internal CPU timing/interrupt behavior." };
  }

  if (event.kind === "sfr" || event.kind === "port") {
    if (event.address === 0x90 || event.address === 0xb0) {
      return { device: "keyboard-port", status: "modeled", note: "Front-panel matrix and firmware-visible status lines." };
    }
    if (event.address === 0x98 || event.address === 0x99) {
      return { device: "serial-uart", status: "modeled", note: "Dual-CPU SCON/SBUF link; timing fidelity is tracked separately." };
    }
    return { device: "cpu-sfr", status: "modeled", note: "8051 core SFR behavior." };
  }

  if (event.kind !== "movx") {
    return { device: "cpu-core", status: "modeled", note: "Internal CPU event." };
  }

  if (event.region === "xram") {
    if (event.cpu === "main" && event.address >= 0x7fe0 && event.address <= 0x7fff) {
      return { device: "display-text-buffer", status: "modeled", note: "Firmware display text mirror." };
    }
    return { device: `${event.cpu}-sram`, status: "modeled", note: "External SRAM." };
  }

  if (event.cpu === "main" && event.address === 0x8400) {
    return {
      device: "keyboard-display-port",
      status: "modeled",
      note: "Shared display-controller status / keyboard scan handshake on the same XDATA address."
    };
  }

  if (event.cpu === "main" && event.address >= 0x8400 && event.address <= 0x841f) {
    return { device: "display-controller", status: "modeled", note: "Display-controller register model; detailed state machine remains planned." };
  }

  if (event.region === "text-rom") {
    return { device: "text-rom", status: "modeled", note: "External text EPROM." };
  }

  if (event.cpu === "main" && event.address === 0x0000) {
    return {
      device: "external-control-latch",
      status: "gap",
      note: "Workflow traces write this unmapped low address during prompt entry; no behavior depends on it yet."
    };
  }

  if (event.cpu === "iop") {
    return { device: "iop-peripheral-bus", status: "gap", note: "Likely modem/radio or front-panel support hardware behind the I/O processor." };
  }

  return { device: "unclassified-external-bus", status: "gap", note: "External access not yet assigned to a device model." };
}
