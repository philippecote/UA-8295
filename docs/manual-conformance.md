# UA-8295 manual conformance

This document tracks emulator behavior against the Philips Usfa UA-8295/00
User's Manual, document 20.0057-E-0884. It distinguishes verified firmware
behavior from a prompt that merely appears and from hardware that still needs a
documented modeling boundary.

Status meanings:

- **Pass** - the complete documented workflow has an automated assertion.
- **Partial** - entry or a representative path works, but the whole procedure is not covered.
- **Not tested** - no repeatable conformance test exists yet.
- **Boundary** - the procedure requires external or analog hardware that must be modeled or declared out of scope.

| Manual section | Function | Status | Current evidence / next requirement |
| --- | --- | --- | --- |
| 2.1 / 3.2.1 | Keyboard and switching on | Partial | Boot reaches `TERMINAL OK ... FUNCTION?`; ON/OFF electrical behavior and error boot are not modeled. |
| 2.2 / 3.2.2 | Battery charging | Boundary | Requires charge-state and external-supply models plus the shifted C workflow. |
| 2.3 / 3.2.3 | Display brightness and 30-second blanking | Pass | All three levels, the 30-second timeout, and wake on SHIFT are asserted through the device model. |
| 2.4 / 3.2.4 | Terminal configuration | Pass | All twelve pages are walked; individual/group addresses, toggles, printer modes, serial speeds/parity, and telex mode are changed and retained in configuration SRAM. |
| 2.5 / 3.2.5 | Setting the time | Pass | An accepted `12:34` is stored against the battery-backed counter and reopens as `12:34` after the first clock tick. |
| 2.6A | Free-format composition | Pass | TERM exits composition; both answers to the existing-message prompt, whole-message deletion, and independent small-memory composition are asserted through SRAM. |
| 2.6B | Fixed-format composition | Pass | Both installed formats complete all prompted fields through the original text ROM; selectors 3-9 are verified as `NOT DEFINED`. |
| 2.7 | Editing | Pass | Character erase/replacement, scrolling, held-key repeat, shifted BEGIN/END, long-message viewport movement, and `=` line breaks run through the ROM. |
| 2.8 | Transmission | Pass | Large and small memories, retained and changed receiver addresses, the transmit indicator, broadcast and addressed delivery, `SENT`, and automatic `ACKNOWLEDGED` are asserted; printer output remains the 2.15 boundary. |
| 2.9 | Reception | Partial | Address filtering, encrypted storage, automatic acknowledgement, and the MESSAGE indicator pass; full-memory, clock/data-error, and sound-alarm cases remain. |
| 2.10 | Display received messages | Partial | Empty state, sender/time headers, free-text bodies, multi-message iteration, read-indicator clearing, and deletion pass; received fixed formats and printer output remain. |
| 2.11 | Off-line encryption/decryption | Not tested | Add plaintext/ciphertext round-trip with and without printer output. |
| 2.12 | Delete all memory | Pass | The installed-ROM `SHIFT+T`, `SHIFT+K` confirmation prompt and zeroing of all persistent message, configuration, and key SRAM are asserted; only the live display workspace is subsequently rewritten. |
| 2.13 | Manual ACK/NAK | Partial | NAK entry prompt works; complete linked-terminal ACK and NAK delivery remain. |
| 2.14 | Changing the key | Pass | DAY'S KEY selection, NEW KEY keyword entry, deterministic four-character ID generation, SRAM encoding, and persistence across reset are asserted. |
| 2.15 | Printer | Boundary | Serial printer input, output, control characters, and auto-print behavior need a peripheral model. |
| 2.16 | External computer | Boundary | Computer-port protocol and modem command boundary are not yet decoded. |
| 3.1-3.8 | Error conditions | Not tested | Add deterministic fault injection and recovery for each documented condition. |

## Executable scenario sources

- `docs/manual-tests/section-3-operation.md` contains the first executable scenarios.
- `web-tests/acceptance-suite.test.ts` loads and runs every `ua8295-test` block.
- Complex two-terminal behavior remains in `web-tests/firmware-transfer.test.ts` until the scenario runner supports paired devices.

The matrix must only move to **Pass** when the complete manual procedure is
covered. Reaching the first prompt is deliberately classified as **Partial**.
