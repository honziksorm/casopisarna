"""Převod naskenovaných časopisů na obrázky pro čtečku.

Zdroje se jen čtou. config.json obsahuje "library_dirs" (složky vybrané ve čtečce: složka
se soubory je jeden časopis, jinak je časopisem každá podsložka), nebo seznam "magazines"
s druhem zdroje:

    folder     složka s PDF / CBZ / ZIP, číslo a datum se čtou z názvu souboru
    pdf-dir    složka s PDF ve tvaru Excalibur_50.pdf
    zip-years  ZIPy po ročnících s CBZ/PDF uvnitř (Score z archive.org)

Pro každou stránku vznikne full/NNN.jpg (lupa, původní JPEG když to jde), view/NNN.webp
(listování, u malých skenů se nedělá) a thumb/NNN.webp (náhled). Hotová čísla se přeskakují.

    python convert.py                  # vše
    python convert.py Score_013 ...    # jen vybraná čísla
    python convert.py --magazine score
    python convert.py --force ...
"""
import argparse
import io
import json
import os
import re
import shutil
import statistics
import sys
import time
import unicodedata
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed

import pymupdf
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
FORMAT_VERSION = 1
SPREAD_FACTOR = 1.25  # o čtvrtinu širší stránka než medián čísla = dvoustrana
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff")

MONTHS = {
    "LEDEN": 1, "ÚNOR": 2, "BŘEZEN": 3, "DUBEN": 4, "KVĚTEN": 5, "ČERVENEC": 7,
    "ČERVEN": 6, "SRPEN": 8, "ZÁŘÍ": 9, "ŘÍJEN": 10, "LISTOPAD": 11, "PROSINEC": 12,
}
MONTH_NAMES = ["", "leden", "únor", "březen", "duben", "květen", "červen", "červenec",
               "srpen", "září", "říjen", "listopad", "prosinec"]


def log(msg):
    print(msg, flush=True)


def ascii_lower(s):
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", ascii_lower(s)).strip("-") or "x"


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def config_path():
    p = os.path.join(ROOT, "config.json")
    return p if os.path.exists(p) else os.path.join(ROOT, "balicek", "program", "config.json")


SOURCE_EXT = (".pdf", ".cbz", ".zip")


def library_paths(cfg, key):
    """Vybrané složky (library_dirs) nebo soubory (library_files) z configu."""
    items = list(cfg.get(key) or [])
    if key == "library_dirs" and cfg.get("library_dir"):
        items.insert(0, cfg["library_dir"])
    return [os.path.normpath(os.path.join(ROOT, d)) for d in items]


def source_files(path, limit=None):
    if os.path.isfile(path):
        return [path] if path.lower().endswith(SOURCE_EXT) else []
    out = []
    for dirpath, _, files in os.walk(path):
        out += [os.path.join(dirpath, f) for f in files if f.lower().endswith(SOURCE_EXT)]
        if limit and len(out) >= limit:
            break
    return out


def name_stems(path):
    """Názvy čísel v souboru: u ZIPu s PDF/CBZ uvnitř jejich jména, jinak jméno souboru."""
    stem = os.path.splitext(os.path.basename(path))[0]
    if path.lower().endswith(".zip"):
        try:
            with zipfile.ZipFile(path) as z:
                inner = [os.path.splitext(n.rsplit("/", 1)[-1])[0] for n in z.namelist() if n.lower().endswith((".pdf", ".cbz"))]
            return inner or [stem]
        except (OSError, zipfile.BadZipFile):
            return [stem]
    return [stem]


def magazine_title(paths, fallback):
    """Název časopisu podle nejčastější předpony čísel (Excalibur_50.pdf -> Excalibur)."""
    prefixes = []
    for path in paths[:300]:
        for stem in name_stems(path)[:50]:
            # slova před prvním číslem: "PSM2_01_2002-02" -> PSM2, "Počítačové hry 05" -> Počítačové hry
            words = re.split(r"[\s_]+", re.sub(r"[-(](?=\d)", " ", stem).strip())
            k = next((i for i, w in enumerate(words) if w[:1].isdigit()), None)
            prefix = " ".join(words[:k]).strip(" -.") if k else ""
            if len(prefix) > 1:
                prefixes.append(prefix)
    if prefixes:
        best = max(set(p.lower() for p in prefixes), key=lambda p: sum(x.lower() == p for x in prefixes))
        if sum(x.lower() == best for x in prefixes) * 2 >= len(prefixes):
            return next(x for x in prefixes if x.lower() == best)
    return fallback


