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
//   - ON/OFF is an electrical power control and has no firmware scan code.
export const FRONT_PANEL_KEYS = [
  // Control / shift / cancel keys.
  "^",
  "DEL",
  // Single-function side / dispatcher keys.
  "CONF",
  "BRIGHT",
  "KEY",
  "ENCR",
  "SEND",
  "DISPL",
  "ACK_NAK",
  "ON_OFF",
  "SHORT_TERM",
  "INPUT_PRINT",
  // Upper-legend convenience aliases for dual-function keys. Pressing these
  // arms the controller with the SHIFT bit pre-set, so manual-expectations and
  // tests can speak the firmware's shifted byte without juggling `^`.
  "TIME",
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
  static readonly COUNTER_MODULUS = 0x9000;
  static readonly TICKS_PER_DAY = ClockDevice.COUNTER_MODULUS;
  static readonly CPU_CYCLES_PER_SECOND = 921_600;
  static readonly CPU_CYCLES_PER_TICK = (ClockDevice.CPU_CYCLES_PER_SECOND * 86_400) / ClockDevice.TICKS_PER_DAY;

  private displayTimingReadCount = 0;
  private counter = ClockDevice.COUNTER_MODULUS - 1;
  private cycleRemainder = 0;
  private readonly timeDigits = new Uint8Array(4);

  readDisplayTiming(baseValue: number, touched: boolean): number {
    if (!touched) return baseValue & 0xff;
    const value = ((baseValue & 0xff) + 0x66 * this.displayTimingReadCount) & 0xff;
    this.displayTimingReadCount += 1;
    return value;
  }

  resetDisplayTiming(): void {
    this.displayTimingReadCount = 0;
  }

  readCounterByte(high: boolean): number {
    return high ? (this.counter >> 8) & 0xff : this.counter & 0xff;
  }

  advanceCpuCycles(cycles: number): void {
    if (cycles <= 0) return;
    this.cycleRemainder += cycles;
    const ticks = Math.floor(this.cycleRemainder / ClockDevice.CPU_CYCLES_PER_TICK);
    if (ticks === 0) return;
    this.cycleRemainder -= ticks * ClockDevice.CPU_CYCLES_PER_TICK;
    this.counter = (this.counter - (ticks % ClockDevice.COUNTER_MODULUS) + ClockDevice.COUNTER_MODULUS) % ClockDevice.COUNTER_MODULUS;
  }

  /** Deterministic test/operator hook for the battery-backed real-time clock. */
  advanceSeconds(seconds: number): void {
    this.advanceCpuCycles(Math.max(0, seconds) * ClockDevice.CPU_CYCLES_PER_SECOND);
  }

  observeTimeDigit(address: number, value: number): void {
    if (address < 0x7165 || address > 0x7168) return;
    const byte = value & 0xff;
    if (byte >= 0x30 && byte <= 0x39) this.timeDigits[address - 0x7165] = byte;
  }

  restoreHourTens(line: string): string {
    const tens = this.timeDigits[0];
    if (!line.startsWith("TIME:  ") || tens < 0x31 || tens > 0x32) return line;
    return `${line.slice(0, 6)}${String.fromCharCode(tens)}${line.slice(7)}`;
  }

  reset(): void {
    this.displayTimingReadCount = 0;
    this.counter = ClockDevice.COUNTER_MODULUS - 1;
    this.cycleRemainder = 0;
    this.timeDigits.fill(0);
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
    if (address === 0x8412) return this.clock.readCounterByte(false);
    if (address === 0x8413) return this.clock.readCounterByte(true);
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
  private readonly portBuffer = new Uint8Array(32).fill(0x20);
  private portCandidate = 0x20;
  private portTouched = false;
  private brightness = 0;
  private blanked = false;
  private inactiveCpuCycles = 0;

  constructor(private readonly clock: ClockDevice = new ClockDevice()) {
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

  /**
   * Decode the character/strobe stream written to the external display port.
   * The E22 ROM writes a character several times, writes it again with bit 6
   * set, then writes 0xE0..0xFF to select one of the 32 display positions.
   */
  writeDataPort(value: number): void {
    const byte = value & 0xff;
    if (byte >= 0xe0) {
      this.portBuffer[byte & 0x1f] = this.portCandidate & 0x3f;
      this.portTouched = true;
      this.controller.markTouched();
      return;
    }
    this.portCandidate = byte;
  }

  displayLine(): string {
    if (this.blanked) return " ".repeat(32);
    if (!this.controller.isTouched()) return "UA-8295 READY?";
    const text = this.portTouched ? this.portLine() : this.textLine();
    if (text.trim().length > 0) return this.clock.restoreHourTens(text);
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

  portSnapshot(): number[] {
    return [...this.portBuffer];
  }

  portLine(): string {
    return [...this.portBuffer]
      .map((byte) => byte === 0 || byte === 0x3f ? (byte === 0x3f ? "?" : " ") : displayCharacter(byte))
      .join("")
      .slice(0, 32)
      .padEnd(32, " ");
  }

  brightnessLevel(): 0 | 1 | 2 {
    return this.brightness as 0 | 1 | 2;
  }

  cycleBrightness(): void {
    this.brightness = (this.brightness + 1) % 3;
    this.noteActivity();
  }

  isBlanked(): boolean {
    return this.blanked;
  }

  noteActivity(): void {
    this.inactiveCpuCycles = 0;
    this.blanked = false;
  }

  advanceCpuCycles(cycles: number): void {
    this.inactiveCpuCycles += Math.max(0, cycles);
    if (this.inactiveCpuCycles >= ClockDevice.CPU_CYCLES_PER_SECOND * 30) this.blanked = true;
  }

  reset(): void {
    this.textBuffer.fill(0);
    this.portBuffer.fill(0x20);
    this.portCandidate = 0x20;
    this.portTouched = false;
    this.brightness = 0;
    this.blanked = false;
    this.inactiveCpuCycles = 0;
  }

}

export class SerialLinkDevice {
  private endpoints: Partial<Record<CpuName, MCS51>> = {};
  private readonly pending: Array<{ target: CpuName; value: number; rb8: boolean; ticks: number }> = [];
  private readonly transfers: Array<{ sequence: number; source: CpuName; target: CpuName; value: number; rb8: boolean }> = [];
  private nextTransferSequence = 1;

  connect(main: MCS51, iop: MCS51): void {
    this.endpoints = { main, iop };
  }

  endpoint(cpu: CpuName): MCS51 | undefined {
    return this.endpoints[cpu];
  }

  transmit(cpu: CpuName, value: number, tb8: boolean): void {
    const target = cpu === "main" ? "iop" : "main";
    this.pending.push({ target, value: value & 0xff, rb8: tb8, ticks: 1 });
    this.transfers.push({ sequence: this.nextTransferSequence++, source: cpu, target, value: value & 0xff, rb8: tb8 });
    if (this.transfers.length > 512) this.transfers.shift();
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

  recentTransfers(): readonly { sequence: number; source: CpuName; target: CpuName; value: number; rb8: boolean }[] {
    return this.transfers;
  }
}

export class ModemRadioDevice {
  private readonly registers = new Map<number, number>();
  private txActive = false;
  private txMark = true;
  private carrier = false;
  private rxMark = true;

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

  /**
   * Observe the IOP's modem-facing P3 pins. Firmware at 0x0417 pulls P3.4
   * low for the transmit routine and restores it at 0x0479. Timer 0 drives
   * the encoded mark/space waveform on P3.6.
   */
  observePort3(value: number): void {
    const byte = value & 0xff;
    this.txActive = (byte & 0x10) === 0;
    this.txMark = (byte & 0x40) !== 0;
  }

  /** Present the linked terminal's demodulated mark/space signal on P3.5. */
  readPort3(latchValue: number): number {
    let value = latchValue & 0xff;
    // A written zero still drives the quasi-bidirectional pin low. A written
    // one releases it so the external modem can supply the received signal.
    if ((value & 0x20) !== 0) {
      if (!this.carrier || this.rxMark) value |= 0x20;
      else value &= ~0x20;
    }
    return value;
  }

  setInput(carrier: boolean, mark: boolean): void {
    this.carrier = carrier;
    this.rxMark = mark;
  }

  isTransmitting(): boolean {
    return this.txActive;
  }

  transmitMark(): boolean {
    return this.txMark;
  }

  hasCarrier(): boolean {
    return this.carrier;
  }

  receiveMark(): boolean {
    return this.rxMark;
  }

  reset(): void {
    this.registers.clear();
    this.txActive = false;
    this.txMark = true;
    this.carrier = false;
    this.rxMark = true;
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
// stored at iram[0x1C]. The mapping follows the physical legends in the manual:
// the lower legend is unshifted and the upper legend is selected with `^`.
//
// ON_OFF has no scan path because it is a real power switch.
export const RAW_SCAN_INDEX = new Map<FrontPanelKey, number>([
  ["SCROLL_RIGHT", 0x00],
  ["SCROLL_LEFT", 0x01],
  ["DEL", 0x02],
  ["ACK_NAK", 0x03],
  ["DISPL", 0x04],
  ["INPUT_PRINT", 0x05],
  ["ENCR", 0x06],
  ["SEND", 0x07],
  ["BRIGHT", 0x08],
  ["KEY", 0x09],
  ["CONF", 0x0a],
  ["SHORT_TERM", 0x0b],
  ["SPACE", 0x0f],
  [",", 0x10],
  ["-", 0x11],
  [".", 0x12],
  ["=", 0x13],
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
  // Convenience names for the upper legends. Each includes the raw SHIFT bit,
  // so callers can request TIME/DECR/SHORT/NEW_KEY directly as well as by
  // holding `^` with the physical lower-legend key.
  ["TIME", 0x08 | 0x40],
  ["DECR", 0x06 | 0x40],
  ["SHORT", 0x0b | 0x40],
  ["NEW_KEY", 0x09 | 0x40]
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
  private hardwareKey: FrontPanelKey | null = null;

  connectSerialEndpoints(main: MCS51, iop: MCS51): void {
    this.serial.connect(main, iop);
    this.mainCpu = main;
  }

  service(): void {
    this.serial.service();
    this.updateKeyboardScan();
  }

  advanceCpuCycles(cycles: number): void {
    this.clock.advanceCpuCycles(cycles);
    this.display.advanceCpuCycles(cycles);
  }

  /** Deterministic wall-clock hook used by manual scenarios and operators. */
  advanceSeconds(seconds: number): void {
    const duration = Math.max(0, seconds);
    this.clock.advanceSeconds(duration);
    this.display.advanceCpuCycles(duration * ClockDevice.CPU_CYCLES_PER_SECOND);
  }

  reset(): void {
    this.keyboard.clear();
    this.keyboardScan.reset();
    this.clock.reset();
    this.display.reset();
    this.modemRadio.reset();
    this.hardwareKey = null;
  }

  readSfr(cpu: CpuName, address: number, latchValue: number): number {
    if (address === 0xb0) {
      if (cpu === "iop") return this.modemRadio.readPort3(latchValue);
      const base = this.keyboard.readP3(latchValue, { forceReadyLow: cpu === "main" });
      const armedOrPressed = this.keyboard.firstPressedKey();
      return this.keyboardScan.p3LineHigh(armedOrPressed) ? base | 0x08 : base & ~0x08;
    }
    return latchValue;
  }

  writeSfr(cpu: CpuName, address: number, value: number): void {
    if (cpu === "iop" && address === 0xb0) {
      this.modemRadio.observePort3(value);
    }
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
      this.clock.observeTimeDigit(address, value);
      if (address === 0x0000) this.display.writeDataPort(value);
      this.storage.writeXdata(cpu, address, value);
      return;
    }
    this.modemRadio.writeXdata(cpu, address, value);
  }

  private updateKeyboardScan(): void {
    if (this.keyboard.pressedKeys().length === 0) {
      this.keyboardScan.notifyKeyReleased();
      this.hardwareKey = null;
      return;
    }

    // SHIFT (`^`) is only a modifier; TERM is the raw 0x00 control key.
    const shiftHeld = this.keyboard.isShiftHeld();
    // Any physical key wakes the display, including SHIFT by itself and keys
    // handled entirely in hardware rather than by the ROM scan pipeline.
    this.display.noteActivity();
    const nonShift = this.keyboard.firstNonShiftKey();
    if (nonShift === undefined) return;
    const target = nonShift;

    // Display brightness is local display-controller hardware. It never needs
    // to enter the main CPU's function dispatcher unless SHIFT selects TIME.
    if (target === "BRIGHT" && !shiftHeld) {
      if (this.hardwareKey !== target) this.display.cycleBrightness();
      this.hardwareKey = target;
      return;
    }

    if (!this.keyboardScan.canArm(target)) return;
    const baseCode = RAW_SCAN_INDEX.get(target);
    if (baseCode === undefined) {
      // ON_OFF is electrical rather than matrix-scanned.
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
