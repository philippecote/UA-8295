from pathlib import Path
import unittest

from ua8295_emulator.roms import load_rom_set
from ua8295_emulator.ua8295 import TEXT_ROM_BASE, UA8295


class MachineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.machine = UA8295(load_rom_set(Path("Nokia_DA8520_firmware")))

    def test_memory_map_exposes_text_rom(self) -> None:
        first = self.machine.roms.text.data[0]
        self.assertEqual(self.machine.main_bus.read_xdata(TEXT_ROM_BASE), first)

    def test_main_firmware_runs(self) -> None:
        entries = self.machine.main_cpu.run(1000, trace=True)
        self.assertEqual(len(entries), 1000)
        self.assertGreater(self.machine.main_cpu.pc, 0)

    def test_iop_firmware_runs(self) -> None:
        entries = self.machine.iop_cpu.run(1000, trace=True)
        self.assertEqual(len(entries), 1000)
        self.assertGreater(self.machine.iop_cpu.pc, 0)


if __name__ == "__main__":
    unittest.main()
