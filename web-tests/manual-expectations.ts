import type { FrontPanelKey } from "../src/devices";

export const MANUAL_EXPECTATIONS = {
  displayWidth: 32,
  source: "Philips Usfa UA-8295/00 User's Manual and supplied instruction card",
  powerUp: {
    summary:
      "On power-up the terminal performs an initial check-out; persistent error messages indicate a faulty terminal.",
    expectedEmulatorBehavior:
      "The coupled main and I/O processor ROMs should pass initial check-out and display the firmware-written terminal OK prompt.",
    currentExpectedDisplayPrefix: "TERMINAL OK"
  },
  readyState: {
    summary:
      "The instruction card says the terminal is ready for a new operation when it displays the prompt; this state is reached after completing an operation or pressing the return/cancel key once or twice.",
    expectedEmulatorBehavior:
      "Headless tests should be able to press front-panel keys and observe a stable 32-character display string.",
    currentExpectedDisplaySuffix: "FUNCTION?"
  },
  keyboard: {
    summary:
      "The manual describes message composition/editing through the unit keyboard, including control keys and numerical keys.",
    keys: ["^", "CONF", "KEY", "TIME", "ENCR", "SEND", "RCV", "DEL", "0", "1", "2", "3", "4", "5", "6", "7"] as FrontPanelKey[]
  }
} as const;
