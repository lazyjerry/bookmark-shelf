#!/usr/bin/env python3
"""產生 PWA 圖示到 public/icons/。需要 Pillow：python3 -m pip install pillow

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

    # 書籤緞帶
    w, h = r * 0.78, r * 1.1
    left, top = cx - w / 2, cy - h / 2
    notch = h * 0.24
    d.polygon(
        [(left, top), (left + w, top), (left + w, top + h), (cx, top + h - notch), (left, top + h)],
        fill=WHITE,
    )
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


if __name__ == "__main__":
    main()
