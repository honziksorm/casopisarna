"""Aktualizace čtečky na nejnovější vydání z GitHubu.

Přepíše jen soubory aplikace. Časopisy, převedená data, config.json, značka
(app/brand) a přibalený Python zůstanou, jak jsou.

    python update.py           # nainstaluje novou verzi, když nějaká je
    python update.py --check   # jen zjistí, jestli je nová verze
    python update.py --force   # nainstaluje nejnovější vydání i při stejné verzi
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
# balíček: spouštěče a návod nahoře, program ve složce program/ (do verze 1.3 všechno vedle sebe)
PKG = os.path.dirname(ROOT) if os.path.basename(ROOT) == "program" else ROOT
REPO = "honziksorm/casopisarna"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
APP_FILES = ["index.html", "convert.py", "server.py", "update.py", "VERSION", "requirements.txt"]
KEEP = {"config.json"}  # z balicek/program/ se nepřepisuje
OLD_DEFAULT_BRANDS = {"Knihovnička"}  # výchozí značka starších verzí se vymění, vlastní značka zůstane
OBSOLETE = ["1 Převést časopisy.bat", "2 Spustit čtečku.bat", "3 Aktualizovat.bat"]


def read(path, default=""):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return default


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)) or (0,)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "casopisarna-update", "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=60)


def app_name():
    m = re.search(r"name:\s*'([^']+)'", read(os.path.join(ROOT, "app", "brand", "brand.js")))
    return m.group(1) if m else "Časopisárna"


def requirements(path):
    return sorted(l.strip().lower() for l in read(path).splitlines() if l.strip() and not l.startswith("#"))


def copy_tree(src, dst, skip=()):
    for dirpath, dirnames, filenames in os.walk(src):
        rel = os.path.relpath(dirpath, src)
        dirnames[:] = [d for d in dirnames if os.path.normpath(os.path.join(rel, d)) not in skip]
        os.makedirs(os.path.join(dst, rel), exist_ok=True)
        for name in filenames:
            if os.path.normpath(os.path.join(rel, name)) in skip:
                continue
            shutil.copy2(os.path.join(dirpath, name), os.path.join(dst, rel, name))


def install(src):
    # app/ celé znovu, jen vlastní značka zůstane
    app = os.path.join(ROOT, "app")
    os.makedirs(app, exist_ok=True)
    keep_brand = app_name() not in OLD_DEFAULT_BRANDS and os.path.exists(os.path.join(app, "brand", "brand.js"))
    for name in os.listdir(app):
        if name == "brand" and keep_brand:
            continue
        p = os.path.join(app, name)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    copy_tree(os.path.join(src, "app"), app, skip={"brand"} if keep_brand else ())

    for name in APP_FILES:
        if os.path.exists(os.path.join(src, name)):
            shutil.copy2(os.path.join(src, name), os.path.join(ROOT, name))

    # spouštěče a návod nahoru, licence a ostatní do program/
    bal = os.path.join(src, "balicek")
    for name in os.listdir(bal):
        p = os.path.join(bal, name)
        if name == "program":
            copy_tree(p, ROOT, skip=KEEP)
        elif os.path.isdir(p):
            copy_tree(p, os.path.join(ROOT, name))
        elif name not in KEEP:
            shutil.copy2(p, os.path.join(PKG, name))
    for name in OBSOLETE:
        if os.path.exists(os.path.join(PKG, name)):
            os.remove(os.path.join(PKG, name))
    readme = os.path.join(PKG, "ČTI MĚ.txt")
    if os.path.exists(readme):
        with open(readme, "rb") as f:
            data = f.read()
        with open(readme, "wb") as f:
            f.write(data.replace("Časopisárna".encode(), app_name().encode(), 1))


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if os.path.isdir(os.path.join(ROOT, ".git")):
        sys.exit("Tohle je složka s gitem, aktualizuj ji přes git pull.")

    local = read(os.path.join(ROOT, "VERSION"), "0").strip()
    print(f"{app_name()} {local}, hledám novou verzi...")
    try:
        with get(API) as r:
            rel = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit("Na GitHubu zatím není žádné vydání." if e.code == 404 else f"GitHub odpověděl chybou {e.code}.")
    except OSError as e:
        sys.exit(f"Nepodařilo se spojit s GitHubem ({e}).")

    latest = rel["tag_name"].lstrip("v")
    if version_tuple(latest) <= version_tuple(local) and not args.force:
        print("Máš nejnovější verzi.")
        return
    print(f"Je k dispozici verze {latest}: {rel.get('html_url', '')}")
    if args.check:
        return

    with tempfile.TemporaryDirectory() as tmp:
        zpath = os.path.join(tmp, "release.zip")
        with get(rel["zipball_url"]) as r, open(zpath, "wb") as f:
            shutil.copyfileobj(r, f)
        with zipfile.ZipFile(zpath) as z:
            z.extractall(os.path.join(tmp, "x"))
        top = os.listdir(os.path.join(tmp, "x"))
        src = os.path.join(tmp, "x", top[0])
        if len(top) != 1 or not os.path.exists(os.path.join(src, "convert.py")):
            sys.exit("Stažené vydání nemá očekávaný obsah, nic jsem neměnil.")

        bundled = os.path.join(ROOT, "python", "requirements.txt")
        if os.path.exists(bundled) and requirements(bundled) != requirements(os.path.join(src, "requirements.txt")):
            sys.exit("Nová verze potřebuje novější knihovny Pythonu. Stáhni si celý balíček:\n"
                     + rel.get("html_url", f"https://github.com/{REPO}/releases"))
        install(src)

    print(f"Hotovo, verze {latest}. Jestli čtečka běží, zavři její okno a spusť ji znovu.")


if __name__ == "__main__":
    main()
