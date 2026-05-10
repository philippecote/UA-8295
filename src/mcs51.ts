import { ExternalBus, hex } from "./memory";
import type { CpuName, TraceLog, XdataRegion } from "./trace";

export class CpuError extends Error {}

export interface TraceEntry {
  pc: number;
  opcode: number;
  bytes: number[];
  text: string;
  a: number;
  b: number;
  psw: number;
  sp: number;
  dptr: number;
}

export interface CpuSnapshot {
  pc: number;
  a: number;
  b: number;
  psw: number;
  sp: number;
  dptr: number;
  cycles: number;
}

type InterruptSource = "EX0" | "T0" | "EX1" | "T1" | "SERIAL";

interface PendingInterrupt {
  source: InterruptSource;
  vector: number;
  priority: "low" | "high";
  flag?: { sfr: number; mask: number };
}

const SFR_NAMES = new Map<number, string>([
  [0x80, "P0"],
  [0x81, "SP"],
  [0x82, "DPL"],
  [0x83, "DPH"],
  [0x87, "PCON"],
  [0x88, "TCON"],
  [0x89, "TMOD"],
  [0x8a, "TL0"],
  [0x8b, "TL1"],
  [0x8c, "TH0"],
  [0x8d, "TH1"],
  [0x90, "P1"],
  [0x98, "SCON"],
  [0x99, "SBUF"],
  [0xa0, "P2"],
  [0xa8, "IE"],
  [0xb0, "P3"],
  [0xb8, "IP"],
  [0xd0, "PSW"],
  [0xe0, "ACC"],
  [0xf0, "B"]
]);

const TRACEABLE_SFRS = new Set([
  0x80, // P0
  0x88, // TCON
  0x89, // TMOD
  0x8a, // TL0
  0x8b, // TL1
  0x8c, // TH0
  0x8d, // TH1
  0x90, // P1
  0x98, // SCON
  0x99, // SBUF
  0xa0, // P2
  0xa8, // IE
  0xb0, // P3
  0xb8 // IP
]);

const PORT_SFRS = new Set([0x80, 0x90, 0xa0, 0xb0]);

export interface CpuTraceOptions {
  traceAllXdata?: boolean;
  traceSfrReads?: boolean;
  traceSfrWrites?: boolean;
}

export interface CpuHardwareHooks {
  readSfr?(cpu: CpuName, address: number, latchValue: number): number;
  writeSfr?(cpu: CpuName, address: number, value: number, previous: number): void;
  transmitSerial?(cpu: CpuName, value: number, tb8: boolean): void;
  readXdata?(cpu: CpuName, address: number, busValue: number, region: XdataRegion): number;
  writeXdata?(cpu: CpuName, address: number, value: number, region: XdataRegion): void;
}

export function u8(value: number): number {
  return value & 0xff;
}

export function u16(value: number): number {
  return value & 0xffff;
}

export function rel8(value: number): number {
  const byte = value & 0xff;
  return byte & 0x80 ? byte - 0x100 : byte;
}

function parity(value: number): number {
  let byte = value & 0xff;
  let count = 0;
  while (byte) {
    count ^= byte & 1;
    byte >>= 1;
  }
  return count;
}

export function fmtDirect(addr: number): string {
  return SFR_NAMES.get(addr & 0xff) ?? `0x${hex(addr & 0xff, 2)}`;
}

export function fmtBit(bitAddr: number): string {
  const bit = bitAddr & 0xff;
  if (bit >= 0x80) {
    return `${fmtDirect(bit & 0xf8)}.${bit & 7}`;
  }
  return `0x${hex(bit, 2)}`;
}

export function instructionLength(opcode: number): number {
  if (
    new Set([
      0x02, 0x10, 0x12, 0x20, 0x30, 0x43, 0x53, 0x63, 0x75, 0x85, 0x90, 0xb4, 0xb5, 0xb6,
      0xb7, 0xd5
    ]).has(opcode) ||
    (opcode >= 0xb8 && opcode <= 0xbf)
  ) {
    return 3;
  }
  if (
    new Set([
      0x01, 0x05, 0x11, 0x15, 0x21, 0x24, 0x25, 0x31, 0x34, 0x35, 0x40, 0x41, 0x44, 0x45,
      0x50, 0x51, 0x54, 0x55, 0x60, 0x61, 0x64, 0x65, 0x70, 0x71, 0x72, 0x74, 0x76, 0x77,
      0x80, 0x81, 0x82, 0x86, 0x87, 0x91, 0x92, 0x94, 0x95, 0xa0, 0xa1, 0xa2, 0xa6, 0xa7,
      0xb0, 0xb1, 0xb2, 0xc0, 0xc1, 0xc2, 0xd0, 0xd1, 0xd2, 0xe1, 0xe5, 0xf1, 0xf5
    ]).has(opcode)
  ) {
    return 2;
  }
  if (
    (opcode >= 0x78 && opcode <= 0x7f) ||
    (opcode >= 0x88 && opcode <= 0x8f) ||
    (opcode >= 0xa8 && opcode <= 0xaf) ||
    (opcode >= 0xd8 && opcode <= 0xdf)
  ) {
    return 2;
  }
  return 1;
}

