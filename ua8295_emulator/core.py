from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .memory import ExternalBus


class CpuError(RuntimeError):
    """Raised when the CPU encounters an unsupported or invalid condition."""


def u8(value: int) -> int:
    return value & 0xFF


def u16(value: int) -> int:
    return value & 0xFFFF


def rel8(value: int) -> int:
    value &= 0xFF
    return value - 0x100 if value & 0x80 else value


def parity(value: int) -> int:
    return bin(value & 0xFF).count("1") & 1


SFR_NAMES = {
    0x80: "P0",
    0x81: "SP",
    0x82: "DPL",
    0x83: "DPH",
    0x87: "PCON",
    0x88: "TCON",
    0x89: "TMOD",
    0x8A: "TL0",
    0x8B: "TL1",
    0x8C: "TH0",
    0x8D: "TH1",
    0x90: "P1",
    0x98: "SCON",
    0x99: "SBUF",
    0xA0: "P2",
    0xA8: "IE",
    0xB0: "P3",
    0xB8: "IP",
    0xD0: "PSW",
    0xE0: "ACC",
    0xF0: "B",
}


@dataclass
class TraceEntry:
    pc: int
    opcode: int
    bytes_: bytes
    text: str
    a: int
    b: int
    psw: int
    sp: int
    dptr: int

    def format(self) -> str:
        raw = " ".join(f"{b:02X}" for b in self.bytes_)
        return (
            f"{self.pc:04X}: {raw:<8} {self.text:<24} "
            f"A={self.a:02X} B={self.b:02X} PSW={self.psw:02X} "
            f"SP={self.sp:02X} DPTR={self.dptr:04X}"
        )


