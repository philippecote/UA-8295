import { hex, type XdataRegion } from "./memory";
import type { CpuHardwareHooks, MCS51 } from "./mcs51";
import type { CpuName } from "./trace";

// Full UA-8295 / DA-8520 front-panel set as labelled on the photo-grade chassis.
// Layout reflects the real keyboard:
//   - Single physical keys with a dual-function (shifted) legend each have ONE
//     primary entry here. The shifted legend is exposed as a convenience alias
//     whose RAW_SCAN_INDEX value already has the SHIFT bit (0x40) baked in, so
//     callers (tests, UI, host-keyboard map) can address either form by name
//     without duplicating physical keys.
//   - Physical SHIFT is the `^` key. When held simultaneously with another key
//     the `KeyboardScanController` is armed with `RAW_SCAN_INDEX[other] | 0x40`
//     instead of treating `^` as cancel. See `UA8295Hardware.updateKeyboardScan`.
//   - `ON_OFF`, `SCROLL_LEFT`, `SCROLL_RIGHT` exist as UI buttons but the IOP
//     firmware has no scan path for them; pressing them is a no-op until that
//     pipeline is reverse-engineered.
export const FRONT_PANEL_KEYS = [
  // Control / shift / cancel keys.
  "^",
  "DEL",
  // Single-function side / dispatcher keys.
  "CONF",
  "TIME",
  "KEY",
  "ENCR",
  "SEND",
  "DISPL",
  "ACK_NAK",
  "ON_OFF",
  "SHORT_TERM",
  // Shift-convenience aliases for the dual-function keys above. Pressing these
  // arms the controller with the SHIFT bit pre-set, so manual-expectations and
  // tests can speak the firmware's shifted byte without juggling `^`.
  "RCV",
  "INPUT_PRINT",
  "BRIGHT",
  "NEW_KEY",
  "DECR",
  "SHORT",
  // Numeric row.
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  // Alpha keys (the device only has uppercase).
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  // Punctuation + spacebar.
  ",",
  ".",
  "-",
  "=",
  "SPACE",
  // Cursor scroll keys (no firmware path yet).
  "SCROLL_LEFT",
  "SCROLL_RIGHT"
] as const;

export type FrontPanelKey = (typeof FRONT_PANEL_KEYS)[number];

export const SHIFT_KEY: FrontPanelKey = "^";

export class KeyboardDevice {
  private readonly pressed = new Set<FrontPanelKey>();

  setPressed(key: FrontPanelKey, isPressed: boolean): void {
    if (isPressed) this.pressed.add(key);
    else this.pressed.delete(key);
  }

  clear(): void {
    this.pressed.clear();
  }

  /**
   * Returns the latched P3 value with the main-CPU self-test ready bit pulled low
   * when requested. The IOP no longer scans the keyboard via P1 row select +
   * P3 column read - the dedicated controller chip drives 0x8400 + P3.3 directly,
   * so this hook intentionally does not mask any column bits per pressed key.
   */
  readP3(latchValue: number, options: { forceReadyLow?: boolean } = {}): number {
    let value = latchValue & 0xff;
    if (options.forceReadyLow) {
      value &= ~0x20;
    }
    return value;
  }

  pressedKeys(): FrontPanelKey[] {
    return [...this.pressed];
  }

  firstPressedKey(): FrontPanelKey | undefined {
    return this.pressed.values().next().value;
  }

  /** Returns the first non-SHIFT key currently held, or undefined when only SHIFT (or nothing) is held. */
  firstNonShiftKey(): FrontPanelKey | undefined {
    for (const key of this.pressed) {
      if (key !== SHIFT_KEY) return key;
    }
    return undefined;
  }

  isShiftHeld(): boolean {
    return this.pressed.has(SHIFT_KEY);
  }

  describe(): string {
    const keys = this.pressedKeys();
    return keys.length ? `KEY ${keys.join("+")}` : "IDLE";
  }
}

export class ClockDevice {
  private displayTimingReadCount = 0;

