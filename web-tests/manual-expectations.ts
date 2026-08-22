import { FRONT_PANEL_KEYS, type FrontPanelKey } from "../src/devices";

export const MANUAL_EXPECTATIONS = {
  displayWidth: 32,
  source: "Philips Usfa UA-8295/00 User's Manual and supplied instruction card",
  powerUp: {
    summary: "On power-up the terminal performs an initial check-out.",
    expectedEmulatorBehavior: "Both original CPUs pass check-out and render the ROM prompt.",
    currentExpectedDisplayPrefix: "TERMINAL OK"
  },
  readyState: {
    summary: "FUNCTION? means the terminal is ready for a new operation.",
    expectedEmulatorBehavior: "The 32-character firmware display remains stable between operations.",
    currentExpectedDisplaySuffix: "FUNCTION?"
  },
  keyboard: {
    summary: "The physical lower legend is unshifted; ^ selects the upper legend.",
    keys: [...FRONT_PANEL_KEYS] as FrontPanelKey[],
    topLevelPrompts: [
      ["SHORT_TERM", "GIVE NUMBER OR FUNCTION"],
      ["DEL", "GIVE NUMBER OR FUNCTION"],
      ["ENCR", "GIVE NUMBER OR FUNCTION"],
      ["DISPL", "NO MESSAGES"],
      ["ACK_NAK", "NAK TO STATION:"],
      ["SEND", "RECEIVER:"],
      ["KEY", "FIXED KEY"],
      ["CONF", "PRIVATE ADDRESS:"],
      ["TIME", "TIME:"],
      ["NEW_KEY", "FIXED KEY"]
    ] as Array<readonly [FrontPanelKey, string]>,
    numericTopLevelPrompt: "COORDINATES X:",
    expectedIramByte: {
      DEL: 0x5f,
      CONF: 0x05,
      TIME: 0x9c,
      KEY: 0x1e,
      ENCR: 0x1f,
      SEND: 0x07,
      DISPL: 0x1b,
      INPUT_PRINT: 0x1d,
      ACK_NAK: 0x0e,
      SHORT_TERM: 0x0d,
      SHORT: 0x8d,
      BRIGHT: 0x1c,
      NEW_KEY: 0x9e,
      DECR: 0x9f,
      SCROLL_LEFT: 0x03,
      SCROLL_RIGHT: 0x02,
      "0": 0x30,
      "1": 0x31,
      "2": 0x32,
      "3": 0x33,
      "4": 0x34,
      "5": 0x35,
      "6": 0x36,
      "7": 0x37,
      "8": 0x38,
      "9": 0x39,
      "=": 0x2f,
      SPACE: 0x20
    } as Partial<Record<FrontPanelKey, number>>,
    pendingDeeperWorkflows: []
  }
} as const;