export function instructionCycles(opcode: number): number {
  if (opcode === 0x84 || opcode === 0xa4) return 4;
  if (
    opcode === 0x02 ||
    opcode === 0x12 ||
    opcode === 0x22 ||
    opcode === 0x32 ||
    opcode === 0x73 ||
    opcode === 0x83 ||
    opcode === 0x90 ||
    opcode === 0x93 ||
    opcode === 0xa3 ||
    opcode === 0xc0 ||
    opcode === 0xd0 ||
    opcode === 0xe0 ||
    opcode === 0xf0 ||
    isAjmp(opcode) ||
    isAcall(opcode) ||
    (opcode >= 0xb4 && opcode <= 0xbf) ||
    (opcode >= 0xd5 && opcode <= 0xdf) ||
    opcode === 0xe2 ||
    opcode === 0xe3 ||
    opcode === 0xf2 ||
    opcode === 0xf3
  ) {
    return 2;
  }
  if (instructionLength(opcode) >= 2 && (opcode <= 0x7f || opcode >= 0x85)) {
    return 2;
  }
  return 1;
}

export class MCS51 {
  pc = 0;
  readonly iram = new Uint8Array(128);
  readonly sfr = new Map<number, number>();
  halted = false;
  cycles = 0;
  private activeInstructionPc: number | null = null;
  private activeOpcode = 0;
  private interruptInService: "low" | "high" | null = null;

  constructor(
    readonly bus: ExternalBus,
    readonly name = "cpu",
    readonly traceLog: TraceLog | null = null,
    readonly traceOptions: CpuTraceOptions = {},
    readonly hardware: CpuHardwareHooks | null = null
  ) {
    this.reset();
  }

  reset(): void {
    this.pc = 0;
    this.iram.fill(0);
    this.sfr.clear();
    for (const [addr, value] of [
      [0x80, 0xff],
      [0x81, 0x07],
      [0x82, 0x00],
      [0x83, 0x00],
      [0x87, 0x00],
      [0x88, 0x00],
      [0x89, 0x00],
      [0x8a, 0x00],
      [0x8b, 0x00],
      [0x8c, 0x00],
      [0x8d, 0x00],
      [0x90, 0xff],
      [0x98, 0x00],
      [0x99, 0x00],
      [0xa0, 0xff],
      [0xa8, 0x00],
      [0xb0, 0xff],
      [0xb8, 0x00],
      [0xd0, 0x00],
      [0xe0, 0x00],
      [0xf0, 0x00]
    ]) {
      this.sfr.set(addr, value);
    }
    this.halted = false;
    this.cycles = 0;
    this.interruptInService = null;
    this.updateParity();
  }

  get a(): number {
    return this.readDirect(0xe0);
  }
  set a(value: number) {
    this.writeDirect(0xe0, value);
  }
  get b(): number {
    return this.readDirect(0xf0);
  }
  set b(value: number) {
    this.writeDirect(0xf0, value);
  }
  get psw(): number {
    return this.readDirect(0xd0);
  }
  set psw(value: number) {
    this.writeDirect(0xd0, value);
  }
  get sp(): number {
    return this.readDirect(0x81);
  }
  set sp(value: number) {
    this.writeDirect(0x81, value);
  }
  get dptr(): number {
    return (this.readDirect(0x83) << 8) | this.readDirect(0x82);
  }
  set dptr(value: number) {
    this.writeDirect(0x82, value);
    this.writeDirect(0x83, value >> 8);
  }
  get carry(): number {
    return (this.psw >> 7) & 1;
  }
  set carry(value: number) {
    this.setPswBit(7, value);
  }

  readDirect(addr: number): number {
    const masked = addr & 0xff;
    if (masked < 0x80) {
      return this.iram[masked];
    }
    const latchValue = this.sfr.get(masked) ?? 0;
    const value = this.hardware?.readSfr?.(this.traceCpuName(), masked, latchValue) ?? latchValue;
    this.recordSfrAccess("read", masked, value);
    return value;
  }

  writeDirect(addr: number, value: number): void {
    const masked = addr & 0xff;
    const byte = u8(value);
    const previous = masked < 0x80 ? this.iram[masked] : (this.sfr.get(masked) ?? 0);
    if (masked < 0x80) {
      this.iram[masked] = byte;
    } else {
      this.sfr.set(masked, byte);
    }
    if (masked >= 0x80) {
      this.hardware?.writeSfr?.(this.traceCpuName(), masked, byte, previous);
    }
    this.recordSfrAccess("write", masked, byte, previous);
    if (masked === 0xe0) {
      this.updateParity();
    }
    if (masked === 0x99) {
      const scon = this.sfr.get(0x98) ?? 0;
      this.sfr.set(0x98, scon | 0x02);
      this.hardware?.transmitSerial?.(this.traceCpuName(), byte, (scon & 0x08) !== 0);
    }
  }

  receiveSerial(value: number, rb8 = false): void {
    const scon = this.sfr.get(0x98) ?? 0;
    this.sfr.set(0x99, value & 0xff);
    this.sfr.set(0x98, (scon | 0x01 | (rb8 ? 0x04 : 0)) & (rb8 ? 0xff : 0xfb));
  }

