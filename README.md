# Časopisárna

Čtečka naskenovaných herních časopisů pro Windows. Obálky stojí na poličce po ročnících,
časopis se listuje jako tištěný a lupa ukáže i drobný text v plném rozlišení skenu.
Pamatuje si rozečtené stránky. Běží jen lokálně v prohlížeči, nic se nikam neposílá.

Hledání najde i slovo v textu všech časopisů (u skenů s textovou vrstvou) a v lupě ho zvýrazní.
Stránky jde zakládat záložkou, rozečtení i záložky si pamatuje čtečka, takže platí i na tabletu.

Do telefonu: ikona telefonu vpravo nahoře ukáže QR kód. Telefon v téže Wi-Fi si čtečku nainstaluje
jako aplikaci a vybraná čísla do ní uloží, takže se dají číst i bez internetu, třeba v letadle.
Síť pro telefon si čtečka pamatuje, aplikace v telefonu si doma sama stáhne novou verzi i rozečtení.
V domácí síti běží čtečka přes HTTPS se jménem od [local-ip.sh](https://local-ip.sh) (veřejné DNS
pro adresy v síti a certifikát k nim). Skeny zůstávají jen v domácí síti.

Repozitář neobsahuje žádné skeny. Excalibur a další české časopisy naskenovala
Herní historie, z. s. ([herniarchiv.cz](https://www.herniarchiv.cz)), Score je na archive.org.

## [Stáhnout Časopisárnu](https://github.com/honziksorm/casopisarna/releases/latest/download/Casopisarna.zip)

Pro Windows 10 a 11, asi 82 MB, nic dalšího instalovat nemusíte.

1. Stažený ZIP rozbalte: pravým tlačítkem na soubor, **Extrahovat vše**.
2. V rozbalené složce dvakrát klikněte na **Spustit čtečku**. Když se Windows zeptá,
   jestli soubor opravdu spustit, klikněte na **Spustit**.
3. V prohlížeči klikněte na **Vybrat složku s časopisy** a vyberte složku s PDF, CBZ nebo ZIP,
   nebo **vyber jednotlivé stažené soubory**. ZIPy není potřeba rozbalovat.

Čtečka časopisy sama převede a postaví na poličku, hotová čísla jdou číst hned.
Potom nabídne zástupce na plochu, příště stačí kliknout na něj. Nová čísla najde sama,
další složku přidá tlačítko vpravo nahoře. Novou verzi stáhne **Aktualizovat**,
časopisy ani rozečtené stránky se nemění.

## Ze zdrojáků

```
pip install -r requirements.txt
python server.py      # http://127.0.0.1:8642/, s --lan i pro tablet v domácí síti
```

Vybrané složky a soubory se ukládají do `config.json` (`library_dirs`, `library_files`); složky
a soubory se stejným názvem časopisu se spojí do jednoho. Složka, ve které přímo leží
soubory, je jeden časopis, jinak je časopisem každá její podsložka. Název časopisu i čísla
a data se čtou z názvů souborů (`Excalibur_50.pdf`, `Score 013 (01-1995).cbz`,
`Level_1997_03.pdf`). Převod jde pustit i ručně: `python convert.py`.

Převedené obrázky jdou do `data/`, `"output_dir"` v configu je může dát jinam, třeba mimo složku
zálohovanou do cloudu. Server je čtečce podává pořád pod `/data/`.

## Co je kde

- `convert.py` – převod. Každá strana jako původní JPEG ze skenu (lupa), WebP pro listování a malý náhled.
  Dvoustrany naskenované jako jedna stránka rozdělí, rozkládací plakáty nechá vcelku. Převádí jen nová čísla.
- `server.py` – lokální server: po startu pustí převod nových čísel na pozadí, `/api/status` (průběh),
  `/api/library` (okno pro výběr složky, jen z tohoto počítače), `/api/search` a `/api/hits` (hledání
  v textu a zvýraznění), `/api/reader` (rozečtení a záložky v `data/reader.json`).
- `index.html`, `app/` – čtečka, čistý JavaScript bez buildu, listování přes [StPageFlip](https://github.com/Nodlik/StPageFlip).
- `app/brand/` – název, texty a styl. Další značky v `brands/<název>/` (viz [brands/README.md](brands/README.md)).
  Značka jde rozdat i jako malý ZIP (`python tools/build.py --brand <název> --pack`), který si uživatel
  načte ve čtečce přes paletu → Načíst vzhled ze souboru. Původní vzhled se dá vrátit.
- `balicek/` – co jde do balíčku. Nahoře jsou jen spouštěče a návod, všechno ostatní
  (čtečka, Python, data, `balicek/program/` s configem a licencemi) leží ve složce `program`.
- `tools/build.py` – sestaví balíček do `dist/`, `tools/fonty.py` stáhne písma.
- `update.py` – aktualizace balíčku z posledního vydání na GitHubu.

## Vydání nové verze

1. zvýšit číslo ve `VERSION`
2. `python tools/build.py`
3. `gh release create v1.1 dist/Casopisarna.zip --title "Časopisárna 1.1" --notes "..."`

Soubor se jmenuje pořád stejně, aby odkaz `releases/latest/download/Casopisarna.zip` vedl vždy na nejnovější verzi.

`update.py` si stáhne zdrojový ZIP vydání a vymění jen soubory aplikace. Když se změní
`requirements.txt`, nic nemění a pošle uživatele pro celý balíček.

## Licence

GNU AGPL 3.0, protože balíček obsahuje PyMuPDF. StPageFlip je pod MIT, písma pod SIL OFL,
licence jsou v `balicek/licenses/`.
