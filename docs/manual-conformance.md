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
| 2.1 / 3.2.1 | Keyboard and switching on | Pass | Boot reaches `TERMINAL OK ... FUNCTION?`; ON/OFF blanks the terminal and repeats the check-out with SRAM retained; injected faults produce `ERROR` codes (see 3.2). |
| 2.2 / 3.2.2 | Battery charging | Pass | `SHIFT+C` offers normal, quick and fast charging; P1.0-P1.2 select the mode, the CHARGE lamp follows the external supply, normal charging runs until the sequence is repeated, and the ROM ends fast and quick charging after 512 and 6,912 charger-timer pulses. |
| 2.3 / 3.2.3 | Display brightness and 30-second blanking | Pass | All three levels, the 30-second timeout, and wake on SHIFT are asserted through the device model. |
| 2.4 / 3.2.4 | Terminal configuration | Pass | All twelve pages are walked; individual/group addresses, toggles, printer modes, serial speeds/parity, and telex mode are changed and retained in configuration SRAM. |
| 2.5 / 3.2.5 | Setting the time | Pass | An accepted `12:34` is stored against the battery-backed counter and reopens as `12:34` after the first clock tick. |
| 2.6A | Free-format composition | Pass | TERM exits composition; both answers to the existing-message prompt, whole-message deletion, and independent small-memory composition are asserted through SRAM. |
| 2.6B | Fixed-format composition | Pass | Both installed formats complete all prompted fields through the original text ROM; selectors 3-9 are verified as `NOT DEFINED`. |
| 2.7 | Editing | Pass | Character erase/replacement, scrolling, held-key repeat, shifted BEGIN/END, long-message viewport movement, and `=` line breaks run through the ROM. |
| 2.8 | Transmission | Pass | Large and small memories, retained and changed receiver addresses, the transmit indicator, broadcast and addressed delivery, `SENT`, automatic `ACKNOWLEDGED`, and the XMT automatic printout are asserted. |
| 2.9 | Reception | Pass | Address filtering, encrypted storage, automatic acknowledgement, the MESSAGE indicator, the sound alarm until a keypress, CE with no automatic ACK when clocks differ, BCH correction of isolated bit errors, DE marking, and `RECEIVING MEMORY FULL` after the eighth message (a ninth is rejected) are asserted. |
| 2.10 | Display received messages | Pass | Empty state, sender/time headers with CE/DE flags, free-text bodies, multi-message iteration, read-indicator clearing, deletion, and the automatic REC printout of a received fixed-format message are asserted. |
| 2.11 | Off-line encryption/decryption | Pass | Displayed `HELLO` round-trips through five-letter ciphertext groups and back; with printer output selected the groups are printed. Day's-key ciphertext depends on the keyword. |
| 2.12 | Delete all memory | Pass | The installed-ROM `SHIFT+T`, `SHIFT+K` confirmation prompt and zeroing of all persistent message, configuration, and key SRAM are asserted; only the live display workspace is subsequently rewritten. |
| 2.13 | Manual ACK/NAK | Pass | Both response prompts, station-address entry, radio delivery, and the late ACK arriving at the original sender as an `ACK1 SENDER,TIME` entry with the MESSAGE lamp lit are asserted. |
| 2.14 | Changing the key | Pass | DAY'S KEY selection, NEW KEY keyword entry, keyword-dependent four-character ID generation (`ALPHA` gives `JPKI`), SRAM encoding, and persistence across reset are asserted. |
| 2.15 | Printer | Pass | PRINT of the displayed message, the BUSY handshake, encrypted printout, 50-baud ITA2 telex printing, XMT and REC automatic printouts, and printer-terminal input with CTRL-O/CTRL-N echo control, erase and CTRL-C are asserted through the bit-banged serial port. |
| 2.16 | External computer | Pass | `SHIFT+R` remote mode announces itself, unknown commands are NAKed, bad checksums are ignored, the exit command restarts the terminal, a computer-supplied message is transmitted and acknowledged (status frame 4), and the receiving terminal uploads its message and deletes it after the computer's ACK. |
| 3.1 | Does not respond when switched on | Pass | A flat battery keeps the terminal dark until the external supply is connected. |
| 3.2 | Error during initial check-out | Pass | Injected EPROM, SRAM, timer, modem-processor and modem-EPROM faults display PR1, PR2, RAM, CLOCK, MOD and PRM; any key resumes operation and a repaired unit boots cleanly. |
| 3.3 / 3.5 | No response / transmission does not succeed | Pass | A switched-off receiver stores nothing and the sender reports only `SENT`. |
| 3.4 | Synchronises but reception does not succeed | Pass | Wrong address, differing day's keys, a garbled burst, and a full receive memory all leave the message unstored. |
| 3.6 | Automatic acknowledgement not functioning | Pass | No ACK for broadcast address 00, when the clocks differ by more than five minutes, or when AUTOACK is off. |
| 3.7 | Remains in reception mode | Partial | A transmission cut off mid-message is neither stored nor acknowledged. Not yet reproduced: the 60-second limit and recovery by resending. The link model has no carrier-loss indication to end a partial frame, and a resend after a cut currently arrives short and is rejected. |
| 3.8 | Undefined operating mode | Pass | The remedy, switching off and on, is covered by the ON/OFF test. |

## Executable scenario sources

- `docs/manual-tests/section-3-operation.md` contains the first executable scenarios.
- `web-tests/acceptance-suite.test.ts` loads and runs every `ua8295-test` block.
- Two-terminal, printer and computer procedures live in `web-tests/firmware-*.test.ts` and `web-tests/manual-*.test.ts`, which share `web-tests/linked-driver.ts`.

The matrix must only move to **Pass** when the complete manual procedure is
covered. Reaching the first prompt is deliberately classified as **Partial**.
