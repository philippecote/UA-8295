/**
 * The printer and computer interfaces (manual Section 1, paragraphs 2.2-2.3)
 * are software UARTs on main-CPU port 1. Timer 1 (ISR 0x12E3) shifts transmit
 * bits out and timer 0 (ISR 0x0304) samples the receive pins:
 *
 *   printer:  TX P1.6, RX P1.7, BUSY P1.5 (high = busy), settings at 0x730E
 *   computer: TX P1.3, RX P1.4, settings at 0x730F
 *
 * The ROM's timer-1 reload table (0x139C) yields bit periods of 7,573, 2,775,
 * 1,386 and 691 machine cycles for 110, 300, 600 and 1,200 baud, and 16,664
 * cycles for 50-baud telex. Those fit a 10 MHz crystal (833,333 machine
 * cycles per second), which is the timing an attached device must use.
 */
export const MAIN_CPU_MACHINE_CYCLES_PER_SECOND = 10_000_000 / 12;

export const SERIAL_BAUD_RATES = [110, 300, 600, 1200] as const;
export const TELEX_BAUD_RATE = 50;

export type SerialParity = "none" | "even" | "odd" | "space";

export interface SerialLineSettings {
  baud: number;
  /** ASCII frames carry 7 data bits plus a parity bit; telex frames carry 5-bit ITA2 codes. */
  format: "ascii" | "telex";
  parity: SerialParity;
}

export const DEFAULT_SERIAL_SETTINGS: SerialLineSettings = { baud: 300, format: "ascii", parity: "none" };

/**
 * Decode the ROM's interface settings byte: bits 0-1 select the speed, bits 2-3
 * the parity, and on the printer port a clear bit 4 selects 50-baud telex mode
 * (0x135C / 0x14B4). The computer port's routines skip the telex test, so it
 * is always ASCII.
 */
export function decodeSerialSettings(byte: number, port: "printer" | "computer" = "printer"): SerialLineSettings {
  if (port === "printer" && (byte & 0x10) === 0) return { baud: TELEX_BAUD_RATE, format: "telex", parity: "none" };
  const parityBits = (byte >> 2) & 0x03;
  const parity: SerialParity = parityBits === 0 ? "none" : parityBits === 1 ? "space" : parityBits === 2 ? "even" : "odd";
  return { baud: SERIAL_BAUD_RATES[byte & 0x03], format: "ascii", parity };
}

function bitPeriod(settings: SerialLineSettings): number {
  return MAIN_CPU_MACHINE_CYCLES_PER_SECOND / settings.baud;
}

function dataBits(settings: SerialLineSettings): number {
  return settings.format === "telex" ? 5 : 8;
}

function parityBit(value: number, parity: SerialParity): number {
  let ones = 0;
  for (let bit = 0; bit < 7; bit += 1) ones += (value >> bit) & 1;
  if (parity === "even") return ones & 1;
  if (parity === "odd") return (ones & 1) ^ 1;
  // The ROM sends a mark bit when parity is off; a space bit for "space".
  return parity === "space" ? 0 : 1;
}

// ITA2 letters and figures shifts, indexed by the 5-bit code (LSB first on the line).
const ITA2_LETTERS = "\0E\nA SIU\rDRJNFCKTZLWHYPQOBG\u000eMXV\u000f";
const ITA2_FIGURES = "\x003\n- '87\r\x054\x07,!:(5+)2#6019?&\u000e./;\u000f";
const ITA2_FIGS = 0x1b;
const ITA2_LTRS = 0x1f;

export interface DecodedCharacter {
  code: number;
  character: string;
  framingError: boolean;
  parityError: boolean;
}

/** An attached device's receiver, sampling the terminal's TX pin at mid-bit. */
class LineReceiver {
  private level = 1;
  private frameStart: number | null = null;
  private sampleIndex = 0;
  private shift = 0;
  private figures = false;
  readonly characters: DecodedCharacter[] = [];

  constructor(private readonly settings: () => SerialLineSettings) {}

  observe(level: number, cycle: number): void {
    this.advanceTo(cycle);
    const next = level ? 1 : 0;
    if (next === this.level) return;
    if (this.frameStart === null && this.level === 1 && next === 0) {
      this.frameStart = cycle;
      this.sampleIndex = 0;
      this.shift = 0;
    }
    this.level = next;
  }

  advanceTo(cycle: number): void {
    const settings = this.settings();
    const period = bitPeriod(settings);
    const bits = dataBits(settings);
    while (this.frameStart !== null) {
      const sampleAt = this.frameStart + period * (this.sampleIndex + 0.5);
      if (sampleAt > cycle) return;
      if (this.sampleIndex === 0) {
        // A glitch shorter than half a bit is not a start bit.
        if (this.level !== 0) {
          this.frameStart = null;
          return;
        }
      } else if (this.sampleIndex <= bits) {
        this.shift |= this.level << (this.sampleIndex - 1);
      } else {
        this.finishFrame(this.level === 0, settings);
        this.frameStart = null;
        return;
      }
      this.sampleIndex += 1;
    }
  }

