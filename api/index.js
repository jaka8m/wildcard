// api/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Pastikan Anda menginstal node-fetch v2.x.x

const app = express();

// === ENVIRONMENT VARIABLES ===
// Variabel ini akan diatur di Vercel sebagai Environment Variables
const {
  CLOUDFLARE_API_KEY,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID,
  CLOUDFLARE_SERVICE_NAME = 'joss', // Nama layanan pekerja Cloudflare Anda
  CLOUDFLARE_ROOT_DOMAIN, // Domain utama yang akan digunakan (contoh: krikkrik.tech)
  ADMIN_PASSWORD, // Password untuk operasi delete
} = process.env;

// Validasi variabel lingkungan
if (
  !CLOUDFLARE_API_KEY ||
  !CLOUDFLARE_ACCOUNT_ID ||
  !CLOUDFLARE_ZONE_ID ||
  !CLOUDFLARE_ROOT_DOMAIN ||
  !ADMIN_PASSWORD
) {
  console.error('❌ Missing required environment variables! Please check your Vercel project settings.');
  // Pada Vercel, ini akan mencegah fungsi berjalan dan memberi tahu Anda tentang missing variables.
  // Untuk lingkungan lokal, Anda bisa memilih untuk menghentikan proses.
  // process.exit(1); // Ini akan menghentikan Node.js secara paksa, bisa dihilangkan di Vercel production
}

// Middleware
app.use(cors()); // Izinkan semua permintaan lintas asal
app.use(express.json()); // Parsing body permintaan sebagai JSON

// Base URL & headers for Cloudflare API
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
const cfHeaders = {
  Authorization: `Bearer ${CLOUDFLARE_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * cloudflareFetch: Never crash on JSON.parse
 * - method: 'GET'|'PUT'|'DELETE'
 * - endpoint: '' or '/:id'
 * - body: JS object for PUT
 *
 * Returns { cfRes, data, raw }:
 * - cfRes: The raw response
 * - data: JSON.parse result if valid JSON
 * - raw: text content if not JSON or parse fails
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
      raw = await cfRes.text(); // Fallback if JSON parse fails
    }
  } else {
    raw = await cfRes.text(); // For non-JSON responses
  }

  return { cfRes, data, raw };
}

// --- ROUTES ---

// GET /api/subdomains
// Mengambil daftar subdomain yang terkait dengan CLOUDFLARE_SERVICE_NAME
app.get('/api/subdomains', async (req, res) => {
  try {
    const { cfRes, data, raw } = await cloudflareFetch('GET');

    if (!cfRes.ok) {
      const msg = data?.errors?.[0]?.message || raw || 'Unknown error fetching subdomains from Cloudflare.';
      console.error('Cloudflare API Error (GET /subdomains):', msg);
      return res.status(cfRes.status).json({ success: false, message: msg });
    }
    if (!data) {
      console.warn('GET /api/subdomains: non-JSON OK response from Cloudflare:', raw);
      return res.status(502).json({
        success: false,
        message: 'Invalid response format from Cloudflare API.',
      });
    }
    if (!Array.isArray(data.result)) { // Pastikan result adalah array
      console.warn('GET /api/subdomains: Cloudflare result is not an array:', data.result);
      return res.status(502).json({
        success: false,
        message: 'Unexpected data format from Cloudflare API.',
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
    console.error('Server error on GET /api/subdomains:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
  }
});

// POST /api/subdomains
// Menambahkan subdomain baru
app.post('/api/subdomains', async (req, res) => {
  const { subdomainPart } = req.body;
  if (!subdomainPart?.trim()) {
    return res.status(400).json({ success: false, message: 'subdomainPart wajib diisi.' });
  }
  // Regex untuk validasi subdomain: hanya huruf, angka, hyphen; tidak diawali/diakhiri hyphen; tidak ada hyphen berturut-turut
  if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
    return res.status(400).json({
      success: false,
      message: 'Subdomain hanya huruf, angka, dan hyphen. Tidak boleh diawali/diakhiri hyphen, atau ada hyphen berturut-turut.',
    });
  }
  if (subdomainPart.length < 2 || subdomainPart.length > 63) {
    return res.status(400).json({
      success: false,
      message: 'Panjang subdomain harus antara 2 hingga 63 karakter.',
    });
  }


  const hostname = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

  try {
    // 1) Cek subdomain yang sudah ada untuk menghindari duplikasi
    const check = await cloudflareFetch('GET');
    if (!check.cfRes.ok) {
      const msg = check.data?.errors?.[0]?.message || check.raw || 'Error checking existing domains on Cloudflare.';
      console.error('Cloudflare API Error (check existing):', msg);
      throw new Error(msg);
    }
    if (check.data && Array.isArray(check.data.result) && check.data.result.some((d) => d.hostname === hostname)) {
      return res
        .status(409) // Conflict
        .json({ success: false, message: `${hostname} sudah terdaftar.` });
    }

    // 2) Buat subdomain baru
    const create = await cloudflareFetch('PUT', '', {
      environment: 'production', // Atau sesuaikan jika Anda memiliki environment lain
      hostname,
      service: CLOUDFLARE_SERVICE_NAME,
      zone_id: CLOUDFLARE_ZONE_ID,
    });

    if (!create.cfRes.ok) {
      const msg = create.data?.errors?.[0]?.message || create.raw || 'Gagal menambahkan subdomain ke Cloudflare.';
      console.error('Cloudflare API Error (PUT /subdomains):', msg);
      return res.status(create.cfRes.status).json({ success: false, message: msg });
    }
    if (!create.data) {
      console.warn('POST /api/subdomains: non-JSON OK response from Cloudflare:', create.raw);
      return res.status(502).json({
        success: false,
        message: 'Invalid response format from Cloudflare after adding subdomain.',
      });
    }

    return res.status(201).json({
      success: true,
      message: `Subdomain '${hostname}' berhasil ditambahkan.`,
      data: create.data.result, // Mengembalikan data yang dibuat
    });
  } catch (err) {
    console.error('Server error on POST /api/subdomains:', err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
  }
});

// DELETE /api/subdomains/:id
// Menghapus subdomain berdasarkan ID
app.delete('/api/subdomains/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Password salah.' });
  }

  try {
    const del = await cloudflareFetch('DELETE', `/${id}`);

    if (!del.cfRes.ok) {
      const msg = del.data?.errors?.[0]?.message || del.raw || 'Gagal menghapus subdomain dari Cloudflare.';
      console.error(`Cloudflare API Error (DELETE /subdomains/${id}):`, msg);
      return res.status(del.cfRes.status).json({ success: false, message: msg });
    }

    // Sukses (meski non-JSON), kirim OK:
    return res.json({ success: true, message: 'Subdomain berhasil dihapus.' });
  } catch (err) {
    console.error(`Server error on DELETE /api/subdomains/${id}:`, err);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
  }
});

// Ekspor aplikasi Express untuk digunakan sebagai Serverless Function oleh Vercel
module.exports = app;

// Opsional: Untuk pengujian lokal saja. Vercel tidak menggunakan ini di production.
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server is running on http://localhost:${PORT}`);
// });
