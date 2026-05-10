export function fit64k(data: Uint8Array, fill = 0xff): Uint8Array {
  if (data.length > 0x10000) {
    throw new Error("memory image is larger than 64 KB");
  }
  const out = new Uint8Array(0x10000);
  out.fill(fill);
  out.set(data);
  return out;
}

export type XdataRegion = "xram" | "text-rom" | "unmapped";

export class ExternalBus {
  readonly codeMem: Uint8Array;
  readonly xram: Uint8Array;
  readonly textRom: Uint8Array;
  readonly ioEvents: string[] = [];

  constructor(
    code: Uint8Array,
    options: { xramSize?: number; defaultRead?: number; textRom?: Uint8Array } = {}
  ) {
    const xramSize = options.xramSize ?? 0x10000;
    if (xramSize <= 0 || xramSize > 0x10000) {
      throw new Error("xramSize must be between 1 and 65536");
    }
    this.codeMem = fit64k(code);
    this.xram = new Uint8Array(xramSize);
    this.textRom = options.textRom ?? new Uint8Array();
    this.defaultRead = options.defaultRead ?? 0xff;
  }

  private readonly defaultRead: number;

  readCode(addr: number): number {
    return this.codeMem[addr & 0xffff];
  }

  readXdata(addr: number): number {
    const masked = addr & 0xffff;
    if (masked < this.xram.length) {
      return this.xram[masked];
    }
    const textAddr = masked - 0x8000;
    if (textAddr >= 0 && textAddr < this.textRom.length) {
      return this.textRom[textAddr];
    }
    this.ioEvents.push(`read_xdata 0x${hex(masked, 4)} -> 0x${hex(this.defaultRead, 2)}`);
    return this.defaultRead;
  }

  regionForXdata(addr: number): XdataRegion {
    const masked = addr & 0xffff;
    if (masked < this.xram.length) {
      return "xram";
    }
    const textAddr = masked - 0x8000;
    if (textAddr >= 0 && textAddr < this.textRom.length) {
      return "text-rom";
    }
    return "unmapped";
  }

  writeXdata(addr: number, value: number): void {
    const masked = addr & 0xffff;
    const byte = value & 0xff;
    if (masked < this.xram.length) {
      this.xram[masked] = byte;
      return;
    }
    this.ioEvents.push(`write_xdata 0x${hex(masked, 4)} <- 0x${hex(byte, 2)}`);
  }

  readPdata(page: number, lowAddr: number): number {
    return this.readXdata(((page & 0xff) << 8) | (lowAddr & 0xff));
  }

  writePdata(page: number, lowAddr: number, value: number): void {
    this.writeXdata(((page & 0xff) << 8) | (lowAddr & 0xff), value);
  }
}

export function hex(value: number, width: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(width, "0");
}
