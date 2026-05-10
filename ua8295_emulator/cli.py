from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .core import CpuError
from .disasm import disassemble
from .roms import RomValidationError, load_rom_set
from .ua8295 import UA8295


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Trace the UA-8295 / Nokia DA-8520 firmware.")
    parser.add_argument("--rom-dir", default="Nokia_DA8520_firmware", help="Directory containing DA-8520 EPROM .bin files.")
    parser.add_argument("--cpu", choices=["main", "iop"], default="main", help="CPU firmware to run.")
    parser.add_argument("--steps", type=int, default=1000, help="Number of instructions to execute.")
    parser.add_argument("--trace", action="store_true", help="Print each executed instruction.")
    parser.add_argument("--disassemble", type=lambda value: int(value, 0), metavar="ADDR", help="Disassemble from address without executing.")
    parser.add_argument("--disassemble-count", type=int, default=16, help="Number of instructions to disassemble.")
    parser.add_argument("--map", action="store_true", help="Print the current UA-8295 memory map model.")
    parser.add_argument("--validate-only", action="store_true", help="Validate ROM files and exit.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        roms = load_rom_set(Path(args.rom_dir))
    except RomValidationError as exc:
        print(f"ROM validation failed: {exc}", file=sys.stderr)
        return 2

    print(f"Loaded ROMs from {roms.root}")
    for image in roms.images():
        print(f"  {image.path.name}: {len(image.data)} bytes sha256={image.digest}")

    if args.validate_only:
        return 0

    machine = UA8295(roms)

    if args.map:
        print("Memory map:")
        for line in machine.describe_memory_map():
            print(f"  {line}")

    code = roms.main_code if args.cpu == "main" else roms.iop_code
    if args.disassemble is not None:
        for line in disassemble(code, start=args.disassemble, count=args.disassemble_count):
            print(line)
        return 0

    cpu = machine.cpu(args.cpu)
    print(f"Running {args.cpu} CPU for up to {args.steps} instructions")
    try:
        entries = cpu.run(args.steps, trace=args.trace)
    except CpuError as exc:
        print(f"CPU stopped: {exc}", file=sys.stderr)
        return 1

    if args.trace:
        for entry in entries:
            print(entry.format())

    snapshot = cpu.snapshot()
    print(
        "State: "
        f"PC=0x{snapshot['pc']:04X} A=0x{snapshot['a']:02X} B=0x{snapshot['b']:02X} "
        f"PSW=0x{snapshot['psw']:02X} SP=0x{snapshot['sp']:02X} "
        f"DPTR=0x{snapshot['dptr']:04X} cycles={snapshot['cycles']}"
    )

    bus = machine.main_bus if args.cpu == "main" else machine.iop_bus
    if bus.io_events:
        print("Peripheral/XDATA events:")
        for event in bus.io_events[-20:]:
            print(f"  {event}")
    return 0
