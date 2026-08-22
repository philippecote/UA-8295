# UA-8295 manual conformance scenarios: operation

These scenarios are derived from Section 3, "Operation", of document
20.0057-E-0884. The prose is the human-readable operating contract. Fenced
`ua8295-test` blocks are loaded directly by `web-tests/acceptance-suite.test.ts`.

Every automated scenario starts with a clean machine and the original ROMs,
then waits for the firmware's `FUNCTION?` prompt. Display assertions are
substrings because the real display is a fixed 32-character window.

## 2.1 Switching on

After initial check-out, the manual says a healthy unit displays `TERMINAL OK`,
the program version, and `FUNCTION?`.

```ua8295-test
{
  "id": "M3-2.1-BOOT-READY",
  "manualSection": "3.2.1",
  "title": "Power-up reaches the healthy terminal prompt",
  "steps": [],
  "expectDisplay": "TERMINAL OK"
}
```

## Function cancellation

The unshifted `TERM` legend ends the current operating sequence and prompts the
next function. At the top level, the ROM renders its number-or-function prompt.

```ua8295-test
{
  "id": "M2-1.1-TERM",
  "manualSection": "2.1.1",
  "title": "TERM returns to the function selector",
  "steps": [
    { "press": "SHORT_TERM", "expectDisplay": "GIVE NUMBER OR FUNCTION" }
  ],
  "expectDisplay": "GIVE NUMBER OR FUNCTION",
  "expectedIramByte": 13
}
```

## 2.4 Terminal configuration

Pressing `CONF` begins configuration at the private-address field.

```ua8295-test
{
  "id": "M3-2.4-CONF-ENTRY",
  "manualSection": "3.2.4",
  "title": "CONF enters terminal configuration",
  "steps": [
    { "press": "CONF", "expectDisplay": "PRIVATE ADDRESS:" }
  ],
  "expectDisplay": "PRIVATE ADDRESS:",
  "expectedIramByte": 5
}
```

## 2.5 Setting the time

The shifted `TIME` function displays the current time and allows a replacement
time to be entered.

```ua8295-test
{
  "id": "M3-2.5-TIME-ENTRY",
  "manualSection": "3.2.5",
  "title": "SHIFT+TIME displays the time field",
  "steps": [
    { "pressShifted": "BRIGHT", "expectDisplay": "TIME:" }
  ],
  "expectDisplay": "TIME:",
  "expectedIramByte": 156
}
```

## 2.6 Fixed-format composition

The numeric function keys select fixed message formats. Formats 1 and 2 expose
their first field prompts through the original text ROM.

```ua8295-test
{
  "id": "M3-2.6B-FORMAT-1",
  "manualSection": "3.2.6B",
  "title": "Format 1 opens the coordinates fields",
  "steps": [
    { "press": "1", "expectDisplay": "COORDINATES X:" }
  ],
  "expectDisplay": "COORDINATES X:",
  "expectedIramByte": 49
}
```

```ua8295-test
{
  "id": "M3-2.6B-FORMAT-2",
  "manualSection": "3.2.6B",
  "title": "Format 2 opens the observer fields",
  "steps": [
    { "press": "2", "expectDisplay": "OBSERVER X,Y" }
  ],
  "expectDisplay": "OBSERVER X,Y",
  "expectedIramByte": 50
}
```

## 2.6A and 2.7 Free-format composition and editing

The free-format editor marks the insertion point with `*`. Character erase
moves back over the preceding character; typing replaces that character.

```ua8295-test
{
  "id": "M3-2.7-CHARACTER-ERASE",
  "manualSection": "3.2.7A",
  "title": "Character erase replaces the character preceding the cursor",
  "steps": [
    { "press": "0" },
    { "press": "A" },
    { "press": "B" },
    { "press": "C" },
    { "press": "DEL" },
    { "press": "X", "expectDisplay": "ABX" }
  ],
  "expectDisplay": "ABX"
}
```

## Known incomplete workflows

These blocks are executable inventory: Vitest reports them as TODOs until the
emulator can satisfy the complete manual procedure. An unexpected pass must be
promoted to `status: "pass"` and retained as regression coverage.