  step(): TraceEntry {
    if (this.halted) {
      throw new CpuError(`${this.name} is halted`);
    }
    const startPc = this.pc;
    const opcode = this.fetchByte();
    this.activeInstructionPc = startPc;
    this.activeOpcode = opcode;
    let text = "";

    const imm = () => this.fetchByte();
    const direct = () => this.fetchByte();

    if (opcode === 0x00) text = "NOP";
    else if (isAjmp(opcode)) {
      const value = imm();
      this.pc = this.ajmpAddr(opcode, value);
      text = `AJMP 0x${hex(this.pc, 4)}`;
    } else if (opcode === 0x02) {
      this.pc = this.fetchWord();
      text = `LJMP 0x${hex(this.pc, 4)}`;
    } else if (opcode === 0x03) {
      this.a = (this.a >> 1) | ((this.a & 1) << 7);
      text = "RR A";
    } else if (opcode >= 0x04 && opcode <= 0x0f) {
      text = this.inc(opcode, direct);
    } else if (opcode === 0x10) {
      const bit = imm();
      const off = imm();
      if (this.readBit(bit)) {
        this.writeBit(bit, 0);
        this.jumpRel(off);
      }
      text = `JBC ${fmtBit(bit)}, ${rel8(off) >= 0 ? "+" : ""}${rel8(off)}`;
    } else if (isAcall(opcode)) {
      this.acall(opcode);
      text = `ACALL 0x${hex(this.pc, 4)}`;
    } else if (opcode === 0x12) {
      const target = this.fetchWord();
      this.push(this.pc & 0xff);
      this.push(this.pc >> 8);
      this.pc = target;
      text = `LCALL 0x${hex(target, 4)}`;
    } else if (opcode === 0x13) {
      const oldA = this.a;
      const oldC = this.carry;
      this.carry = oldA & 1;
      this.a = (oldA >> 1) | (oldC << 7);
      text = "RRC A";
    } else if (opcode >= 0x14 && opcode <= 0x1f) {
      text = this.dec(opcode, direct);
    } else if (opcode === 0x20 || opcode === 0x30) {
      const bit = imm();
      const off = imm();
      const shouldJump = opcode === 0x20 ? this.readBit(bit) : !this.readBit(bit);
      if (shouldJump) this.jumpRel(off);
      text = `${opcode === 0x20 ? "JB" : "JNB"} ${fmtBit(bit)}, ${signed(off)}`;
    } else if (opcode === 0x22 || opcode === 0x32) {
      this.ret();
      if (opcode === 0x32) {
        this.recordInterruptReturn(startPc);
        this.interruptInService = null;
      }
      text = opcode === 0x22 ? "RET" : "RETI";
    } else if (opcode === 0x23) {
      this.a = (this.a << 1) | (this.a >> 7);
      text = "RL A";
    } else if (opcode >= 0x24 && opcode <= 0x2f) {
      const [value, operand] = this.aluOperand(opcode, direct, imm);
      this.add(value);
      text = `ADD A, ${operand}`;
    } else if (opcode === 0x33) {
      const oldA = this.a;
      const oldC = this.carry;
      this.carry = (oldA >> 7) & 1;
      this.a = (oldA << 1) | oldC;
      text = "RLC A";
    } else if (opcode >= 0x34 && opcode <= 0x3f) {
      const [value, operand] = this.aluOperand(opcode - 0x10, direct, imm);
      this.add(value, true);
      text = `ADDC A, ${operand}`;
    } else if (opcode === 0x40 || opcode === 0x50 || opcode === 0x60 || opcode === 0x70 || opcode === 0x80) {
      const off = imm();
      const jump =
        opcode === 0x80 ||
        (opcode === 0x40 && !!this.carry) ||
        (opcode === 0x50 && !this.carry) ||
        (opcode === 0x60 && this.a === 0) ||
        (opcode === 0x70 && this.a !== 0);
      if (jump) this.jumpRel(off);
      text = `${branchName(opcode)} ${signed(off)}`;
    } else if (opcode === 0x42 || opcode === 0x52 || opcode === 0x62) {
      const addr = direct();
      const op = opcode === 0x42 ? "|" : opcode === 0x52 ? "&" : "^";
      this.writeDirect(addr, applyLogic(op, this.readDirect(addr), this.a));
      text = `${logicName(op)} ${fmtDirect(addr)}, A`;
    } else if (opcode === 0x43 || opcode === 0x53 || opcode === 0x63) {
      const addr = direct();
      const value = imm();
      const op = opcode === 0x43 ? "|" : opcode === 0x53 ? "&" : "^";
      this.writeDirect(addr, applyLogic(op, this.readDirect(addr), value));
      text = `${logicName(op)} ${fmtDirect(addr)}, #0x${hex(value, 2)}`;
    } else if ((opcode >= 0x44 && opcode <= 0x4f) || (opcode >= 0x54 && opcode <= 0x5f) || (opcode >= 0x64 && opcode <= 0x6f)) {
      const [value, operand] = this.aluOperand((opcode & 0x0f) | 0x24, direct, imm);
      const op = opcode < 0x50 ? "|" : opcode < 0x60 ? "&" : "^";
      this.a = applyLogic(op, this.a, value);
      text = `${logicName(op)} A, ${operand}`;
    } else if (opcode === 0x72 || opcode === 0x82 || opcode === 0xa0 || opcode === 0xb0) {
      const bit = imm();
      const bitValue = this.readBit(bit);
      if (opcode === 0x72) this.carry = this.carry | bitValue;
      else if (opcode === 0x82) this.carry = this.carry & bitValue;
      else if (opcode === 0xa0) this.carry = this.carry | (1 - bitValue);
      else this.carry = this.carry & (1 - bitValue);
      text = `${opcode === 0x72 || opcode === 0xa0 ? "ORL" : "ANL"} C, ${opcode >= 0xa0 ? "/" : ""}${fmtBit(bit)}`;
    } else if (opcode === 0x73) {
      this.pc = u16(this.dptr + this.a);
      text = "JMP @A+DPTR";
    } else if (opcode >= 0x74 && opcode <= 0x7f) {
      text = this.movImmediate(opcode, direct, imm);
    } else if (opcode === 0x83) {
      this.a = this.bus.readCode(this.pc + this.a);
      text = "MOVC A, @A+PC";
    } else if (opcode === 0x84) {
      if (this.b === 0) this.setPswBit(2, 1);
      else {
        const a = this.a;
        this.a = Math.floor(a / this.b);
        this.b = a % this.b;
        this.setPswBit(2, 0);
      }
      this.carry = 0;
      text = "DIV AB";
    } else if (opcode >= 0x85 && opcode <= 0x8f) {
      text = this.movToDirect(opcode, direct);
    } else if (opcode === 0x90) {
      this.dptr = this.fetchWord();
      text = `MOV DPTR, #0x${hex(this.dptr, 4)}`;
    } else if (opcode === 0x92) {
      const bit = imm();
      this.writeBit(bit, this.carry);
      text = `MOV ${fmtBit(bit)}, C`;
    } else if (opcode === 0x93) {
      this.a = this.bus.readCode(this.dptr + this.a);
      text = "MOVC A, @A+DPTR";
    } else if (opcode >= 0x94 && opcode <= 0x9f) {
      const [value, operand] = this.aluOperand(opcode - 0x70, direct, imm);
      this.subb(value);
      text = `SUBB A, ${operand}`;
    } else if (opcode === 0xa2) {
      const bit = imm();
      this.carry = this.readBit(bit);
      text = `MOV C, ${fmtBit(bit)}`;
    } else if (opcode === 0xa3) {
      this.dptr = this.dptr + 1;
      text = "INC DPTR";
    } else if (opcode === 0xa4) {
      const result = this.a * this.b;
      this.a = result;
      this.b = result >> 8;
      this.carry = 0;
      this.setPswBit(2, result > 0xff ? 1 : 0);
      text = "MUL AB";
    } else if (opcode === 0xa5) {
      this.halted = true;
      text = "DB 0xA5";
    } else if (opcode >= 0xa6 && opcode <= 0xaf) {
      text = this.movFromDirect(opcode, direct);
    } else if (opcode === 0xb2) {
      const bit = imm();
      this.writeBit(bit, 1 - this.readBit(bit));
      text = `CPL ${fmtBit(bit)}`;
    } else if (opcode === 0xb3) {
      this.carry = 1 - this.carry;
      text = "CPL C";
    } else if (opcode >= 0xb4 && opcode <= 0xbf) {
      text = this.cjne(opcode, direct, imm);
    } else if (opcode === 0xc0) {
      const addr = direct();
      this.push(this.readDirect(addr));
      text = `PUSH ${fmtDirect(addr)}`;
    } else if (opcode === 0xc2 || opcode === 0xd2) {
      const bit = imm();
      this.writeBit(bit, opcode === 0xd2 ? 1 : 0);
      text = `${opcode === 0xd2 ? "SETB" : "CLR"} ${fmtBit(bit)}`;
    } else if (opcode === 0xc3 || opcode === 0xd3) {
      this.carry = opcode === 0xd3 ? 1 : 0;
      text = opcode === 0xd3 ? "SETB C" : "CLR C";
    } else if (opcode === 0xc4) {
      this.a = ((this.a & 0x0f) << 4) | (this.a >> 4);
      text = "SWAP A";
    } else if (opcode >= 0xc5 && opcode <= 0xcf) {
      text = this.xch(opcode, direct);
    } else if (opcode === 0xd0) {
      const addr = direct();
      this.writeDirect(addr, this.pop());
      text = `POP ${fmtDirect(addr)}`;
    } else if (opcode === 0xd4) {
      this.decimalAdjust();
      text = "DA A";
    } else if (opcode >= 0xd5 && opcode <= 0xdf) {
      text = this.djnz(opcode, direct, imm);
    } else if (opcode >= 0xe0 && opcode <= 0xef) {
      text = this.movToA(opcode, direct);
    } else if (opcode >= 0xf0 && opcode <= 0xff) {
      text = this.movFromA(opcode, direct);
    } else {
      throw new CpuError(`unsupported opcode 0x${hex(opcode, 2)} at 0x${hex(startPc, 4)}`);
    }

    const elapsedCycles = instructionCycles(opcode);
    this.cycles += elapsedCycles;
    this.advanceTimers(elapsedCycles, startPc);
    this.dispatchInterruptIfPending(startPc);
    this.updateParity();
    const bytes = Array.from({ length: instructionLength(opcode) }, (_, i) => this.bus.readCode(startPc + i));
    this.activeInstructionPc = null;
    return { pc: startPc, opcode, bytes, text, a: this.a, b: this.b, psw: this.psw, sp: this.sp, dptr: this.dptr };
  }