@dataclass
class MCS51:
    """Intel MCS-51/8051 execution core suitable for 80C31 ROM tracing."""

    bus: ExternalBus
    name: str = "cpu"
    pc: int = 0
    iram: bytearray = field(default_factory=lambda: bytearray(128))
    sfr: dict[int, int] = field(default_factory=dict)
    halted: bool = False
    cycles: int = 0

    def __post_init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.pc = 0
        self.iram[:] = bytes(128)
        self.sfr = {
            0x80: 0xFF,
            0x81: 0x07,
            0x82: 0x00,
            0x83: 0x00,
            0x87: 0x00,
            0x88: 0x00,
            0x89: 0x00,
            0x8A: 0x00,
            0x8B: 0x00,
            0x8C: 0x00,
            0x8D: 0x00,
            0x90: 0xFF,
            0x98: 0x00,
            0x99: 0x00,
            0xA0: 0xFF,
            0xA8: 0x00,
            0xB0: 0xFF,
            0xB8: 0x00,
            0xD0: 0x00,
            0xE0: 0x00,
            0xF0: 0x00,
        }
        self.halted = False
        self.cycles = 0
        self._update_parity()

    @property
    def a(self) -> int:
        return self.read_direct(0xE0)

    @a.setter
    def a(self, value: int) -> None:
        self.write_direct(0xE0, value)

    @property
    def b(self) -> int:
        return self.read_direct(0xF0)

    @b.setter
    def b(self, value: int) -> None:
        self.write_direct(0xF0, value)

    @property
    def psw(self) -> int:
        return self.read_direct(0xD0)

    @psw.setter
    def psw(self, value: int) -> None:
        self.write_direct(0xD0, value)

    @property
    def sp(self) -> int:
        return self.read_direct(0x81)

    @sp.setter
    def sp(self, value: int) -> None:
        self.write_direct(0x81, value)

    @property
    def dptr(self) -> int:
        return (self.read_direct(0x83) << 8) | self.read_direct(0x82)

    @dptr.setter
    def dptr(self, value: int) -> None:
        self.write_direct(0x82, value)
        self.write_direct(0x83, value >> 8)

    @property
    def carry(self) -> int:
        return (self.psw >> 7) & 1

    @carry.setter
    def carry(self, value: int) -> None:
        self._set_psw_bit(7, value)

    def _set_psw_bit(self, bit: int, value: int) -> None:
        psw = self.psw
        if value:
            psw |= 1 << bit
        else:
            psw &= ~(1 << bit)
        self.sfr[0xD0] = u8(psw)

    def _update_parity(self) -> None:
        psw = self.sfr.get(0xD0, 0)
        psw = (psw & ~0x01) | parity(self.sfr.get(0xE0, 0))
        self.sfr[0xD0] = u8(psw)

    def _bank_base(self) -> int:
        return ((self.psw >> 3) & 0x03) * 8

    def get_r(self, index: int) -> int:
        return self.iram[self._bank_base() + (index & 7)]

    def set_r(self, index: int, value: int) -> None:
        self.iram[self._bank_base() + (index & 7)] = u8(value)

    def read_direct(self, addr: int) -> int:
        addr &= 0xFF
        if addr < 0x80:
            return self.iram[addr]
        return self.sfr.get(addr, 0x00)

    def write_direct(self, addr: int, value: int) -> None:
        addr &= 0xFF
        value = u8(value)
        if addr < 0x80:
            self.iram[addr] = value
        else:
            self.sfr[addr] = value
        if addr == 0xE0:
            self._update_parity()

    def read_indirect(self, reg: int) -> int:
        addr = self.get_r(reg)
        return self.iram[addr & 0x7F]

    def write_indirect(self, reg: int, value: int) -> None:
        addr = self.get_r(reg)
        self.iram[addr & 0x7F] = u8(value)

    def read_bit(self, bit_addr: int) -> int:
        bit_addr &= 0xFF
        if bit_addr < 0x80:
            byte_addr = 0x20 + (bit_addr >> 3)
            bit = bit_addr & 7
        else:
            byte_addr = bit_addr & 0xF8
            bit = bit_addr & 7
        return (self.read_direct(byte_addr) >> bit) & 1

    def write_bit(self, bit_addr: int, value: int) -> None:
        bit_addr &= 0xFF
        if bit_addr < 0x80:
            byte_addr = 0x20 + (bit_addr >> 3)
            bit = bit_addr & 7
        else:
            byte_addr = bit_addr & 0xF8
            bit = bit_addr & 7
        byte = self.read_direct(byte_addr)
        if value:
            byte |= 1 << bit
        else:
            byte &= ~(1 << bit)
        self.write_direct(byte_addr, byte)

    def fetch_byte(self) -> int:
        value = self.bus.read_code(self.pc)
        self.pc = u16(self.pc + 1)
        return value

    def fetch_word(self) -> int:
        high = self.fetch_byte()
        low = self.fetch_byte()
        return (high << 8) | low

    def push(self, value: int) -> None:
        self.sp = self.sp + 1
        self.write_direct(self.sp, value)

    def pop(self) -> int:
        value = self.read_direct(self.sp)
        self.sp = self.sp - 1
        return value

    def _jump_rel(self, offset: int) -> None:
        self.pc = u16(self.pc + rel8(offset))

    def _ajmp_addr(self, opcode: int, imm: int) -> int:
        return (self.pc & 0xF800) | ((opcode & 0xE0) << 3) | imm

    def _acall(self, opcode: int) -> None:
        imm = self.fetch_byte()
        target = self._ajmp_addr(opcode, imm)
        self.push(self.pc & 0xFF)
        self.push(self.pc >> 8)
        self.pc = target

    def _ret(self) -> None:
        high = self.pop()
        low = self.pop()
        self.pc = (high << 8) | low

    def _add(self, value: int, with_carry: bool = False) -> None:
        a = self.a
        c = self.carry if with_carry else 0
        result = a + value + c
        self.a = result
        self.carry = result > 0xFF
        self._set_psw_bit(6, ((a & 0x0F) + (value & 0x0F) + c) > 0x0F)
        self._set_psw_bit(2, (~(a ^ value) & (a ^ result) & 0x80) != 0)

    def _subb(self, value: int) -> None:
        a = self.a
        c = self.carry
        result = a - value - c
        self.a = result
        self.carry = result < 0
        self._set_psw_bit(6, ((a & 0x0F) - (value & 0x0F) - c) < 0)
        self._set_psw_bit(2, ((a ^ value) & (a ^ result) & 0x80) != 0)

    def _logical_a(self, op: Callable[[int, int], int], value: int) -> None:
        self.a = op(self.a, value)

    def _cjne(self, left: int, right: int, offset: int) -> None:
        self.carry = left < right
        if left != right:
            self._jump_rel(offset)

    def _xch(self, read: Callable[[], int], write: Callable[[int], None]) -> None:
        old_a = self.a
        self.a = read()
        write(old_a)

    def step(self) -> TraceEntry:
        if self.halted:
            raise CpuError(f"{self.name} is halted")
        start_pc = self.pc
        opcode = self.fetch_byte()

        def imm() -> int:
            return self.fetch_byte()

        def direct() -> int:
            return self.fetch_byte()

        if opcode == 0x00:
            text = "NOP"
        elif opcode in (0x01, 0x21, 0x41, 0x61, 0x81, 0xA1, 0xC1, 0xE1):
            value = imm()
            self.pc = self._ajmp_addr(opcode, value)
            text = f"AJMP 0x{self.pc:04X}"
        elif opcode == 0x02:
            self.pc = self.fetch_word()
            text = f"LJMP 0x{self.pc:04X}"
        elif opcode == 0x03:
            a = self.a
            self.a = ((a >> 1) | ((a & 1) << 7))
            text = "RR A"
        elif opcode == 0x04:
            self.a = self.a + 1
            text = "INC A"
        elif opcode == 0x05:
            addr = direct()
            self.write_direct(addr, self.read_direct(addr) + 1)
            text = f"INC {fmt_direct(addr)}"
        elif opcode in (0x06, 0x07):
            reg = opcode & 1
            self.write_indirect(reg, self.read_indirect(reg) + 1)
            text = f"INC @R{reg}"
        elif 0x08 <= opcode <= 0x0F:
            reg = opcode & 7
            self.set_r(reg, self.get_r(reg) + 1)
            text = f"INC R{reg}"
        elif opcode == 0x10:
            bit, off = imm(), imm()
            if self.read_bit(bit):
                self.write_bit(bit, 0)
                self._jump_rel(off)
            text = f"JBC {fmt_bit(bit)}, {rel8(off):+d}"
        elif opcode in (0x11, 0x31, 0x51, 0x71, 0x91, 0xB1, 0xD1, 0xF1):
            call_pc = self.pc
            self._acall(opcode)
            text = f"ACALL 0x{self.pc:04X}"
            _ = call_pc
        elif opcode == 0x12:
            target = self.fetch_word()
            self.push(self.pc & 0xFF)
            self.push(self.pc >> 8)
            self.pc = target
            text = f"LCALL 0x{target:04X}"
        elif opcode == 0x13:
            a = self.a
            c = self.carry
            self.carry = a & 1
            self.a = (a >> 1) | (c << 7)
            text = "RRC A"
        elif opcode == 0x14:
            self.a = self.a - 1
            text = "DEC A"
        elif opcode == 0x15:
            addr = direct()
            self.write_direct(addr, self.read_direct(addr) - 1)
            text = f"DEC {fmt_direct(addr)}"
        elif opcode in (0x16, 0x17):
            reg = opcode & 1
            self.write_indirect(reg, self.read_indirect(reg) - 1)
            text = f"DEC @R{reg}"
        elif 0x18 <= opcode <= 0x1F:
            reg = opcode & 7
            self.set_r(reg, self.get_r(reg) - 1)
            text = f"DEC R{reg}"
        elif opcode == 0x20:
            bit, off = imm(), imm()
            if self.read_bit(bit):
                self._jump_rel(off)
            text = f"JB {fmt_bit(bit)}, {rel8(off):+d}"
        elif opcode == 0x22:
            self._ret()
            text = "RET"
        elif opcode == 0x23:
            a = self.a
            self.a = ((a << 1) | (a >> 7))
            text = "RL A"
        elif 0x24 <= opcode <= 0x2F:
            value, text = self._read_alu_operand(opcode, imm, "ADD A")
            self._add(value)
        elif opcode == 0x30:
            bit, off = imm(), imm()
            if not self.read_bit(bit):
                self._jump_rel(off)
            text = f"JNB {fmt_bit(bit)}, {rel8(off):+d}"
        elif opcode == 0x32:
            self._ret()
            text = "RETI"
        elif opcode == 0x33:
            a = self.a
            c = self.carry
            self.carry = (a >> 7) & 1
            self.a = (a << 1) | c
            text = "RLC A"
        elif 0x34 <= opcode <= 0x3F:
            value, text = self._read_alu_operand(opcode - 0x10, imm, "ADDC A")
            self._add(value, with_carry=True)
        elif opcode == 0x40:
            off = imm()
            if self.carry:
                self._jump_rel(off)
            text = f"JC {rel8(off):+d}"
        elif opcode == 0x42:
            addr = direct()
            self.write_direct(addr, self.read_direct(addr) | self.a)
            text = f"ORL {fmt_direct(addr)}, A"
        elif opcode == 0x43:
            addr, value = direct(), imm()
            self.write_direct(addr, self.read_direct(addr) | value)
            text = f"ORL {fmt_direct(addr)}, #0x{value:02X}"
        elif opcode in (0x44, 0x45, 0x46, 0x47) or 0x48 <= opcode <= 0x4F:
            value, text = self._read_alu_operand(opcode, imm, "ORL A")
            self._logical_a(lambda a, b: a | b, value)
        elif opcode == 0x50:
            off = imm()
            if not self.carry:
                self._jump_rel(off)
            text = f"JNC {rel8(off):+d}"
        elif opcode == 0x52:
            addr = direct()
            self.write_direct(addr, self.read_direct(addr) & self.a)
            text = f"ANL {fmt_direct(addr)}, A"
        elif opcode == 0x53:
            addr, value = direct(), imm()
            self.write_direct(addr, self.read_direct(addr) & value)
            text = f"ANL {fmt_direct(addr)}, #0x{value:02X}"
        elif opcode in (0x54, 0x55, 0x56, 0x57) or 0x58 <= opcode <= 0x5F:
            value, text = self._read_alu_operand(opcode, imm, "ANL A")
            self._logical_a(lambda a, b: a & b, value)
        elif opcode == 0x60:
            off = imm()
            if self.a == 0:
                self._jump_rel(off)
            text = f"JZ {rel8(off):+d}"
        elif opcode == 0x62:
            addr = direct()
            self.write_direct(addr, self.read_direct(addr) ^ self.a)
            text = f"XRL {fmt_direct(addr)}, A"
        elif opcode == 0x63:
            addr, value = direct(), imm()
            self.write_direct(addr, self.read_direct(addr) ^ value)
            text = f"XRL {fmt_direct(addr)}, #0x{value:02X}"
        elif opcode in (0x64, 0x65, 0x66, 0x67) or 0x68 <= opcode <= 0x6F:
            value, text = self._read_alu_operand(opcode, imm, "XRL A")
            self._logical_a(lambda a, b: a ^ b, value)
        elif opcode == 0x70:
            off = imm()
            if self.a != 0:
                self._jump_rel(off)
            text = f"JNZ {rel8(off):+d}"
        elif opcode == 0x72:
            bit = imm()
            self.carry = self.carry | self.read_bit(bit)
            text = f"ORL C, {fmt_bit(bit)}"
        elif opcode == 0x73:
            self.pc = u16(self.dptr + self.a)
            text = "JMP @A+DPTR"
        elif opcode == 0x74:
            value = imm()
            self.a = value
            text = f"MOV A, #0x{value:02X}"
        elif opcode == 0x75:
            addr, value = direct(), imm()
            self.write_direct(addr, value)
            text = f"MOV {fmt_direct(addr)}, #0x{value:02X}"
        elif opcode in (0x76, 0x77):
            reg, value = opcode & 1, imm()
            self.write_indirect(reg, value)
            text = f"MOV @R{reg}, #0x{value:02X}"
        elif 0x78 <= opcode <= 0x7F:
            reg, value = opcode & 7, imm()
            self.set_r(reg, value)
            text = f"MOV R{reg}, #0x{value:02X}"
        elif opcode == 0x80:
            off = imm()
            self._jump_rel(off)
            text = f"SJMP {rel8(off):+d}"
        elif opcode == 0x82:
            bit = imm()
            self.carry = self.carry & self.read_bit(bit)
            text = f"ANL C, {fmt_bit(bit)}"
        elif opcode == 0x83:
            self.a = self.bus.read_code(u16(self.pc + self.a))
            text = "MOVC A, @A+PC"
        elif opcode == 0x84:
            if self.b == 0:
                self._set_psw_bit(2, 1)
            else:
                a, b = self.a, self.b
                self.a = a // b
                self.b = a % b
                self._set_psw_bit(2, 0)
            self.carry = 0
            text = "DIV AB"
        elif opcode == 0x85:
            src, dst = direct(), direct()
            self.write_direct(dst, self.read_direct(src))
            text = f"MOV {fmt_direct(dst)}, {fmt_direct(src)}"
        elif opcode in (0x86, 0x87):
            reg, addr = opcode & 1, direct()
            self.write_direct(addr, self.read_indirect(reg))
            text = f"MOV {fmt_direct(addr)}, @R{reg}"
        elif 0x88 <= opcode <= 0x8F:
            reg, addr = opcode & 7, direct()
            self.write_direct(addr, self.get_r(reg))
            text = f"MOV {fmt_direct(addr)}, R{reg}"
        elif opcode == 0x90:
            self.dptr = self.fetch_word()
            text = f"MOV DPTR, #0x{self.dptr:04X}"
        elif opcode == 0x92:
            bit = imm()
            self.write_bit(bit, self.carry)
            text = f"MOV {fmt_bit(bit)}, C"
        elif opcode == 0x93:
            self.a = self.bus.read_code(u16(self.dptr + self.a))
            text = "MOVC A, @A+DPTR"
        elif 0x94 <= opcode <= 0x9F:
            value, text = self._read_alu_operand(opcode - 0x70, imm, "SUBB A")
            self._subb(value)
        elif opcode == 0xA0:
            bit = imm()
            self.carry = self.carry | (1 - self.read_bit(bit))
            text = f"ORL C, /{fmt_bit(bit)}"
        elif opcode == 0xA2:
            bit = imm()
            self.carry = self.read_bit(bit)
            text = f"MOV C, {fmt_bit(bit)}"
        elif opcode == 0xA3:
            self.dptr = self.dptr + 1
            text = "INC DPTR"
        elif opcode == 0xA4:
            result = self.a * self.b
            self.a = result & 0xFF
            self.b = result >> 8
            self.carry = 0
            self._set_psw_bit(2, result > 0xFF)
            text = "MUL AB"
        elif opcode == 0xA5:
            self.halted = True
            text = "DB 0xA5"
        elif opcode in (0xA6, 0xA7):
            reg, addr = opcode & 1, direct()
            self.write_indirect(reg, self.read_direct(addr))
            text = f"MOV @R{reg}, {fmt_direct(addr)}"
        elif 0xA8 <= opcode <= 0xAF:
            reg, addr = opcode & 7, direct()
            self.set_r(reg, self.read_direct(addr))
            text = f"MOV R{reg}, {fmt_direct(addr)}"
        elif opcode == 0xB0:
            bit = imm()
            self.carry = self.carry & (1 - self.read_bit(bit))
            text = f"ANL C, /{fmt_bit(bit)}"
        elif opcode == 0xB2:
            bit = imm()
            self.write_bit(bit, 1 - self.read_bit(bit))
            text = f"CPL {fmt_bit(bit)}"
        elif opcode == 0xB3:
            self.carry = 1 - self.carry
            text = "CPL C"
        elif opcode == 0xB4:
            value, off = imm(), imm()
            self._cjne(self.a, value, off)
            text = f"CJNE A, #0x{value:02X}, {rel8(off):+d}"
        elif opcode == 0xB5:
            addr, off = direct(), imm()
            self._cjne(self.a, self.read_direct(addr), off)
            text = f"CJNE A, {fmt_direct(addr)}, {rel8(off):+d}"
        elif opcode in (0xB6, 0xB7):
            reg, value, off = opcode & 1, imm(), imm()
            self._cjne(self.read_indirect(reg), value, off)
            text = f"CJNE @R{reg}, #0x{value:02X}, {rel8(off):+d}"
        elif 0xB8 <= opcode <= 0xBF:
            reg, value, off = opcode & 7, imm(), imm()
            self._cjne(self.get_r(reg), value, off)
            text = f"CJNE R{reg}, #0x{value:02X}, {rel8(off):+d}"
        elif opcode == 0xC0:
            addr = direct()
            self.push(self.read_direct(addr))
            text = f"PUSH {fmt_direct(addr)}"
        elif opcode == 0xC2:
            bit = imm()
            self.write_bit(bit, 0)
            text = f"CLR {fmt_bit(bit)}"
        elif opcode == 0xC3:
            self.carry = 0
            text = "CLR C"
        elif opcode == 0xC4:
            self.a = ((self.a & 0x0F) << 4) | (self.a >> 4)
            text = "SWAP A"
        elif opcode == 0xC5:
            addr = direct()
            self._xch(lambda: self.read_direct(addr), lambda value: self.write_direct(addr, value))
            text = f"XCH A, {fmt_direct(addr)}"
        elif opcode in (0xC6, 0xC7):
            reg = opcode & 1
            self._xch(lambda reg=reg: self.read_indirect(reg), lambda value, reg=reg: self.write_indirect(reg, value))
            text = f"XCH A, @R{reg}"
        elif 0xC8 <= opcode <= 0xCF:
            reg = opcode & 7
            self._xch(lambda reg=reg: self.get_r(reg), lambda value, reg=reg: self.set_r(reg, value))
            text = f"XCH A, R{reg}"
        elif opcode == 0xD0:
            addr = direct()
            self.write_direct(addr, self.pop())
            text = f"POP {fmt_direct(addr)}"
        elif opcode == 0xD2:
            bit = imm()
            self.write_bit(bit, 1)
            text = f"SETB {fmt_bit(bit)}"
        elif opcode == 0xD3:
            self.carry = 1
            text = "SETB C"
        elif opcode == 0xD4:
            self._decimal_adjust()
            text = "DA A"
        elif opcode == 0xD5:
            addr, off = direct(), imm()
            value = u8(self.read_direct(addr) - 1)
            self.write_direct(addr, value)
            if value != 0:
                self._jump_rel(off)
            text = f"DJNZ {fmt_direct(addr)}, {rel8(off):+d}"
        elif opcode in (0xD6, 0xD7):
            reg = opcode & 1
            indirect = self.read_indirect(reg)
            new_indirect = (indirect & 0xF0) | (self.a & 0x0F)
            self.a = (self.a & 0xF0) | (indirect & 0x0F)
            self.write_indirect(reg, new_indirect)
            text = f"XCHD A, @R{reg}"
        elif 0xD8 <= opcode <= 0xDF:
            reg, off = opcode & 7, imm()
            value = u8(self.get_r(reg) - 1)
            self.set_r(reg, value)
            if value != 0:
                self._jump_rel(off)
            text = f"DJNZ R{reg}, {rel8(off):+d}"
        elif opcode == 0xE0:
            self.a = self.bus.read_xdata(self.dptr)
            text = "MOVX A, @DPTR"
        elif opcode in (0xE2, 0xE3):
            reg = opcode & 1
            self.a = self.bus.read_pdata(self.read_direct(0xA0), self.get_r(reg))
            text = f"MOVX A, @R{reg}"
        elif opcode == 0xE4:
            self.a = 0
            text = "CLR A"
        elif opcode == 0xE5:
            addr = direct()
            self.a = self.read_direct(addr)
            text = f"MOV A, {fmt_direct(addr)}"
        elif opcode in (0xE6, 0xE7):
            reg = opcode & 1
            self.a = self.read_indirect(reg)
            text = f"MOV A, @R{reg}"
        elif 0xE8 <= opcode <= 0xEF:
            reg = opcode & 7
            self.a = self.get_r(reg)
            text = f"MOV A, R{reg}"
        elif opcode == 0xF0:
            self.bus.write_xdata(self.dptr, self.a)
            text = "MOVX @DPTR, A"
        elif opcode in (0xF2, 0xF3):
            reg = opcode & 1
            self.bus.write_pdata(self.read_direct(0xA0), self.get_r(reg), self.a)
            text = f"MOVX @R{reg}, A"
        elif opcode == 0xF4:
            self.a = ~self.a
            text = "CPL A"
        elif opcode == 0xF5:
            addr = direct()
            self.write_direct(addr, self.a)
            text = f"MOV {fmt_direct(addr)}, A"
        elif opcode in (0xF6, 0xF7):
            reg = opcode & 1
            self.write_indirect(reg, self.a)
            text = f"MOV @R{reg}, A"
        elif 0xF8 <= opcode <= 0xFF:
            reg = opcode & 7
            self.set_r(reg, self.a)
            text = f"MOV R{reg}, A"
        else:
            raise CpuError(f"unsupported opcode 0x{opcode:02X} at 0x{start_pc:04X}")

        self.cycles += 1
        self._update_parity()
        raw = bytes(self.bus.read_code(start_pc + i) for i in range(instruction_length(opcode)))
        return TraceEntry(
            pc=start_pc,
            opcode=opcode,
            bytes_=raw,
            text=text,
            a=self.a,
            b=self.b,
            psw=self.psw,
            sp=self.sp,
            dptr=self.dptr,
        )

    def _read_alu_operand(self, opcode: int, imm: Callable[[], int], mnemonic: str) -> tuple[int, str]:
        if opcode in (0x24, 0x44, 0x54, 0x64):
            value = imm()
            return value, f"{mnemonic}, #0x{value:02X}"
        if opcode in (0x25, 0x45, 0x55, 0x65):
            addr = imm()
            return self.read_direct(addr), f"{mnemonic}, {fmt_direct(addr)}"
        if opcode in (0x26, 0x27, 0x46, 0x47, 0x56, 0x57, 0x66, 0x67):
            reg = opcode & 1
            return self.read_indirect(reg), f"{mnemonic}, @R{reg}"
        reg = opcode & 7
        return self.get_r(reg), f"{mnemonic}, R{reg}"

    def _decimal_adjust(self) -> None:
        value = self.a
        add = 0
        if (value & 0x0F) > 9 or ((self.psw >> 6) & 1):
            add |= 0x06
        if value > 0x99 or self.carry:
            add |= 0x60
            self.carry = 1
        self.a = value + add

    def run(self, steps: int, trace: bool = False) -> list[TraceEntry]:
        entries: list[TraceEntry] = []
        for _ in range(steps):
            entry = self.step()
            if trace:
                entries.append(entry)
            if self.halted:
                break
        return entries

    def snapshot(self) -> dict[str, int]:
        return {
            "pc": self.pc,
            "a": self.a,
            "b": self.b,
            "psw": self.psw,
            "sp": self.sp,
            "dptr": self.dptr,
            "cycles": self.cycles,
        }


