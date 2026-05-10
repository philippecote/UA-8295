import { hex, type XdataRegion } from "./memory";
import type { CpuHardwareHooks, MCS51 } from "./mcs51";
import type { CpuName } from "./trace";

export const FRONT_PANEL_KEYS = [
  "^",
  "CONF",
  "KEY",
  "TIME",
  "ENCR",
  "SEND",
  "RCV",
  "DEL",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7"
] as const;

export type FrontPanelKey = (typeof FRONT_PANEL_KEYS)[number];

export class KeyboardDevice {
  private readonly pressed = new Set<FrontPanelKey>();
  private rowLatch = 0xff;
  private readonly keyPositions = new Map<FrontPanelKey, { row: number; column: number }>(
    FRONT_PANEL_KEYS.map((key, index) => [key, { row: Math.floor(index / 4), column: index % 4 }])
  );

  setPressed(key: FrontPanelKey, isPressed: boolean): void {
    if (isPressed) this.pressed.add(key);
    else this.pressed.delete(key);
  }

  clear(): void {
    this.pressed.clear();
  }

  setRowLatch(value: number): void {
    this.rowLatch = value & 0xff;
  }

  readP3(latchValue: number, options: { forceReadyLow?: boolean } = {}): number {
    let value = latchValue & 0xff;
    if (options.forceReadyLow) {
      // The main firmware expects this ready/self-test input low before it continues.
      value &= ~0x20;
    }

    const selectedRows = this.selectedRows();
    for (const key of this.pressed) {
      const position = this.keyPositions.get(key);
      if (!position) continue;
      if (selectedRows === null || selectedRows.includes(position.row)) {
        value &= ~this.columnMask(position.column);
      }
    }
    return value;
  }

  pressedKeys(): FrontPanelKey[] {
    return [...this.pressed];
  }

  describe(): string {
    const keys = this.pressedKeys();
    const rows = this.selectedRows();
    const row = rows ? rows.join(",") : "*";
    return keys.length ? `ROW ${row} KEY ${keys.join("+")}` : `ROW ${row} LATCH ${hex(this.rowLatch, 2)}`;
  }

  private selectedRows(): number[] | null {
    const rows: number[] = [];
    for (let row = 0; row < 4; row += 1) {
      if ((this.rowLatch & (1 << row)) === 0) rows.push(row);
    }
    return rows.length > 0 ? rows : null;
  }

  private columnMask(column: number): number {
    // P3.3 is used by the firmware as a display/controller-ready line, so keep
    // the provisional key columns on P3.0-P3.2 and P3.4 until the matrix is fully decoded.
    return column === 3 ? 0x10 : 1 << column;
  }
}

export class DisplayDevice {
  private readonly registers = new Uint8Array(0x20);
  private readonly textBuffer = new Uint8Array(32);
  private readonly writes: Array<{ address: number; value: number }> = [];
  private timingReadCount = 0;
  private touched = false;

  readRegister(address: number, busValue: number): number {
    if (!this.isDisplayAddress(address)) return busValue;
    if (address === 0x8400) {
      // The firmware checks bits 3-5 as controller-ready/status flags.
      return (this.registers[0] | 0x38) & 0xff;
    }
    if (address === 0x8410 && this.touched) {
      const value = (this.registers[0x10] + 0x66 * this.timingReadCount) & 0xff;
      this.timingReadCount += 1;
      return value;
    }
    const offset = address - 0x8400;
    return this.touched ? this.registers[offset] : busValue;
  }

  writeRegister(address: number, value: number): void {
    if (!this.isDisplayAddress(address)) return;
    const byte = value & 0xff;
    this.registers[address - 0x8400] = byte;
    if (address === 0x8410) {
      this.timingReadCount = 0;
    }
    this.writes.push({ address, value: byte });
    if (this.writes.length > 16) this.writes.shift();
    this.touched = true;
  }

