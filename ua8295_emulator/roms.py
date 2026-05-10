from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Iterable


EPROM_SIZE = 0x2000


@dataclass(frozen=True)
class RomSpec:
    name: str
    size: int
    sha256: str
    description: str


@dataclass(frozen=True)
class RomImage:
    spec: RomSpec
    path: Path
    data: bytes

    @property
    def digest(self) -> str:
        return sha256(self.data).hexdigest()


ROM_SPECS = {
    "main_low": RomSpec(
        name="DA8520_IC24_E22_19841030.bin",
        size=EPROM_SIZE,
        sha256="5d61fc88c0b7bec8624e3263dbe10f0bfbf1e785e1294ffc9505d54f5033f2f3",
        description="Main 80C31 firmware, lower 8 KB code bank.",
    ),
    "main_high": RomSpec(
        name="DA8520_IC18_E22_19841030.bin",
        size=EPROM_SIZE,
        sha256="d2d442bbe7e69caba5b20563a1090ed1bcba795c7e0be6b64f78dcb56dcb8192",
        description="Main 80C31 firmware, upper 8 KB code bank.",
    ),
    "text": RomSpec(
        name="DA8520_IC15_E22_19831228.bin",
        size=EPROM_SIZE,
        sha256="67647b7d17c32965c69926c095959dbf2cee66c0e46af74141bd92fdf2f04695",
        description="On-display user-guide text EPROM.",
    ),
    "iop": RomSpec(
        name="DA8520_IC03_I0P_19841030.bin",
        size=EPROM_SIZE,
        sha256="22db8cbbf71915a6fbf37f76c3b7ef2f98628640e5ee3c1266ab42ada98c476e",
        description="I/O processor 80C31 firmware for the AFSK modem.",
    ),
}


@dataclass(frozen=True)
class RomSet:
    root: Path
    main_low: RomImage
    main_high: RomImage
    text: RomImage
    iop: RomImage

    @property
    def main_code(self) -> bytes:
        return self.main_low.data + self.main_high.data

    @property
    def iop_code(self) -> bytes:
        return self.iop.data

    def images(self) -> Iterable[RomImage]:
        yield self.main_low
        yield self.main_high
        yield self.text
        yield self.iop


class RomValidationError(ValueError):
    """Raised when a ROM directory is missing files or contains unexpected data."""


def _load_image(root: Path, spec: RomSpec) -> RomImage:
    path = root / spec.name
    if not path.exists():
        raise RomValidationError(f"Missing ROM: {path}")
    data = path.read_bytes()
    digest = sha256(data).hexdigest()
    errors = []
    if len(data) != spec.size:
        errors.append(f"size {len(data)} != expected {spec.size}")
    if digest != spec.sha256:
        errors.append(f"sha256 {digest} != expected {spec.sha256}")
    if errors:
        raise RomValidationError(f"{path.name}: " + "; ".join(errors))
    return RomImage(spec=spec, path=path, data=data)


def load_rom_set(root: str | Path) -> RomSet:
    rom_root = Path(root)
    if not rom_root.is_dir():
        raise RomValidationError(f"ROM directory does not exist: {rom_root}")
    return RomSet(
        root=rom_root,
        main_low=_load_image(rom_root, ROM_SPECS["main_low"]),
        main_high=_load_image(rom_root, ROM_SPECS["main_high"]),
        text=_load_image(rom_root, ROM_SPECS["text"]),
        iop=_load_image(rom_root, ROM_SPECS["iop"]),
    )