  readDisplayTiming(baseValue: number, touched: boolean): number {
    if (!touched) return baseValue & 0xff;
    const value = ((baseValue & 0xff) + 0x66 * this.displayTimingReadCount) & 0xff;
    this.displayTimingReadCount += 1;
    return value;
  }

  resetDisplayTiming(): void {
    this.displayTimingReadCount = 0;
  }
}

export class DisplayControllerDevice {
  private readonly registers = new Uint8Array(0x20);
  private readonly writes: Array<{ address: number; value: number }> = [];
  private touched = false;

  constructor(private readonly clock: ClockDevice = new ClockDevice()) {}

  readRegister(address: number, busValue: number): number {
    if (!this.isDisplayAddress(address)) return busValue;
    if (address === 0x8400) {
      // The firmware checks bits 3-5 as controller-ready/status flags.
      return (this.registers[0] | 0x38) & 0xff;
    }
    if (address === 0x8410 && this.touched) {
      return this.clock.readDisplayTiming(this.registers[0x10], this.touched);
    }
    const offset = address - 0x8400;
    return this.touched ? this.registers[offset] : busValue;
  }

  writeRegister(address: number, value: number): void {
    if (!this.isDisplayAddress(address)) return;
    const byte = value & 0xff;
    this.registers[address - 0x8400] = byte;
    if (address === 0x8410) {
      this.clock.resetDisplayTiming();
    }
    this.writes.push({ address, value: byte });
    if (this.writes.length > 16) this.writes.shift();
    this.touched = true;
  }

  isTouched(): boolean {
    return this.touched;
  }

  markTouched(): void {
    this.touched = true;
  }

  register(offset: number): number {
    return this.registers[offset & 0x1f];
  }

  recentWrites(): Array<{ address: number; value: number }> {
    return this.writes.slice();
  }

  activeRegisters(): Array<{ address: number; value: number }> {
    return [...this.registers.entries()]
      .filter(([, value]) => value !== 0)
      .map(([offset, value]) => ({ address: 0x8400 + offset, value }));
  }

  snapshot(): number[] {
    return [...this.registers];
  }

  private isDisplayAddress(address: number): boolean {
    return address >= 0x8400 && address <= 0x841f;
  }
}

export class DisplayDevice {
  readonly controller: DisplayControllerDevice;
  private readonly textBuffer = new Uint8Array(32);

  constructor(clock: ClockDevice = new ClockDevice()) {
    this.controller = new DisplayControllerDevice(clock);
  }

  readRegister(address: number, busValue: number): number {
    return this.controller.readRegister(address, busValue);
  }

  writeRegister(address: number, value: number): void {
    this.controller.writeRegister(address, value);
  }

  writeTextBuffer(address: number, value: number): void {
    if (address < 0x7fe0 || address > 0x7fff) return;
    this.textBuffer[address - 0x7fe0] = value & 0xff;
    this.controller.markTouched();
  }

  displayLine(): string {
    if (!this.controller.isTouched()) return "UA-8295 READY?";
    const text = this.textLine();
    if (text.trim().length > 0) return text;
    const active = this.activeRegisters()
      .slice(0, 4)
      .map(({ address, value }) => `${hex(address, 4)}=${hex(value, 2)}`);
    return (active.join(" ") || "DISPLAY REGISTERS CLEAR").slice(0, 32).padEnd(32, " ");
  }

  detailLines(): string[] {
    const active = this.activeRegisters();
    const recent = this.controller.recentWrites().slice(-6).map(({ address, value }) => `${hex(address, 4)}:${hex(value, 2)}`);
    return [
      `status 8400=${hex(this.readRegister(0x8400, 0), 2)} command 840A=${hex(this.controller.register(0x0a), 2)} error 840E=${hex(this.controller.register(0x0e), 2)}`,
      `text "${this.textLine()}"`,
      `cursor/window 8410=${hex(this.controller.register(0x10), 2)} 8411=${hex(this.controller.register(0x11), 2)} 8412=${hex(this.controller.register(0x12), 2)} 8418=${hex(this.controller.register(0x18), 2)} 8419=${hex(this.controller.register(0x19), 2)}`,
      `active ${active.length ? active.map(({ address, value }) => `${hex(address, 4)}=${hex(value, 2)}`).join(" ") : "none"}`,
      `recent ${recent.length ? recent.join(" ") : "none"}`
    ];
  }

