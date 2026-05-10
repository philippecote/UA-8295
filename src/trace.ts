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

export interface TraceLogOptions {
  maxEvents?: number;
}

export class TraceLog {
  readonly events: DeviceTraceEvent[] = [];
  private readonly maxEvents: number;

  constructor(options: TraceLogOptions = {}) {
    this.maxEvents = options.maxEvents ?? 50_000;
  }

  record(event: DeviceTraceEvent): void {
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
} {
  const sfr = new Map<string, number>();
  const xdata = new Map<string, number>();

  for (const event of events) {
    if (event.kind === "sfr" || event.kind === "port") {
      const key = `${event.cpu}:${event.name}`;
      sfr.set(key, (sfr.get(key) ?? 0) + 1);
    } else if (event.kind === "movx") {
      const bucket = `0x${hex(event.address & 0xff00, 4)}-${event.region}`;
      const key = `${event.cpu}:${bucket}`;
      xdata.set(key, (xdata.get(key) ?? 0) + 1);
    }
  }

  const sortEntries = (entries: Map<string, number>) => [...entries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    sfr: sortEntries(sfr),
    xdata: sortEntries(xdata)
  };
}
