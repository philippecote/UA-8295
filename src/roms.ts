export const EPROM_SIZE = 0x2000;

export type RomKey = "mainLow" | "mainHigh" | "text" | "iop";

export interface RomSpec {
  key: RomKey;
  filename: string;
  size: number;
  sha256: string;
  description: string;
}

export interface RomImage {
  spec: RomSpec;
  data: Uint8Array;
  digest: string;
}

export interface RomSet {
  mainLow: RomImage;
  mainHigh: RomImage;
  text: RomImage;
  iop: RomImage;
}

export const ROM_SPECS: Record<RomKey, RomSpec> = {
  mainLow: {
    key: "mainLow",
    filename: "DA8520_IC24_E22_19841030.bin",
    size: EPROM_SIZE,
    sha256: "5d61fc88c0b7bec8624e3263dbe10f0bfbf1e785e1294ffc9505d54f5033f2f3",
    description: "Main 80C31 firmware, lower 8 KB code bank"
  },
  mainHigh: {
    key: "mainHigh",
    filename: "DA8520_IC18_E22_19841030.bin",
    size: EPROM_SIZE,
    sha256: "d2d442bbe7e69caba5b20563a1090ed1bcba795c7e0be6b64f78dcb56dcb8192",
    description: "Main 80C31 firmware, upper 8 KB code bank"
  },
  text: {
    key: "text",
    filename: "DA8520_IC15_E22_19831228.bin",
    size: EPROM_SIZE,
    sha256: "67647b7d17c32965c69926c095959dbf2cee66c0e46af74141bd92fdf2f04695",
    description: "On-display user-guide text EPROM"
  },
  iop: {
    key: "iop",
    filename: "DA8520_IC03_I0P_19841030.bin",
    size: EPROM_SIZE,
    sha256: "22db8cbbf71915a6fbf37f76c3b7ef2f98628640e5ee3c1266ab42ada98c476e",
    description: "I/O processor 80C31 firmware for the AFSK modem"
  }
};

export const BUNDLED_ROM_URLS: Record<RomKey, string> = {
  mainLow: new URL("../Nokia_DA8520_firmware/DA8520_IC24_E22_19841030.bin", import.meta.url).href,
  mainHigh: new URL("../Nokia_DA8520_firmware/DA8520_IC18_E22_19841030.bin", import.meta.url).href,
  text: new URL("../Nokia_DA8520_firmware/DA8520_IC15_E22_19831228.bin", import.meta.url).href,
  iop: new URL("../Nokia_DA8520_firmware/DA8520_IC03_I0P_19841030.bin", import.meta.url).href
};

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function mainCode(roms: RomSet): Uint8Array {
  return concatBytes(roms.mainLow.data, roms.mainHigh.data);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateImage(spec: RomSpec, data: Uint8Array): Promise<RomImage> {
  const digest = await sha256Hex(data);
  const errors: string[] = [];
  if (data.length !== spec.size) {
    errors.push(`size ${data.length} != expected ${spec.size}`);
  }
  if (digest !== spec.sha256) {
    errors.push(`sha256 ${digest} != expected ${spec.sha256}`);
  }
  if (errors.length > 0) {
    throw new Error(`${spec.filename}: ${errors.join("; ")}`);
  }
  return { spec, data, digest };
}

export async function loadBundledRomSet(urls: Record<RomKey, string> = BUNDLED_ROM_URLS): Promise<RomSet> {
  async function fetchOne(spec: RomSpec): Promise<RomImage> {
    const response = await fetch(urls[spec.key]);
    if (!response.ok) {
      throw new Error(`Unable to fetch ${spec.filename}: ${response.status} ${response.statusText}`);
    }
    return validateImage(spec, new Uint8Array(await response.arrayBuffer()));
  }

  const [mainLow, mainHigh, text, iop] = await Promise.all([
    fetchOne(ROM_SPECS.mainLow),
    fetchOne(ROM_SPECS.mainHigh),
    fetchOne(ROM_SPECS.text),
    fetchOne(ROM_SPECS.iop)
  ]);
  return { mainLow, mainHigh, text, iop };
}

export async function loadRomSetFromFiles(files: FileList | File[]): Promise<RomSet> {
  const byName = new Map([...files].map((file) => [file.name, file]));

  async function readOne(spec: RomSpec): Promise<RomImage> {
    const file = byName.get(spec.filename);
    if (!file) {
      throw new Error(`Missing selected ROM: ${spec.filename}`);
    }
    return validateImage(spec, new Uint8Array(await file.arrayBuffer()));
  }

  const [mainLow, mainHigh, text, iop] = await Promise.all([
    readOne(ROM_SPECS.mainLow),
    readOne(ROM_SPECS.mainHigh),
    readOne(ROM_SPECS.text),
    readOne(ROM_SPECS.iop)
  ]);
  return { mainLow, mainHigh, text, iop };
}
