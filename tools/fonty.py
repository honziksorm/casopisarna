"""Stáhne písma z Google Fonts (jen latin + latin-ext, woff2) a vytvoří _fontface.css.

    python tools/fonty.py                                        # písma aplikace -> app/fonts
    python tools/fonty.py --brand <název> "Barlow:wght@400;700"  # písma značky -> brands/<název>/fonts
"""
import argparse
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

APP_FAMILIES = [
    "Instrument+Serif:ital@0;1",
    "Instrument+Sans:ital,wdth,wght@0,75..100,400..700;1,75..100,400..700",
    "IBM+Plex+Mono:wght@400;500;600",
    "Anton",  # nadpisy jako na obálkách Excaliburu
    "VT323",  # pixelové štítky, terminál DOS
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=30).read()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--brand")
    ap.add_argument("families", nargs="*", help="rodiny ve tvaru Google Fonts css2, jen se značkou")
    args = ap.parse_args()
    families = args.families if args.brand else APP_FAMILIES

    out = ROOT / "brands" / args.brand / "fonts" if args.brand else ROOT / "app" / "fonts"
    out.mkdir(parents=True, exist_ok=True)
    faces = []
    for family in families:
        key = re.sub(r"[^a-z]", "", family.split(":")[0].lower())
        css = get(f"https://fonts.googleapis.com/css2?family={family}&display=swap").decode()
        for subset, face in re.findall(r"/\* ([\w-]+) \*/\s*(@font-face\s*\{.*?\})", css, re.S):
            if subset not in ("latin", "latin-ext"):
                continue
            url = re.search(r"url\((https://[^)]+\.woff2)\)", face).group(1)
            style = re.search(r"font-style:\s*(\w+)", face).group(1)
            weight = re.search(r"font-weight:\s*([\d ]+)", face).group(1).replace(" ", "-")
            name = f"{key}-{'i-' if style == 'italic' else ''}{weight}-{subset}.woff2"
            (out / name).write_bytes(get(url))
            faces.append(face.replace(url, name))
            print(name, len((out / name).read_bytes()) // 1024, "kB")
    (out / "_fontface.css").write_text("\n".join(faces), encoding="utf-8")


if __name__ == "__main__":
    main()
