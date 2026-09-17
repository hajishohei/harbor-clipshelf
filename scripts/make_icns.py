"""
Builds assets/icon.icns from icon-1024.png without needing a Mac.
Run after make_icons.py: python3 scripts/make_icns.py
"""
import os
from PIL import Image
import icnsutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SRC = os.path.join(ASSETS, "icon-1024.png")
OUT = os.path.join(ASSETS, "icon.icns")

SIZES = [16, 32, 48, 128, 256, 512, 1024]


def main():
    src = Image.open(SRC).convert("RGBA")
    img = icnsutil.IcnsFile()
    tmp_dir = os.path.join(ASSETS, "_icns_tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    for size in SIZES:
        resized = src.resize((size, size), Image.LANCZOS)
        path = os.path.join(tmp_dir, f"icon_{size}x{size}.png")
        resized.save(path)
        img.add_media(file=path)
    img.write(OUT)
    print("Wrote", OUT)


if __name__ == "__main__":
    main()
