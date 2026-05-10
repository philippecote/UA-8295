from __future__ import annotations

from .core import fmt_bit, fmt_direct, instruction_length, rel8


def _b(code: bytes, addr: int) -> int:
    return code[addr & 0xFFFF] if (addr & 0xFFFF) < len(code) else 0xFF


def disassemble_one(code: bytes, pc: int) -> tuple[str, int]:
    op = _b(code, pc)
    b1 = _b(code, pc + 1)
    b2 = _b(code, pc + 2)
    word = (b1 << 8) | b2
    length = instruction_length(op)

    if op == 0x00:
        text = "NOP"
    elif op in (0x01, 0x21, 0x41, 0x61, 0x81, 0xA1, 0xC1, 0xE1):
        target = ((pc + 2) & 0xF800) | ((op & 0xE0) << 3) | b1
        text = f"AJMP 0x{target:04X}"
    elif op == 0x02:
        text = f"LJMP 0x{word:04X}"
    elif op == 0x10:
        text = f"JBC {fmt_bit(b1)}, {rel8(b2):+d}"
    elif op in (0x11, 0x31, 0x51, 0x71, 0x91, 0xB1, 0xD1, 0xF1):
        target = ((pc + 2) & 0xF800) | ((op & 0xE0) << 3) | b1
        text = f"ACALL 0x{target:04X}"
    elif op == 0x12:
        text = f"LCALL 0x{word:04X}"
    elif op == 0x20:
        text = f"JB {fmt_bit(b1)}, {rel8(b2):+d}"
    elif op == 0x22:
        text = "RET"
    elif op == 0x30:
        text = f"JNB {fmt_bit(b1)}, {rel8(b2):+d}"
    elif op == 0x32:
        text = "RETI"
    elif op == 0x40:
        text = f"JC {rel8(b1):+d}"
    elif op == 0x50:
        text = f"JNC {rel8(b1):+d}"
    elif op == 0x60:
        text = f"JZ {rel8(b1):+d}"
    elif op == 0x70:
        text = f"JNZ {rel8(b1):+d}"
    elif op == 0x80:
        text = f"SJMP {rel8(b1):+d}"
    elif op == 0x90:
        text = f"MOV DPTR, #0x{word:04X}"
    elif op == 0xA5:
        text = "DB 0xA5"
    elif op == 0x03:
        text = "RR A"
    elif op == 0x04:
        text = "INC A"
    elif op == 0x05:
        text = f"INC {fmt_direct(b1)}"
    elif op in (0x06, 0x07):
        text = f"INC @R{op & 1}"
    elif 0x08 <= op <= 0x0F:
        text = f"INC R{op & 7}"
    elif op == 0x13:
        text = "RRC A"
    elif op == 0x14:
        text = "DEC A"
    elif op == 0x15:
        text = f"DEC {fmt_direct(b1)}"
    elif op in (0x16, 0x17):
        text = f"DEC @R{op & 1}"
    elif 0x18 <= op <= 0x1F:
        text = f"DEC R{op & 7}"
    elif op == 0x23:
        text = "RL A"
    elif op == 0x33:
        text = "RLC A"
    elif op in (0x24, 0x34, 0x44, 0x54, 0x64, 0x94):
        names = {0x24: "ADD A", 0x34: "ADDC A", 0x44: "ORL A", 0x54: "ANL A", 0x64: "XRL A", 0x94: "SUBB A"}
        text = f"{names[op]}, #0x{b1:02X}"
    elif op in (0x25, 0x35, 0x45, 0x55, 0x65, 0x95):
        names = {0x25: "ADD A", 0x35: "ADDC A", 0x45: "ORL A", 0x55: "ANL A", 0x65: "XRL A", 0x95: "SUBB A"}
        text = f"{names[op]}, {fmt_direct(b1)}"
    elif op in (0x26, 0x27, 0x36, 0x37, 0x46, 0x47, 0x56, 0x57, 0x66, 0x67, 0x96, 0x97):
        family = (op & 0xF0)
        names = {0x20: "ADD A", 0x30: "ADDC A", 0x40: "ORL A", 0x50: "ANL A", 0x60: "XRL A", 0x90: "SUBB A"}
        text = f"{names[family]}, @R{op & 1}"
    elif (
        0x28 <= op <= 0x2F
        or 0x38 <= op <= 0x3F
        or 0x48 <= op <= 0x4F
        or 0x58 <= op <= 0x5F
        or 0x68 <= op <= 0x6F
        or 0x98 <= op <= 0x9F
    ):
        family = op & 0xF0
        names = {0x20: "ADD A", 0x30: "ADDC A", 0x40: "ORL A", 0x50: "ANL A", 0x60: "XRL A", 0x90: "SUBB A"}
        text = f"{names[family]}, R{op & 7}"
    elif op in (0x42, 0x52, 0x62):
        names = {0x42: "ORL", 0x52: "ANL", 0x62: "XRL"}
        text = f"{names[op]} {fmt_direct(b1)}, A"
    elif op in (0x43, 0x53, 0x63):
        names = {0x43: "ORL", 0x53: "ANL", 0x63: "XRL"}
        text = f"{names[op]} {fmt_direct(b1)}, #0x{b2:02X}"
    elif op == 0x73:
        text = "JMP @A+DPTR"
    elif op in (0x74, 0x75, 0x78, 0x79, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F):
        if op == 0x74:
            text = f"MOV A, #0x{b1:02X}"
        elif op == 0x75:
            text = f"MOV {fmt_direct(b1)}, #0x{b2:02X}"
        else:
            text = f"MOV R{op & 7}, #0x{b1:02X}"
    elif op in (0x76, 0x77):
        text = f"MOV @R{op & 1}, #0x{b1:02X}"
    elif op == 0x82:
        text = f"ANL C, {fmt_bit(b1)}"
    elif op == 0x83:
        text = "MOVC A, @A+PC"
    elif op == 0x84:
        text = "DIV AB"
    elif op == 0x85:
        text = f"MOV {fmt_direct(b2)}, {fmt_direct(b1)}"
    elif op in (0x86, 0x87):
        text = f"MOV {fmt_direct(b1)}, @R{op & 1}"
    elif 0x88 <= op <= 0x8F:
        text = f"MOV {fmt_direct(b1)}, R{op & 7}"
    elif op == 0x92:
        text = f"MOV {fmt_bit(b1)}, C"
    elif op == 0x93:
        text = "MOVC A, @A+DPTR"
    elif op == 0xA0:
        text = f"ORL C, /{fmt_bit(b1)}"
    elif op == 0xA2:
        text = f"MOV C, {fmt_bit(b1)}"
    elif op == 0xA3:
        text = "INC DPTR"
    elif op == 0xA4:
        text = "MUL AB"
    elif op in (0xA6, 0xA7):
        text = f"MOV @R{op & 1}, {fmt_direct(b1)}"
    elif 0xA8 <= op <= 0xAF:
        text = f"MOV R{op & 7}, {fmt_direct(b1)}"
    elif op == 0xB0:
        text = f"ANL C, /{fmt_bit(b1)}"
    elif op == 0xB2:
        text = f"CPL {fmt_bit(b1)}"
    elif op == 0xB3:
        text = "CPL C"
    elif op == 0xB4:
        text = f"CJNE A, #0x{b1:02X}, {rel8(b2):+d}"
    elif op == 0xB5:
        text = f"CJNE A, {fmt_direct(b1)}, {rel8(b2):+d}"
    elif op in (0xB6, 0xB7):
        text = f"CJNE @R{op & 1}, #0x{b1:02X}, {rel8(b2):+d}"
    elif 0xB8 <= op <= 0xBF:
        text = f"CJNE R{op & 7}, #0x{b1:02X}, {rel8(b2):+d}"
    elif op == 0xC0:
        text = f"PUSH {fmt_direct(b1)}"
    elif op == 0xC2:
        text = f"CLR {fmt_bit(b1)}"
    elif op == 0xC3:
        text = "CLR C"
    elif op == 0xC4:
        text = "SWAP A"
    elif op == 0xC5:
        text = f"XCH A, {fmt_direct(b1)}"
    elif op in (0xC6, 0xC7):
        text = f"XCH A, @R{op & 1}"
    elif 0xC8 <= op <= 0xCF:
        text = f"XCH A, R{op & 7}"
    elif op == 0xD0:
        text = f"POP {fmt_direct(b1)}"
    elif op == 0xD2:
        text = f"SETB {fmt_bit(b1)}"
    elif op == 0xD3:
        text = "SETB C"
    elif op == 0xD4:
        text = "DA A"
    elif op == 0xD5:
        text = f"DJNZ {fmt_direct(b1)}, {rel8(b2):+d}"
    elif op in (0xD6, 0xD7):
        text = f"XCHD A, @R{op & 1}"
    elif 0xD8 <= op <= 0xDF:
        text = f"DJNZ R{op & 7}, {rel8(b1):+d}"
    elif op == 0xE0:
        text = "MOVX A, @DPTR"
    elif op in (0xE2, 0xE3):
        text = f"MOVX A, @R{op & 1}"
    elif op == 0xE4:
        text = "CLR A"
    elif op == 0xE5:
        text = f"MOV A, {fmt_direct(b1)}"
    elif op in (0xE6, 0xE7):
        text = f"MOV A, @R{op & 1}"
    elif 0xE8 <= op <= 0xEF:
        text = f"MOV A, R{op & 7}"
    elif op == 0xF0:
        text = "MOVX @DPTR, A"
    elif op in (0xF2, 0xF3):
        text = f"MOVX @R{op & 1}, A"
    elif op == 0xF4:
        text = "CPL A"
    elif op == 0xF5:
        text = f"MOV {fmt_direct(b1)}, A"
    elif op in (0xF6, 0xF7):
        text = f"MOV @R{op & 1}, A"
    elif 0xF8 <= op <= 0xFF:
        text = f"MOV R{op & 7}, A"
    else:
        text = f"DB 0x{op:02X}"
    return text, length


def disassemble(code: bytes, start: int = 0, count: int = 16) -> list[str]:
    lines = []
    pc = start & 0xFFFF
    for _ in range(count):
        text, length = disassemble_one(code, pc)
        raw = " ".join(f"{_b(code, pc + i):02X}" for i in range(length))
        lines.append(f"{pc:04X}: {raw:<8} {text}")
        pc = (pc + length) & 0xFFFF
    return lines