```ua8295-test
{
  "id": "M3-2.6A-FREE-DELETE",
  "manualSection": "3.2.6A",
  "title": "TERM finishes free text and shifted DELETE clears the complete message",
  "status": "pass",
  "steps": [
    { "press": "0" },
    { "press": "H" },
    { "press": "I" },
    { "pressShifted": "DEL", "expectDisplay": "*" },
    { "press": "SHORT_TERM", "expectDisplay": "GIVE NUMBER OR FUNCTION" },
    { "press": "0", "expectDisplay": "*" }
  ],
  "expectDisplay": "GIVE NUMBER OR FUNCTION"
}
```

```ua8295-test
{
  "id": "M3-2.2-CHARGING-MODES",
  "manualSection": "3.2.2",
  "title": "SHIFT+C selects normal, quick, or fast charging",
  "status": "boundary",
  "reason": "External supply, battery state, charge timer, and charge LED are not modeled",
  "steps": [{ "pressShifted": "C" }],
  "expectDisplay": "CHARG"
}
```

```ua8295-test
{
  "id": "M3-2.3-BRIGHTNESS-CYCLE",
  "manualSection": "3.2.3",
  "title": "BRIGHT cycles three levels and the display blanks after 30 seconds",
  "status": "pass",
  "steps": [
    { "press": "BRIGHT", "expectDisplay": "FUNCTION", "expectBrightness": 1 },
    { "press": "BRIGHT", "expectBrightness": 2 },
    { "press": "BRIGHT", "expectBrightness": 0 },
    { "advanceSeconds": 30, "expectBlanked": true },
    { "press": "^", "expectBlanked": false }
  ],
  "expectDisplay": "FUNCTION"
}
```

```ua8295-test
{
  "id": "M3-2.4-CONF-WALK",
  "manualSection": "3.2.4",
  "title": "Accepting each configuration feature completes the setup walk",
  "status": "pass",
  "steps": [
    { "press": "CONF" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=" },
    { "press": "=", "expectDisplay": "GIVE NUMBER OR FUNCTION" }
  ],
  "expectDisplay": "COMPUTER I/F:"
}
```

```ua8295-test
{
  "id": "M3-2.5-TIME-PERSIST",
  "manualSection": "3.2.5",
  "title": "A newly entered time is retained and advances",
  "status": "pass",
  "steps": [
    { "pressShifted": "BRIGHT" },
    { "press": "1" },
    { "press": "2" },
    { "press": "3" },
    { "press": "4" },
    { "press": "=", "advanceSeconds": 3 },
    { "pressShifted": "BRIGHT" }
  ],
  "expectDisplay": "TIME: 12:34"
}
```

```ua8295-test
{
  "id": "M3-2.6B-ALL-FORMATS",
  "manualSection": "3.2.6B",
  "title": "Every installed fixed format accepts all prompted fields",
  "status": "pass",
  "steps": [
    { "press": "1" },
    { "press": "1" }, { "press": "2" }, { "press": "3" }, { "press": "4" }, { "press": "=" },
    { "press": "5" }, { "press": "6" }, { "press": "7" }, { "press": "8" }, { "press": "=" },
    { "press": "9" }, { "press": "0" }, { "press": "=" },
    { "press": "1" }, { "press": "2" }, { "press": "3" }, { "press": "=", "expectDisplay": "*" }
  ],
  "expectDisplay": "*"
}
```

```ua8295-test
{
  "id": "M3-2.7-EDIT-NAVIGATION",
  "manualSection": "3.2.7",
  "title": "Scroll, held-key repeat, BEGIN, END, and line break edit text",
  "status": "pass",
  "steps": [
    { "press": "0" },
    { "press": "A" },
    { "press": "B" },
    { "press": "C" },
    { "press": "SCROLL_LEFT", "expectDisplay": "AB*C" },
    { "press": "SCROLL_RIGHT", "expectDisplay": "ABC*" },
    { "press": "=", "expectDisplay": "ABC/*" },
    { "pressShifted": "SCROLL_LEFT", "expectDisplay": "*ABC/" },
    { "pressShifted": "SCROLL_RIGHT", "expectDisplay": "ABC/" }
  ],
  "expectDisplay": "ABC/"
}
```

