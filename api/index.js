export default async function handler(req, res) {
  // Routing parameter (mirip fungsi doGet)
  const { action, path } = req.query;

  if (action === 'ghfile') {
    return await handleGithubFile(res, path);
  }

  // Default: proxy halaman utama
  return await handleMainPage(res);
}

async function handleMainPage(res) {
  const TARGET_URL = 'https://jwehehewjhfj.github.io/ortu/';
  
  try {
    const response = await fetch(TARGET_URL, { redirect: 'follow' });
    let html = await response.text();

    // Suntik <base href> dan script anti-devtools
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${TARGET_URL}">${DEVTOOLS_GUARD_SCRIPT_}`);
    } else {
      html = `<base href="${TARGET_URL}">${DEVTOOLS_GUARD_SCRIPT_}` + html;
    }

    // Mengizinkan iframe (ALLOWALL)
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    
    return res.status(200).send(html);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(`<p>Gagal memuat halaman: ${err.message}</p>`);
  }
}

async function handleGithubFile(res, filePath) {
  if (!filePath) {
    return res.status(400).json({ error: 'Parameter path wajib diisi' });
  }

  // Mengambil properties dari Environment Variables Vercel
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
        'User-Agent': 'Vercel-Proxy' // GitHub API membutuhkan User-Agent
      }
    });

    const code = response.status;
    if (code !== 200) {
      const errorText = await response.text();
      return res.status(code).json({ error: `GitHub API gagal (${code})`, detail: errorText });
    }

    const data = await response.json();
    
    // Decode base64 dari GitHub
    const decoded = Buffer.from(data.content, 'base64').toString('utf-8');

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ path: filePath, content: decoded });
  } catch (err) {
    return res.status(500).json({ error: 'Internal Server Error', detail: err.message });
  }
}

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
        '<div><h2>Terjadi kesalahan</h2><p>Aplikasi dihentikan.</p></div></body>';
    } catch (e) {}
  }

  function blockNetwork_() {
    window.fetch = function () {
      return Promise.reject(new Error('Blocked'));
    };
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      throw new Error('Blocked');
    };
  }

  function onDevtoolsDetected_() {
    if (devtoolsOpen) return;
    devtoolsOpen = true;
    blockNetwork_();
    wipeStorage_();
    if (appAlreadyLoaded) {
      resetApp_();
    }
  }

  (function loopCheck() {
    var start = performance.now();
    debugger;
    var diff = performance.now() - start;
    if (diff > 100) {
      onDevtoolsDetected_();
    }
    setTimeout(loopCheck, 800);
  })();

  setInterval(function () {
    var threshold = 160;
    var widthDiff = window.outerWidth - window.innerWidth;
    var heightDiff = window.outerHeight - window.innerHeight;
    if (widthDiff > threshold || heightDiff > threshold) {
      onDevtoolsDetected_();
    }
  }, 800);

  document.addEventListener('keydown', function (e) {
    var key = (e.key || '').toUpperCase();
    if (
      key === 'F12' ||
      (e.ctrlKey && e.shiftKey && (key === 'I' || key === 'J' || key === 'C')) ||
      (e.metaKey && e.altKey && key === 'I')
    ) {
      e.preventDefault();
      onDevtoolsDetected_();
    }
  });

  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });
})();
</script>
`;
