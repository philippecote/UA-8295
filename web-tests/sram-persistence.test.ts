import { describe, expect, it } from "vitest";
import {
  decodeTerminalMemory,
  encodeTerminalMemory,
  SRAM_STORAGE_PREFIX
} from "../src/sram-persistence";
import { MAIN_XRAM_SIZE } from "../src/ua8295";

describe("terminal SRAM persistence", () => {
  it("uses a new storage schema so incompatible v1 snapshots are not restored", () => {
    expect(SRAM_STORAGE_PREFIX).toBe("ua8295.sram.v2");
  });

  it("round-trips a valid SRAM image exactly", () => {
    const source = new Uint8Array(MAIN_XRAM_SIZE);
    source.fill(0xff);
    source.set([0x01, 0x18, 0x48, 0x49, 0xfe], 0x800);

    expect(decodeTerminalMemory(encodeTerminalMemory(source), MAIN_XRAM_SIZE)).toEqual(source);
  });

  it("rejects the firmware's all-zero post-clear image on a cold restore", () => {
    const cleared = new Uint8Array(MAIN_XRAM_SIZE);
    cleared.set(new TextEncoder().encode("TERMINAL OK        FUNCTION?"), 0x1fe0);

    expect(decodeTerminalMemory(encodeTerminalMemory(cleared), MAIN_XRAM_SIZE)).toBeNull();
  });

  it("rejects corrupt and truncated snapshots without partially overwriting fresh SRAM", () => {
    expect(decodeTerminalMemory("not base64!", MAIN_XRAM_SIZE)).toBeNull();
    expect(decodeTerminalMemory(encodeTerminalMemory(new Uint8Array(16)), MAIN_XRAM_SIZE)).toBeNull();
  });
});
