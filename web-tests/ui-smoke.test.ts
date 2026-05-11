import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Device Mode UI smoke coverage", () => {
  it("keeps the production device shell and fixed-cell display renderer wired", async () => {
    const [app, styles] = await Promise.all([readFile("src/app.ts", "utf8"), readFile("src/styles.css", "utf8")]);

    expect(app).toContain("Short-Burst Message Terminal");
    expect(app).toContain("Developer Mode");
    expect(app).toContain("PHYSICAL_KEY_MAP");
    expect(app).toContain("renderDisplay");
    expect(styles).toContain(".display-cell");
    expect(styles).toContain(".device-label");
    expect(styles).toContain("touch-action: none");
  });

  it("renders the photo-accurate LED indicator labels", async () => {
    const app = await readFile("src/app.ts", "utf8");

    // Updated labels match the real UA-8295 chassis (BATTERY LOW / CHARGE / MESSAGE / TRANSMIT).
    expect(app).toContain("BATTERY LOW");
    expect(app).toContain("CHARGE");
    expect(app).toContain("MESSAGE");
    expect(app).toContain("TRANSMIT");

    // The pre-fidelity placeholder labels must be gone.
    expect(app).not.toContain("LOW BATT");
    // "RECEIVE" was the old placeholder for what the photo labels "MESSAGE".
    expect(app).not.toMatch(/<span>RECEIVE<\/span>/);
  });

  it("describes the QWERTY chassis layout in CSS and source", async () => {
    const [app, styles] = await Promise.all([readFile("src/app.ts", "utf8"), readFile("src/styles.css", "utf8")]);

    // Stable layout selectors used by the new keypad chassis.
    expect(styles).toContain(".keypad");
    expect(styles).toContain(".keypad-main");
    expect(styles).toContain(".key-row");
    expect(styles).toContain(".fn-column");
    expect(styles).toContain(".key.is-stub");

    // Per-row classes the renderer emits (keyboard-row-1..5).
    expect(app).toContain("keyboard-row-${idx + 1}");
    for (let i = 1; i <= 5; i += 1) {
      expect(styles).toMatch(new RegExp(`keyboard-row-${i}|key-row`));
    }
  });

  it("declares all photo-grade key legends in the chassis source", async () => {
    const app = await readFile("src/app.ts", "utf8");

    const requiredLabels = [
      // Full A-Z alpha block.
      "Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P",
      "A", "S", "D", "F", "G", "H", "J", "K", "L",
      "Z", "X", "C", "V", "B", "N", "M",
      // Digits 0-9.
      "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
      // Punctuation.
      ",", ".", "-", "=",
      // Function keys around the keypad.
      "DELETE",
      "ACK NAK",
      "DISPL",
      "INPUT PRINT",
      "ENCR DECR",
      "SEND",
      // Side function column.
      "CONF",
      "TIME BRIGHT",
      "NEW KEY",
      "SHORT TERM",
      "ON OFF"
    ];
    for (const label of requiredLabels) {
      expect(app, `expected key legend ${JSON.stringify(label)} in src/app.ts`).toContain(label);
    }
  });

  it("binds the expanded chassis so previously-stub keys become live targets", async () => {
    const app = await readFile("src/app.ts", "utf8");

    // Stable evidence that A-Z are wired to FrontPanelKey bindings rather than
    // rendering as bare stub buttons. We grep for binding entries because the
    // KEYBOARD_ROWS structure is a TypeScript literal and not the rendered HTML.
    for (const letter of ["A", "B", "M", "P", "Q", "Z"]) {
      expect(app).toMatch(new RegExp(`label: "${letter}"[^}]*binding: "${letter}"`));
    }
    // Digits 8 and 9 - previously visible-but-unbound stubs - are now bound.
    expect(app).toMatch(/label: "8"[^}]*binding: "8"/);
    expect(app).toMatch(/label: "9"[^}]*binding: "9"/);
    // ACK NAK should be bound to the dedicated ACK_NAK key, not the legacy RCV alias.
    expect(app).toContain('binding: "ACK_NAK"');
    expect(app).not.toMatch(/ACK NAK[^}]*binding: "RCV"/);
  });
});