```ua8295-test
{
  "id": "M3-2.11-OFFLINE-CRYPTO",
  "manualSection": "3.2.11",
  "title": "Offline encryption and decryption round-trip five-character groups",
  "status": "todo",
  "reason": "Radio-path encryption works, but the offline display workflow is unverified",
  "steps": [{ "press": "0" }],
  "expectDisplay": "PRINT"
}
```

```ua8295-test
{
  "id": "M3-2.12-DELETE-MEMORY",
  "manualSection": "3.2.12",
  "title": "The confirmation chord clears messages, configuration, and key material",
  "status": "todo",
  "reason": "The manual's two shifted-letter confirmation sequence is not decoded",
  "steps": [],
  "expectDisplay": "DELETE THE MEMORY"
}
```

```ua8295-test
{
  "id": "M3-2.13-ACK-NAK-LINK",
  "manualSection": "3.2.13",
  "title": "Manual ACK and NAK reach the original transmitting terminal",
  "status": "todo",
  "reason": "Entry prompt works; paired acknowledgement delivery is not covered",
  "steps": [{ "press": "ACK_NAK" }],
  "expectDisplay": "ACKNOWLEDGED"
}
```

```ua8295-test
{
  "id": "M3-2.14-CHANGE-KEY",
  "manualSection": "3.2.14",
  "title": "A new keyword changes the displayed four-character key ID",
  "status": "todo",
  "reason": "KEY display works; keyword entry and persistence are not covered",
  "steps": [{ "pressShifted": "KEY" }],
  "expectDisplay": "KEY"
}
```

```ua8295-test
{
  "id": "M3-2.15-PRINTER",
  "manualSection": "3.2.15",
  "title": "Printer input, output, echo controls, and automatic printing work",
  "status": "boundary",
  "reason": "The external printer serial port is not modeled",
  "steps": [],
  "expectDisplay": "PRINT"
}
```

```ua8295-test
{
  "id": "M3-2.16-COMPUTER",
  "manualSection": "3.2.16",
  "title": "An external computer can operate the terminal as a crypto modem",
  "status": "boundary",
  "reason": "The computer-port protocol and connector are not modeled",
  "steps": [],
  "expectDisplay": "FUNCTION"
}
```

## 2.8 Message transmission

`SEND` begins the documented transmission sequence by asking for the receiver.

```ua8295-test
{
  "id": "M3-2.8-SEND-ENTRY",
  "manualSection": "3.2.8",
  "title": "SEND asks for the receiver address",
  "steps": [
    { "press": "SEND", "expectDisplay": "RECEIVER:" }
  ],
  "expectDisplay": "RECEIVER:",
  "expectedIramByte": 7
}
```

## 2.10 Display of messages

With empty receive memory, `DISPL` reports that there are no messages.

```ua8295-test
{
  "id": "M3-2.10-DISPLAY-EMPTY",
  "manualSection": "3.2.10",
  "title": "DISPL reports empty receive memory",
  "steps": [
    { "press": "DISPL", "expectDisplay": "NO MESSAGES" }
  ],
  "expectDisplay": "NO MESSAGES",
  "expectedIramByte": 27
}
```

## 2.13 Manual acknowledgement

The unshifted dual-function key selects `NAK` and asks for the destination.

```ua8295-test
{
  "id": "M3-2.13-NAK-ENTRY",
  "manualSection": "3.2.13",
  "title": "NAK asks for the station address",
  "steps": [
    { "press": "ACK_NAK", "expectDisplay": "NAK TO STATION:" }
  ],
  "expectDisplay": "NAK TO STATION:",
  "expectedIramByte": 14
}
```

## 2.14 Changing the key

`KEY` displays the fixed-key workflow before a new keyword is entered through
the shifted `NEW KEY` function.

```ua8295-test
{
  "id": "M3-2.14-KEY-ENTRY",
  "manualSection": "3.2.14",
  "title": "KEY displays the fixed-key workflow",
  "steps": [
    { "press": "KEY", "expectDisplay": "FIXED KEY" }
  ],
  "expectDisplay": "FIXED KEY",
  "expectedIramByte": 30
}
```
