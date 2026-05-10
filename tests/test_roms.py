from pathlib import Path
import unittest

from ua8295_emulator.roms import load_rom_set


class RomSetTest(unittest.TestCase):
    def test_public_rom_set_loads(self) -> None:
        roms = load_rom_set(Path("Nokia_DA8520_firmware"))
        self.assertEqual(len(roms.main_code), 0x4000)
        self.assertEqual(len(roms.iop_code), 0x2000)
        self.assertEqual(roms.main_code[:4], bytes([0x00, 0x00, 0x80, 0x02]))
        self.assertEqual(roms.iop_code[:4], bytes([0x00, 0x00, 0x00, 0x02]))


if __name__ == "__main__":
    unittest.main()
