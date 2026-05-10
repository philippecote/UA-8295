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
