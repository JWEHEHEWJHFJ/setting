// ============================================================
// KONFIGURASI RATE LIMIT (lapisan cadangan; lapisan utama = Vercel Firewall
// Rate Limit Rule yang dipasang lewat dashboard, karena itu jalan SEBELUM
// function ini dipanggil dan tidak makan kuota sama sekali kalau kena block).
// Rate limit di sini bersifat per-instance (bukan global lintas semua
// instance/region Vercel), jadi anggap ini sebagai jaring pengaman kedua,
// bukan pengganti Firewall Rule di dashboard.
// ============================================================
const RATE_LIMIT_WINDOW_MS = 10 * 1000; // jendela hitung: 10 detik
const RATE_LIMIT_MAX = 20;              // maksimal 20 request per IP per jendela
const ipHits = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Return true kalau IP ini sedang melebihi limit (harus ditolak).
function isRateLimited(ip) {
  const now = Date.now();
  let entry = ipHits.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Jendela baru untuk IP ini
    entry = { count: 1, windowStart: now };
    ipHits.set(ip, entry);

    // Bersih-bersih ringan supaya Map tidak membengkak tanpa batas kalau
    // banyak IP unik yang pernah mampir (sekolah dengan ratusan siswa).
    if (ipHits.size > 5000) {
      for (const [key, val] of ipHits) {
        if (now - val.windowStart > RATE_LIMIT_WINDOW_MS * 2) ipHits.delete(key);
      }
    }
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// ============================================================
// KONFIGURASI CACHE
// ============================================================
// Cache disimpan di memory module (bertahan selama instance
// serverless Vercel masih "warm"). Ini mengurangi jumlah request
// ke GitHub Pages / GitHub API meskipun user reload berkali-kali
// dalam rentang waktu TTL di bawah ini.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

// Cache untuk halaman/aset hasil proxy (key: requestPath + search)
const pageCache = new Map();
// Cache untuk hasil handleGithubFile (key: filePath)
const ghFileCache = new Map();

function getFromCache(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCache(cache, key, value) {
  cache.set(key, { ...value, timestamp: Date.now() });
}

// Halaman/aset di-fetch client dengan cache-buster "?v=<timestamp>" (cache: no-store)
// supaya browser tidak nyimpen versi lama. Tapi itu bikin tiap request punya
// searchParams yang selalu beda -> cache key di server jadi selalu MISS kalau
// dihitung apa adanya. Maka param "v" dibuang dulu sebelum dijadikan cache key,
// parameter lain (kalau ada) tetap dipertahankan.
function buildCacheKey(requestPath, searchParams) {
  if (!searchParams) return requestPath;
  const params = new URLSearchParams(searchParams);
  params.delete('v');
  const rest = params.toString();
  return rest ? `${requestPath}?${rest}` : requestPath;
}

// ============================================================

export default async function handler(req, res) {
  // --- CEK RATE LIMIT DULU (paling awal, sebelum kerja apa pun) ---
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    res.setHeader('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).send('Terlalu banyak permintaan dari perangkat Anda. Silakan coba lagi beberapa saat.');
  }

  const { action, path } = req.query;

  // 1. Layani request API GitHub jika ada parameter action=ghfile
  if (action === 'ghfile') {
    return await handleGithubFile(res, path);
  }

  // 2. Dapatkan path dari request asli
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  let requestPath = urlObj.pathname.replace(/^\//, '');

  // 3. Proxy halaman utama & semua aset
  return await handleProxyPage(res, requestPath, urlObj.search);
}

// FUNGSI PENGACAK HTML (SERVER-SIDE OBFUSCATOR)
function obfuscateHTML(htmlString) {
  // Ubah seluruh HTML menjadi string Base64 aman (UTF-8)
  const base64Payload = Buffer.from(htmlString, 'utf-8').toString('base64');

  // Kembalikan dokumen pembungkus yang mendeskripsi HTML di memori browser
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script>
    (function() {
      var payload = "${base64Payload}";
      var decoded = decodeURIComponent(escape(window.atob(payload)));
      document.open();
      document.write(decoded);
      document.close();
    })();
  </script>
</head>
<body>
  <noscript>JavaScript diperlukan untuk membuka halaman ini.</noscript>
</body>
</html>`;
}

// FUNGSI PROXY DENGAN PEMBERSIH URL & OBFUSCATION (+ CACHE 5 MENIT)
async function handleProxyPage(res, requestPath, searchParams) {
  const TARGET_URL = process.env.TARGET_URL;

  if (!TARGET_URL) {
    return res.status(500).send("Variabel TARGET_URL belum di-set di Vercel");
  }

  const cacheKey = buildCacheKey(requestPath, searchParams);

  // --- CEK CACHE DULU (lapisan cadangan per-instance; lapisan utama ada di Edge Vercel via s-maxage) ---
  const cached = getFromCache(pageCache, cacheKey);
  if (cached) {
    const ageMs = Date.now() - cached.timestamp;
    const remainingMs = Math.max(0, CACHE_TTL_MS - ageMs);
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.blogspot.com https://www.sman5pinrang.my.id https://sman5pinrang.my.id;");
    res.setHeader('Access-Control-Allow-Origin', '*');
    // s-maxage: Vercel Edge Network boleh nyimpen & jawab langsung tanpa
    // manggil function ini lagi, selama sisa waktu di bawah ini. Ini yang
    // paling besar ngirit Function Invocations & Edge Requests, karena
    // request dari SEMUA user (bukan cuma 1 instance) dilayani dari CDN.
    res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${Math.ceil(remainingMs / 1000)}, stale-while-revalidate=60`);
    res.setHeader('X-Cache', 'HIT');
    // Beri tahu client kapan cache ini akan kedaluwarsa (dipakai untuk auto-reload di index.html)
    res.setHeader('X-Cache-Expires-In', String(remainingMs));
    if (cached.isBinary) {
      return res.status(200).send(Buffer.from(cached.body, 'base64'));
    }
    return res.status(200).send(cached.body);
  }

  const cleanBaseUrl = TARGET_URL.replace(/\/$/, "");
  const fetchUrl = `${cleanBaseUrl}/${requestPath}${searchParams}`;

  try {
    const response = await fetch(fetchUrl, { redirect: 'follow' });

    if (!response.ok) {
      return res.status(response.status).send(`Gagal memuat: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // JIKA RESPONSE BERUPA TEKS (HTML, JS, CSS, JSON)
    if (
      contentType.includes('text/html') ||
      contentType.includes('application/javascript') ||
      contentType.includes('text/css') ||
      contentType.includes('application/json')
    ) {
      let content = await response.text();

      // Clean/Replace jalur hardcoded GitHub Pages
      const urlPatternWithSlash = new RegExp(`${cleanBaseUrl}/`, 'g');
      const urlPatternWithoutSlash = new RegExp(`${cleanBaseUrl}`, 'g');

      content = content.replace(urlPatternWithSlash, '/');
      content = content.replace(urlPatternWithoutSlash, '');

      // Jika file HTML: suntik skrip anti-debug DULU, lalu ACAK (obfuscate) seluruh kodenya
      if (contentType.includes('text/html')) {
        if (/<head[^>]*>/i.test(content)) {
          content = content.replace(/<head([^>]*)>/i, `<head$1>${DEVTOOLS_GUARD_SCRIPT_}`);
        } else {
          content = DEVTOOLS_GUARD_SCRIPT_ + content;
        }

        // Jalankan fitur obfuscation di sini
        content = obfuscateHTML(content);
      }

      // --- SIMPAN KE CACHE (lapisan cadangan per-instance) ---
      setCache(pageCache, cacheKey, { contentType, body: content, isBinary: false });

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.blogspot.com https://www.sman5pinrang.my.id https://sman5pinrang.my.id;");
      res.setHeader('Access-Control-Allow-Origin', '*');
      // --- LAPISAN UTAMA: cache di Edge Network Vercel selama CACHE_TTL_MS ---
      res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${Math.ceil(CACHE_TTL_MS / 1000)}, stale-while-revalidate=60`);
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Expires-In', String(CACHE_TTL_MS));
      return res.status(200).send(content);
    }
    // JIKA RESPONSE BERUPA BINER (Gambar, Font, dll)
    else {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // --- SIMPAN KE CACHE (base64 karena Map menyimpan objek biasa) ---
      setCache(pageCache, cacheKey, { contentType, body: buffer.toString('base64'), isBinary: true });

      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://*.blogspot.com https://www.sman5pinrang.my.id https://sman5pinrang.my.id;");
      // Aset biner (gambar/font) jarang berubah -> cache lebih lama di Edge & browser
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
      res.setHeader('X-Cache', 'MISS');

      return res.status(200).send(buffer);
    }
  } catch (err) {
    return res.status(500).send(`<p>Gagal memuat halaman: ${err.message}</p>`);
  }
}

// FUNGSI API GITHUB (+ CACHE 5 MENIT)
async function handleGithubFile(res, filePath) {
  if (!filePath) {
    return res.status(400).json({ error: 'Parameter path wajib diisi' });
  }

  // --- CEK CACHE DULU ---
  const cached = getFromCache(ghFileCache, filePath);
  if (cached) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({ path: filePath, content: cached.content });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !owner || !repo) {
    return res.status(500).json({ error: 'Server misconfiguration: GITHUB_TOKEN/OWNER/REPO missing' });
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Vercel-Proxy'
      }
    });

    const code = response.status;
    if (code !== 200) {
      const errorText = await response.text();
      return res.status(code).json({ error: `GitHub API gagal (${code})`, detail: errorText });
    }

    const data = await response.json();
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');

    // --- SIMPAN KE CACHE ---
    setCache(ghFileCache, filePath, { content: decoded });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json({ path: filePath, content: decoded });
  } catch (err) {
    return res.status(500).json({ error: 'Internal Server Error', detail: err.message });
  }
}

