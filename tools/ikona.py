"""Ikona pro zástupce na ploše (app/icon.ico). Potřebuje Pillow a písmo Georgia z Windows.

    python tools/ikona.py app/icon.ico
"""
import sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((16, 16, S - 16, S - 16), radius=104, fill=(228, 85, 63, 255))
# jemný hřbet časopisu vlevo
d.rounded_rectangle((16, 16, 92, S - 16), radius=104, fill=(196, 62, 44, 255))
d.rectangle((60, 16, 92, S - 16), fill=(196, 62, 44, 255))
font = ImageFont.truetype(r"C:\Windows\Fonts\georgiab.ttf", 330)
text = "Č"
box = d.textbbox((0, 0), text, font=font, anchor="ls")
w, h = box[2] - box[0], box[3] - box[1]
x = (S - w) / 2 - box[0] + 22
y = (S + h) / 2 - box[3] + 6
d.text((x, y), text, font=font, fill=(255, 248, 238, 255), anchor="ls")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