  activeRegisters(): Array<{ address: number; value: number }> {
    return this.controller.activeRegisters();
  }

  snapshot(): number[] {
    return this.controller.snapshot();
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

}

export class SerialLinkDevice {
  private endpoints: Partial<Record<CpuName, MCS51>> = {};
  private readonly pending: Array<{ target: CpuName; value: number; rb8: boolean; ticks: number }> = [];

  connect(main: MCS51, iop: MCS51): void {
    this.endpoints = { main, iop };
  }

  endpoint(cpu: CpuName): MCS51 | undefined {
    return this.endpoints[cpu];
  }

  transmit(cpu: CpuName, value: number, tb8: boolean): void {
    this.pending.push({ target: cpu === "main" ? "iop" : "main", value: value & 0xff, rb8: tb8, ticks: 1 });
  }

  service(): void {
    for (const transfer of [...this.pending]) {
      transfer.ticks -= 1;
      if (transfer.ticks > 0) continue;
      const peer = this.endpoints[transfer.target];
      peer?.receiveSerial(transfer.value, transfer.rb8);
      this.pending.splice(this.pending.indexOf(transfer), 1);
    }
  }

  pendingTransfers(): readonly { target: CpuName; value: number; rb8: boolean; ticks: number }[] {
    return this.pending;
  }
}

export class ModemRadioDevice {
  private readonly registers = new Map<number, number>();

  readXdata(cpu: CpuName, address: number, busValue: number): number {
    if (cpu !== "iop") return busValue;
    const masked = address & 0xffff;
    return this.registers.get(masked) ?? this.defaultStatus(masked, busValue);
  }

  writeXdata(cpu: CpuName, address: number, value: number): void {
    if (cpu !== "iop") return;
    this.registers.set(address & 0xffff, value & 0xff);
    if (this.registers.size > 64) {
      const first = this.registers.keys().next().value;
      if (first !== undefined) this.registers.delete(first);
    }
  }

  snapshot(): Array<{ address: number; value: number }> {
    return [...this.registers.entries()].map(([address, value]) => ({ address, value }));
  }

  private defaultStatus(_address: number, busValue: number): number {
    // Unidentified IOP peripherals are pulled up until a workflow trace proves a register-specific status bit.
    return busValue & 0xff;
  }
}

export class StorageControlDevice {
  private readonly controlWrites: Array<{ address: number; value: number }> = [];

  writeXdata(cpu: CpuName, address: number, value: number): void {
    if (cpu !== "main" || address !== 0x0000) return;
    this.controlWrites.push({ address, value: value & 0xff });
    if (this.controlWrites.length > 16) this.controlWrites.shift();
  }