def discover_magazines(lib):
    """Složka se soubory je jeden časopis, jinak je časopisem každá její podsložka."""
    if not os.path.isdir(lib):
        return []
    direct = [f for f in os.listdir(lib) if f.lower().endswith(SOURCE_EXT) and os.path.isfile(os.path.join(lib, f))]
    if direct:
        folders = [lib]
    else:
        folders = [os.path.join(lib, d) for d in sorted(os.listdir(lib), key=natural_key)
                   if os.path.isdir(os.path.join(lib, d)) and source_files(os.path.join(lib, d), 1)]
    return [{"title": magazine_title(source_files(f, 300), os.path.basename(os.path.normpath(f))), "source": f} for f in folders]


def file_magazines(files):
    """Jednotlivě vybrané soubory patří k časopisu podle svého názvu."""
    return [{"title": magazine_title([f], os.path.splitext(os.path.basename(f))[0]), "source": f}
            for f in files if os.path.isfile(f)]


def group_magazines(candidates, used):
    """Složky a soubory se stejným názvem časopisu jsou jeden časopis."""
    groups = {}
    for c in candidates:
        g = groups.setdefault(c["title"].lower(), {"title": c["title"], "kind": "folder", "sources": []})
        g["sources"].append(c["source"])
    mags = []
    for g in groups.values():
        base = mid = slugify(g["title"])
        k = 2
        while mid in used:
            mid, k = f"{base}-{k}", k + 1
        used.add(mid)
        mags.append({"id": mid, **g, "source_dir": g["sources"][0]})
    return mags


def load_config():
    with open(config_path(), encoding="utf-8") as f:
        cfg = json.load(f)
    cfg.setdefault("output_dir", "data")
    cfg.setdefault("include", [])
    cfg.setdefault("view_height", 1600)
    cfg.setdefault("view_quality", 82)
    cfg.setdefault("thumb_height", 400)
    cfg.setdefault("thumb_quality", 75)
    cfg.setdefault("min_pages", 4)
    cfg["output_dir"] = os.path.join(ROOT, cfg["output_dir"])
    mags = cfg.setdefault("magazines", [])
    candidates = [m for lib in library_paths(cfg, "library_dirs") for m in discover_magazines(lib)]
    candidates += file_magazines(library_paths(cfg, "library_files"))
    mags += group_magazines(candidates, {m["id"] for m in mags})
    return cfg


def save_library(paths, key="library_dirs"):
    """Přidá vybrané složky (library_dirs) nebo soubory (library_files) do config.json."""
    with open(config_path(), encoding="utf-8") as f:
        raw = json.load(f)
    known = set(library_paths(raw, key))
    for p in paths:
        p = os.path.normpath(os.path.abspath(p))
        if p not in known:
            raw.setdefault(key, []).append(p)
            known.add(p)
    with open(os.path.join(ROOT, "config.json"), "w", encoding="utf-8") as f:
        json.dump(raw, f, ensure_ascii=False, indent=2)