  run(steps: number, trace = false): TraceEntry[] {
    const entries: TraceEntry[] = [];
    for (let i = 0; i < steps; i += 1) {
      const entry = this.step();
      if (trace) entries.push(entry);
      if (this.halted) break;
    }
    return entries;
  }

  snapshot(): CpuSnapshot {
    return { pc: this.pc, a: this.a, b: this.b, psw: this.psw, sp: this.sp, dptr: this.dptr, cycles: this.cycles };
  }

  private recordSfrAccess(operation: "read" | "write", address: number, value: number, previous?: number): void {
    if (this.activeInstructionPc === null || !TRACEABLE_SFRS.has(address)) return;
    if (operation === "read" && this.traceOptions.traceSfrReads === false) return;
    if (operation === "write" && this.traceOptions.traceSfrWrites === false) return;
    this.traceLog?.record({
      kind: PORT_SFRS.has(address) ? "port" : "sfr",
      cpu: this.traceCpuName(),
      pc: this.activeInstructionPc,
      cycle: this.cycles,
      operation,
      address,
      name: fmtDirect(address),
      value: value & 0xff,
      previous,
      instruction: `0x${hex(this.activeOpcode, 2)}`
    });
  }

  private recordMovxAccess(
    operation: "read" | "write",
    bus: "@DPTR" | "@R0" | "@R1",
    address: number,
    value: number
  ): void {
    if (this.activeInstructionPc === null) return;
    const region = this.bus.regionForXdata(address) as XdataRegion;
    if (region !== "unmapped" && !this.traceOptions.traceAllXdata) return;
    this.traceLog?.record({
      kind: "movx",
      cpu: this.traceCpuName(),
      pc: this.activeInstructionPc,
      cycle: this.cycles,
      operation,
      address: address & 0xffff,
      value: value & 0xff,
      region,
      bus,
      instruction: `0x${hex(this.activeOpcode, 2)}`
    });
  }

