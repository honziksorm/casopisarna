"""Lokální server čtečky, obdoba `python -m http.server`.

Navíc nastavuje správné MIME typy (registr ve Windows je umí rozbít), obrázkům stránek
dává dlouhou cache, při obsazeném portu zkusí další a po startu otevře prohlížeč.
Po spuštění na pozadí převede nová čísla a čtečce nabídne výběr složky s časopisy.
Poslouchá jen na tomto počítači, pro tablet v domácí síti: python server.py --lan
(nebo tlačítko Do telefonu ve čtečce, které síť zapne za běhu).
"""
import argparse
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import unicodedata
import urllib.request
import zipfile
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
PORT = 8642
LAN = {"url": None}  # adresa v domácí síti, když je zapnutá
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)  # přibalený Python (embed) složku skriptu do cesty nepřidává
LOCAL = ("127.0.0.1", "::1")

# okna Windows pro výběr složky nebo souborů; začínají ve Stažených souborech, kam lidé skeny stahují
PICK_START = r"""
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dl = (New-Object -ComObject Shell.Application).Namespace('shell:Downloads').Self.Path
if (-not $dl) { $dl = Join-Path $env:USERPROFILE 'Downloads' }
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false}
"""
PICK_FOLDER = PICK_START + r"""
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Vyber složku, kde máš časopisy (PDF, CBZ nebo ZIP)'
$d.ShowNewFolderButton = $false
if (Test-Path $dl) { $d.SelectedPath = $dl }
if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }
"""
PICK_FILES = PICK_START + r"""
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Vyber stažené časopisy (můžeš označit víc souborů najednou)'
$d.Filter = 'Časopisy (PDF, CBZ, ZIP)|*.pdf;*.cbz;*.zip'
$d.Multiselect = $true
if (Test-Path $dl) { $d.InitialDirectory = $dl }
if ($d.ShowDialog($owner) -eq 'OK') { $d.FileNames -join "`n" }
"""


MAKE_SHORTCUT = r"""
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK)
$s.TargetPath = $env:TARGET
$s.WorkingDirectory = $env:WORKDIR
$s.IconLocation = $env:ICON
$s.WindowStyle = 7
$s.Save()
"""


def desktop_dir():
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(260)
        ctypes.windll.shell32.SHGetFolderPathW(None, 0x0010, None, 0, buf)  # plocha, i přesměrovaná do OneDrive
        return buf.value or None
    except Exception:
        return None


def launcher():
    # v balíčku leží spouštěč o složku výš než program/
    for folder in (os.path.dirname(ROOT), ROOT):
        for name in ("Spustit čtečku.bat", "Časopisárna.bat"):
            if os.path.exists(os.path.join(folder, name)):
                return os.path.join(folder, name)
    return None


def shortcut_path():
    desk = desktop_dir()
    return os.path.join(desk, app_name() + ".lnk") if desk else None


def make_shortcut():
    lnk, target = shortcut_path(), launcher()
    if not lnk or not target:
        return {"ok": False}
    icon = next((p for p in (os.path.join(ROOT, "app", "brand", "icon.ico"), os.path.join(ROOT, "app", "icon.ico")) if os.path.exists(p)), "")
    env = {**os.environ, "LNK": lnk, "TARGET": target, "WORKDIR": os.path.dirname(target), "ICON": icon}
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    subprocess.run(["powershell", "-NoProfile", "-Command", MAKE_SHORTCUT], env=env, capture_output=True, creationflags=flags)
    return {"ok": os.path.exists(lnk)}


def read_config():
    path = os.path.join(ROOT, "config.json")
    if not os.path.exists(path):
        path = os.path.join(ROOT, "balicek", "program", "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def has_library(cfg):
    return bool(cfg.get("magazines") or cfg.get("library_dir") or cfg.get("library_dirs") or cfg.get("library_files"))


class Converter:
    """Převod na pozadí (convert.py). Když se mezitím přidá složka, pustí se znovu."""

    def __init__(self):
        self.proc = None
        self.again = False
        self.lock = threading.Lock()

    def start(self):
        with self.lock:
            if self.proc and self.proc.poll() is None:
                self.again = True
                return
            flags = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)  # ať se při převodu dá plynule číst
            self.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "convert.py")], cwd=ROOT, creationflags=flags)
            threading.Thread(target=self._wait, args=(self.proc,), daemon=True).start()

    def _wait(self, proc):
        proc.wait()
        with self.lock:
            again, self.again = self.again, False
        if again:
            self.start()

    def running(self):
        if self.again or (self.proc and self.proc.poll() is None):
            return True
        import convert  # převod spuštěný jinde (Převést nová čísla.bat) drží zámek
        lock = convert.try_lock(os.path.join(DATA, "convert.lock"))
        if lock:
            lock.close()
            return False
        return True


