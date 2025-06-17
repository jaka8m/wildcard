// api/index.js
require('dotenv').config(); // Hanya untuk development lokal

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit'); // Import library rate-limit

const app = express();

// --- VARIABEL LINGKUNGAN ---
const {
  CLOUDFLARE_API_KEY,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_ZONE_ID,
  CLOUDFLARE_SERVICE_NAME = 'joss', // Nama layanan default jika tidak ada di env
  CLOUDFLARE_ROOT_DOMAIN,
  ADMIN_PASSWORD,
} = process.env;

// Validasi ketat untuk memastikan semua variabel lingkungan yang diperlukan ada dan valid.
// Aplikasi akan berhenti jika ada yang kurang atau salah.
if (
  !CLOUDFLARE_API_KEY || typeof CLOUDFLARE_API_KEY !== 'string' || CLOUDFLARE_API_KEY.trim() === '' ||
  !CLOUDFLARE_ACCOUNT_ID || typeof CLOUDFLARE_ACCOUNT_ID !== 'string' || CLOUDFLARE_ACCOUNT_ID.trim() === '' ||
  !CLOUDFLARE_ZONE_ID || typeof CLOUDFLARE_ZONE_ID !== 'string' || CLOUDFLARE_ZONE_ID.trim() === '' ||
  !CLOUDFLARE_ROOT_DOMAIN || typeof CLOUDFLARE_ROOT_DOMAIN !== 'string' || CLOUDFLARE_ROOT_DOMAIN.trim() === '' ||
  !ADMIN_PASSWORD || typeof ADMIN_PASSWORD !== 'string' || ADMIN_PASSWORD.trim() === ''
) {
  console.error('❌ Variabel lingkungan wajib ada atau tidak valid! Silakan periksa file .env atau Variabel Lingkungan Vercel Anda.');
  process.exit(1);
}

// --- MIDDLEWARE ---
// Mengaktifkan CORS untuk semua origin secara default.
app.use(cors());
// Mengaktifkan body parser untuk JSON, agar bisa menerima data JSON dari request body.
app.use(express.json());

// --- RATE LIMITING ---
// Konfigurasi rate limiter umum: Membatasi 100 permintaan per IP dalam 15 menit.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 100, // Maksimal 100 permintaan per IP
  message: 'Terlalu banyak permintaan dari IP ini, coba lagi setelah 15 menit.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Konfigurasi rate limiter yang lebih ketat untuk endpoint sensitif (POST, DELETE):
// Membatasi 10 permintaan per IP dalam 15 menit.
const sensitiveApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 10, // Maksimal 10 permintaan per IP
  message: 'Terlalu banyak upaya, coba lagi setelah 15 menit.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Terapkan rate limiter umum ke semua rute di bawah path '/api/'.
app.use('/api/', apiLimiter);