  private traceCpuName(): CpuName {
    return this.name === "iop" ? "iop" : "main";
  }

  private advanceTimers(elapsedCycles: number, pc: number): void {
    this.advanceTimer(0, elapsedCycles, pc);
    this.advanceTimer(1, elapsedCycles, pc);
  }

  private advanceTimer(timer: 0 | 1, elapsedCycles: number, pc: number): void {
    const tcon = this.sfr.get(0x88) ?? 0;
    const tmod = this.sfr.get(0x89) ?? 0;
    const running = timer === 0 ? (tcon & 0x10) !== 0 : (tcon & 0x40) !== 0;
    if (!running) return;

    const shift = timer === 0 ? 0 : 4;
    const mode = (tmod >> shift) & 0x03;
    const counterMode = (tmod & (timer === 0 ? 0x04 : 0x40)) !== 0;
    if (counterMode) return;

    if (timer === 0 && mode === 3) {
      this.advanceSplitTimer0(elapsedCycles, pc);
      return;
    }
    if (timer === 1 && ((tmod & 0x03) === 3)) {
      return;
    }

    const tlAddr = timer === 0 ? 0x8a : 0x8b;
    const thAddr = timer === 0 ? 0x8c : 0x8d;
    const flagMask = timer === 0 ? 0x20 : 0x80;

    if (mode === 0) {
      let counter = (((this.sfr.get(thAddr) ?? 0) << 5) | ((this.sfr.get(tlAddr) ?? 0) & 0x1f)) + elapsedCycles;
      if (counter > 0x1fff) {
        counter &= 0x1fff;
        this.setSfrBit(0x88, flagMask, true);
        this.recordTimerOverflow(timer, pc, counter);
      }
      this.sfr.set(tlAddr, counter & 0x1f);
      this.sfr.set(thAddr, (counter >> 5) & 0xff);
      return;
    }

    if (mode === 2) {
      let value = (this.sfr.get(tlAddr) ?? 0) + elapsedCycles;
      while (value > 0xff) {
        value = (this.sfr.get(thAddr) ?? 0) + (value - 0x100);
        this.setSfrBit(0x88, flagMask, true);
        this.recordTimerOverflow(timer, pc, value & 0xff);
      }
      this.sfr.set(tlAddr, value & 0xff);
      return;
    }

    let counter = (((this.sfr.get(thAddr) ?? 0) << 8) | (this.sfr.get(tlAddr) ?? 0)) + elapsedCycles;
    if (counter > 0xffff) {
      counter &= 0xffff;
      this.setSfrBit(0x88, flagMask, true);
      this.recordTimerOverflow(timer, pc, counter);
    }
    this.sfr.set(tlAddr, counter & 0xff);
    this.sfr.set(thAddr, (counter >> 8) & 0xff);
  }

  private advanceSplitTimer0(elapsedCycles: number, pc: number): void {
    let low = (this.sfr.get(0x8a) ?? 0) + elapsedCycles;
    if (low > 0xff) {
      low &= 0xff;
      this.setSfrBit(0x88, 0x20, true);
      this.recordTimerOverflow(0, pc, low);
    }
    this.sfr.set(0x8a, low);

    if ((this.sfr.get(0x88) ?? 0) & 0x40) {
      let high = (this.sfr.get(0x8c) ?? 0) + elapsedCycles;
      if (high > 0xff) {
        high &= 0xff;
        this.setSfrBit(0x88, 0x80, true);
        this.recordTimerOverflow(1, pc, high);
      }
      this.sfr.set(0x8c, high);
    }
  }

  private dispatchInterruptIfPending(pc: number): void {
    const pending = this.pendingInterrupt();
    if (!pending) return;
    if (this.interruptInService === "high") return;
    if (this.interruptInService === "low" && pending.priority === "low") return;

    if (pending.flag) {
      this.setSfrBit(pending.flag.sfr, pending.flag.mask, false);
    }
    this.push(this.pc & 0xff);
    this.push(this.pc >> 8);
    this.pc = pending.vector;
    this.interruptInService = pending.priority;
    this.traceLog?.record({
      kind: "interrupt",
      cpu: this.traceCpuName(),
      pc,
      cycle: this.cycles,
      operation: "dispatch",
      vector: pending.vector,
      priority: pending.priority,
      instruction: pending.source
    });
  }

  private pendingInterrupt(): PendingInterrupt | null {
    const ie = this.sfr.get(0xa8) ?? 0;
    if ((ie & 0x80) === 0) return null;

    const tcon = this.sfr.get(0x88) ?? 0;
    const scon = this.sfr.get(0x98) ?? 0;
    const candidates: PendingInterrupt[] = [];
    if ((ie & 0x01) && (tcon & 0x02)) candidates.push(this.interruptCandidate("EX0", 0x0003, 0, { sfr: 0x88, mask: 0x02 }));
    if ((ie & 0x02) && (tcon & 0x20)) candidates.push(this.interruptCandidate("T0", 0x000b, 1, { sfr: 0x88, mask: 0x20 }));
    if ((ie & 0x04) && (tcon & 0x08)) candidates.push(this.interruptCandidate("EX1", 0x0013, 2, { sfr: 0x88, mask: 0x08 }));
    if ((ie & 0x08) && (tcon & 0x80)) candidates.push(this.interruptCandidate("T1", 0x001b, 3, { sfr: 0x88, mask: 0x80 }));
    if ((ie & 0x10) && (scon & 0x03)) candidates.push(this.interruptCandidate("SERIAL", 0x0023, 4));

    return candidates.find((candidate) => candidate.priority === "high") ?? candidates[0] ?? null;
  }