  reset(): void {
    this.level = 1;
    this.frameStart = null;
    this.figures = false;
  }

  private finishFrame(framingError: boolean, settings: SerialLineSettings): void {
    const code = this.shift;
    if (settings.format === "telex") {
      if (code === ITA2_FIGS) this.figures = true;
      else if (code === ITA2_LTRS) this.figures = false;
      const character = code === ITA2_FIGS || code === ITA2_LTRS ? "" : (this.figures ? ITA2_FIGURES : ITA2_LETTERS)[code];
      this.characters.push({ code, character, framingError, parityError: false });
      return;
    }
    const value = code & 0x7f;
    const parityError = settings.parity !== "none" && ((code >> 7) & 1) !== parityBit(value, settings.parity);
    this.characters.push({ code, character: String.fromCharCode(value), framingError, parityError });
  }
}

/** An attached device's transmitter, driving the terminal's RX pin. */
class LineTransmitter {
  private readonly queue: number[] = [];
  private frameStart = 0;
  private frame: number[] | null = null;
  /** Idle bit times after each character, like the pauses of a human typist. */
  gapBits = 0;

  constructor(private readonly settings: () => SerialLineSettings) {}

  enqueue(codes: Iterable<number>): void {
    for (const code of codes) this.queue.push(code & 0xff);
  }

  pending(): number {
    return this.queue.length + (this.frame ? 1 : 0);
  }

  levelAt(cycle: number): number {
    const period = bitPeriod(this.settings());
    for (;;) {
      if (!this.frame) {
        const next = this.queue.shift();
        if (next === undefined) return 1;
        this.frame = this.frameFor(next);
        this.frameStart = cycle;
      }
      const bit = Math.floor((cycle - this.frameStart) / period);
      if (bit < this.frame.length) return this.frame[bit];
      this.frame = null;
    }
  }

  reset(): void {
    this.queue.length = 0;
    this.frame = null;
  }

  private frameFor(code: number): number[] {
    const settings = this.settings();
    const bits = [0];
    if (settings.format === "telex") {
      for (let bit = 0; bit < 5; bit += 1) bits.push((code >> bit) & 1);
    } else {
      for (let bit = 0; bit < 7; bit += 1) bits.push((code >> bit) & 1);
      bits.push(parityBit(code, settings.parity));
    }
    // Two stop bits give the ROM's polled receiver time to store each byte.
    bits.push(1, 1);
    for (let gap = 0; gap < this.gapBits; gap += 1) bits.push(1);
    return bits;
  }
}

/**
 * A serial device on one of the terminal's interfaces: a printer terminal or
 * an external computer. It must be configured to the terminal's speed and
 * parity, exactly like the real equipment.
 */
export class SerialPeripheral {
  settings: SerialLineSettings = { ...DEFAULT_SERIAL_SETTINGS };
  /** Printer handshake; only the printer interface has a BUSY line. */
  busy = false;
  private readonly receiver = new LineReceiver(() => this.settings);
  private readonly transmitter = new LineTransmitter(() => this.settings);

  constructor(readonly name: "printer" | "computer") {}

  /** Terminal TX pin changed. */
  observeTerminalTx(level: number, cycle: number): void {
    this.receiver.observe(level, cycle);
  }

  advanceTo(cycle: number): void {
    this.receiver.advanceTo(cycle);
    this.transmitter.levelAt(cycle);
  }

  /** Level the device drives onto the terminal's RX pin. */
  terminalRxLevel(cycle: number): number {
    return this.transmitter.levelAt(cycle);
  }

  /** Characters received from the terminal, oldest first. */
  received(): readonly DecodedCharacter[] {
    return this.receiver.characters;
  }

  /** Printable transcript: CR is dropped and LF starts a new line. */
  transcript(): string {
    return this.receiver.characters
      .map(({ character }) => character)
      .join("")
      .replace(/\r/g, "")
      .replace(/[\0\u000e\u000f\u0005\u0007]/g, "");
  }

  clearReceived(): void {
    this.receiver.characters.length = 0;
  }

  /** Type characters on the device; ASCII strings or raw ITA2 codes for telex. */
  send(input: string | Iterable<number>): void {
    this.transmitter.enqueue(typeof input === "string" ? [...input].map((character) => character.charCodeAt(0)) : input);
  }

  pendingInput(): number {
    return this.transmitter.pending();
  }

  /**
   * The ROM receives and echoes on the same software timers, so characters
   * sent back-to-back can lose their echo. A keyboard terminal leaves idle
   * time between keystrokes; set this to model it.
   */
  set characterGapBits(bits: number) {
    this.transmitter.gapBits = Math.max(0, Math.floor(bits));
  }

  reset(): void {
    this.receiver.reset();
    this.transmitter.reset();
  }
}