  recentControlWrites(): readonly { address: number; value: number }[] {
    return this.controlWrites;
  }
}

// Authentic 7-bit scan codes the controller chip presents on XDATA 0x8400 once the
// INT1 strobe handshake completes. Bit 6 carries SHIFT; bits 0..5 index the
// lookup table at code address 0x045B that the firmware uses to derive the byte
// stored at iram[0x1C]. The shift-convenience aliases (RCV, BRIGHT, NEW_KEY,
// DECR, INPUT_PRINT, SHORT) map straight to the shifted-form raw code so callers
// that pressKey("RCV") get the same byte (0x9E) the firmware would produce when
// the user holds `^` while pressing SEND.
//
// Keys not present in this map (ON_OFF, SCROLL_LEFT, SCROLL_RIGHT) have no
// firmware scan path yet; pressing them is a no-op until that pipeline is
// reverse-engineered.
export const RAW_SCAN_INDEX = new Map<FrontPanelKey, number>([
  ["^", 0x00],
  ["DEL", 0x01],
  ["TIME", 0x03],
  ["CONF", 0x04],
  ["DISPL", 0x05],
  ["ENCR", 0x06],
  ["ACK_NAK", 0x07],
  ["SHORT_TERM", 0x08],
  ["SEND", 0x09],
  ["KEY", 0x0a],
  ["=", 0x0b],
  ["SPACE", 0x0f],
  [",", 0x10],
  ["-", 0x11],
  [".", 0x12],
  ["0", 0x14],
  ["1", 0x15],
  ["2", 0x16],
  ["3", 0x17],
  ["4", 0x18],
  ["5", 0x19],
  ["6", 0x1a],
  ["7", 0x1b],
  ["8", 0x1c],
  ["9", 0x1d],
  ["A", 0x1e],
  ["B", 0x1f],
  ["C", 0x20],
  ["D", 0x21],
  ["E", 0x22],
  ["F", 0x23],
  ["G", 0x24],
  ["H", 0x25],
  ["I", 0x26],
  ["J", 0x27],
  ["K", 0x28],
  ["L", 0x29],
  ["M", 0x2a],
  ["N", 0x2b],
  ["O", 0x2c],
  ["P", 0x2d],
  ["Q", 0x2e],
  ["R", 0x2f],
  ["S", 0x30],
  ["T", 0x31],
  ["U", 0x32],
  ["V", 0x33],
  ["W", 0x34],
  ["X", 0x35],
  ["Y", 0x36],
  ["Z", 0x37],
  // Shift-convenience aliases. Each value equals the unshifted raw code | 0x40
  // so the firmware's lookup at 0x045B produces the corresponding upper-bit byte
  // (e.g. RCV → 0x9E, BRIGHT → 0x8E, NEW_KEY → 0x85, DECR → 0x9F, SHORT → 0x9C,
  // INPUT_PRINT → 0x9D).
  ["BRIGHT", 0x03 | 0x40],
  ["INPUT_PRINT", 0x05 | 0x40],
  ["DECR", 0x06 | 0x40],
  ["SHORT", 0x08 | 0x40],
  ["RCV", 0x09 | 0x40],
  ["NEW_KEY", 0x0a | 0x40]
]);

export type KeyboardScanState = "idle" | "pending" | "strobe" | "ready";

/**
 * Mediates main-CPU XDATA accesses to address 0x8400 for the authentic INT1 +
 * keyboard-controller handshake described in the firmware at 0x03E2..0x045A:
 *
 *   IDLE    - no key armed; firmware sees P3.3 HIGH so the INT1 handler early-outs.
 *   PENDING - INT1 has been requested; P3.3 LOW. The firmware enters its init loop
 *             and writes 0x80..0x87 to 0x8400 (3 writes per iteration, INC A, JNB
 *             ACC.3 loop); we drive P3.3 HIGH on every bit-7-set write so the
 *             `JB P3.3` at 0x0410 takes. We stay in PENDING until the firmware
 *             follows up with a bit-7-CLEAR write (CLR ACC.7 + MOVX) which marks
 *             the start of the strobe phase.
 *   STROBE  - 8-iteration handshake at 0x041A..0x042F. Phase-1 writes (bit 7 = 0)
 *             must see P3.3 LOW; phase-2 writes (bit 7 = 1) must see P3.3 HIGH.
 *             The loop exits at 0x0424 when ADD A, #0x10 overflows bit 7, i.e.
 *             after the 8th phase-1 batch whose value is in 0x70..0x7F. We trip
 *             READY on any phase-1 write with the high nibble equal to 0x7,
 *             because that is the unambiguous final batch before MOVX A, @DPTR.
 *   READY   - the next read of 0x8400 returns the 7-bit raw code (bit 6 = SHIFT,
 *             bits 0..5 = scan index). After the read we go back to IDLE and hold
 *             P3.3 HIGH until the key is released and pressed again, mimicking
 *             the controller's edge-triggered debounce.
 */
export class KeyboardScanController {
  private state: KeyboardScanState = "idle";
  private rawCode = 0;
  private p33High = true;
  private armedKey: FrontPanelKey | null = null;
  private ackedKey: FrontPanelKey | null = null;
  private readonly writes: number[] = [];