  private interruptCandidate(
    source: InterruptSource,
    vector: number,
    priorityBit: number,
    flag?: { sfr: number; mask: number }
  ): PendingInterrupt {
    const ip = this.sfr.get(0xb8) ?? 0;
    return {
      source,
      vector,
      priority: (ip & (1 << priorityBit)) !== 0 ? "high" : "low",
      flag
    };
  }

  private recordTimerOverflow(timer: 0 | 1, pc: number, value: number): void {
    this.traceLog?.record({
      kind: "timer",
      cpu: this.traceCpuName(),
      pc,
      cycle: this.cycles,
      operation: "tick",
      timer: timer === 0 ? "T0" : "T1",
      value
    });
  }

  private recordInterruptReturn(pc: number): void {
    this.traceLog?.record({
      kind: "interrupt",
      cpu: this.traceCpuName(),
      pc,
      cycle: this.cycles,
      operation: "return",
      vector: pc
    });
  }

  private setSfrBit(addr: number, mask: number, enabled: boolean): void {
    const value = this.sfr.get(addr) ?? 0;
    this.sfr.set(addr, enabled ? value | mask : value & ~mask);
  }

  private fetchByte(): number {
    const value = this.bus.readCode(this.pc);
    this.pc = u16(this.pc + 1);
    return value;
  }

  private fetchWord(): number {
    return (this.fetchByte() << 8) | this.fetchByte();
  }

  private updateParity(): void {
    this.sfr.set(0xd0, (this.sfr.get(0xd0) ?? 0) & 0xfe | parity(this.sfr.get(0xe0) ?? 0));
  }

  private setPswBit(bit: number, value: number | boolean): void {
    const mask = 1 << bit;
    this.sfr.set(0xd0, value ? this.psw | mask : this.psw & ~mask);
  }

  private bankBase(): number {
    return ((this.psw >> 3) & 3) * 8;
  }

  private getR(index: number): number {
    return this.iram[this.bankBase() + (index & 7)];
  }

  private setR(index: number, value: number): void {
    this.iram[this.bankBase() + (index & 7)] = u8(value);
  }

  private readIndirect(reg: number): number {
    return this.iram[this.getR(reg) & 0x7f];
  }

  private writeIndirect(reg: number, value: number): void {
    this.iram[this.getR(reg) & 0x7f] = u8(value);
  }

  private readBit(bitAddr: number): number {
    const bit = bitAddr & 0xff;
    const byteAddr = bit < 0x80 ? 0x20 + (bit >> 3) : bit & 0xf8;
    return (this.readDirect(byteAddr) >> (bit & 7)) & 1;
  }

  private writeBit(bitAddr: number, value: number): void {
    const bit = bitAddr & 0xff;
    const byteAddr = bit < 0x80 ? 0x20 + (bit >> 3) : bit & 0xf8;
    const mask = 1 << (bit & 7);
    const current = this.readDirect(byteAddr);
    this.writeDirect(byteAddr, value ? current | mask : current & ~mask);
  }

  private push(value: number): void {
    this.sp = this.sp + 1;
    this.writeDirect(this.sp, value);
  }

  private pop(): number {
    const value = this.readDirect(this.sp);
    this.sp = this.sp - 1;
    return value;
  }

  private jumpRel(offset: number): void {
    this.pc = u16(this.pc + rel8(offset));
  }

  private ajmpAddr(opcode: number, imm: number): number {
    return (this.pc & 0xf800) | ((opcode & 0xe0) << 3) | imm;
  }

  private acall(opcode: number): void {
    const imm = this.fetchByte();
    const target = this.ajmpAddr(opcode, imm);
    this.push(this.pc & 0xff);
    this.push(this.pc >> 8);
    this.pc = target;
  }

  private ret(): void {
    const high = this.pop();
    const low = this.pop();
    this.pc = (high << 8) | low;
  }

  private add(value: number, withCarry = false): void {
    const a = this.a;
    const c = withCarry ? this.carry : 0;
    const result = a + value + c;
    this.a = result;
    this.carry = result > 0xff ? 1 : 0;
    this.setPswBit(6, ((a & 0x0f) + (value & 0x0f) + c) > 0x0f);
    this.setPswBit(2, (~(a ^ value) & (a ^ result) & 0x80) !== 0);
  }

  private subb(value: number): void {
    const a = this.a;
    const c = this.carry;
    const result = a - value - c;
    this.a = result;
    this.carry = result < 0 ? 1 : 0;
    this.setPswBit(6, ((a & 0x0f) - (value & 0x0f) - c) < 0);
    this.setPswBit(2, ((a ^ value) & (a ^ result) & 0x80) !== 0);
  }

  private aluOperand(opcode: number, direct: () => number, imm: () => number): [number, string] {
    if ((opcode & 0x0f) === 0x04) {
      const value = imm();
      return [value, `#0x${hex(value, 2)}`];
    }
    if ((opcode & 0x0f) === 0x05) {
      const addr = direct();
      return [this.readDirect(addr), fmtDirect(addr)];
    }
    if ((opcode & 0x0e) === 0x06) {
      const reg = opcode & 1;
      return [this.readIndirect(reg), `@R${reg}`];
    }
    const reg = opcode & 7;
    return [this.getR(reg), `R${reg}`];
  }

