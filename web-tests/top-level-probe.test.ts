import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Read-only probe that, with the corrected XRAM init = 0xFF, captures the
 * authentic top-level prompt produced by every key the firmware dispatcher
 * understands. Outputs the captured display so manual-expectations.ts can be
 * resynced.
 */
describe("top-level prompt probe (post-XRAM-init fix)", () => {
  const keys: FrontPanelKey[] = [
    "^", "DEL", "CONF", "TIME", "KEY", "ENCR", "SEND", "RCV",
    "DISPL", "INPUT_PRINT", "ACK_NAK", "SHORT_TERM", "BRIGHT", "NEW_KEY", "DECR", "SHORT",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "A", "Z",
    "=", "SPACE", ",", ".", "-"
  ];

  for (const key of keys) {
    it(`captures prompt for ${key}`, async () => {
      const driver = await HeadlessDeviceDriver.create({ maxTraceEvents: 30_000, traceAllXdata: false });
      driver.runCoupledBoot();
      driver.pressKey(key);
      driver.runSchedulerSlices(800, 80);
      driver.releaseKey(key);
      driver.runSchedulerSlices(200, 80);
      const display = driver.displayText().trimEnd();
      const iramByte = driver.machine.mainCpu.iram[0x1c];
      console.log(`KEY=${key.padEnd(12)} iram[1C]=0x${iramByte.toString(16).padStart(2, "0")} display="${display}"`);
    }, 30_000);
  }
});
