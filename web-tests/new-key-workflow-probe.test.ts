import { describe, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { HeadlessDeviceDriver } from "./device-driver";

/**
 * Drives the NEW_KEY (SHIFT+KEY, DEFAULT SETTINGS) workflow.
 *
 * Empirical state machine (post-XRAM-init fix):
 *   IDLE → press NEW_KEY → "DEFAULT SETTINGS FUNCTION"   (iram[0x1C]=0x85,
 *                                                          confirms shift-bit routing)
 *   The display reads "DEFAULT SETTINGS FUNCTION" — the trailing FUNCTION token
 *   suggests the menu is *waiting* for a function key to drill into a sub-menu.
 *   Probe results:
 *     - digit  1 / 2 / ... → falls through to the main dispatcher and opens
 *                            COORDINATES X (digit 1) or OBSERVER X,Y (digit 2)
 *                            etc. The DEFAULT SETTINGS layer does NOT capture
 *                            digit input.
 *     - DISPL → returns to "GIVE NUMBER OR FUNCTION" (DEFAULT SETTINGS is dismissed)
 *     - "="   → returns to "GIVE NUMBER OR FUNCTION"
 *     - "^"   → returns to "GIVE NUMBER OR FUNCTION"
 *
 * Stall: which sub-menu key the firmware actually expects is unclear from
 * top-level probing. Likely candidates (TIME, BRIGHT, ENCR, KEY) need to be
 * exercised here to see if any of them switch the display to a settings page.
 * The probe sweeps all of them so the empirical record is complete.
 */
describe("NEW_KEY (DEFAULT SETTINGS) workflow probe", () => {
  it("walks NEW_KEY and probes possible sub-menu keys", async () => {
    const candidates: FrontPanelKey[] = [
      "DISPL",
      "=",
      "1",
      "2",
      "3",
      "TIME",
      "BRIGHT",
      "ENCR",
      "KEY",
      "ACK_NAK",
      "INPUT_PRINT",
      "DECR"
    ];

    for (const candidate of candidates) {
      const driver = await HeadlessDeviceDriver.create({
        maxTraceEvents: 20_000,
        traceAllXdata: false
      });
      driver.runCoupledBoot();

      const press = (key: FrontPanelKey, holdSlices = 250, settleSlices = 80): void => {
        driver.pressKey(key);
        driver.runSchedulerSlices(holdSlices, 80);
        driver.releaseKey(key);
        driver.runSchedulerSlices(settleSlices, 80);
      };

      press("NEW_KEY");
      const afterEnter = driver.displayText().trimEnd();
      press(candidate);
      const afterCandidate = driver.displayText().trimEnd();
      const main = driver.machine.mainCpu;
      const iram1c = main.iram[0x1c].toString(16).padStart(2, "0");
      const iram20 = main.iram[0x20].toString(16).padStart(2, "0");
      console.log(
        `[NEW_KEY] enter="${afterEnter}" then ${candidate.padEnd(12)} → "${afterCandidate}" 1C=0x${iram1c} 20=0x${iram20}`
      );
    }
  }, 240_000);
});
