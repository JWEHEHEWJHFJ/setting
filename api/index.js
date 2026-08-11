export default async function handler(req, res) {
  const { action, path } = req.query;

  // Hanya layani jika ada parameter action=ghfile
  if (action === 'ghfile') {
    return await handleGithubFile(res, path);
  }

  // Hentikan pemanggilan index.html / halaman utama
  // Kembalikan status 403 (Forbidden) atau pesan JSON
  return res.status(403).json({ 
    error: 'Akses ditolak. Endpoint ini hanya menerima request API yang valid.' 
  });
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
        'User-Agent': 'Vercel-Proxy' 
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

    // Izinkan akses CORS jika dipanggil dari domain lain
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ path: filePath, content: decoded });
  } catch (err) {
    return res.status(500).json({ error: 'Internal Server Error', detail: err.message });
  }
}
