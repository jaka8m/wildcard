// api/index.js
require('dotenv').config();             // Hanya untuk development lokal
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// === ENVIRONMENT VARIABLES ===
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
  process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json());

// Base URL & headers for Cloudflare API
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
const cfHeaders = {
  Authorization: `Bearer ${CLOUDFLARE_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * cloudflareFetch: Tidak pernah crash di JSON.parse
 * - method: 'GET'|'PUT'|'DELETE'
 * - endpoint: '' atau '/:id'
 * - body: JS object untuk PUT
 * 
 * Mengembalikan { cfRes, data, raw }:
 * - cfRes: Response asli
 * - data: hasil JSON.parse kalau valid JSON
 * - raw: isi text kalau bukan JSON atau parse gagal
 */
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

// --- ROUTES ---

// GET /api/subdomains
app.get('/api/subdomains', async (req, res) => {
  try {
    const { cfRes, data, raw } = await cloudflareFetch('GET');

    if (!cfRes.ok) {
      const msg = data?.errors?.[0]?.message || raw || 'Unknown error';
      return res.status(cfRes.status).json({ success: false, message: msg });
    }
    if (!data) {
      console.warn('GET: non‑JSON OK response:', raw);
      return res.status(502).json({
        success: false,
        message: 'Invalid response format from Cloudflare',
      });
    }

    const subdomains = data.result
      .filter(
        (d) =>
          d.service === CLOUDFLARE_SERVICE_NAME &&
          d.hostname.endsWith(CLOUDFLARE_ROOT_DOMAIN)
      )
      .map((d) => ({ id: d.id, hostname: d.hostname }));

    return res.json({ success: true, subdomains });
  } catch (err) {
    console.error('GET /api/subdomains error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/subdomains
app.post('/api/subdomains', async (req, res) => {
  const { subdomainPart } = req.body;
  if (!subdomainPart?.trim()) {
    return res.status(400).json({ success: false, message: 'subdomainPart wajib diisi.' });
  }
  if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
    return res.status(400).json({
      success: false,
      message:
        'Subdomain hanya huruf, angka, hyphen, dan tidak boleh diawali/diakhiri hyphen.',
    });
  }

  const hostname = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

  try {
    // 1) Cek existing
    const check = await cloudflareFetch('GET');
    if (!check.cfRes.ok) {
      const msg = check.data?.errors?.[0]?.message || check.raw || 'Error checking domains';
      throw new Error(msg);
    }
    if (check.data.result.some((d) => d.hostname === hostname)) {
      return res
        .status(409)
        .json({ success: false, message: `${hostname} sudah terdaftar.` });
    }

    // 2) Create baru
    const create = await cloudflareFetch('PUT', '', {
      environment: 'production',
      hostname,
      service: CLOUDFLARE_SERVICE_NAME,
      zone_id: CLOUDFLARE_ZONE_ID,
    });

    if (!create.cfRes.ok) {
      const msg = create.data?.errors?.[0]?.message || create.raw || 'Gagal menambahkan.';
      return res.status(create.cfRes.status).json({ success: false, message: msg });
    }
    if (!create.data) {
      console.warn('POST: non‑JSON OK response:', create.raw);
      return res.status(502).json({
        success: false,
        message: 'Invalid response format from Cloudflare',
      });
    }

    return res.status(201).json({
      success: true,
      message: `Subdomain '${hostname}' berhasil ditambahkan.`,
      data: create.data.result,
    });
  } catch (err) {
    console.error('POST /api/subdomains error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/subdomains/:id
app.delete('/api/subdomains/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Password salah.' });
  }

  try {
    const del = await cloudflareFetch('DELETE', `/${id}`);

    if (!del.cfRes.ok) {
      const msg = del.data?.errors?.[0]?.message || del.raw || 'Gagal menghapus.';
      return res.status(del.cfRes.status).json({ success: false, message: msg });
    }

    // Sukses (meski non-JSON), kirim OK:
    return res.json({ success: true, message: 'Subdomain berhasil dihapus.' });
  } catch (err) {
    console.error(`DELETE /api/subdomains/${id} error:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Ekspor untuk Vercel
module.exports = app;