def fmt_direct(addr: int) -> str:
    return SFR_NAMES.get(addr & 0xFF, f"0x{addr & 0xFF:02X}")


def fmt_bit(bit_addr: int) -> str:
    bit_addr &= 0xFF
    if bit_addr >= 0x80:
        return f"{fmt_direct(bit_addr & 0xF8)}.{bit_addr & 7}"
    return f"0x{bit_addr:02X}"


def instruction_length(opcode: int) -> int:
    if opcode in {
        0x02,
        0x10,
        0x12,
        0x20,
        0x30,
        0x43,
        0x53,
        0x63,
        0x75,
        0x85,
        0x90,
        0xB4,
        0xB5,
        0xB6,
        0xB7,
        0xD5,
    } or 0xB8 <= opcode <= 0xBF:
        return 3
    if opcode in {
        0x01,
        0x05,
        0x11,
        0x15,
        0x21,
        0x24,
        0x25,
        0x31,
        0x34,
        0x35,
        0x40,
        0x41,
        0x44,
        0x45,
        0x50,
        0x51,
        0x54,
        0x55,
        0x60,
        0x61,
        0x64,
        0x65,
        0x70,
        0x71,
        0x72,
        0x74,
        0x76,
        0x77,
        0x80,
        0x81,
        0x82,
        0x86,
        0x87,
        0x91,
        0x92,
        0x94,
        0x95,
        0xA0,
        0xA1,
        0xA2,
        0xA6,
        0xA7,
        0xB0,
        0xB1,
        0xB2,
        0xC0,
        0xC1,
        0xC2,
        0xD0,
        0xD1,
        0xD2,
        0xE5,
        0xE1,
        0xF5,
        0xF1,
    }:
        return 2
    if (
        0x78 <= opcode <= 0x7F
        or 0x88 <= opcode <= 0x8F
        or 0xA8 <= opcode <= 0xAF
        or 0xD8 <= opcode <= 0xDF
    ):
        return 2
    return 1
