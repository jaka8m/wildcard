// api/index.js
require('dotenv').config(); // Hanya untuk development lokal
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// === Environment Variables (set di Vercel atau .env lokal) ===
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

// Cloudflare API base URL & headers
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
const cfHeaders = {
  Authorization: `Bearer ${CLOUDFLARE_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Baca response sebagai text, coba parse JSON.
 * - Jika valid JSON: kembalikan { isJson: true, data }
 * - Jika bukan JSON: kembalikan { isJson: false, raw }
 */
async function parseCloudflareResponse(res) {
  const bodyText = await res.text();
  try {
    const data = JSON.parse(bodyText);
    return { isJson: true, data };
  } catch {
    return { isJson: false, raw: bodyText };
  }
}

// --- ROUTES ---

// GET /api/subdomains
app.get('/api/subdomains', async (req, res) => {
  try {
    const cloudRes = await fetch(CF_BASE, { headers: cfHeaders });
    const { isJson, data, raw } = await parseCloudflareResponse(cloudRes);

    if (!cloudRes.ok) {
      const msg = isJson
        ? data.errors?.[0]?.message || 'Gagal mengambil subdomains'
        : raw || 'Unknown error';
      return res.status(cloudRes.status).json({ success: false, message: msg });
    }
    if (!isJson) {
      console.warn('Unexpected non-JSON response:', raw);
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
    return res
      .status(400)
      .json({ success: false, message: 'subdomainPart wajib diisi.' });
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
    // 1) Cek apakah sudah ada
    const checkRes = await fetch(CF_BASE, { headers: cfHeaders });
    const checkParsed = await parseCloudflareResponse(checkRes);
    if (!checkRes.ok) {
      const msg = checkParsed.isJson
        ? checkParsed.data.errors?.[0]?.message
        : checkParsed.raw;
      throw new Error(msg || 'Error checking existing domains');
    }
    if (
      checkParsed.isJson &&
      checkParsed.data.result.some((d) => d.hostname === hostname)
    ) {
      return res
        .status(409)
        .json({ success: false, message: `${hostname} sudah terdaftar.` });
    }

    // 2) Tambah
    const createRes = await fetch(CF_BASE, {
      method: 'PUT',
      headers: cfHeaders,
      body: JSON.stringify({
        environment: 'production',
        hostname,
        service: CLOUDFLARE_SERVICE_NAME,
        zone_id: CLOUDFLARE_ZONE_ID,
      }),
    });
    const createParsed = await parseCloudflareResponse(createRes);
    if (!createRes.ok) {
      const msg = createParsed.isJson
        ? createParsed.data.errors?.[0]?.message
        : createParsed.raw;
      return res
        .status(createRes.status)
        .json({ success: false, message: msg || 'Gagal menambahkan.' });
    }

    return res.status(201).json({
      success: true,
      message: `Subdomain '${hostname}' berhasil ditambahkan.`,
      data: createParsed.data.result,
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
    const delRes = await fetch(`${CF_BASE}/${id}`, {
      method: 'DELETE',
      headers: cfHeaders,
    });
    const parsed = await parseCloudflareResponse(delRes);

    if (!delRes.ok) {
      const msg = parsed.isJson
        ? parsed.data.errors?.[0]?.message
        : parsed.raw;
      return res
        .status(delRes.status)
        .json({ success: false, message: msg || 'Gagal menghapus.' });
    }
    if (!parsed.isJson) {
      console.warn('DELETE unexpected non-JSON response:', parsed.raw);
    }

    return res.json({ success: true, message: 'Subdomain berhasil dihapus.' });
  } catch (err) {
    console.error(`DELETE /api/subdomains/${id} error:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Ekspor untuk Vercel
module.exports = app;
