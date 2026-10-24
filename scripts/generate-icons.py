#!/usr/bin/env python3
"""產生 PWA 圖示與品牌標記到 public/icons/。需要 Pillow：python3 -m pip install pillow

用法：python3 scripts/generate-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

PAPER = (245, 243, 237)
GRID = (226, 224, 218)
NAVY = (23, 30, 52)
CORAL = (237, 115, 95)
WHITE = (255, 254, 250)
BASE = 1024
OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
# 書脊 (x, y, w, h)，上層站在 y=15.5 的隔板上、下層站在 y=24.5 的底板上
BOOKS = [
    (10, 9.5, 2, 6), (12.5, 10.5, 2.5, 5), (15.5, 9, 2, 6.5), (18, 10.5, 2, 5), (20.5, 9.5, 1.5, 6),
    (10, 18.5, 2.5, 6), (13, 19.5, 2, 5), (15.5, 18, 2, 6.5), (18, 19, 2.5, 5.5), (21, 18.5, 1, 6),
]


def draw(scale: float) -> Image.Image:
    """scale 是圖案直徑佔畫布的比例；maskable 要縮在中央 80% 安全區內"""
    img = Image.new("RGB", (BASE, BASE), PAPER)
    d = ImageDraw.Draw(img)
    step = BASE // 16
    for x in range(0, BASE, step):
        d.line([(x, 0), (x, BASE)], fill=GRID, width=4)
        d.line([(0, x), (BASE, x)], fill=GRID, width=4)

    r = BASE * scale / 2
    cx = cy = BASE / 2
    shadow = r * 0.09
    d.ellipse([cx - r + shadow, cy - r + shadow, cx + r + shadow, cy + r + shadow], fill=NAVY)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CORAL)

    bookcase(d, cx, cy, r)
    return img


def bookcase(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float) -> None:
    """書櫃：白色櫃體、兩層格子、每層幾本高矮不一的書脊。座標與 public/favicon.svg 同一套 32 格系統"""
    u = r / 16
    ox, oy = cx - 16 * u, cy - 16 * u

    def box(x, y, w, h, fill, radius=0.0):
        d.rounded_rectangle([ox + x * u, oy + y * u, ox + (x + w) * u, oy + (y + h) * u], radius=radius * u, fill=fill)

    box(7.5, 6.5, 17, 20, WHITE, radius=1.5)
    box(9, 8, 14, 7.5, CORAL)
    box(9, 17, 14, 7.5, CORAL)
    for x, y, w, h in BOOKS:
        box(x, y, w, h, WHITE)


def draw_mark() -> Image.Image:
    """透明背景的品牌標記（珊瑚色圓＋書櫃），給通知信頁首用"""
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, BASE, BASE], fill=CORAL)
    bookcase(d, BASE / 2, BASE / 2, BASE / 2)
    return img


def save(img: Image.Image, name: str, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    print(f"public/icons/{name} ({size}x{size})")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    regular = draw(0.74)
    maskable = draw(0.56)
    save(regular, "icon-192.png", 192)
    save(regular, "icon-512.png", 512)
    save(maskable, "icon-maskable-512.png", 512)
    save(maskable, "apple-touch-icon.png", 180)
    save(draw_mark(), "brand-mark.png", 60)


if __name__ == "__main__":
    main()
