import unittest

from ua8295_emulator.core import MCS51
from ua8295_emulator.memory import ExternalBus


def cpu_for(code: bytes) -> MCS51:
    return MCS51(ExternalBus(code=code))


class CoreTest(unittest.TestCase):
    def test_reset_state(self) -> None:
        cpu = cpu_for(b"\x00")
        self.assertEqual(cpu.pc, 0)
        self.assertEqual(cpu.sp, 0x07)
        self.assertEqual(cpu.a, 0)

    def test_mov_add_and_parity(self) -> None:
        cpu = cpu_for(bytes([0x74, 0x41, 0x24, 0x01]))
        cpu.step()
        self.assertEqual(cpu.a, 0x41)
        cpu.step()
        self.assertEqual(cpu.a, 0x42)
        self.assertEqual(cpu.carry, 0)
        self.assertEqual(cpu.psw & 1, 0)

    def test_lcall_and_ret(self) -> None:
        cpu = cpu_for(bytes([0x12, 0x00, 0x05, 0x00, 0x00, 0x74, 0xAA, 0x22]))
        cpu.step()
        self.assertEqual(cpu.pc, 5)
        self.assertEqual(cpu.sp, 9)
        cpu.step()
        self.assertEqual(cpu.a, 0xAA)
        cpu.step()
        self.assertEqual(cpu.pc, 3)

    def test_bit_addressing_and_branch(self) -> None:
        cpu = cpu_for(bytes([0xD2, 0x00, 0x20, 0x00, 0x02, 0x74, 0x00, 0x74, 0x7F]))
        cpu.step()
        self.assertEqual(cpu.read_direct(0x20), 1)
        cpu.step()
        cpu.step()
        self.assertEqual(cpu.a, 0x7F)

    def test_movx_dptr(self) -> None:
        cpu = cpu_for(bytes([0x90, 0x00, 0x10, 0x74, 0x5A, 0xF0, 0xE0]))
        for _ in range(4):
            cpu.step()
        self.assertEqual(cpu.bus.xram[0x10], 0x5A)
        self.assertEqual(cpu.a, 0x5A)


if __name__ == "__main__":
    unittest.main()
