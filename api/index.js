require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Pastikan ini v2

const app = express();

// ENV Variables
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
  console.error('❌ Missing environment variables!');
}

app.use(cors());
app.use(express.json());

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
const cfHeaders = {
  Authorization: `Bearer ${CLOUDFLARE_API_KEY}`,
  'Content-Type': 'application/json',
};

async function cloudflareFetch(method, endpoint = '', body) {
  const opts = { method, headers: cfHeaders };
  if (body) opts.body = JSON.stringify(body);

  const cfRes = await fetch(`${CF_BASE}${endpoint}`, opts);
  const contentType = cfRes.headers.get('content-type') || '';
  let data = null, raw = null;

  if (contentType.includes('application/json')) {
    try {
      data = await cfRes.json();
    } catch (e) {
      raw = await cfRes.text();
      console.warn('⚠️ JSON parse failed, raw text:', raw.slice(0, 100));
    }
  } else {
    raw = await cfRes.text();
    console.warn('⚠️ Non-JSON response:', raw.slice(0, 100));
  }

  return { cfRes, data, raw };
}

app.get('/api/subdomains', async (req, res) => {
  try {
    const { cfRes, data, raw } = await cloudflareFetch('GET');

    if (!cfRes.ok) {
      const msg = data?.errors?.[0]?.message || raw || 'Error fetching subdomains.';
      return res.status(cfRes.status).json({ success: false, message: msg });
    }

    if (!Array.isArray(data?.result)) {
      return res.status(502).json({
        success: false,
        message: 'Unexpected response format from Cloudflare.',
      });
    }

    const subdomains = data.result
      .filter(d =>
        d.service === CLOUDFLARE_SERVICE_NAME &&
        d.hostname.endsWith(CLOUDFLARE_ROOT_DOMAIN)
      )
      .map(d => ({ id: d.id, hostname: d.hostname }));

    return res.json({ success: true, subdomains });
  } catch (err) {
    console.error('GET /api/subdomains error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/subdomains', async (req, res) => {
  const { subdomainPart } = req.body;

  if (!subdomainPart?.trim()) {
    return res.status(400).json({ success: false, message: 'subdomainPart wajib diisi.' });
  }

  if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
    return res.status(400).json({
      success: false,
      message: 'Subdomain hanya boleh berisi huruf, angka, dan tanda hubung.',
    });
  }

  const hostname = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

  try {
    const check = await cloudflareFetch('GET');
    if (!check.cfRes.ok) {
      const msg = check.data?.errors?.[0]?.message || check.raw || 'Gagal memeriksa subdomain.';
      return res.status(check.cfRes.status).json({ success: false, message: msg });
    }

    if (check.data?.result?.some(d => d.hostname === hostname)) {
      return res.status(409).json({ success: false, message: `${hostname} sudah terdaftar.` });
    }

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

    return res.status(201).json({
      success: true,
      message: `Subdomain '${hostname}' berhasil ditambahkan.`,
      data: create.data?.result || null,
    });
  } catch (err) {
    console.error('POST /api/subdomains error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/subdomains/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, message: 'Password salah.' });
  }

  try {
    const del = await cloudflareFetch('DELETE', `/${id}`);

    if (!del.cfRes.ok) {
      const msg = del.data?.errors?.[0]?.message || del.raw || 'Gagal menghapus subdomain.';
      return res.status(del.cfRes.status).json({ success: false, message: msg });
    }

    return res.json({ success: true, message: 'Subdomain berhasil dihapus.' });
  } catch (err) {
    console.error('DELETE /api/subdomains error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = app;
