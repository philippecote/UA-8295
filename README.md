# UA-8295 Emulator

Experimental CPU-level emulator tooling for the Philips UA-8295 / Nokia DA-8520
Short-Burst Message Terminal firmware.

The first milestone is a traceable Intel 80C31/8051 emulator rather than a
complete interactive front panel. It can validate the public EPROM set, load the
main CPU and I/O processor ROMs, execute instructions, and report CPU/RAM/SFR
state for reverse engineering.

## Firmware

Place the public Crypto Museum firmware files in `Nokia_DA8520_firmware/`:

- `DA8520_IC03_I0P_19841030.bin`
- `DA8520_IC15_E22_19831228.bin`
- `DA8520_IC18_E22_19841030.bin`
- `DA8520_IC24_E22_19841030.bin`

## Usage

```sh
python -m ua8295_emulator --rom-dir Nokia_DA8520_firmware --steps 1000 --trace
```

Run the I/O processor firmware instead of the main CPU:

```sh
python -m ua8295_emulator --rom-dir Nokia_DA8520_firmware --cpu iop --steps 1000
```

Validate ROMs without executing firmware:

```sh
python -m ua8295_emulator --rom-dir Nokia_DA8520_firmware --validate-only
```

## Tests

```sh
python -m unittest discover
```
