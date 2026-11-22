/* Časopisárna offline: čtečka a uložená čísla z paměti telefonu.
   Mezipaměti: "shell" (čtečka a manifest), "covers" (obálky na poličku), "issue:<id>" (stránky uloženého čísla). */
let awayUntil = 0; // počítač nedávno neodpověděl: nečekat na něj u každého souboru

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // s výpadkem API si čtečka poradí sama
  e.respondWith(url.pathname.startsWith('/data/issues/') ? image(req, url.pathname) : shell(req));
});

// fetch s časovým limitem: na Wi-Fi v letadle by se na počítač čekalo dlouho
function fetchT(req, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(req, { signal: ctl.signal }).finally(() => clearTimeout(t));
}

// čtečka a manifest: z počítače, když odpovídá, jinak z paměti
async function shell(req) {
  const cached = () => caches.match(req, { ignoreSearch: req.mode === 'navigate' })
    .then((r) => r || (req.mode === 'navigate' ? caches.match('./') : null));
  if (Date.now() < awayUntil) {
    const r = await cached();
    if (r) return r;
  }
  try {
    const res = await fetchT(req, 3000);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open('shell').then((c) => c.put(req, copy));
    }
    awayUntil = 0;
    return res;
  } catch (err) {
    awayUntil = Date.now() + 30000;
    const r = await cached();
    if (r) return r;
    throw err;
  }
}

// stránky: uložené z paměti, ostatní z počítače
async function image(req, path) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  // lupa chce plné rozlišení, v telefonu je uložené to na listování
  const m = /^(.*)\/full\/([^/]+)\.jpg$/.exec(path);
  const view = m && await caches.match(`${m[1]}/view/${m[2]}.webp`);
  if (view && Date.now() < awayUntil) return view;
  try {
    const res = await (view ? fetchT(req, 4000) : fetch(req));
    awayUntil = 0;
    return res;
  } catch (err) {
    awayUntil = Date.now() + 30000;
    if (view) return view;
    throw err;
  }
}