  armKey(rawCode: number, key: FrontPanelKey): void {
    this.rawCode = rawCode & 0x7f;
    this.armedKey = key;
    this.ackedKey = null;
    this.state = "pending";
    this.p33High = false;
    this.writes.length = 0;
  }

  /** Returns true if a fresh keypress can be armed (no in-flight handshake or ack). */
  canArm(currentKey: FrontPanelKey | undefined): boolean {
    if (this.state !== "idle") return false;
    if (this.ackedKey !== null && currentKey === this.ackedKey) return false;
    return true;
  }

  notifyKeyReleased(): void {
    this.ackedKey = null;
    this.armedKey = null;
  }

  /** Returns the byte to return for a 0x8400 read, or null if it should fall through. */
  readPort(): number | null {
    if (this.state === "ready") {
      // The post-handshake key-code read at 0x0433 (MOVX A, @DPTR).
      const value = this.rawCode & 0x7f;
      this.state = "idle";
      this.ackedKey = this.armedKey;
      this.armedKey = null;
      // Leave p33High alone — the IDLE p33 line is recomputed from "held-key"
      // state in p3LineHigh(); driving HIGH here would short-circuit the
      // firmware's wait-for-release loop at 0x0624.
      return value;
    }
    if (this.state === "pending") {
      // The status-check read at 0x03F0. The firmware does ANL A, #0x38 then
      // CJNE A, #0x38, +0x15 → 0x040B; the +0x15 branch is the GOOD path that
      // enters the init/strobe loop, so bits 3..5 must NOT all be set. Return
      // 0x00 (controller "key pending, ready for handshake") to take that path.
      return 0x00;
    }
    return null;
  }

  writePort(value: number): void {
    const byte = value & 0xff;
    this.writes.push(byte);
    if (this.writes.length > 16) this.writes.shift();

    if (this.state === "pending") {
      if ((byte & 0x80) !== 0) {
        // Init pattern (0x80..0x87): assert P3.3 HIGH so JB P3.3 at 0x0410 takes.
        this.p33High = true;
        return;
      }
      // First bit-7-clear write marks the start of the strobe handshake.
      this.state = "strobe";
      this.p33High = false;
      return;
    }

    if (this.state === "strobe") {
      if ((byte & 0x80) === 0) {
        this.p33High = false;
        if ((byte & 0xf0) === 0x70) {
          // Final phase-1 batch (0x70..0x7F): firmware will exit the loop and
          // do MOVX A, @DPTR next. P3.3 must remain LOW so the JB at 0x041F
          // does not branch to the cleanup path.
          this.state = "ready";
        }
      } else {
        this.p33High = true;
      }
    }
  }

  /** Logical level of P3.3 the controller is presenting to the main CPU. */
  p3LineHigh(currentKey: FrontPanelKey | undefined): boolean {
    if (this.state === "pending" || this.state === "strobe" || this.state === "ready") {
      return this.p33High;
    }
    // IDLE: the controller releases P3.3 on key release. The firmware's
    // wait-for-release loop at 0x0624 spins on `JNB P3.3` until this line goes
    // HIGH. We can safely keep P3.3 LOW while the same key is held because INT1
    // re-firing is gated by armKey() / canArm(), not by automatic level/edge
    // sampling of P3.3.
    return currentKey === undefined;
  }

  scanState(): KeyboardScanState {
    return this.state;
  }

  recentStrobes(): readonly number[] {
    return this.writes.slice();
  }