// SKRIP ANTI-DEBUG (dengan lockout 5 menit, bukan wipe permanen)
const DEVTOOLS_GUARD_SCRIPT_ = `
<script>
(function () {
  var LOCK_KEY = 'sp5p_lockout_until';
  var LOCK_MS  = 5 * 60 * 1000; // 5 menit
  var devtoolsOpen = false;
  var appAlreadyLoaded = false;
  var lockTicking = false;

  window.addEventListener('load', function () {
    setTimeout(function () { appAlreadyLoaded = true; }, 500);
  });

  function wipeStorage_() {
    try { sessionStorage.clear(); } catch (e) {}
    try { localStorage.removeItem('sp5p_session'); } catch (e) {}
    try { if (window.__APP_DATA__) window.__APP_DATA__ = null; } catch (e) {}
  }

  function blockNetwork_() {
    window.fetch = function () { return Promise.reject(new Error('Blocked')); };
    XMLHttpRequest.prototype.open = function () { throw new Error('Blocked'); };
  }

  function fmt_(ms) {
    var totalSec = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ' menit ' + (s < 10 ? '0' : '') + s + ' detik';
  }

  function showLockScreen_(untilTs) {
    try {
      document.documentElement.innerHTML =
        '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
        'height:100vh;font-family:sans-serif;background:#111;color:#eee;text-align:center;padding:24px;box-sizing:border-box;">' +
        '<div><h2 style="margin-bottom:12px;">Maaf, Anda mencoba melakukan kesalahan</h2>' +
        '<p style="opacity:.8;margin-bottom:6px;">Akses sementara dibatasi. Silakan coba lagi dalam:</p>' +
        '<p id="sp5p-lock-timer" style="font-size:1.4em;font-weight:700;">' + fmt_(untilTs - Date.now()) + '</p></div></body>';
    } catch (e) {}

    if (lockTicking) return;
    lockTicking = true;
    (function tick() {
      var remaining = untilTs - Date.now();
      var el = document.getElementById('sp5p-lock-timer');
      if (remaining <= 0) {
        try { localStorage.removeItem(LOCK_KEY); } catch (e) {}
        location.reload();
        return;
      }
      if (el) el.textContent = fmt_(remaining);
      setTimeout(tick, 1000);
    })();
  }

  function triggerLockout_() {
    var until = Date.now() + LOCK_MS;
    try { localStorage.setItem(LOCK_KEY, String(until)); } catch (e) {}
    blockNetwork_();
    wipeStorage_();
    showLockScreen_(until);
  }

  function checkExistingLockout_() {
    var until = 0;
    try { until = parseInt(localStorage.getItem(LOCK_KEY) || '0', 10); } catch (e) {}
    if (until && until > Date.now()) {
      devtoolsOpen = true;
      blockNetwork_();
      showLockScreen_(until);
      return true;
    }
    return false;
  }

  function onDevtoolsDetected_() {
    if (devtoolsOpen) return;
    devtoolsOpen = true;
    if (appAlreadyLoaded) {
      triggerLockout_();
    } else {
      blockNetwork_();
    }
  }

  if (checkExistingLockout_()) return;

  (function loopCheck() {
    var start = performance.now();
    debugger;
    var diff = performance.now() - start;
    if (diff > 100) onDevtoolsDetected_();
    setTimeout(loopCheck, 800);
  })();

  setInterval(function () {
    var threshold = 160;
    var widthDiff = window.outerWidth - window.innerWidth;
    var heightDiff = window.outerHeight - window.innerHeight;
    if (widthDiff > threshold || heightDiff > threshold) onDevtoolsDetected_();
  }, 800);

  document.addEventListener('keydown', function (e) {
    var key = (e.key || '').toUpperCase();
    if (key === 'F12' || (e.ctrlKey && e.shiftKey && (key === 'I' || key === 'J' || key === 'C')) || (e.metaKey && e.altKey && key === 'I')) {
      e.preventDefault();
      onDevtoolsDetected_();
    }
  });

  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
})();
</script>
`;
