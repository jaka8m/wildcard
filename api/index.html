// api/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // v2.x.x

// 1) Buat Express app
const app = express();
app.use(cors());
app.use(express.json());

// 2) Load ENV
const {
  CLOUDFLARE_API_KEY,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID,
  CLOUDFLARE_SERVICE_NAME = 'joss',
  CLOUDFLARE_ROOT_DOMAIN,
  ADMIN_PASSWORD,
} = process.env;

if (
  !CLOUDFLARE_API_KEY ||
  !CLOUDFLARE_ACCOUNT_ID ||
  !CLOUDFLARE_ZONE_ID ||
  !CLOUDFLARE_ROOT_DOMAIN ||
  !ADMIN_PASSWORD
) {
  console.error('❌ Missing required environment variables!');
}

// 3) Wrapper fetch ke Cloudflare
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
const cfHeaders = {
  Authorization: `Bearer ${CLOUDFLARE_API_KEY}`,
  'Content-Type': 'application/json',
};
async function cloudflareFetch(method, endpoint = '', body) {
  const opts = { method, headers: cfHeaders };
  if (body) opts.body = JSON.stringify(body);

  const cfRes = await fetch(`${CF_BASE}${endpoint}`, opts);
  const ct = cfRes.headers.get('content-type') || '';
  let data = null, raw = null;

  if (ct.includes('application/json')) {
    try {
      data = await cfRes.json();
    } catch {
      raw = await cfRes.text();
    }
  } else {
    raw = await cfRes.text();
  }
  return { cfRes, data, raw };
}

// 4) ROUTES (tanpa /api prefix)
// GET  /api/subdomains
app.get('/subdomains', async (req, res, next) => {
  try {
    const { cfRes, data, raw } = await cloudflareFetch('GET');
    if (!cfRes.ok) {
      const msg = data?.errors?.[0]?.message || raw || 'Error fetching subdomains.';
      return res.status(cfRes.status).json({ success: false, message: msg });
    }
    if (!Array.isArray(data.result)) {
      return res.status(502).json({ success: false, message: 'Invalid Cloudflare response.' });
    }
    const subs = data.result
      .filter(d =>
        d.service === CLOUDFLARE_SERVICE_NAME &&
        d.hostname.endsWith(CLOUDFLARE_ROOT_DOMAIN)
      )
      .map(d => ({ id: d.id, hostname: d.hostname }));
    res.json({ success: true, subdomains: subs });
  } catch (err) { next(err); }
});

// POST /api/subdomains
app.post('/subdomains', async (req, res, next) => {
  try {
    const { subdomainPart } = req.body;
    if (!subdomainPart?.trim()) {
      return res.status(400).json({ success: false, message: 'subdomainPart wajib diisi.' });
    }
    if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
      return res.status(400).json({ success: false, message: 'Format subdomain tidak valid.' });
    }
    const hostname = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

    // Cek duplikat
    const check = await cloudflareFetch('GET');
    if (check.data?.result?.some(d => d.hostname === hostname)) {
      return res.status(409).json({ success: false, message: `${hostname} sudah terdaftar.` });
    }

    // Buat
    const create = await cloudflareFetch('PUT', '', {
      environment: 'production',
      hostname,
      service: CLOUDFLARE_SERVICE_NAME,
      zone_id: CLOUDFLARE_ZONE_ID,
    });
    if (!create.cfRes.ok) {
      const msg = create.data?.errors?.[0]?.message || create.raw || 'Gagal membuat subdomain.';
      return res.status(create.cfRes.status).json({ success: false, message: msg });
    }
    res.status(201).json({
      success: true,
      message: `Subdomain '${hostname}' berhasil dibuat.`,
      data: create.data.result,
    });
  } catch (err) { next(err); }
});

// DELETE /api/subdomains/:id
app.delete('/subdomains/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, message: 'Password salah.' });
    }
    const del = await cloudflareFetch('DELETE', `/${id}`);
    if (!del.cfRes.ok) {
      const msg = del.data?.errors?.[0]?.message || del.raw || 'Gagal menghapus subdomain.';
      return res.status(del.cfRes.status).json({ success: false, message: msg });
    }
    res.json({ success: true, message: 'Subdomain berhasil dihapus.' });
  } catch (err) { next(err); }
});

// 5) Middleware fallback & error handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
});
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// 6) Export sebagai handler Vercel
module.exports = (req, res) => app(req, res);