  reset(): void {
    this.state = "idle";
    this.rawCode = 0;
    this.p33High = true;
    this.armedKey = null;
    this.ackedKey = null;
    this.writes.length = 0;
  }
}

export class UA8295Hardware implements CpuHardwareHooks {
  readonly keyboard = new KeyboardDevice();
  readonly clock = new ClockDevice();
  readonly display = new DisplayDevice(this.clock);
  readonly serial = new SerialLinkDevice();
  readonly modemRadio = new ModemRadioDevice();
  readonly storage = new StorageControlDevice();
  readonly keyboardScan = new KeyboardScanController();
  private mainCpu: MCS51 | undefined;

  connectSerialEndpoints(main: MCS51, iop: MCS51): void {
    this.serial.connect(main, iop);
    this.mainCpu = main;
  }

  service(): void {
    this.serial.service();
    this.updateKeyboardScan();
  }

  readSfr(cpu: CpuName, address: number, latchValue: number): number {
    if (address === 0xb0) {
      const base = this.keyboard.readP3(latchValue, { forceReadyLow: cpu === "main" });
      if (cpu !== "main") return base;
      const armedOrPressed = this.keyboard.firstPressedKey();
      return this.keyboardScan.p3LineHigh(armedOrPressed) ? base | 0x08 : base & ~0x08;
    }
    return latchValue;
  }

  writeSfr(_cpu: CpuName, _address: number, _value: number): void {
    // The IOP no longer scans the keyboard via P1 row-select; the dedicated
    // controller chip drives 0x8400 + P3.3 directly, so there is nothing to do
    // for SFR writes at the moment. The hook stays in place for future use
    // (display brightness, charge/transmit LEDs, etc.).
  }

  transmitSerial(cpu: CpuName, value: number, tb8: boolean): void {
    this.serial.transmit(cpu, value, tb8);
  }

  readXdata(cpu: CpuName, address: number, busValue: number, _region: XdataRegion): number {
    if (cpu === "main") {
      if (address === 0x8400) {
        const handshakeValue = this.keyboardScan.readPort();
        if (handshakeValue !== null) return handshakeValue;
      }
      return this.display.readRegister(address, busValue);
    }
    return this.modemRadio.readXdata(cpu, address, busValue);
  }

  writeXdata(cpu: CpuName, address: number, value: number): void {
    if (cpu === "main") {
      if (address === 0x8400) {
        this.keyboardScan.writePort(value);
      }
      this.display.writeRegister(address, value);
      this.display.writeTextBuffer(address, value);
      this.storage.writeXdata(cpu, address, value);
      return;
    }
    this.modemRadio.writeXdata(cpu, address, value);
  }

  private updateKeyboardScan(): void {
    if (this.keyboard.pressedKeys().length === 0) {
      this.keyboardScan.notifyKeyReleased();
      return;
    }

    // SHIFT (`^`) acts as a modifier when held simultaneously with another key.
    // When held alone it is the cancel key (raw 0x00). Pick the first non-SHIFT
    // key as the target and OR the SHIFT bit (0x40) onto its base scan code if
    // `^` is also held; otherwise fall back to whatever single key is pressed.
    const shiftHeld = this.keyboard.isShiftHeld();
    const nonShift = this.keyboard.firstNonShiftKey();
    const target = nonShift ?? SHIFT_KEY;

    if (!this.keyboardScan.canArm(target)) return;
    const baseCode = RAW_SCAN_INDEX.get(target);
    if (baseCode === undefined) {
      // ON_OFF, SCROLL_LEFT, SCROLL_RIGHT have no firmware scan path yet.
      return;
    }
    const code = shiftHeld && nonShift !== undefined ? (baseCode | 0x40) : baseCode;
    this.keyboardScan.armKey(code, target);
    this.mainCpu?.requestInterrupt("EX1");
  }
}

export function displayCharacter(byte: number): string {
  const value = byte & 0xff;
  if (value >= 1 && value <= 26) return String.fromCharCode(0x40 + value);
  if (value >= 0x20 && value <= 0x7e) return String.fromCharCode(value);
  return ".";
}