// --- KONFIGURASI CLOUDFLARE API ---
// Base URL untuk Cloudflare Workers Domain API.
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
// Headers yang diperlukan untuk otentikasi dan tipe konten permintaan Cloudflare API.
const cfHeaders = {
  Authorization: `Bearer ${CLOUDFLARE_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * cloudflareFetch: Fungsi pembantu untuk melakukan permintaan ke Cloudflare API.
 * Menangani parsing JSON dan non-JSON, serta mencatat error.
 * @param {string} method - Metode HTTP ('GET'|'PUT'|'DELETE').
 * @param {string} [endpoint=''] - Bagian URL tambahan (misalnya, '/:id' untuk operasi spesifik).
 * @param {object} [body] - Objek JavaScript untuk dikirim sebagai body permintaan (hanya untuk PUT).
 * @returns {Promise<{cfRes: Response, data: object|null, raw: string|null}>} Objek hasil permintaan.
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
    } catch (e) {
      console.warn(`cloudflareFetch: Gagal parse JSON untuk respons ${method} ${endpoint} (Status: ${cfRes.status}):`, e);
      raw = await cfRes.text();
    }
  } else {
    raw = await cfRes.text();
  }

  if (!cfRes.ok && data?.errors) {
    console.error(`Cloudflare API Error Details (${method} ${endpoint}, Status: ${cfRes.status}):`, data.errors);
  }

  return { cfRes, data, raw };
}

// --- ROUTES ---

// GET /api/subdomains: Mengambil daftar subdomain yang terdaftar.
app.get('/api/subdomains', async (req, res) => {
  try {
    const { cfRes, data, raw } = await cloudflareFetch('GET');

    if (!cfRes.ok) {
      const msg = data?.errors?.[0]?.message || raw || 'Terjadi kesalahan tidak dikenal saat mengambil subdomain dari Cloudflare.';
      return res.status(cfRes.status).json({ success: false, message: msg });
    }
    if (!data || !data.result) {
      console.warn('GET /api/subdomains: Respons OK non-JSON atau format tidak valid dari Cloudflare:', raw || data);
      return res.status(502).json({
        success: false,
        message: 'Format respons tidak valid dari Cloudflare. Mohon laporkan masalah ini.',
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
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server internal.' });
  }
});

// POST /api/subdomains: Menambahkan subdomain baru.
app.post('/api/subdomains', sensitiveApiLimiter, async (req, res) => {
  const { subdomainPart } = req.body;

  // Validasi Input subdomainPart
  if (!subdomainPart || typeof subdomainPart !== 'string' || subdomainPart.trim() === '') {
    return res.status(400).json({ success: false, message: 'Nama subdomain wajib diisi dan harus berupa teks.' });
  }

  const trimmedSubdomain = subdomainPart.trim();

  // Regex untuk validasi format subdomain:
  // - Hanya boleh huruf (a-z, A-Z), angka (0-9), dan hyphen (-).
  // - Harus dimulai dan diakhiri dengan huruf atau angka (tidak boleh hyphen).
  // - Tidak boleh ada dua hyphen berturut-turut.
  if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(trimmedSubdomain)) {
    return res.status(400).json({
      success: false,
      message:
        'Subdomain hanya boleh mengandung huruf, angka, dan hyphen. Tidak boleh diawali atau diakhiri dengan hyphen, dan tidak boleh ada hyphen berturut-turut.',
    });
  }

  // Batasan panjang untuk label DNS (subdomain), maksimal 63 karakter.
  if (trimmedSubdomain.length < 2 || trimmedSubdomain.length > 63) {
      return res.status(400).json({
          success: false,
          message: 'Subdomain harus memiliki panjang antara 2 hingga 63 karakter.'
      });
  }

  const hostname = `${trimmedSubdomain.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

  try {
    // 1) Cek apakah subdomain sudah ada di Cloudflare
    const check = await cloudflareFetch('GET');
    if (!check.cfRes.ok) {
      const msg = check.data?.errors?.[0]?.message || check.raw || 'Terjadi error saat memeriksa subdomain yang sudah ada.';
      return res.status(check.cfRes.status).json({ success: false, message: msg });
    }
    if (!check.data || !check.data.result) {
        console.warn('POST /api/subdomains (Check Existing): Respons OK non-JSON atau format tidak valid dari Cloudflare:', check.raw || check.data);
        return res.status(502).json({
            success: false,
            message: 'Format respons tidak valid saat memeriksa domain dari Cloudflare.'
        });
    }

    if (check.data.result.some((d) => d.hostname === hostname)) {
      return res
        .status(409)
        .json({ success: false, message: `'${hostname}' sudah terdaftar. Silakan pilih nama lain.` });
    }

    // 2) Buat subdomain baru di Cloudflare
    const create = await cloudflareFetch('PUT', '', {
      environment: 'production',
      hostname,
      service: CLOUDFLARE_SERVICE_NAME,
      zone_id: CLOUDFLARE_ZONE_ID,
    });

    if (!create.cfRes.ok) {
      const msg = create.data?.errors?.[0]?.message || create.raw || 'Gagal menambahkan subdomain.';
      return res.status(create.cfRes.status).json({ success: false, message: msg });
    }
    if (!create.data) {
      console.warn('POST /api/subdomains (Create): Respons OK non-JSON atau format tidak valid dari Cloudflare:', create.raw);
      return res.status(502).json({
        success: false,
        message: 'Format respons tidak valid saat membuat domain di Cloudflare.',
      });
    }

    return res.status(201).json({
      success: true,
      message: `Subdomain '${hostname}' berhasil ditambahkan.`,
      data: create.data.result,
    });
  } catch (err) {
    console.error('POST /api/subdomains error:', err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server internal.' });
  }
});

// DELETE /api/subdomains/:id: Menghapus subdomain.
app.delete('/api/subdomains/:id', sensitiveApiLimiter, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  // Validasi Input
  if (!id || typeof id !== 'string' || id.trim() === '') {
      return res.status(400).json({ success: false, message: 'ID subdomain wajib diisi.' });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Password salah. Anda tidak berwenang menghapus subdomain.' });
  }

  try {
    const del = await cloudflareFetch('DELETE', `/${id}`);

    if (!del.cfRes.ok) {
      const msg = del.data?.errors?.[0]?.message || del.raw || 'Gagal menghapus subdomain.';
      return res.status(del.cfRes.status).json({ success: false, message: msg });
    }

    return res.json({ success: true, message: 'Subdomain berhasil dihapus.' });
  } catch (err) {
    console.error(`DELETE /api/subdomains/${id} error:`, err);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan server internal.' });
  }
});

// Ekspor aplikasi Express agar Vercel dapat menggunakannya sebagai fungsi serverless.
module.exports = app;