  private inc(opcode: number, direct: () => number): string {
    if (opcode === 0x04) {
      this.a = this.a + 1;
      return "INC A";
    }
    if (opcode === 0x05) {
      const addr = direct();
      this.writeDirect(addr, this.readDirect(addr) + 1);
      return `INC ${fmtDirect(addr)}`;
    }
    if (opcode === 0x06 || opcode === 0x07) {
      const reg = opcode & 1;
      this.writeIndirect(reg, this.readIndirect(reg) + 1);
      return `INC @R${reg}`;
    }
    const reg = opcode & 7;
    this.setR(reg, this.getR(reg) + 1);
    return `INC R${reg}`;
  }

  private dec(opcode: number, direct: () => number): string {
    if (opcode === 0x14) {
      this.a = this.a - 1;
      return "DEC A";
    }
    if (opcode === 0x15) {
      const addr = direct();
      this.writeDirect(addr, this.readDirect(addr) - 1);
      return `DEC ${fmtDirect(addr)}`;
    }
    if (opcode === 0x16 || opcode === 0x17) {
      const reg = opcode & 1;
      this.writeIndirect(reg, this.readIndirect(reg) - 1);
      return `DEC @R${reg}`;
    }
    const reg = opcode & 7;
    this.setR(reg, this.getR(reg) - 1);
    return `DEC R${reg}`;
  }

  private movImmediate(opcode: number, direct: () => number, imm: () => number): string {
    if (opcode === 0x74) {
      const value = imm();
      this.a = value;
      return `MOV A, #0x${hex(value, 2)}`;
    }
    if (opcode === 0x75) {
      const addr = direct();
      const value = imm();
      this.writeDirect(addr, value);
      return `MOV ${fmtDirect(addr)}, #0x${hex(value, 2)}`;
    }
    if (opcode === 0x76 || opcode === 0x77) {
      const reg = opcode & 1;
      const value = imm();
      this.writeIndirect(reg, value);
      return `MOV @R${reg}, #0x${hex(value, 2)}`;
    }
    const reg = opcode & 7;
    const value = imm();
    this.setR(reg, value);
    return `MOV R${reg}, #0x${hex(value, 2)}`;
  }

  private movToDirect(opcode: number, direct: () => number): string {
    if (opcode === 0x85) {
      const src = direct();
      const dst = direct();
      this.writeDirect(dst, this.readDirect(src));
      return `MOV ${fmtDirect(dst)}, ${fmtDirect(src)}`;
    }
    const addr = direct();
    if (opcode === 0x86 || opcode === 0x87) {
      const reg = opcode & 1;
      this.writeDirect(addr, this.readIndirect(reg));
      return `MOV ${fmtDirect(addr)}, @R${reg}`;
    }
    const reg = opcode & 7;
    this.writeDirect(addr, this.getR(reg));
    return `MOV ${fmtDirect(addr)}, R${reg}`;
  }

  private movFromDirect(opcode: number, direct: () => number): string {
    const addr = direct();
    if (opcode === 0xa6 || opcode === 0xa7) {
      const reg = opcode & 1;
      this.writeIndirect(reg, this.readDirect(addr));
      return `MOV @R${reg}, ${fmtDirect(addr)}`;
    }
    const reg = opcode & 7;
    this.setR(reg, this.readDirect(addr));
    return `MOV R${reg}, ${fmtDirect(addr)}`;
  }

  private movToA(opcode: number, direct: () => number): string {
    if (opcode === 0xe0) {
      const address = this.dptr;
      const busValue = this.bus.readXdata(address);
      const value = this.hardware?.readXdata?.(this.traceCpuName(), address, busValue, this.bus.regionForXdata(address) as XdataRegion) ?? busValue;
      this.recordMovxAccess("read", "@DPTR", address, value);
      this.a = value;
      return "MOVX A, @DPTR";
    }
    if (opcode === 0xe2 || opcode === 0xe3) {
      const reg = opcode & 1;
      const address = ((this.readDirect(0xa0) & 0xff) << 8) | this.getR(reg);
      const busValue = this.bus.readXdata(address);
      const value = this.hardware?.readXdata?.(this.traceCpuName(), address, busValue, this.bus.regionForXdata(address) as XdataRegion) ?? busValue;
      this.recordMovxAccess("read", reg === 0 ? "@R0" : "@R1", address, value);
      this.a = value;
      return `MOVX A, @R${reg}`;
    }
    if (opcode === 0xe4) {
      this.a = 0;
      return "CLR A";
    }
    if (opcode === 0xe5) {
      const addr = direct();
      this.a = this.readDirect(addr);
      return `MOV A, ${fmtDirect(addr)}`;
    }
    if (opcode === 0xe6 || opcode === 0xe7) {
      const reg = opcode & 1;
      this.a = this.readIndirect(reg);
      return `MOV A, @R${reg}`;
    }
    const reg = opcode & 7;
    this.a = this.getR(reg);
    return `MOV A, R${reg}`;
  }

