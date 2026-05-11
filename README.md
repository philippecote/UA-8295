# UA-8295 Emulator

Browser-native emulator tooling for the Philips UA-8295 / Nokia DA-8520
Short-Burst Message Terminal firmware.

The TypeScript implementation is the product: it validates the public EPROM set,
executes the main CPU and I/O processor ROMs, models emerging front-panel
hardware behavior, and provides headless integration tests for ROM-backed device
workflows.

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

## Tests

```sh
npm test
npm run build
```

The TypeScript tests include headless device integration coverage: they load the
real ROMs, run the coupled main and I/O processor CPUs through initial check-out,
press front-panel keys through the hardware model, and assert the observed
32-character display text without using a browser.

The acceptance suite is data-driven from manual expectations. It currently
covers power-up, `CONF`, `KEY`, `TIME`, `ENCR`, `SEND`, `RCV`, `DEL`, numeric
prompt recovery, display history, trace summaries, and performance budgets.

## Architecture

- `src/mcs51.ts` implements the 80C31/MCS-51 core, including bit operations,
  timers, serial flags, interrupts, MOVX/MOVC access, and save/load of CPU state.
- `src/ua8295.ts` wires the dual CPUs to ROM, SRAM, a cycle scheduler, and the
  shared hardware model.
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

## Current Limitations

The emulator is real-ROM driven, but several hardware details are still modeled
at prompt-stable fidelity rather than component-perfect fidelity. `SEND`, `RCV`,
`ENCR`, and some numeric/message editing paths are covered to their current
stable prompts; deeper radio, modem, crypto/key-storage, and full message-buffer
behavior still need more trace evidence before they can be treated as exact.
