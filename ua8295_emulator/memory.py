from __future__ import annotations

from dataclasses import dataclass, field


def _fit64k(data: bytes, fill: int = 0xFF) -> bytearray:
    if len(data) > 0x10000:
        raise ValueError("memory image is larger than 64 KB")
    return bytearray(data + bytes([fill]) * (0x10000 - len(data)))


@dataclass
class ExternalBus:
    """Simple 80C31 external code/data bus with traceable peripheral fallbacks."""

    code: bytes
    xram_size: int = 0x10000
    default_read: int = 0xFF
    text_rom: bytes = b""
    io_events: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.code_mem = _fit64k(self.code)
        if not (1 <= self.xram_size <= 0x10000):
            raise ValueError("xram_size must be between 1 and 65536")
        self.xram = bytearray([0x00] * self.xram_size)
        self.text_rom_mem = bytes(self.text_rom)

    def read_code(self, addr: int) -> int:
        return self.code_mem[addr & 0xFFFF]

    def read_xdata(self, addr: int) -> int:
        addr &= 0xFFFF
        if addr < len(self.xram):
            return self.xram[addr]
        if self.text_rom_mem:
            text_addr = addr - 0x8000
            if 0 <= text_addr < len(self.text_rom_mem):
                return self.text_rom_mem[text_addr]
        self.io_events.append(f"read_xdata 0x{addr:04X} -> 0x{self.default_read:02X}")
        return self.default_read

    def write_xdata(self, addr: int, value: int) -> None:
        addr &= 0xFFFF
        value &= 0xFF
        if addr < len(self.xram):
            self.xram[addr] = value
            return
        self.io_events.append(f"write_xdata 0x{addr:04X} <- 0x{value:02X}")

    def read_pdata(self, page: int, low_addr: int) -> int:
        return self.read_xdata(((page & 0xFF) << 8) | (low_addr & 0xFF))

    def write_pdata(self, page: int, low_addr: int, value: int) -> None:
        self.write_xdata(((page & 0xFF) << 8) | (low_addr & 0xFF), value)
