export default async function handler(req, res) {
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

// FUNGSI PROXY DENGAN PEMBERSIH URL & OBFUSCATION
async function handleProxyPage(res, requestPath, searchParams) {
  const TARGET_URL = process.env.TARGET_URL; 
  
  if (!TARGET_URL) {
    return res.status(500).send("Variabel TARGET_URL belum di-set di Vercel");
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

      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Access-Control-Allow-Origin', '*'); 
      return res.status(200).send(content);
    } 
    // JIKA RESPONSE BERUPA BINER (Gambar, Font, dll)
    else {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600'); 
      
      return res.status(200).send(buffer);
    }
  } catch (err) {
    return res.status(500).send(`<p>Gagal memuat halaman: ${err.message}</p>`);
  }
}

// FUNGSI API GITHUB
async function handleGithubFile(res, filePath) {
  if (!filePath) {
    return res.status(400).json({ error: 'Parameter path wajib diisi' });
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

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ path: filePath, content: decoded });
  } catch (err) {
    return res.status(500).json({ error: 'Internal Server Error', detail: err.message });
  }
}

// SKRIP ANTI-DEBUG
const DEVTOOLS_GUARD_SCRIPT_ = `
<script>
(function () {
  var devtoolsOpen = false;
  var appAlreadyLoaded = false;

  window.addEventListener('load', function () {
    setTimeout(function () { appAlreadyLoaded = true; }, 500);
  });

  function wipeStorage_() {
    try { sessionStorage.clear(); } catch (e) {}
    try { localStorage.clear(); } catch (e) {}
    try { if (window.__APP_DATA__) window.__APP_DATA__ = null; } catch (e) {}
  }

  function resetApp_() {
    wipeStorage_();
    try {
      document.documentElement.innerHTML =
        '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
        'height:100vh;font-family:sans-serif;background:#111;color:#eee;text-align:center;">' +
        '<div><h2>Akses Ditolak</h2><p>Halaman ini telah dihapus dari memori Anda karena Alat Pengembang terdeteksi.</p></div></body>';
    } catch (e) {}
  }

  function blockNetwork_() {
    window.fetch = function () { return Promise.reject(new Error('Blocked')); };
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () { throw new Error('Blocked'); };
  }

  function onDevtoolsDetected_() {
    if (devtoolsOpen) return;
    devtoolsOpen = true;
    blockNetwork_();
    if (appAlreadyLoaded) resetApp_();
  }

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
