"""
Generates placeholder app/tray icons for HarboR ClipShelf.
Run once during setup: python3 scripts/make_icons.py
Replace assets/icon-1024.png with real branded artwork any time and re-run.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)

ACCENT = (47, 111, 237, 255)   # matches --accent in styles.css
WHITE = (255, 255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def base_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(size * 0.06)
    rounded_rect(d, [pad, pad, size - pad, size - pad], radius=int(size * 0.22), fill=ACCENT)

    # "clip" tab at top (Paste/clipboard cue)
    tab_w, tab_h = size * 0.26, size * 0.10
    tab_x = (size - tab_w) / 2
    tab_y = pad + size * 0.02
    rounded_rect(d, [tab_x, tab_y, tab_x + tab_w, tab_y + tab_h], radius=tab_h / 2, fill=WHITE)

    # clipboard body
    body_pad = size * 0.20
    body_top = pad + size * 0.10
    rounded_rect(d, [body_pad, body_top, size - body_pad, size - pad - size * 0.08], radius=size * 0.06, fill=WHITE)

    # "shelf" lines inside (Yoink cue: stacked items on a shelf)
    line_color = ACCENT
    inner_pad = size * 0.27
    ys = [size * 0.46, size * 0.58, size * 0.70]
    for y in ys:
        d.rounded_rectangle(
            [inner_pad, y, size - inner_pad, y + size * 0.045],
            radius=size * 0.02,
            fill=line_color,
        )
    return img


def save_png(img, path):
    img.save(path)


def make_ico(src_1024, out_path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [src_1024.resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[0].save(out_path, format="ICO", sizes=[(s, s) for s in sizes])


def tray_glyph(size):
    """Monochrome clipboard+shelf glyph for the macOS menu bar (template image)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    black = (0, 0, 0, 255)
    w = max(1, round(size / 14))
    pad = size * 0.14
    tab_w = size * 0.32
    d.rounded_rectangle([(size - tab_w) / 2, pad * 0.6, (size + tab_w) / 2, pad * 0.6 + size * 0.12], radius=size * 0.04, fill=black)
    d.rounded_rectangle([pad, pad + size * 0.06, size - pad, size - pad * 0.6], radius=size * 0.1, outline=black, width=w)
    for frac in (0.46, 0.60, 0.74):
        y = size * frac
        d.line([pad + size * 0.14, y, size - pad - size * 0.14, y], fill=black, width=w)
    return img


def with_dot(img, color, outline=None):
    out = img.copy()
    d = ImageDraw.Draw(out)
    s = out.size[0]
    d.ellipse([s * 0.56, s * 0.56, s * 0.98, s * 0.98], fill=color, outline=outline)
    return out


def make_tray_pngs(src_1024):
    # Windows: colored icon (1x = 16px, 2x = 32px)
    for scale, px in (("", 16), ("@2x", 32)):
        tray = src_1024.resize((px, px), Image.LANCZOS)
        save_png(tray, os.path.join(ASSETS, f"tray{scale}.png"))
        save_png(with_dot(tray, (255, 170, 0, 255), (255, 255, 255, 255)), os.path.join(ASSETS, f"trayAwake{scale}.png"))
    # macOS: template glyph (1x = 22pt, 2x = 44px)
    for scale, px in (("", 22), ("@2x", 44)):
        glyph = tray_glyph(px)
        save_png(glyph, os.path.join(ASSETS, f"trayTemplate{scale}.png"))
        save_png(with_dot(glyph, (0, 0, 0, 255)), os.path.join(ASSETS, f"trayAwakeTemplate{scale}.png"))


def main():
    icon_1024 = base_icon(1024)
    save_png(icon_1024, os.path.join(ASSETS, "icon-1024.png"))
    save_png(icon_1024.resize((512, 512), Image.LANCZOS), os.path.join(ASSETS, "icon-512.png"))
    save_png(icon_1024.resize((256, 256), Image.LANCZOS), os.path.join(ASSETS, "icon-256.png"))
    make_ico(icon_1024, os.path.join(ASSETS, "icon.ico"))
    make_tray_pngs(icon_1024)
    print("Icons written to", ASSETS)
    print("Next: python3 scripts/make_icns.py  (builds assets/icon.icns, needs `pip install icnsutil`)")


if __name__ == "__main__":
    main()
