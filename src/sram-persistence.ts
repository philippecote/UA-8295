/**
 * Version 2 drops snapshots written by the original persistence implementation.
 * Those snapshots could contain the firmware's post-clear, all-zero SRAM image,
 * which is not a valid cold-start image and makes message allocation report
 * MEMORY FULL after the next page load.
 */
export const SRAM_STORAGE_PREFIX = "ua8295.sram.v2";

// 0x7FE0-0x7FFF is the live display workspace, not persistent message/config data.
const DISPLAY_WORKSPACE_OFFSET = 0x1fe0;

export function encodeTerminalMemory(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x1000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x1000));
  }
  return btoa(binary);
}

export function decodeTerminalMemory(encoded: string, expectedLength: number): Uint8Array | null {
  try {
    const binary = atob(encoded);
    if (binary.length !== expectedLength) return null;

    const bytes = new Uint8Array(expectedLength);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index) & 0xff;
    }

    // SHIFT+T, SHIFT+K clears the persistent portion to 0x00. Keeping that
    // runtime image is correct, but restoring it after a cold boot leaves the
    // ROM without its volatile allocation state and it sees every message slot
    // as occupied. Treat this canonical cleared image as fresh SRAM (0xFF).
    const persistentLength = Math.min(DISPLAY_WORKSPACE_OFFSET, bytes.length);
    let allCleared = persistentLength > 0;
    for (let index = 0; index < persistentLength; index += 1) {
      if (bytes[index] !== 0x00) {
        allCleared = false;
        break;
      }
    }
    return allCleared ? null : bytes;
  } catch {
    return null;
  }
}