  private movFromA(opcode: number, direct: () => number): string {
    if (opcode === 0xf0) {
      const address = this.dptr;
      const value = this.a;
      this.bus.writeXdata(address, value);
      this.hardware?.writeXdata?.(this.traceCpuName(), address, value, this.bus.regionForXdata(address) as XdataRegion);
      this.recordMovxAccess("write", "@DPTR", address, value);
      return "MOVX @DPTR, A";
    }
    if (opcode === 0xf2 || opcode === 0xf3) {
      const reg = opcode & 1;
      const address = ((this.readDirect(0xa0) & 0xff) << 8) | this.getR(reg);
      const value = this.a;
      this.bus.writeXdata(address, value);
      this.hardware?.writeXdata?.(this.traceCpuName(), address, value, this.bus.regionForXdata(address) as XdataRegion);
      this.recordMovxAccess("write", reg === 0 ? "@R0" : "@R1", address, value);
      return `MOVX @R${reg}, A`;
    }
    if (opcode === 0xf4) {
      this.a = ~this.a;
      return "CPL A";
    }
    if (opcode === 0xf5) {
      const addr = direct();
      this.writeDirect(addr, this.a);
      return `MOV ${fmtDirect(addr)}, A`;
    }
    if (opcode === 0xf6 || opcode === 0xf7) {
      const reg = opcode & 1;
      this.writeIndirect(reg, this.a);
      return `MOV @R${reg}, A`;
    }
    const reg = opcode & 7;
    this.setR(reg, this.a);
    return `MOV R${reg}, A`;
  }

  private cjne(opcode: number, direct: () => number, imm: () => number): string {
    let left: number;
    let right: number;
    let off: number;
    let text: string;
    if (opcode === 0xb4) {
      right = imm();
      off = imm();
      left = this.a;
      text = `CJNE A, #0x${hex(right, 2)}, ${signed(off)}`;
    } else if (opcode === 0xb5) {
      const addr = direct();
      off = imm();
      left = this.a;
      right = this.readDirect(addr);
      text = `CJNE A, ${fmtDirect(addr)}, ${signed(off)}`;
    } else if (opcode === 0xb6 || opcode === 0xb7) {
      const reg = opcode & 1;
      right = imm();
      off = imm();
      left = this.readIndirect(reg);
      text = `CJNE @R${reg}, #0x${hex(right, 2)}, ${signed(off)}`;
    } else {
      const reg = opcode & 7;
      right = imm();
      off = imm();
      left = this.getR(reg);
      text = `CJNE R${reg}, #0x${hex(right, 2)}, ${signed(off)}`;
    }
    this.carry = left < right ? 1 : 0;
    if (left !== right) this.jumpRel(off);
    return text;
  }

  private xch(opcode: number, direct: () => number): string {
    const oldA = this.a;
    if (opcode === 0xc5) {
      const addr = direct();
      this.a = this.readDirect(addr);
      this.writeDirect(addr, oldA);
      return `XCH A, ${fmtDirect(addr)}`;
    }
    if (opcode === 0xc6 || opcode === 0xc7) {
      const reg = opcode & 1;
      this.a = this.readIndirect(reg);
      this.writeIndirect(reg, oldA);
      return `XCH A, @R${reg}`;
    }
    const reg = opcode & 7;
    this.a = this.getR(reg);
    this.setR(reg, oldA);
    return `XCH A, R${reg}`;
  }

  private djnz(opcode: number, direct: () => number, imm: () => number): string {
    if (opcode === 0xd5) {
      const addr = direct();
      const off = imm();
      const value = u8(this.readDirect(addr) - 1);
      this.writeDirect(addr, value);
      if (value !== 0) this.jumpRel(off);
      return `DJNZ ${fmtDirect(addr)}, ${signed(off)}`;
    }
    if (opcode === 0xd6 || opcode === 0xd7) {
      const reg = opcode & 1;
      const indirect = this.readIndirect(reg);
      this.writeIndirect(reg, (indirect & 0xf0) | (this.a & 0x0f));
      this.a = (this.a & 0xf0) | (indirect & 0x0f);
      return `XCHD A, @R${reg}`;
    }
    const reg = opcode & 7;
    const off = imm();
    const value = u8(this.getR(reg) - 1);
    this.setR(reg, value);
    if (value !== 0) this.jumpRel(off);
    return `DJNZ R${reg}, ${signed(off)}`;
  }

  private decimalAdjust(): void {
    const value = this.a;
    let add = 0;
    if ((value & 0x0f) > 9 || ((this.psw >> 6) & 1)) add |= 0x06;
    if (value > 0x99 || this.carry) {
      add |= 0x60;
      this.carry = 1;
    }
    this.a = value + add;
  }
}

function isAjmp(opcode: number): boolean {
  return [0x01, 0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0xe1].includes(opcode);
}

function isAcall(opcode: number): boolean {
  return [0x11, 0x31, 0x51, 0x71, 0x91, 0xb1, 0xd1, 0xf1].includes(opcode);
}

function signed(value: number): string {
  const offset = rel8(value);
  return `${offset >= 0 ? "+" : ""}${offset}`;
}

function branchName(opcode: number): string {
  return ({ 0x40: "JC", 0x50: "JNC", 0x60: "JZ", 0x70: "JNZ", 0x80: "SJMP" } as Record<number, string>)[opcode];
}

function applyLogic(op: "|" | "&" | "^", left: number, right: number): number {
  if (op === "|") return left | right;
  if (op === "&") return left & right;
  return left ^ right;
}

function logicName(op: "|" | "&" | "^"): string {
  if (op === "|") return "ORL";
  if (op === "&") return "ANL";
  return "XRL";
}

export function formatTrace(entry: TraceEntry): string {
  const raw = entry.bytes.map((byte) => hex(byte, 2)).join(" ");
  return `${hex(entry.pc, 4)}: ${raw.padEnd(8)} ${entry.text.padEnd(24)} A=${hex(entry.a, 2)} B=${hex(entry.b, 2)} PSW=${hex(entry.psw, 2)} SP=${hex(entry.sp, 2)} DPTR=${hex(entry.dptr, 4)}`;
}
