from __future__ import annotations

from dataclasses import dataclass

from .core import MCS51
from .memory import ExternalBus
from .roms import RomSet


MAIN_XRAM_SIZE = 0x2000
IOP_XRAM_SIZE = 0x0800
TEXT_ROM_BASE = 0x8000


@dataclass
class UA8295:
    """Two-CPU UA-8295 machine shell with traceable peripheral stubs."""

    roms: RomSet

    def __post_init__(self) -> None:
        self.main_bus = ExternalBus(
            code=self.roms.main_code,
            xram_size=MAIN_XRAM_SIZE,
            text_rom=self.roms.text.data,
        )
        self.iop_bus = ExternalBus(code=self.roms.iop_code, xram_size=IOP_XRAM_SIZE)
        self.main_cpu = MCS51(self.main_bus, name="main")
        self.iop_cpu = MCS51(self.iop_bus, name="iop")

    def cpu(self, name: str) -> MCS51:
        if name == "main":
            return self.main_cpu
        if name == "iop":
            return self.iop_cpu
        raise ValueError(f"unknown CPU: {name}")

    def describe_memory_map(self) -> list[str]:
        return [
            "main code 0x0000-0x1FFF: IC24 lower firmware EPROM",
            "main code 0x2000-0x3FFF: IC18 upper firmware EPROM",
            f"main xdata 0x0000-0x{MAIN_XRAM_SIZE - 1:04X}: emulated SRAM",
            f"main xdata 0x{TEXT_ROM_BASE:04X}-0x{TEXT_ROM_BASE + len(self.roms.text.data) - 1:04X}: IC15 text ROM",
            "main xdata other addresses: traceable peripheral stubs",
            "iop code 0x0000-0x1FFF: IC03 I/O processor firmware EPROM",
            f"iop xdata 0x0000-0x{IOP_XRAM_SIZE - 1:04X}: scratch RAM",
            "iop xdata other addresses: traceable modem/peripheral stubs",
        ]