def try_lock(path):
    """Zámek proti dvěma převodům najednou. Vrací otevřený soubor, nebo None, když je zamčeno."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    f = open(path, "a+")
    try:
        if os.name == "nt":
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return f
    except OSError:
        f.close()
        return None


def replace_file(src, dst, tries=10):
    """os.replace, který počká, když soubor zrovna čte server (Windows ho pak nedovolí přepsat)."""
    for attempt in range(tries):
        try:
            os.replace(src, dst)
            return True
        except PermissionError:
            if attempt == tries - 1:
                return False
            time.sleep(0.05)


def write_status(cfg, **status):
    path = os.path.join(cfg["output_dir"], "status.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({**status, "t": round(time.time(), 1)}, f, ensure_ascii=False)
    replace_file(path + ".tmp", path)  # průběh není důležitý, když to nevyjde, zapíše se příště


# zdroje

def excalibur_meta(stem):
    m = re.fullmatch(r"Excalibur_(\d+)(plus)?", stem, re.I)
    if m:
        num, plus = int(m.group(1)), bool(m.group(2))
        return {"title": f"Excalibur {num}" + (" Plus" if plus else ""),
                "number": f"{num}" + ("+" if plus else ""), "sort": [num, 1 if plus else 0]}
    if stem.lower() == "excalibur_classic":
        return {"title": "Excalibur Classic", "number": "Classic", "sort": [10000, 0]}
    return {"title": stem.replace("_", " "), "number": stem, "sort": [20000, 0]}


_DATE_MY = re.compile(r"(?<!\d)(\d{1,2})\s*[-_./]\s*((?:19|20)\d{2})(?!\d)")
_DATE_YM = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*[-_./\s]\s*(\d{1,2})(?!\d)")
_YEAR = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
_NUMBER = re.compile(r"(?<![\d.])(\d{1,4})(?!\d)\s*(plus|\+)?", re.I)


def meta_from_name(stem, magazine):
    """Číslo a datum z názvu souboru: "Score 013 (01-1995)", "Excalibur_19plus", "Level_1997_03"."""
    s = stem.replace("_", " ")
    year = month = None
    for rx, month_first in ((_DATE_MY, True), (_DATE_YM, False)):
        m = rx.search(s)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            mo, yr = (a, b) if month_first else (b, a)
            if 1 <= mo <= 12:
                year, month = yr, mo
                s = s[:m.start()] + " " + s[m.end():]
                break
    if year is None:
        m = _YEAR.search(s)
        if m:
            year = int(m.group(1))
            s = s[:m.start()] + " " + s[m.end():]

    rest = re.sub(re.escape(magazine), " ", s, flags=re.I)
    m = _NUMBER.search(rest)
    if m:
        num, plus = int(m.group(1)), bool(m.group(2))
        number = f"{num}{'+' if plus else ''}"
        sort = [num, 1 if plus else 0]
    elif month:
        number = f"{month}/{year}"
        sort = [year * 100 + month, 0]
    else:
        number = re.sub(r"[\s()\[\]-]+", " ", rest).strip() or (str(year) if year else stem)
        sort = [year * 100, 0] if year else [100000, 0]
    meta = {"title": f"{magazine} {number}", "number": number, "sort": sort}
    if year:
        meta.update(year=year, date_exact=bool(month), date_from_name=True,
                    date=f"{MONTH_NAMES[month]} {year}" if month else str(year))
    return meta


_VARIANT = re.compile(r"[\s_-]*(\d{3,4}\s*dpi|jp2)$", re.I)
_ZIP_ISSUE = re.compile(r"(?P<mag>[A-Za-z]+)\s+(?P<num>\d{1,4})\s*\((?P<mo>\d{1,2})-(?P<yr>\d{4})\)\s*\.(?P<ext>cbz|pdf|zip)$", re.I)


def file_fp(path):
    st = os.stat(path)
    return f"{st.st_size}:{int(st.st_mtime)}"


def list_sources(cfg):
    """Všechna dostupná čísla: {id: source}. source["spec"] říká, jak zdroj otevřít."""
    out = {}
    nested = cfg.setdefault("_nested", [])  # ZIPy s dalšími ZIPy uvnitř je potřeba jednou rozbalit
    for mag in cfg["magazines"]:
        src = mag["source_dir"]
        if not os.path.exists(src):
            log(f"! Časopis {mag['title']} už na disku není: {src}")
            continue
        exclude = set(mag.get("exclude", []))
        kind = mag.get("kind", "folder")

        def add(iid, spec, fp, name, meta, legacy=None):
            if iid not in exclude:
                out[iid] = {"id": iid, "magazine": mag["id"], "spec": spec, "fp": fp,
                            "name": name, "meta": meta, "legacy": legacy}

        if kind == "pdf-dir":
            for name in sorted(os.listdir(src), key=natural_key):
                stem, ext = os.path.splitext(name)
                if ext.lower() == ".pdf":
                    path = os.path.join(src, name)
                    st = os.stat(path)
                    add(stem, ("pdf", path, None), file_fp(path), name, excalibur_meta(stem),
                        legacy=(st.st_size, int(st.st_mtime)))

        elif kind == "zip-years":
            for zp in sorted(f for f in os.listdir(src) if f.lower().endswith(".zip")):
                zp = os.path.join(src, zp)
                with zipfile.ZipFile(zp) as z:
                    for info in z.infolist():
                        base = info.filename.rsplit("/", 1)[-1]
                        m = _ZIP_ISSUE.match(base)
                        if info.is_dir() or not m:
                            continue
                        num, mo, yr = int(m["num"]), int(m["mo"]), int(m["yr"])
                        meta = {"title": f"{mag['title']} {num}", "number": str(num), "sort": [num, 0],
                                "date": f"{MONTH_NAMES[mo]} {yr}" if 1 <= mo <= 12 else str(yr),
                                "year": yr, "date_exact": True, "date_from_name": True}
                        spec = ("cbz" if m["ext"].lower() in ("cbz", "zip") else "zpdf", zp, info.filename)
                        fp = f"{os.path.basename(zp)}:{info.filename}:{info.file_size}:{info.CRC}"
                        add(f"{mag['title']}_{num:03d}", spec, fp, base, meta)

        else:  # folder
            def issue_id(stem):
                short = re.sub(re.escape(mag["title"]), " ", stem, flags=re.I)
                return f"{mag['id']}-{slugify(short) if slugify(short) != 'x' else slugify(stem)}"

            def walk(root):  # vybraná složka, nebo jednotlivě vybraný soubor
                if os.path.isfile(root):
                    yield os.path.dirname(root), [os.path.basename(root)]
                else:
                    for dirpath, _, files in os.walk(root):
                        yield dirpath, files

            def base(stem):  # "X_600dpi.pdf" nebo "X_jp2" je jen jiná verze téhož čísla
                return _VARIANT.sub("", re.sub(r"\.(pdf|cbz)$", "", stem, flags=re.I))

            def add_once(iid, *rest):  # stejné číslo ve dvou verzích: první vyhrává (PDF před .pdf.zip)
                if iid not in out:
                    add(iid, *rest)

            for root in mag.get("sources") or [src]:
                for dirpath, files in walk(root):
                    for name in sorted(files, key=natural_key):
                        path = os.path.join(dirpath, name)
                        stem, ext = os.path.splitext(name)
                        stem, ext = base(stem), ext.lower()
                        iid = issue_id(stem)
                        if ext == ".pdf":
                            add_once(iid, ("pdf", path, None), file_fp(path), name, meta_from_name(stem, mag["title"]))
                        elif ext == ".cbz":
                            add_once(iid, ("cbzfile", path, None), file_fp(path), name, meta_from_name(stem, mag["title"]))
                        elif ext == ".zip":
                            try:
                                with zipfile.ZipFile(path) as z:
                                    members = [i for i in z.infolist() if not i.is_dir()]
                            except (OSError, zipfile.BadZipFile):
                                log(f"! {name} není čitelný ZIP")
                                continue
                            issues = [i for i in members if i.filename.lower().endswith((".pdf", ".cbz"))]
                            for info in issues:
                                inner = base(os.path.splitext(info.filename.rsplit("/", 1)[-1])[0])
                                spec = ("zpdf" if info.filename.lower().endswith(".pdf") else "cbz", path, info.filename)
                                fp = f"{name}:{info.filename}:{info.file_size}:{info.CRC}"
                                add_once(issue_id(inner), spec, fp, inner, meta_from_name(inner, mag["title"]))
                            if not issues and any(i.filename.lower().endswith(IMAGE_EXT) for i in members):
                                add_once(iid, ("cbzfile", path, None), file_fp(path), name, meta_from_name(stem, mag["title"]))
                            elif not issues and any(i.filename.lower().endswith(".zip") for i in members):
                                nested.append(name)
    return out


# otevírání zdroje (i v podprocesech)

_cache = {"key": None, "obj": None}


def open_source(spec):
    """("pdf", Document) nebo ("cbz", (ZipFile, jména obrázků)). Každý proces drží jen poslední zdroj."""
    if _cache["key"] == spec:
        return _cache["obj"]
    old = _cache["obj"]
    if old and old[0] == "pdf":
        old[1].close()
    kind, path, member = spec
    if kind == "pdf":
        obj = ("pdf", pymupdf.open(path))
    elif kind == "cbzfile":
        z = zipfile.ZipFile(path)
        obj = ("cbz", (z, image_names(z)))
    else:
        with zipfile.ZipFile(path) as z:
            data = z.read(member)
        if kind == "zpdf":
            obj = ("pdf", pymupdf.open(stream=data, filetype="pdf"))
        else:
            inner = zipfile.ZipFile(io.BytesIO(data))
            obj = ("cbz", (inner, image_names(inner)))
    _cache["key"], _cache["obj"] = spec, obj
    return obj


def extract_text(spec, out_dir):
    """Text stránek pro hledání (text.json, seznam po stránkách zdroje). Skeny bez textové vrstvy dají prázdné stránky."""
    kind, src = open_source(spec)
    texts = []
    if kind == "pdf":
        for page in src:
            t = re.sub(r"(\w)-[ \t]*\n\s*(\w)", r"\1\2", page.get_text())  # slova rozdělená na konci řádku
            texts.append(" ".join(t.split()))
    with open(os.path.join(out_dir, "text.json"), "w", encoding="utf-8") as f:
        json.dump({"src": texts}, f, ensure_ascii=False)


def image_names(z):
    names = [n for n in z.namelist() if n.lower().endswith(IMAGE_EXT) and "__MACOSX" not in n]
    return sorted(names, key=natural_key)


def page_ratios(spec):
    kind, src = open_source(spec)
    if kind == "pdf":
        return [p.rect.width / p.rect.height for p in src]
    z, names = src
    ratios = []
    for n in names:
        with Image.open(io.BytesIO(z.read(n))) as im:
            ratios.append(im.width / im.height)
    return ratios


# odhad data vydání z textu stránek

_MON_ASCII = {ascii_lower(k): v for k, v in MONTHS.items()}
_PAT_WORD = re.compile(
    r"\b(" + "|".join(sorted(_MON_ASCII, key=len, reverse=True)) + r")\s*[/–-]?\s*(?:(?:"
    + "|".join(_MON_ASCII) + r")\s*)?['’`´]?\s*((?:19|20)?\d{2})\b")
_PAT_NUM = re.compile(r"(?<![\d/.,])(\d{1,2})\s*/\s*(9\d|0\d)(?![\d/])")


def date_votes(spec, pages=6):
    """Kandidáti na datum z textové vrstvy prvních stran: [[rok, měsíc, váha], ...].
    "září 1992" má váhu 3, "2/92" váhu 1. Bývají tam i zmínky jiných dat, proto se
    vybírá až napříč čísly v estimate_dates()."""
    kind, doc = open_source(spec)
    if kind != "pdf":
        return []
    votes = {}
    for pg in range(min(pages, doc.page_count)):
        try:
            text = ascii_lower(" ".join(doc[pg].get_text("text").split()))
        except Exception:
            continue
        for m in _PAT_WORD.finditer(text):
            y = int(m.group(2))
            y = y + (1900 if y >= 80 else 2000) if y < 100 else y
            if 1989 <= y <= 2005:
                key = (y, _MON_ASCII[m.group(1)])
                votes[key] = votes.get(key, 0) + 3
        for m in _PAT_NUM.finditer(text):
            mo, y = int(m.group(1)), int(m.group(2))
            y += 1900 if y >= 80 else 2000
            if 1 <= mo <= 12 and 1989 <= y <= 2005:
                votes[(y, mo)] = votes.get((y, mo), 0) + 1
    best = sorted(votes.items(), key=lambda kv: -kv[1])[:5]
    return [[y, mo, w] for (y, mo), w in best]


def estimate_dates(issues):
    """Kotvy = nejdelší posloupnost kandidátů, která roste s číslem časopisu; zbytek se dopočítá."""
    regular = sorted((i for i in issues if re.fullmatch(r"\d+", str(i.get("number", "")))),
                     key=lambda i: int(i["number"]))
    cand = []
    for i in regular:
        v = i.get("date_votes") or []
        cand.append(v[0][0] * 12 + v[0][1] - 1 if v else None)
    idx = [k for k, t in enumerate(cand) if t is not None]
    best_len, prev = {}, {}
    for a in idx:
        best_len[a], prev[a] = 1, None
        for b in idx:
            if b >= a:
                break
            if cand[b] < cand[a] and best_len[b] + 1 > best_len[a]:
                best_len[a], prev[a] = best_len[b] + 1, b
    anchors = []
    if best_len:
        k = max(best_len, key=lambda a: (best_len[a], a))
        while k is not None:
            anchors.append(k)
            k = prev[k]
        anchors.reverse()

    num = [int(i["number"]) for i in regular]
    for k, issue in enumerate(regular):
        if k in anchors:
            t = cand[k]
        elif not anchors:
            t = None
        else:
            before = [a for a in anchors if a < k]
            after = [a for a in anchors if a > k]
            if before and after:
                a, b = before[-1], after[0]
                t = cand[a] + (cand[b] - cand[a]) * (num[k] - num[a]) / (num[b] - num[a])
            elif before:
                t = cand[before[-1]] + (num[k] - num[before[-1]])
            else:
                t = cand[after[0]] - (num[after[0]] - num[k])
        if t is None:
            issue.update(date=None, year=None, date_exact=False)
            continue
        y, mo = divmod(int(round(t)), 12)
        exact = k in anchors
        issue.update(year=y, date_exact=exact, date=f"{MONTH_NAMES[mo + 1]} {y}" if exact else f"≈ {y}")

    by_num = {i["number"]: i for i in regular}
    for i in issues:
        m = re.fullmatch(r"(\d+)\+", str(i.get("number", "")))
        if m and m.group(1) in by_num:
            year = by_num[m.group(1)].get("year")
            i.update(year=year, date_exact=False, date=f"≈ {year}" if year else None)
        elif i not in regular:
            i.setdefault("year", None)
            i.setdefault("date_exact", False)
            if not i.get("date_exact"):
                i["date"] = None


# jedna stránka (v podprocesu)

def lossless_jpeg(doc, page):
    """Původní JPEG, pokud je stránka jeden JPEG přes celou plochu, jinak None."""
    if page.rotation:
        return None
    infos = page.get_image_info(xrefs=True)
    if len(infos) != 1 or not infos[0].get("xref"):
        return None
    info = infos[0]
    a, b, c, d, _, _ = info["transform"]
    if abs(b) > 1e-3 or abs(c) > 1e-3 or a <= 0 or d <= 0:
        return None
    r = page.rect
    bbox = pymupdf.Rect(info["bbox"]) & r
    if bbox.width * bbox.height < 0.97 * r.width * r.height:
        return None
    img = doc.extract_image(info["xref"])
    if img.get("ext") != "jpeg" or img.get("smask") or img.get("colorspace") not in (1, 3):
        return None
    return img["image"]


def native_dpi(page):
    best = 0
    for info in page.get_image_info():
        w = info.get("width") or 0
        bw = pymupdf.Rect(info["bbox"]).width
        if w and bw:
            best = max(best, w / (bw / 72))
    return int(min(400, max(110, best or 200)))


def save_webp(im, path, height, quality):
    if im.height > height:
        im = im.resize((max(1, round(im.width * height / im.height)), height), Image.LANCZOS)
    im.save(path, "WEBP", quality=quality, method=4)


def process_page(spec, index, out_dir, split, cfg):
    kind, src = open_source(spec)
    num = f"{index + 1:03d}"
    raw = None
    if kind == "pdf":
        page = src[index]
        raw = lossless_jpeg(src, page)
        if raw is not None:
            im = Image.open(io.BytesIO(raw))
            im.load()
        else:
            pix = page.get_pixmap(dpi=native_dpi(page))
            im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    else:
        z, names = src
        data = z.read(names[index])
        im = Image.open(io.BytesIO(data))
        im.load()
        if im.format == "JPEG" and im.mode in ("RGB", "L"):
            raw = data
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")

    if split:
        half = im.width // 2
        parts = [(num + "a", im.crop((0, 0, half, im.height)), None),
                 (num + "b", im.crop((half, 0, im.width, im.height)), None)]
    else:
        parts = [(num, im, raw)]

    entries = []
    for name, part, part_raw in parts:
        full_path = os.path.join(out_dir, "full", name + ".jpg")
        if part_raw is not None:
            with open(full_path, "wb") as f:
                f.write(part_raw)
        else:
            part.save(full_path, "JPEG", quality=88, optimize=True)
        entry = {"f": name, "w": part.width, "h": part.height, "src": index + 1}
        if part.height <= cfg["view_height"] * 1.15:
            entry["nv"] = 1  # malý sken, na listování stačí full
        else:
            save_webp(part, os.path.join(out_dir, "view", name + ".webp"), cfg["view_height"], cfg["view_quality"])
        save_webp(part, os.path.join(out_dir, "thumb", name + ".webp"), cfg["thumb_height"], cfg["thumb_quality"])
        if split:
            entry["part"] = "L" if name.endswith("a") else "R"
        if part_raw is None:
            entry["render"] = True
        entries.append(entry)
    return index, entries


# celé číslo

def safe_rmtree(path, issues_dir):
    path, issues_dir = os.path.abspath(path), os.path.abspath(issues_dir)
    if os.path.dirname(path) != issues_dir:
        raise RuntimeError(f"Odmítám mazat mimo složku čísel: {path}")
    for attempt in range(5):  # na Windows složku občas chvíli drží jiný proces
        if not os.path.isdir(path):
            return
        try:
            shutil.rmtree(path)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(1.5)


def convert_issue(source, cfg, pool, report=None):
    iid, spec = source["id"], source["spec"]
    issues_dir = os.path.join(cfg["output_dir"], "issues")
    final_dir = os.path.join(issues_dir, iid)
    tmp_dir = final_dir + ".tmp"

    t0 = time.time()
    ratios = page_ratios(spec)
    if len(ratios) < cfg["min_pages"]:  # mozaika obálek apod., příště se už nezkouší
        log(f"  {iid}: jen {len(ratios)} str., přeskakuji")
        with open(os.path.join(issues_dir, iid + ".skip"), "w", encoding="utf-8") as f:
            f.write(source["fp"])
        return
    safe_rmtree(tmp_dir, issues_dir)
    for sub in ("full", "view", "thumb"):
        os.makedirs(os.path.join(tmp_dir, sub))

    median = statistics.median(ratios)
    wide = [r > median * SPREAD_FACTOR for r in ratios]
    # Široký sken je buď dvoustrana (rozdělit), nebo rozkládací plakát na místě jedné strany.
    # Časopis má sudý počet stran, takže dělit jen když tím sudý počet vyjde.
    split_ok = (len(ratios) + sum(wide)) % 2 == 0
    splits = [w and split_ok for w in wide]
    notes = [f"str. {i + 1}: {'dvoustrana, rozdělena' if split_ok else 'rozkládací stránka, vcelku'} ({ratios[i]:.2f})"
             for i, w in enumerate(wide) if w]

    results = {}
    cover = None
    futures = [pool.submit(process_page, spec, i, tmp_dir, splits[i], cfg) for i in range(len(ratios))]
    for done, fut in enumerate(as_completed(futures), 1):
        index, entries = fut.result()
        results[index] = entries
        if index == 0:  # obálku čtečka ukáže už během převodu
            cover = f"data/issues/{iid}.tmp/thumb/{entries[0]['f']}.webp"
        if report:
            report(done, len(ratios), cover)
        if done % 40 == 0:
            log(f"  {iid}: {done}/{len(ratios)}")

    pages = [e for i in range(len(ratios)) for e in results[i]]
    if len(pages) % 2:
        notes.append(f"lichý počet stran ({len(pages)})")
    issue = {
        "id": iid,
        "magazine": source["magazine"],
        **source["meta"],
        "date_votes": date_votes(spec) if not source["meta"].get("date_exact") else [],
        "source": source["name"],
        "source_fp": source["fp"],
        "format": FORMAT_VERSION,
        "aspect": round(statistics.median(p["w"] / p["h"] for p in pages), 4),
        "pages": pages,
        "notes": notes,
    }
    try:
        extract_text(spec, tmp_dir)
    except Exception as e:  # bez textu se jen nedá hledat, číslo se čte dál
        log(f"  {iid}: text pro hledání se nepodařilo vytáhnout ({e})")
    with open(os.path.join(tmp_dir, "issue.json"), "w", encoding="utf-8") as f:
        json.dump(issue, f, ensure_ascii=False, indent=1)
    safe_rmtree(final_dir, issues_dir)
    os.replace(tmp_dir, final_dir)
    log(f"  {iid}: {len(pages)} stran, {time.time() - t0:.0f} s" + "".join(f"\n    {n}" for n in notes))


def is_up_to_date(source, cfg):
    path = os.path.join(cfg["output_dir"], "issues", source["id"], "issue.json")
    try:
        with open(path, encoding="utf-8") as f:
            issue = json.load(f)
    except (OSError, ValueError):
        return False
    if issue.get("format") != FORMAT_VERSION:
        return False
    if issue.get("source_fp") == source["fp"]:
        return True
    legacy = source.get("legacy")  # čísla z první verze skriptu
    return bool(legacy) and (issue.get("source_size"), issue.get("source_mtime")) == legacy


def write_manifest(cfg, sources, quiet=False):
    issues_dir = os.path.join(cfg["output_dir"], "issues")
    os.makedirs(issues_dir, exist_ok=True)
    issues = []
    for name in os.listdir(issues_dir):
        path = os.path.join(issues_dir, name, "issue.json")
        if name.endswith(".tmp") or not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            issue = json.load(f)
        changed = False
        if "magazine" not in issue:
            issue["magazine"] = "excalibur"
            changed = True
        if "date_votes" not in issue and issue["id"] in sources:
            issue["date_votes"] = date_votes(sources[issue["id"]]["spec"])
            issue.pop("date", None)
            changed = True
        if changed:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(issue, f, ensure_ascii=False, indent=1)
        issue.pop("notes", None)
        issues.append(issue)

    mags = cfg["magazines"]
    for mag in mags:
        group = [i for i in issues if i["magazine"] == mag["id"] and not i.get("date_from_name")]
        if group:
            estimate_dates(group)
    for issue in issues:
        issue.pop("date_votes", None)
    order = {m["id"]: k for k, m in enumerate(mags)}
    issues.sort(key=lambda i: (order.get(i["magazine"], 99), i["sort"], i["id"]))

    manifest = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "format": FORMAT_VERSION,
        "magazines": [{"id": m["id"], "title": m["title"]} for m in mags
                      if any(i["magazine"] == m["id"] for i in issues)],
        "issues": issues,
    }
    tmp = os.path.join(cfg["output_dir"], "manifest.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, separators=(",", ":"))
    replace_file(tmp, os.path.join(cfg["output_dir"], "manifest.json"))
    if not quiet:
        counts = ", ".join(f"{m['title']} {sum(1 for i in issues if i['magazine'] == m['id'])}" for m in mags)
        log(f"Hotovo: {len(issues)} {plural(len(issues))} ({counts or 'zatím nic'})")


def plural(n):
    return "číslo" if n == 1 else "čísla" if 2 <= n <= 4 else "čísel"


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Převod naskenovaných časopisů pro čtečku")
    ap.add_argument("issues", nargs="*", help="id čísel, např. Excalibur_51")
    ap.add_argument("--magazine", help="jen jeden časopis (id)")
    ap.add_argument("--force", action="store_true", help="převést znovu i hotová čísla")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    args = ap.parse_args()

    cfg = load_config()
    if not cfg["magazines"]:
        log("Zatím nevím, kde máš časopisy. Spusť čtečku a vyber složku s časopisy.")
        return
    os.makedirs(os.path.join(cfg["output_dir"], "issues"), exist_ok=True)
    for _ in range(6):
        lock = try_lock(os.path.join(cfg["output_dir"], "convert.lock"))
        if lock:
            break
        time.sleep(0.5)
    else:
        log("Převod už běží v jiném okně.")
        return

    sources = list_sources(cfg)
    wanted = args.issues or cfg["include"] or list(sources)
    if args.magazine:
        wanted = [w for w in wanted if w in sources and sources[w]["magazine"] == args.magazine]
    for w in wanted:
        if w not in sources:
            log(f"! {w} mezi zdroji není")
    wanted = [w for w in wanted if w in sources]

    def failed_before(src):  # poškozený nebo přeskočený soubor se zkouší znovu, až se změní
        for ext in (".failed", ".skip"):
            try:
                with open(os.path.join(cfg["output_dir"], "issues", src["id"] + ext), encoding="utf-8") as f:
                    if f.read() == src["fp"]:
                        return True
            except OSError:
                pass
        return False

    todo = [w for w in wanted if args.force or not (is_up_to_date(sources[w], cfg) or failed_before(sources[w]))]
    log(f"K převodu: {len(todo)} z {len(wanted)} {'čísla' if len(wanted) == 1 else 'čísel'}")
    failed = []
    started = round(time.time(), 1)
    if todo:
        last = 0

        def status(k, iid, page=0, pages=0, cover=None):  # průběh pro čtečku
            write_status(cfg, state="running", done=k - 1, total=len(todo), id=iid, current=sources[iid]["meta"]["title"],
                         page=page, pages=pages, cover=cover, started=started, failed=failed)

        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            for k, iid in enumerate(todo, 1):
                log(f"[{k}/{len(todo)}] {iid}")
                status(k, iid)
                tick = {"t": 0}

                def report(page, pages, cover, k=k, iid=iid, tick=tick):
                    if time.time() - tick["t"] > 0.6 or page == pages:
                        tick["t"] = time.time()
                        status(k, iid, page, pages, cover)
                try:
                    convert_issue(sources[iid], cfg, pool, report)
                except Exception as e:  # jedno poškozené číslo nesmí zastavit ostatní
                    log(f"! {iid} se nepodařilo převést: {e}")
                    failed.append(sources[iid]["name"])
                    with open(os.path.join(cfg["output_dir"], "issues", iid + ".failed"), "w", encoding="utf-8") as f:
                        f.write(sources[iid]["fp"])
                if time.time() - last > 3:  # polička se průběžně plní
                    write_manifest(cfg, sources, quiet=True)
                    last = time.time()

    # text pro hledání u čísel převedených starší verzí (jen samostatná PDF, PDF uvnitř ZIPu se kvůli tomu nečte celé)
    issues_dir = os.path.join(cfg["output_dir"], "issues")
    missing = [w for w in wanted if os.path.isfile(os.path.join(issues_dir, w, "issue.json"))
               and not os.path.exists(os.path.join(issues_dir, w, "text.json"))]
    if missing:
        log(f"Připravuju hledání v textu: {len(missing)} {plural(len(missing))}")
        for w in missing:
            try:
                if sources[w]["spec"][0] == "pdf":
                    extract_text(sources[w]["spec"], os.path.join(issues_dir, w))
                else:
                    with open(os.path.join(issues_dir, w, "text.json"), "w", encoding="utf-8") as f:
                        json.dump({"src": []}, f)
            except Exception as e:
                log(f"! {w}: text se nepodařilo vytáhnout ({e})")
    write_manifest(cfg, sources)
    write_status(cfg, state="done", done=len(todo), total=len(todo), failed=failed, started=started, nested=cfg["_nested"])
    lock.close()


if __name__ == "__main__":
    main()