CONVERTER = Converter()


PICK_BRAND = PICK_START + r"""
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = 'Vyber soubor se vzhledem čtečky (ZIP)'
$d.Filter = 'Vzhled čtečky (*.zip)|*.zip'
if (Test-Path $dl) { $d.InitialDirectory = $dl }
if ($d.ShowDialog($owner) -eq 'OK') { $d.FileName }
"""
BRAND_EXT = (".js", ".css", ".svg", ".woff2", ".woff", ".ttf", ".png", ".jpg", ".webp", ".ico", ".txt")


def install_brand(path=None, reset=False):
    """Vzhled (značka) ze ZIPu s brand.js do app/brand; původní se schová do brand-puvodni."""
    brand = os.path.join(ROOT, "app", "brand")
    backup = os.path.join(ROOT, "brand-puvodni")
    if reset:
        if not os.path.isfile(os.path.join(backup, "brand.js")):
            return {"ok": False, "error": "Původní vzhled tu není."}
        shutil.rmtree(brand, ignore_errors=True)
        shutil.copytree(backup, brand, copy_function=shutil.copy)  # nový čas změny, ať prohlížeč nevezme starý vzhled z paměti
        return {"ok": True, "name": app_name()}
    path = path or next(iter(pick(PICK_BRAND)), None)
    if not path:
        return {"ok": False, "cancelled": True}
    try:
        z = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile):
        return {"ok": False, "error": "Tohle není soubor se vzhledem čtečky (čekám ZIP)."}
    with z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        js = [n for n in names if n.rsplit("/", 1)[-1] == "brand.js"]
        if len(js) != 1:
            return {"ok": False, "error": "V souboru chybí brand.js, tohle není vzhled čtečky."}
        prefix = js[0][:-len("brand.js")]
        files = [n for n in names if n.startswith(prefix) and n[len(prefix):].lower().endswith(BRAND_EXT)
                 and ".." not in n[len(prefix):].split("/") and not n[len(prefix):].startswith("/")]
        if sum(z.getinfo(n).file_size for n in files) > 20_000_000:
            return {"ok": False, "error": "Soubor se vzhledem je moc velký."}
        tmp = brand + ".novy"
        shutil.rmtree(tmp, ignore_errors=True)
        for n in files:
            out = os.path.join(tmp, *n[len(prefix):].split("/"))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(n) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
    if not os.path.isdir(backup) and os.path.isfile(os.path.join(brand, "brand.js")):
        shutil.copytree(brand, backup)  # první cizí vzhled: výchozí se zazálohuje
    shutil.rmtree(brand, ignore_errors=True)
    os.replace(tmp, brand)
    return {"ok": True, "name": app_name()}


def pick(script):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script],
                       capture_output=True, encoding="utf-8", errors="replace", creationflags=flags)
    return [p.strip() for p in r.stdout.splitlines() if p.strip()]


def add_library(mode="folder", paths=None):
    """Výběr složky nebo stažených souborů ve čtečce: ověří, že v nich jsou časopisy, uloží a pustí převod."""
    import convert
    files = mode == "files"
    paths = paths or pick(PICK_FILES if files else PICK_FOLDER)
    if not paths:
        return {"ok": False, "cancelled": True}
    paths = [p for p in paths if os.path.isfile(p) or (not files and os.path.isdir(p))]
    if not paths:
        return {"ok": False, "error": "Vybrané soubory nebo složka už na disku nejsou."}
    cands = convert.file_magazines(paths) if files else [m for p in paths for m in convert.discover_magazines(p)]
    cfg = {"magazines": convert.group_magazines(cands, set())}
    issues = len(convert.list_sources(cfg))
    if not issues:
        if cfg["_nested"]:
            return {"ok": False, "error": f"{cfg['_nested'][0]} obsahuje další ZIPy. Rozbal ho jednou (pravým tlačítkem, "
                                          "Extrahovat vše) a vyber rozbalenou složku."}
        what = "vybraných souborech" if files else "téhle složce"
        return {"ok": False, "error": f"Ve {what} jsem nenašel žádné časopisy (PDF, CBZ ani ZIP). Zkus vybrat jiné."}
    convert.save_library(paths, "library_files" if files else "library_dirs")
    CONVERTER.start()
    return {"ok": True, "magazines": [m["title"] for m in cfg["magazines"]], "issues": issues}


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    for _ in range(10):  # Windows nedovolí přepsat soubor, který zrovna někdo čte
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            threading.Event().wait(0.05)


