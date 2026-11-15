# Značky

Každá podsložka je jedna značka: `brand.js` (název, texty, logo, výchozí vzhled),
`brand.css` (barvy a písma) a případně `fonts/` a logo. Výchozí značka je v `app/brand/`.

- náhled v čtečce: `http://127.0.0.1:8642/?brand=<název>`
- balíček: `python tools/build.py --brand <název>`
- jen vzhled (pár set kB): `python tools/build.py --brand <název> --pack`, ve čtečce paleta → Načíst vzhled ze souboru
- písma: `python tools/fonty.py --brand <název> "Barlow:wght@400;700"`

Vlastní vzhled poličky přidá značka přes `themes` v `brand.js` a pravidla
`.shelf[data-theme="<id>"]` v `brand.css`.
