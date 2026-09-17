"""
Builds every app / menu bar / tray icon from the artwork in assets/artwork/.
  python3 scripts/make_icons.py && python3 scripts/make_icns.py   (npm run icons)

- assets/artwork/panda-app-icon.png  app icon artwork (square, full bleed)
- assets/artwork/panda-face.png      the character on a transparent background
The macOS menu bar icon is a monochrome "template" glyph (drawn below) so it
turns white / black with the menu bar like the system icons.
"""
import os
from PIL import Image, ImageDraw, ImageChops, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
ART = os.path.join(ASSETS, "artwork")
S = 352  # glyph drawing size (8x of 44px)


def app_icon(size=1024):
    """macOS Big Sur+ style: rounded square on the 1024 grid with a soft shadow."""
    art = Image.open(os.path.join(ART, "panda-app-icon.png")).convert("RGBA")
    body = round(size * 824 / 1024)
    off = (size - body) // 2
    radius = round(body * 0.225)
    scale = 4
    mask = Image.new("L", (body * scale, body * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, body * scale - 1, body * scale - 1], radius=radius * scale, fill=255)
    mask = mask.resize((body, body), Image.LANCZOS)
    tile = art.resize((body, body), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sm = Image.new("L", (size, size), 0)
    sm.paste(mask, (off, off + round(size * 0.012)))
    sm = sm.filter(ImageFilter.GaussianBlur(size * 0.014))
    shadow.putalpha(sm.point(lambda v: int(v * 0.35)))
    canvas = Image.alpha_composite(canvas, shadow)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.paste(tile, (off, off), mask)
    return Image.alpha_composite(canvas, layer)


def draw_panda(style='outline', awake=False):
    from PIL import ImageFilter
    m = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(m)
    cx = S/2
    head = [cx-134, 112, cx+134, 338]
    ears = Image.new('L', (S, S), 0); ed = ImageDraw.Draw(ears)
    for ex in (cx-122, cx+122):
        ed.ellipse([ex-50, 150-50, ex+50, 150+50], fill=255)
    d.ellipse(head, outline=255, width=26)
    # hat: dome + brim, with a small gap below the brim
    hat = Image.new('L', (S, S), 0); hd = ImageDraw.Draw(hat)
    hd.pieslice([cx-94, 48, cx+94, 236], 180, 360, fill=255)
    hd.rounded_rectangle([cx-116, 124, cx+116, 156], radius=16, fill=255)
    hd.ellipse([cx-17, 28, cx+17, 62], fill=255)
    gap = hat.filter(ImageFilter.MaxFilter(15))
    m = ImageChops.subtract(m, gap)
    # ears sit behind the head: keep only what is outside the head (and away from the hat)
    face = Image.new('L', (S, S), 0); ImageDraw.Draw(face).ellipse([head[0]+10, head[1]+10, head[2]-10, head[3]-10], fill=255)
    ears = ImageChops.subtract(ImageChops.subtract(ears, face), gap)
    m = ImageChops.lighter(m, ears)
    m = ImageChops.lighter(m, hat)
    d = ImageDraw.Draw(m)
    # eye patches with a bright eye
    patch = Image.new('L', (78, 100), 0); ImageDraw.Draw(patch).ellipse([0, 0, 78, 100], fill=255)
    for sx, ang in ((-1, -32), (1, 32)):
        p = patch.rotate(ang, expand=True, resample=Image.BICUBIC)
        pcx, pcy = cx + sx*54, 234
        m.paste(255, (int(pcx - p.width/2), int(pcy - p.height/2)), p)
        d = ImageDraw.Draw(m)
        ex, ey = pcx + sx*2, pcy - 4
        d.ellipse([ex-14, ey-14, ex+14, ey+14], fill=0)
    # nose + mouth
    d.ellipse([cx-24, 272, cx+24, 300], fill=255)
    if awake:
        d.ellipse([S-118, S-118, S-2, S-2], fill=0)
        d.ellipse([S-102, S-102, S-18, S-18], fill=255)
    return m


def glyph_png(mask, px, color=(0, 0, 0)):
    a = mask.resize((px, px), Image.LANCZOS)
    img = Image.new("RGBA", (px, px), color + (0,))
    img.paste(Image.new("RGBA", (px, px), color + (255,)), (0, 0), a)
    return img


def face(px):
    src = Image.open(os.path.join(ART, "panda-face.png")).convert("RGBA")
    bbox = src.getbbox()
    src = src.crop(bbox)
    side = max(src.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(src, ((side - src.width) // 2, (side - src.height) // 2))
    return sq.resize((px, px), Image.LANCZOS)


def with_dot(img, color, outline=None):
    out = img.copy()
    d = ImageDraw.Draw(out)
    s = out.size[0]
    d.ellipse([s * 0.58, s * 0.58, s * 0.98, s * 0.98], fill=color, outline=outline)
    return out


def make_ico(src_1024, out_path):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    src_1024.save(out_path, format="ICO", sizes=[(s, s) for s in sizes])


def main():
    icon = app_icon(1024)
    icon.save(os.path.join(ASSETS, "icon-1024.png"))
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(ASSETS, "icon-512.png"))
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(ASSETS, "icon-256.png"))
    make_ico(icon, os.path.join(ASSETS, "icon.ico"))
    # Windows tray: the colored character (1x = 16px, 2x = 32px)
    for scale, px in (("", 16), ("@2x", 32)):
        t = face(px)
        t.save(os.path.join(ASSETS, f"tray{scale}.png"))
        with_dot(t, (255, 170, 0, 255), (255, 255, 255, 255)).save(os.path.join(ASSETS, f"trayAwake{scale}.png"))
    # macOS menu bar: monochrome template glyph (1x = 22pt, 2x = 44px)
    plain = draw_panda()
    awake = draw_panda(awake=True)
    for scale, px in (("", 22), ("@2x", 44)):
        glyph_png(plain, px).save(os.path.join(ASSETS, f"trayTemplate{scale}.png"))
        glyph_png(awake, px).save(os.path.join(ASSETS, f"trayAwakeTemplate{scale}.png"))
    docs = os.path.join(ROOT, "docs")
    if os.path.isdir(docs):
        icon.resize((256, 256), Image.LANCZOS).save(os.path.join(docs, "icon.png"))
    print("Icons written to", ASSETS)


if __name__ == "__main__":
    main()
