"""Sestaví balíček čtečky pro Windows do dist/.

    python tools/build.py                       # Časopisárna, s přenosným Pythonem, ZIP
    python tools/build.py --brand <název>       # jiná značka z brands/<název>/
    python tools/build.py --no-python           # bez Pythonu (rychlé zkoušky)

Spouštěcí soubory, návod, config a licence balíčku jsou v balicek/, verze v VERSION.
Stažený Python a knihovny se ukládají do build/cache.
"""
import argparse
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import unicodedata
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "build" / "cache"
DIST = ROOT / "dist"
PY_VERSION = "3.12.10"
PY_EMBED = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
PACKAGES = (ROOT / "requirements.txt").read_text(encoding="utf-8").split()  # verze vyzkoušené s convert.py


def brand_info(brand):
    src = ROOT / "brands" / brand if brand else ROOT / "app" / "brand"
    name = re.search(r"name:\s*'([^']+)'", (src / "brand.js").read_text(encoding="utf-8")).group(1)
    ascii_name = "".join(c for c in unicodedata.normalize("NFD", name) if unicodedata.category(c) != "Mn")
    return {"src": src, "name": name, "folder": re.sub(r"[^A-Za-z0-9]+", "-", ascii_name).strip("-")}


def fetch(url, dest):
    if not dest.exists():
        print("stahuji", url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        dest.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    return dest


def rmtree(path):
    def unlock(func, p, exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    for attempt in range(5):
        try:
            shutil.rmtree(path, onexc=unlock)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(1.5)


def add_python(out):
    py = out / "python"
    with zipfile.ZipFile(fetch(PY_EMBED, CACHE / Path(PY_EMBED).name)) as z:
        z.extractall(py)
    pth = next(py.glob("python*._pth"))
    pth.write_text(pth.read_text().replace("#import site", "import site") + "Lib\\site-packages\n")
    wheels = CACHE / ("wheels-" + "-".join(PACKAGES).replace("==", ""))
    if not wheels.exists():
        subprocess.check_call([sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:",
                               "--platform", "win_amd64", "--python-version", "3.12", "-d", str(wheels), *PACKAGES])
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--no-deps", "--no-index", "--find-links", str(wheels),
                           "--only-binary=:all:", "--platform", "win_amd64", "--python-version", "3.12",
                           "--target", str(py / "Lib" / "site-packages"), "--no-compile", *PACKAGES])
    shutil.copy2(ROOT / "requirements.txt", py / "requirements.txt")  # update.py podle něj pozná změnu knihoven


def brand_pack(brand):
    """Jen vzhled značky (brand.js, styly, písma, logo) – pár set kB místo celého balíčku."""
    info = brand_info(brand)
    DIST.mkdir(exist_ok=True)
    zip_path = DIST / f"Vzhled-{info['folder']}.zip"
    zip_path.unlink(missing_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(info["src"].rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(info["src"]).as_posix())
    print(f"{zip_path.name}: {zip_path.stat().st_size / 1024:.0f} kB")


def build(brand, with_python, make_zip):
    info = brand_info(brand)
    out = DIST / info["folder"]
    if out.exists():
        rmtree(out)
    prog = out / "program"  # nahoře jen spouštěče a návod, všechno ostatní sem
    (prog / "app").mkdir(parents=True)

    for name in ("index.html", "sw.js", "manifest.webmanifest", "convert.py", "server.py", "update.py", "VERSION", "requirements.txt"):
        shutil.copy2(ROOT / name, prog / name)
    for name in ("app.js", "style.css", "icon.ico"):
        shutil.copy2(ROOT / "app" / name, prog / "app" / name)
    shutil.copytree(info["src"], prog / "app" / "brand")
    shutil.copytree(ROOT / "app" / "fonts", prog / "app" / "fonts")
    shutil.copytree(ROOT / "app" / "vendor", prog / "app" / "vendor")
    shutil.copytree(ROOT / "balicek", out, dirs_exist_ok=True)
    readme = out / "ČTI MĚ.txt"
    readme.write_bytes(readme.read_bytes().replace("Časopisárna".encode(), info["name"].encode(), 1))

    if with_python:
        add_python(prog)

    if make_zip:
        zip_path = DIST / f"{info['folder']}.zip"  # stálý název kvůli odkazu releases/latest/download
        zip_path.unlink(missing_ok=True)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    z.write(f, Path(info["folder"]) / f.relative_to(out))
        print(f"{zip_path.name}: {zip_path.stat().st_size / 1e6:.1f} MB")
    print("hotovo:", out)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--brand", choices=sorted(p.parent.name for p in (ROOT / "brands").glob("*/brand.js")))
    ap.add_argument("--no-python", action="store_true")
    ap.add_argument("--no-zip", action="store_true")
    ap.add_argument("--pack", action="store_true", help="jen malý ZIP se vzhledem značky (do čtečky přes Načíst vzhled)")
    a = ap.parse_args()
    if a.pack:
        brand_pack(a.brand)
    else:
        build(a.brand, not a.no_python, not a.no_zip)
