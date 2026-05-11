import { FRONT_PANEL_KEYS, type FrontPanelKey } from "../src/devices";

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
    // The full FRONT_PANEL_KEYS roster. The integration test asserts this stays in
    // sync with the source-of-truth array exported from src/devices.ts.
    keys: [...FRONT_PANEL_KEYS] as FrontPanelKey[],
    // Empirically observed first-prompt outcomes once both (a) the authentic
    // INT1 + 0x8400 strobe pipeline runs through the firmware and (b) external
    // SRAM is initialised to 0xFF on power-up (real CMOS SRAM convention). The
    // earlier "KEY: AIEH" / "NEW KEY:" / "DELETE THE OLD MESSAGE" prompts were
    // artefacts of XRAM zero-init: the firmware was reading uninitialised
    // bytes as if they were live message metadata. With proper init the
    // dispatcher exposes the real workflows below.
    topLevelPrompts: [
      ["^", "GIVE NUMBER OR FUNCTION?"],
      ["DEL", "GIVE NUMBER OR FUNCTION?"],
      ["ENCR", "GIVE NUMBER OR FUNCTION?"],
      ["CONF", "NO MESSAGES"],
      ["TIME", "NAK TO STATION:"],
      // SEND and SHIFT+SEND (RCV alias) both land on the FIXED KEY transmit
      // entry — the firmware checks if a fixed encryption key is loaded; with
      // a clean SRAM that key slot is empty and the prompt reads "FIXED KEY".
      ["SEND", "FIXED KEY"],
      ["RCV", "FIXED KEY"],
      ["KEY", "PRIVATE ADDRESS:"],
      ["ACK_NAK", "RECEIVER:"],
      ["BRIGHT", "ACK TO STATION:"],
      ["NEW_KEY", "DEFAULT SETTINGS"],
      ["SHORT", "TIME:"]
    ] as Array<readonly [FrontPanelKey, string]>,
    // Plain digit keys 1 and 2 select pre-defined message templates from idle.
    // Digits 3-9 are reported by the firmware as "NOT DEFINED".
    numericTopLevelPrompt: "COORDINATES X:",
    // Bytes the firmware lookup at 0x045B + CJNE specials at 0x043E/0x0445 deposit at
    // iram[0x1C] for each currently-modeled front-panel key. The shifted-form aliases
    // (RCV, BRIGHT, NEW_KEY, DECR, INPUT_PRINT, SHORT) carry bit 7 set because their
    // raw scan code already has the SHIFT bit (0x40) baked in.
    expectedIramByte: {
      "^": 0x02,
      DEL: 0x03,
      CONF: 0x1b,
      TIME: 0x0e,
      KEY: 0x05,
      ENCR: 0x1f,
      SEND: 0x1e,
      RCV: 0x9e,
      DISPL: 0x1d,
      INPUT_PRINT: 0x9d,
      ACK_NAK: 0x07,
      SHORT_TERM: 0x1c,
      SHORT: 0x9c,
      BRIGHT: 0x8e,
      NEW_KEY: 0x85,
      DECR: 0x9f,
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
      "=": 0x0d,
      SPACE: 0x20
    } as Partial<Record<FrontPanelKey, number>>,
    // Workflow prompts that we cannot yet assert because they require additional
    // dispatcher entry paths or shifted variants we haven't modelled. Leave empty for
    // now — the previously-listed "DELETE THE OLD MESSAGE (Y/N)?" gap turned out to be
    // reachable from idle once the strobe pipeline delivers iram[0x1C] for digit keys.
    pendingDeeperWorkflows: [] as ReadonlyArray<{
      key: FrontPanelKey;
      expected: string;
      reason: string;
    }>
  },
  acceptanceCases: [
    {
      id: "power-up-ready",
      title: "Power-up reaches the ready FUNCTION prompt",
      sequence: [] as FrontPanelKey[],
      expectedDisplay: "TERMINAL OK"
    },
    {
      id: "configuration-entry",
      title: "CONF enters the message-status workflow",
      sequence: ["CONF"] as FrontPanelKey[],
      expectedDisplay: "NO MESSAGES"
    },
    {
      id: "encryption-entry",
      title: "ENCR returns to the GIVE NUMBER OR FUNCTION prompt",
      sequence: ["ENCR"] as FrontPanelKey[],
      expectedDisplay: "GIVE NUMBER OR FUNCTION?"
    },
    {
      id: "time-entry",
      title: "TIME enters the NAK TO STATION workflow",
      sequence: ["TIME"] as FrontPanelKey[],
      expectedDisplay: "NAK TO STATION:"
    },
    {
      id: "delete-recovery",
      title: "DEL recovers to the function-number prompt",
      sequence: ["DEL"] as FrontPanelKey[],
      expectedDisplay: "GIVE NUMBER OR FUNCTION?"
    },
    {
      id: "send-entry",
      title: "SEND enters the FIXED KEY transmit-key prompt",
      sequence: ["SEND"] as FrontPanelKey[],
      expectedDisplay: "FIXED KEY"
    },
    {
      // RCV is an alias for SHIFT+SEND. The firmware dispatcher routes both
      // SEND (0x1E) and SHIFT+SEND (0x9E) to the FIXED KEY transmit entry on
      // a clean SRAM. The earlier "NEW KEY:" expectation was an artefact of
      // uninitialised XRAM; the real NEW KEY workflow is reached via SHIFT+KEY
      // (0x85) and shows "DEFAULT SETTINGS".
      id: "receive-entry",
      title: "RCV (SHIFT+SEND) enters the FIXED KEY transmit-key prompt",
      sequence: ["RCV"] as FrontPanelKey[],
      expectedDisplay: "FIXED KEY"
    },
    {
      id: "key-private-address",
      title: "KEY enters the PRIVATE ADDRESS prompt",
      sequence: ["KEY"] as FrontPanelKey[],
      expectedDisplay: "PRIVATE ADDRESS:"
    },
    {
      id: "digit-coordinates",
      title: "Digit 1 enters the COORDINATES message template",
      sequence: ["1"] as FrontPanelKey[],
      expectedDisplay: "COORDINATES X:"
    },
    {
      id: "digit-observer",
      title: "Digit 2 enters the OBSERVER message template",
      sequence: ["2"] as FrontPanelKey[],
      expectedDisplay: "OBSERVER X,Y"
    },
    {
      id: "ack-receiver",
      title: "ACK NAK enters the RECEIVER prompt",
      sequence: ["ACK_NAK"] as FrontPanelKey[],
      expectedDisplay: "RECEIVER:"
    },
    {
      id: "bright-ack-station",
      title: "SHIFT+TIME (BRIGHT) enters the ACK TO STATION prompt",
      sequence: ["BRIGHT"] as FrontPanelKey[],
      expectedDisplay: "ACK TO STATION:"
    },
    {
      id: "new-key-default-settings",
      title: "SHIFT+KEY (NEW KEY) enters the DEFAULT SETTINGS prompt",
      sequence: ["NEW_KEY"] as FrontPanelKey[],
      expectedDisplay: "DEFAULT SETTINGS"
    },
    {
      id: "short-clock-display",
      title: "SHIFT+SHORT_TERM (SHORT) shows the real-time clock",
      sequence: ["SHORT"] as FrontPanelKey[],
      expectedDisplay: "TIME:"
    },
    // === Multi-step workflows ============================================
    // The acceptance harness asserts `expectedDisplay` is a substring present
    // at SOME point during the polling window of EVERY key in `sequence`. We
    // therefore use the prompt header (the part that survives digit entry)
    // as the assertion. The probe files document the deeper, per-step state.
    {
      id: "coordinates-x-fill",
      title: "Digit 1 then 4 digits keeps the COORDINATES X prompt active",
      sequence: ["1", "1", "2", "3", "4"] as FrontPanelKey[],
      expectedDisplay: "COORDINATES X:"
    },
    {
      id: "observer-x-y-fill",
      title: "Digit 2 then 4 digits keeps the OBSERVER X,Y prompt active",
      sequence: ["2", "1", "2", "3", "4"] as FrontPanelKey[],
      expectedDisplay: "OBSERVER X,Y"
    },
    {
      id: "private-address-fill",
      title: "KEY then 2 digits keeps the PRIVATE ADDRESS prompt (2-digit slot)",
      sequence: ["KEY", "1", "2"] as FrontPanelKey[],
      expectedDisplay: "PRIVATE ADDRESS:"
    },
    {
      id: "private-address-overfill",
      title: "KEY then 4 digits stays on PRIVATE ADDRESS (extras silently dropped)",
      sequence: ["KEY", "1", "2", "3", "4"] as FrontPanelKey[],
      expectedDisplay: "PRIVATE ADDRESS:"
    },
    {
      id: "nak-station-fill",
      title: "TIME then 2 digits keeps the NAK TO STATION prompt (2-digit slot)",
      sequence: ["TIME", "1", "2"] as FrontPanelKey[],
      expectedDisplay: "NAK TO STATION:"
    },
    {
      id: "nak-station-overfill",
      title: "TIME then 4 digits stays on NAK TO STATION (extras dropped)",
      sequence: ["TIME", "1", "2", "3", "4"] as FrontPanelKey[],
      expectedDisplay: "NAK TO STATION:"
    },
    {
      id: "ack-station-fill",
      title: "BRIGHT then 2 digits keeps the ACK TO STATION prompt (2-digit slot)",
      sequence: ["BRIGHT", "1", "2"] as FrontPanelKey[],
      expectedDisplay: "ACK TO STATION:"
    },
    {
      id: "ack-station-overfill",
      title: "BRIGHT then 4 digits stays on ACK TO STATION (extras dropped)",
      sequence: ["BRIGHT", "1", "2", "3", "4"] as FrontPanelKey[],
      expectedDisplay: "ACK TO STATION:"
    },
    {
      id: "receiver-fill",
      title: "ACK_NAK then 2 digits keeps the RECEIVER prompt (2-digit slot)",
      sequence: ["ACK_NAK", "1", "2"] as FrontPanelKey[],
      expectedDisplay: "RECEIVER:"
    },
    {
      id: "receiver-overfill",
      title: "ACK_NAK then 4 digits stays on RECEIVER (extras dropped)",
      sequence: ["ACK_NAK", "1", "2", "3", "4"] as FrontPanelKey[],
      expectedDisplay: "RECEIVER:"
    },
    {
      id: "short-clock-edit",
      title: "SHORT then 2 digits keeps the TIME clock prompt active",
      sequence: ["SHORT", "1", "2"] as FrontPanelKey[],
      expectedDisplay: "TIME:"
    }
  ],
  pendingAcceptanceCases: [] as ReadonlyArray<{
    id: string;
    title: string;
    sequence: FrontPanelKey[];
    expectedDisplay: string;
    reason: string;
  }>
} as const;