  writeTextBuffer(address: number, value: number): void {
    if (address < 0x7fe0 || address > 0x7fff) return;
    this.textBuffer[address - 0x7fe0] = value & 0xff;
    this.touched = true;
  }

  displayLine(): string {
    if (!this.touched) return "UA-8295 READY?";
    const text = this.textLine();
    if (text.trim().length > 0) return text;
    const active = this.activeRegisters()
      .slice(0, 4)
      .map(({ address, value }) => `${hex(address, 4)}=${hex(value, 2)}`);
    return (active.join(" ") || "DISPLAY REGISTERS CLEAR").slice(0, 32).padEnd(32, " ");
  }

  detailLines(): string[] {
    const active = this.activeRegisters();
    const recent = this.writes.slice(-6).map(({ address, value }) => `${hex(address, 4)}:${hex(value, 2)}`);
    return [
      `status 8400=${hex(this.readRegister(0x8400, 0), 2)} command 840A=${hex(this.registers[0x0a], 2)} error 840E=${hex(this.registers[0x0e], 2)}`,
      `text "${this.textLine()}"`,
      `cursor/window 8410=${hex(this.registers[0x10], 2)} 8411=${hex(this.registers[0x11], 2)} 8412=${hex(this.registers[0x12], 2)} 8418=${hex(this.registers[0x18], 2)} 8419=${hex(this.registers[0x19], 2)}`,
      `active ${active.length ? active.map(({ address, value }) => `${hex(address, 4)}=${hex(value, 2)}`).join(" ") : "none"}`,
      `recent ${recent.length ? recent.join(" ") : "none"}`
    ];
  }

  activeRegisters(): Array<{ address: number; value: number }> {
    return [...this.registers.entries()]
      .filter(([, value]) => value !== 0)
      .map(([offset, value]) => ({ address: 0x8400 + offset, value }));
  }

  snapshot(): number[] {
    return [...this.registers];
  }

  textSnapshot(): number[] {
    return [...this.textBuffer];
  }

  textLine(): string {
    return [...this.textBuffer]
      .map((byte) => {
        if (byte === 0 || byte === 0xff) return " ";
        return displayCharacter(byte);
      })
      .join("")
      .slice(0, 32)
      .padEnd(32, " ");
  }

  private isDisplayAddress(address: number): boolean {
    return address >= 0x8400 && address <= 0x841f;
  }
}

export class UA8295Hardware implements CpuHardwareHooks {
  readonly keyboard = new KeyboardDevice();
  readonly display = new DisplayDevice();
  private serialEndpoints: Partial<Record<CpuName, MCS51>> = {};

  connectSerialEndpoints(main: MCS51, iop: MCS51): void {
    this.serialEndpoints = { main, iop };
  }

  readSfr(cpu: CpuName, address: number, latchValue: number): number {
    if (address === 0xb0) {
      return this.keyboard.readP3(latchValue, { forceReadyLow: cpu === "main" });
    }
    return latchValue;
  }

  writeSfr(cpu: CpuName, address: number, value: number): void {
    if (address === 0x90) {
      this.keyboard.setRowLatch(value);
    }
  }

  transmitSerial(cpu: CpuName, value: number, tb8: boolean): void {
    const peer = cpu === "main" ? this.serialEndpoints.iop : this.serialEndpoints.main;
    peer?.receiveSerial(value, tb8);
  }

  readXdata(cpu: CpuName, address: number, busValue: number, _region: XdataRegion): number {
    if (cpu === "main") {
      return this.display.readRegister(address, busValue);
    }
    return busValue;
  }

  writeXdata(cpu: CpuName, address: number, value: number): void {
    if (cpu === "main") {
      this.display.writeRegister(address, value);
      this.display.writeTextBuffer(address, value);
    }
  }
}

export function displayCharacter(byte: number): string {
  const value = byte & 0xff;
  if (value >= 1 && value <= 26) return String.fromCharCode(0x40 + value);
  if (value >= 0x20 && value <= 0x7e) return String.fromCharCode(value);
  return ".";
}
