"""Ikona pro zástupce na ploše (app/icon.ico): disketa se žlutým Č jako v logu.

    python tools/ikona.py app/icon.ico [nahled.png]
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
K = 4  # kreslí se ve 4× větším rozlišení a zmenší, ať jsou hrany hladké
S = 512 * K
CLEAR = (0, 0, 0, 0)
BODY = (26, 25, 32, 255)


def k(*v):
    return tuple(x * K for x in v)


img = Image.new("RGBA", (S, S), CLEAR)
d = ImageDraw.Draw(img)

# tělo diskety se seříznutým rohem
d.rounded_rectangle(k(32, 32, 480, 480), radius=30 * K, fill=BODY)
d.rounded_rectangle(k(46, 46, 466, 466), radius=20 * K, outline=(54, 52, 62, 255), width=5 * K)
d.polygon([k(410, 20), k(492, 20), k(492, 102)], fill=CLEAR)
d.line([k(422, 48), k(464, 90)], fill=(54, 52, 62, 255), width=5 * K)

# kovová záklopka se štěrbinou
d.rectangle(k(150, 32, 362, 164), fill=(196, 200, 208, 255))
d.rectangle(k(150, 32, 362, 44), fill=(228, 231, 236, 255))
d.rectangle(k(292, 56, 334, 142), fill=BODY)

# štítek: červený jako na obálkách, žluté Č s tvrdým stínem
lx0, ly0, lx1, ly1 = k(78, 192, 434, 456)
d.rounded_rectangle((lx0, ly0, lx1, ly1), radius=10 * K, fill=(232, 50, 42, 255))
font_file = str(ROOT / "app" / "fonts" / "anton-400-latin-ext.woff2")
size = 400 * K
while True:  # písmo co největší, ale i s háčkem uvnitř štítku
    font = ImageFont.truetype(font_file, size)
    box = d.textbbox((0, 0), "Č", font=font)
    if box[3] - box[1] <= (ly1 - ly0) - 34 * K:
        break
    size -= 4 * K
shadow = 12 * K
x = (lx0 + lx1 - shadow) / 2 - (box[0] + box[2]) / 2
y = (ly0 + ly1 - shadow) / 2 - (box[1] + box[3]) / 2
d.text((x + shadow, y + shadow), "Č", font=font, fill=(0, 0, 0, 255))
d.text((x, y), "Č", font=font, fill=(255, 210, 63, 255))

# okénko ochrany proti zápisu
d.rectangle(k(52, 432, 70, 450), fill=(10, 10, 14, 255))

img = img.resize((512, 512), Image.LANCZOS)
img.save(sys.argv[1], sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
if len(sys.argv) > 2:  # náhled ve více velikostech
    sheet = Image.new("RGBA", (256 + 128 + 64 + 48 + 32 + 16 + 60, 256), (40, 40, 44, 255))
    x = 0
    for s in (256, 128, 64, 48, 32, 16):
        sheet.alpha_composite(img.resize((s, s), Image.LANCZOS), (x, 256 - s))
        x += s + 10
    sheet.save(sys.argv[2])
