// api/index.js
require('dotenv').config();       // Jika dijalankan lokal, pastikan paket dotenv terinstal
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// --- Baca dari environment variables ---
const {
  CLOUDFLARE_API_KEY,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID,
  CLOUDFLARE_API_EMAIL,
  CLOUDFLARE_SERVICE_NAME = 'joss',
  CLOUDFLARE_ROOT_DOMAIN,
  ADMIN_PASSWORD
} = process.env;

if (!CLOUDFLARE_API_KEY || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_ZONE_ID || !CLOUDFLARE_ROOT_DOMAIN || !ADMIN_PASSWORD) {
  console.error('⚠️ Missing required environment variables!');
  process.exit(1);
}

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Header standarisasi untuk Cloudflare API
const cfHeaders = {
  'Authorization': `Bearer ${CLOUDFLARE_API_KEY}`,
  'Content-Type': 'application/json'
};

// Helper: parse JSON or throw
async function parseJson(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return res.json();
  }
  const txt = await res.text();
  throw new Error(`Expected JSON, got: ${txt}`);
}

// Base URL Cloudflare Workers Domains
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;

/**
 * GET /api/subdomains
 * List subdomains yang terdaftar
 */
app.get('/api/subdomains', async (req, res) => {
  try {
    const response = await fetch(CF_BASE, { headers: cfHeaders });
    const data = await parseJson(response);

    if (!response.ok) {
      throw new Error(data.errors?.[0]?.message || 'Gagal fetch subdomains');
    }

    const subdomains = data.result
      .filter(d => d.service === CLOUDFLARE_SERVICE_NAME && d.hostname.endsWith(CLOUDFLARE_ROOT_DOMAIN))
      .map(d => ({ id: d.id, hostname: d.hostname }));

    res.json({ success: true, subdomains });
  } catch (err) {
    console.error('GET /subdomains error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/subdomains
 * Tambah subdomain baru
 * Body: { subdomainPart }
 */
app.post('/api/subdomains', async (req, res) => {
  const { subdomainPart } = req.body;
  if (!subdomainPart?.trim()) {
    return res.status(400).json({ success: false, message: 'subdomainPart wajib diisi.' });
  }
  if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
    return res.status(400).json({
      success: false,
      message: 'Subdomain hanya huruf, angka, hyphen, dan tidak boleh diawali/diakhiri hyphen.'
    });
  }

  const hostname = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;
  try {
    // Cek eksistensi
    const checkRes = await fetch(CF_BASE, { headers: cfHeaders });
    const checkData = await parseJson(checkRes);
    if (!checkRes.ok) throw new Error(checkData.errors?.[0]?.message);

    if (checkData.result.some(d => d.hostname === hostname)) {
      return res.status(409).json({ success: false, message: `${hostname} sudah ada.` });
    }

    // Tambah
    const addRes = await fetch(CF_BASE, {
      method: 'PUT',
      headers: cfHeaders,
      body: JSON.stringify({
        environment: 'production',
        hostname,
        service: CLOUDFLARE_SERVICE_NAME,
        zone_id: CLOUDFLARE_ZONE_ID
      })
    });
    const addData = await parseJson(addRes);
    if (!addRes.ok) throw new Error(addData.errors?.[0]?.message);

    res.status(201).json({ success: true, message: `${hostname} berhasil ditambahkan!`, data: addData.result });
  } catch (err) {
    console.error('POST /subdomains error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/subdomains/:id
 * Hapus subdomain berdasarkan ID, with admin password
 * Body: { password }
 */
app.delete('/api/subdomains/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Password salah.' });
  }

  try {
    const delRes = await fetch(`${CF_BASE}/${id}`, {
      method: 'DELETE',
      headers: cfHeaders
    });

    // Coba parse JSON, tapi jika non-JSON dan status ok → sukses
    let delData;
    try {
      delData = await parseJson(delRes);
    } catch {
      if (delRes.ok) {
        return res.json({ success: true, message: 'Subdomain berhasil dihapus!' });
      }
      throw new Error('Non-JSON response dari Cloudflare');
    }

    if (!delRes.ok) {
      throw new Error(delData.errors?.[0]?.message || 'Gagal menghapus subdomain');
    }
    res.json({ success: true, message: 'Subdomain berhasil dihapus!' });
  } catch (err) {
    console.error(`DELETE /subdomains/${id} error:`, err.message);
    const isNotFound = /not found/i.test(err.message);
    res.status(isNotFound ? 404 : 500).json({ success: false, message: err.message });
  }
});

// Ekspor untuk Vercel
module.exports = app;