# rozečtené stránky a záložky drží čtečka, ne prohlížeč: platí pro PC i tablet a nezmizí s historií
READER_LOCK = threading.Lock()


def load_reader():
    try:
        with open(os.path.join(DATA, "reader.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_reader(update):
    """Sloučí změny: u každého čísla i u záložek vyhrává novější záznam."""
    with READER_LOCK:
        st = load_reader()
        prog = st.setdefault("progress", {})
        for iid, e in (update.get("progress") or {}).items():
            if isinstance(e, dict) and e.get("t", 0) >= prog.get(iid, {}).get("t", 0):
                prog[iid] = {"page": int(e.get("page", 0)), "max": int(e.get("max", 0)), "t": e.get("t", 0)}
        last = update.get("last")
        if isinstance(last, dict) and last.get("t", 0) >= st.get("last", {}).get("t", 0):
            st["last"] = {"id": str(last.get("id", "")), "t": last.get("t", 0)}
        bm = update.get("bookmarks")
        if isinstance(bm, dict) and bm.get("t", 0) >= st.get("bookmarks", {}).get("t", 0):
            items = [{"id": str(b.get("id", "")), "page": int(b.get("page", 0)), "t": b.get("t", 0)}
                     for b in bm.get("items", []) if isinstance(b, dict)]
            st["bookmarks"] = {"t": bm.get("t", 0), "items": items[:5000]}
        os.makedirs(DATA, exist_ok=True)
        write_json(os.path.join(DATA, "reader.json"), st)
        return st


# hledání v textu: bez diakritiky a velikosti písmen, délka textu zůstává (kvůli úryvkům)
FOLD = str.maketrans({c: unicodedata.normalize("NFD", c)[0] for c in map(chr, range(0xC0, 0x250))
                      if len(unicodedata.normalize("NFD", c)) > 1})


def fold(s):
    return s.lower().translate(FOLD)


TEXT = {"key": None, "manifest": None, "pages": {}}
SOURCES = {"key": None, "map": {}}
PDF_LOCK = threading.Lock()


def text_index():
    """Manifest a text stránek všech čísel, načtené jednou a obnovené po změně manifestu."""
    path = os.path.join(DATA, "manifest.json")
    try:
        key = os.path.getmtime(path)
    except OSError:
        return None, {}
    if TEXT["key"] != key:
        with open(path, encoding="utf-8") as f:
            manifest = json.load(f)
        pages = {}
        for issue in manifest.get("issues", []):
            try:
                with open(os.path.join(DATA, "issues", issue["id"], "text.json"), encoding="utf-8") as f:
                    src = json.load(f).get("src", [])
            except (OSError, ValueError):
                continue
            if any(src):
                pages[issue["id"]] = [(t, fold(t)) for t in src]
        TEXT.update(key=key, manifest=manifest, pages=pages)
    return TEXT["manifest"], TEXT["pages"]


def search(q, limit=400):
    manifest, pages = text_index()
    terms = [t for t in fold(q).split() if len(t) >= 2]
    if not manifest or not terms:
        return {"hits": [], "searchable": len(pages)}
    phrase = " ".join(terms) if len(terms) > 1 else None
    hits = []
    for order, issue in enumerate(manifest["issues"]):
        src = pages.get(issue["id"])
        if not src:
            continue
        seen = set()
        for i, p in enumerate(issue["pages"]):
            s = p.get("src", i + 1) - 1
            if s in seen or s >= len(src):
                continue
            seen.add(s)
            raw, low = src[s]
            if not all(t in low for t in terms):
                continue
            exact = bool(phrase) and phrase in low  # víc slov: stránky s celou frází první
            key = phrase if exact else terms[0]
            pos = low.find(key)
            a, b = max(0, pos - 70), min(len(raw), pos + len(key) + 110)
            a = raw.rfind(" ", 0, a) + 1 if a else 0  # úryvek od začátku slova
            part = low[a:b]
            marks = sorted([m.start(), m.end()] for t in ([phrase] if exact else terms) for m in re.finditer(re.escape(t), part))
            hits.append({"id": issue["id"], "page": i, "text": raw[a:b], "marks": marks, "cut": [a > 0, b < len(raw)],
                         "_rank": (0 if exact or not phrase else 1, order, i)})
    hits.sort(key=lambda h: h["_rank"])
    for h in hits:
        del h["_rank"]
    more = len(hits) > limit
    return {"hits": hits[:limit], "more": more, "searchable": len(pages)}


def page_hits(iid, page, q):
    """Obdélníky nalezených slov na stránce (0–1 vůči obrázku stránky) pro zvýraznění v lupě."""
    import convert
    manifest, _ = text_index()
    terms = [t for t in fold(q).split() if len(t) >= 2]
    issue = next((i for i in (manifest or {}).get("issues", []) if i["id"] == iid), None)
    if not issue or not terms or not 0 <= page < len(issue["pages"]):
        return []
    p = issue["pages"][page]
    try:
        key = os.path.getmtime(convert.config_path())
    except OSError:
        key = None
    with PDF_LOCK:
        if SOURCES["key"] != key or iid not in SOURCES["map"]:
            SOURCES.update(key=key, map=convert.list_sources(convert.load_config()))
        src = SOURCES["map"].get(iid)
        if not src or src["spec"][0] not in ("pdf", "zpdf"):
            return []
        kind, doc = convert.open_source(src["spec"])
        pg = doc[p.get("src", page + 1) - 1]
        W, H = pg.rect.width, pg.rect.height
        words = pg.get_text("words")
        folded = [fold(w[4]) for w in words]
        pick = set()
        if len(terms) > 1:  # víc slov: jen celá fráze, slova za sebou
            for k in range(len(words) - len(terms) + 1):
                if all(terms[j] in folded[k + j] for j in range(len(terms))):
                    pick.update(range(k, k + len(terms)))
        if not pick:
            pick = {k for k, f in enumerate(folded) if any(t in f for t in terms)}
        rects = []
        for k in sorted(pick):
            r = convert.pymupdf.Rect(words[k][:4]) * pg.rotation_matrix
            x, y, rw, rh = r.x0 / W, r.y0 / H, r.width / W, r.height / H
            if p.get("part") == "L":
                x, rw = x * 2, rw * 2
            elif p.get("part") == "R":
                x, rw = x * 2 - 1, rw * 2
            if x + rw > 0 and x < 1:
                rects.append([round(x, 4), round(y, 4), round(rw, 4), round(rh, 4)])
    return rects[:300]


MONTHS = ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"]
TRIP_H = 1600  # výška stránky v souboru na cestu, na telefonu jde ještě dobře zvětšit
CBZ_LOCK = threading.Lock()


def comic_info(issue, series):
    """ComicInfo.xml: čtečky komiksů z něj berou název, číslo a datum."""
    from xml.sax.saxutils import escape
    m = re.match(r"(\S+)\s+(\d{4})$", issue.get("date") or "")
    month = MONTHS.index(m.group(1).lower()) + 1 if m and m.group(1).lower() in MONTHS else None
    fields = [("Title", issue.get("title")), ("Series", series), ("Number", issue.get("number")),
              ("Year", issue.get("year")), ("Month", month), ("PageCount", len(issue["pages"])), ("LanguageISO", "cs")]
    body = "".join(f"  <{k}>{escape(str(v))}</{k}>\n" for k, v in fields if v not in (None, ""))
    return f'<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n{body}</ComicInfo>\n'


def trip_cbz(iid):
    """Číslo jako CBZ na cestu (JPEG do 1600 px, čte ho každá čtečka komiksů). Hotové leží v data/cbz/."""
    with open(os.path.join(DATA, "manifest.json"), encoding="utf-8") as f:
        man = json.load(f)
    issue = next((i for i in man["issues"] if i["id"] == iid), None)
    if not issue:
        return None, None
    series = next((m.get("title") for m in man.get("magazines", []) if m.get("id") == issue.get("magazine")), None)
    src = os.path.join(DATA, "issues", iid)
    out = os.path.join(DATA, "cbz", iid + ".cbz")
    name = issue.get("title") or iid
    with CBZ_LOCK:
        if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(os.path.join(src, "issue.json")):
            return out, name
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tmp = out + ".tmp"
        try:
            write_cbz(tmp, src, issue, series)
        except Exception:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise
        os.replace(tmp, out)
    return out, name


def write_cbz(tmp, src, issue, series):
    from PIL import Image
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:  # JPEG se už víc nezmenší
        for n, page in enumerate(issue["pages"], 1):
            view = os.path.join(src, "view", page["f"] + ".webp")
            path = view if not page.get("nv") and os.path.exists(view) else os.path.join(src, "full", page["f"] + ".jpg")
            arc = f"{n:03d}.jpg"
            with Image.open(path) as im:
                if path.endswith(".jpg") and im.height <= TRIP_H * 1.15:
                    z.write(path, arc)  # malý sken jde beze změny
                    continue
                im = im.convert("RGB")
                if im.height > TRIP_H:
                    im = im.resize((round(im.width * TRIP_H / im.height), TRIP_H), Image.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=82, optimize=True)
                z.writestr(arc, buf.getvalue())
        z.writestr("ComicInfo.xml", comic_info(issue, series))


def saved_size(iid):
    """Kolik místa zabere číslo uložené v telefonu (stránky na listování a náhledy)."""
    with open(os.path.join(DATA, "manifest.json"), encoding="utf-8") as f:
        issue = next((i for i in json.load(f)["issues"] if i["id"] == iid), None)
    if not issue:
        return 0
    src = os.path.join(DATA, "issues", iid)
    total = 0
    for p in issue["pages"]:
        for path in (os.path.join(src, "full", p["f"] + ".jpg") if p.get("nv") else os.path.join(src, "view", p["f"] + ".webp"),
                     os.path.join(src, "thumb", p["f"] + ".webp")):
            total += os.path.getsize(path) if os.path.exists(path) else 0
    return total


def start_lan():
    """Zpřístupní čtečku v domácí síti za běhu (druhý server na adrese počítače)."""
    if LAN["url"]:
        return {"ok": True, "url": LAN["url"]}
    ip = lan_ip()
    if not ip:
        return {"ok": False, "error": "Počítač teď není připojený k žádné síti."}
    try:
        srv = ThreadingHTTPServer((ip, PORT), partial(Handler, directory=ROOT))
    except OSError as e:
        return {"ok": False, "error": f"Síť se nepodařilo zapnout: {e}"}
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    LAN["url"] = f"http://{ip}:{PORT}/"
    print(f"Čtečka je teď i v domácí síti: {LAN['url']}")
    return {"ok": True, "url": LAN["url"]}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".webp": "image/webp",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json",
    }

    def local(self):
        # výběr složky jen z tohoto počítače; vlastní hlavička nejde poslat z cizí stránky bez CORS
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return self.client_address[0] in LOCAL and host in ("127.0.0.1", "localhost", "::1")

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_download(self, path, filename):
        plain = unicodedata.normalize("NFD", filename).encode("ascii", "ignore").decode()
        plain = re.sub(r"[^A-Za-z0-9._-]+", "_", plain).strip("_") or "casopis.cbz"
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.comicbook+zip")
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.send_header("Content-Disposition", f"attachment; filename=\"{plain}\"; filename*=UTF-8''{quote(filename)}")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/status":
            try:
                with open(os.path.join(DATA, "status.json"), encoding="utf-8") as f:
                    status = json.load(f)
            except (OSError, ValueError):
                status = {}
            lnk = shortcut_path()
            return self.send_json({**status, "running": CONVERTER.running(),
                                   "library": has_library(read_config()), "can_pick": self.local(),
                                   "can_shortcut": bool(self.local() and lnk and launcher()),
                                   "shortcut": bool(lnk and os.path.exists(lnk)),
                                   "custom_brand": os.path.isfile(os.path.join(ROOT, "brand-puvodni", "brand.js")),
                                   "lan": LAN["url"]})
        url = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/reader":
                return self.send_json(load_reader())
            if url.path == "/api/search":
                return self.send_json(search(qs.get("q", "")))
            if url.path == "/api/hits":
                return self.send_json(page_hits(qs.get("id", ""), int(qs.get("page", -1)), qs.get("q", "")))
            if url.path == "/api/cbz":
                path, name = trip_cbz(qs.get("id", ""))
                return self.send_download(path, name + ".cbz") if path else self.send_error(404)
            if url.path == "/api/size":
                return self.send_json({"bytes": saved_size(qs.get("id", ""))})
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        return super().do_GET()

    def do_POST(self):
        if self.path not in ("/api/library", "/api/shortcut", "/api/reader", "/api/brand", "/api/lan"):
            return self.send_error(404)
        # rozečtení ukládá i tablet v domácí síti, výběr složek a plochu jen tento počítač
        if self.headers.get("X-Reader") != "1" or (self.path != "/api/reader" and not self.local()):
            return self.send_error(403)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if self.path == "/api/reader":
                return self.send_json(save_reader(body))
            if self.path == "/api/brand":
                return self.send_json(install_brand(body.get("path"), bool(body.get("reset"))))
            if self.path == "/api/lan":
                return self.send_json(start_lan())
            self.send_json(make_shortcut() if self.path == "/api/shortcut" else add_library(body.get("mode", "folder"), body.get("paths")))
        except Exception as e:
            self.send_json({"ok": False, "error": f"Něco se nepovedlo: {e}"}, 500)

    def send_head(self):
        # skryté soubory a složky (.git apod.) se neposílají
        if any(p.startswith(".") for p in self.path.split("?", 1)[0].split("/")):
            self.send_error(404)
            return None
        return super().send_head()

    def translate_path(self, path):
        # service worker a manifest leží v app/ (aktualizace ji přenáší celou), prohlížeč je chce z kořene
        if path.split("?", 1)[0].split("#", 1)[0] in ("/sw.js", "/manifest.webmanifest"):
            path = "/app" + path
        # převedená data můžou ležet mimo složku čtečky ("output_dir" v config.json)
        full = super().translate_path(path)
        default = os.path.join(ROOT, "data")
        if DATA != default and (full == default or full.startswith(default + os.sep)):
            full = DATA + full[len(default):]
        return full

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        cache = "public, max-age=604800" if path.startswith("/data/issues/") else "no-cache"
        self.send_header("Cache-Control", cache)
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def app_name():
    try:
        with open(os.path.join(ROOT, "app", "brand", "brand.js"), encoding="utf-8") as f:
            m = re.search(r"name:\s*'([^']+)'", f.read())
        return m.group(1) if m else "Čtečka"
    except OSError:
        return "Čtečka"


def version():
    try:
        with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def already_running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/app/brand/brand.js", timeout=1.5) as r:
            return "window.BRAND" in r.read(2000).decode("utf-8", "replace")
    except Exception:
        return False


def free_port(host, start):
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                pass
    sys.exit("Nenašel jsem volný port.")


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.168.0.1", 9))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    global DATA, PORT
    cfg = read_config()
    DATA = os.path.normpath(os.path.join(ROOT, cfg.get("output_dir", "data")))

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=cfg.get("port", 8642))
    ap.add_argument("--lan", action="store_true", help="zpřístupnit v domácí síti")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-convert", action="store_true", help="po startu nehledat nová čísla")
    args = ap.parse_args()

    if already_running(args.port):
        url = f"http://127.0.0.1:{args.port}/"
        print(f"Čtečka už běží na {url}, jen ji otevírám.")
        if not args.no_browser:
            webbrowser.open(url)
        return

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    port = free_port(host, args.port)
    if port != args.port:
        print(f"Port {args.port} je obsazený, používám {port}. Rozečtené stránky se pamatují pro každý port zvlášť.")
    httpd = ThreadingHTTPServer((host, port), partial(Handler, directory=ROOT))
    PORT = port
    if args.lan and lan_ip():
        LAN["url"] = f"http://{lan_ip()}:{port}/"
    url = f"http://127.0.0.1:{port}/"
    name = app_name()
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW(name)
        except Exception:
            pass
    print(f"{name} {version()} běží na {url}")
    if args.lan and lan_ip():
        print(f"V domácí síti: http://{lan_ip()}:{port}/")
    print("Tohle okno nech otevřené, dokud čteš. Zavřením čtečku vypneš.\n")
    if has_library(cfg) and not args.no_convert:
        CONVERTER.start()
    threading.Thread(target=text_index, daemon=True).start()  # první hledání pak nečeká na načtení textu
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
