# UA-8295 Emulator

Browser-native emulator tooling for the Philips UA-8295 / Nokia DA-8520
Short-Burst Message Terminal firmware.

The TypeScript implementation validates the public EPROM set, executes both
original 80C31 ROMs, models the complete operator keyboard/display workflow,
and connects two terminals for encrypted message transfer.

## Firmware

Place the public Crypto Museum firmware files in `Nokia_DA8520_firmware/`:

- `DA8520_IC03_I0P_19841030.bin`
- `DA8520_IC15_E22_19831228.bin`
- `DA8520_IC18_E22_19841030.bin`
- `DA8520_IC24_E22_19841030.bin`

## Usage

```sh
npm run dev
```

Device Mode can switch between a single terminal and **Transmission Test**, which
runs two independent dual-CPU terminals side by side. Their I/O processors are
connected through a radio link, simultaneous transmission is treated as a
collision, and each terminal's SRAM is persisted independently in the browser.

To reproduce the automated A-to-B path: load defaults on both units with
`SHIFT+CONF`, enter a free-format message with `0`, finish with `TERM`, press
`SEND`, enter receiver `00`, and press `=`. On the receiving unit, press
`DISPL`, choose message `1`, then use the left scroll key to show its text.

## Tests

```sh
npm test
npm run build
```

The TypeScript tests include headless device integration coverage: they load the
real ROMs, run the coupled main and I/O processor CPUs through initial check-out,
press front-panel keys through the hardware model, and assert the observed
32-character display text without using a browser.

The acceptance suite loads executable scenarios from
`docs/manual-tests/section-3-operation.md`; `docs/manual-conformance.md` tracks
complete, partial, untested, and hardware-boundary procedures. In addition to
power-up, configuration, key, time, message-format and editing workflows, an
end-to-end test composes `HI` on terminal A and verifies that terminal B stores,
decrypts and displays it through the original main firmware.

## Architecture

- `src/mcs51.ts` implements the 80C31/MCS-51 core, including bit operations,
  timers, serial flags, interrupts, MOVX/MOVC access, and save/load of CPU state.
- `src/ua8295.ts` wires the dual CPUs to ROM, SRAM, a cycle scheduler, and the
  shared hardware model.
- `src/radio-link.ts` interleaves two complete terminals, carries the IOP
  waveform/carrier state, and models the external analog modem's recovered-byte
  output while leaving framing, encryption, checksums, address filtering,
  storage and display handling to the original firmware.
- `src/devices.ts` contains named device models for keyboard, display
  controller, serial link, clock, IOP modem/radio bus, and storage/control
  latch gaps.
- `src/app.ts` provides Device Mode by default, with Developer Mode exposing CPU,
  ROM, trace, and memory-map panels.

## Decoded Memory Map

- Main code `0x0000-0x1FFF`: IC24 lower firmware EPROM.
- Main code `0x2000-0x3FFF`: IC18 upper firmware EPROM.
- Main XDATA `0x6000-0x7FFF`: emulated SRAM; `0x7FE0-0x7FFF` mirrors the
  firmware display text buffer.
- Main XDATA `0x8000-0x9FFF`: IC15 text EPROM, with display-controller register
  behavior modeled at `0x8400-0x841F`.
- I/O processor code `0x0000-0x1FFF`: IC03 firmware EPROM.
- I/O processor XDATA `0x0000-0x07FF`: scratch RAM; other IOP XDATA accesses go
  through the modem/radio peripheral model.

## Modeling Boundary

The digital machine is ROM-driven through message composition, encryption,
transmission, reception, decryption and SRAM storage. The undocumented analog
radio front-end is modeled at its two useful boundaries: the IOP's mark/space
waveform is exposed for link status, while correctly recovered octets are
delivered to the receiving firmware. Audio-frequency filtering and noisy-channel
error simulation are intentionally outside the current model.
