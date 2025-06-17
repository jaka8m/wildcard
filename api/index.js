// /sdcard/hasil/app.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch'); // Pastikan 'node-fetch' terinstal

const app = express();
// const PORT = 3000; // Tidak perlu mendefinisikan PORT secara eksplisit untuk Vercel Functions

// --- Informasi Sensitif dari Variabel Lingkungan ---
// Pastikan variabel-variabel ini diatur di Vercel Project Settings Anda (Environment Variables)
const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_EMAIL = process.env.CLOUDFLARE_API_EMAIL;
const CLOUDFLARE_SERVICE_NAME = process.env.CLOUDFLARE_SERVICE_NAME;
const CLOUDFLARE_ROOT_DOMAIN = process.env.CLOUDFLARE_ROOT_DOMAIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Pastikan semua variabel lingkungan penting ada
if (!CLOUDFLARE_API_KEY || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_EMAIL || !CLOUDFLARE_SERVICE_NAME || !CLOUDFLARE_ROOT_DOMAIN || !ADMIN_PASSWORD) {
    console.error("Missing one or more Cloudflare/Admin environment variables. Please check your .env file or Vercel settings.");
    // Dalam produksi, mungkin Anda ingin mematikan aplikasi atau mengembalikan error 500 jika variabel kritis tidak ada.
    // Untuk pengembangan, ini mungkin cukup sebagai peringatan.
}

// --- Middleware ---
app.use(cors());
app.use(express.json());
// app.use(express.static(__dirname)); // Hapus ini jika Anda menggunakan Vercel untuk menyajikan file statis secara terpisah (disarankan)

// Headers untuk Cloudflare API
const cloudflareHeaders = {
    'Authorization': `Bearer ${CLOUDFLARE_API_KEY}`,
    'X-Auth-Email': CLOUDFLARE_API_EMAIL,
    // 'X-Auth-Key': CLOUDFLARE_API_KEY, // Hanya jika CLOUDFLARE_API_KEY adalah Global API Key. Jika Token API, 'Authorization: Bearer' sudah cukup.
    'Content-Type': 'application/json'
};

/**
 * Fungsi pembantu untuk memparsing respons JSON dari fetch.
 * Ini menangani kasus di mana respons bukan JSON yang valid.
 */
async function parseJsonResponse(response) {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return response.json();
    } else {
        const text = await response.text();
        console.warn('Unexpected non-JSON response from Cloudflare:', text);
        // Penting: Sertakan respons teks untuk debugging lebih lanjut
        throw new Error(`Received non-JSON response from Cloudflare API. Response: "${text.substring(0, 100)}..."`);
    }
}

// --- Rute API ---

/**
 * @route GET /api/subdomains
 * @description Mendapatkan daftar subdomain yang terdaftar di Cloudflare Workers.
 */
app.get('/api/subdomains', async (req, res) => {
    // Validasi kredensial sebelum melanjutkan
    if (!CLOUDFLARE_API_KEY || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_EMAIL) {
        return res.status(500).json({ success: false, message: 'Server configuration error: Cloudflare credentials are not set.' });
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
    try {
        const cfRes = await fetch(url, { headers: cloudflareHeaders });
        const data = await parseJsonResponse(cfRes);

        if (cfRes.ok) {
            const filteredDomains = data.result
                .filter(domain => domain.service === CLOUDFLARE_SERVICE_NAME && domain.hostname.endsWith(CLOUDFLARE_ROOT_DOMAIN))
                .map(domain => ({
                    hostname: domain.hostname,
                    id: domain.id
                }));
            res.json({ success: true, subdomains: filteredDomains });
        } else {
            console.error('Cloudflare API Error (get subdomains):', data.errors || 'Unknown error');
            res.status(cfRes.status).json({ success: false, message: data.errors?.[0]?.message || 'Failed to fetch subdomains from Cloudflare.' });
        }
    } catch (error) {
        console.error('Error fetching subdomains:', error.message);
        res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
    }
});

/**
 * @route POST /api/subdomains
 * @description Menambahkan subdomain baru ke Cloudflare Workers.
 */
app.post('/api/subdomains', async (req, res) => {
    // Validasi kredensial sebelum melanjutkan
    if (!CLOUDFLARE_API_KEY || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_EMAIL || !CLOUDFLARE_SERVICE_NAME) {
        return res.status(500).json({ success: false, message: 'Server configuration error: Cloudflare credentials are not set.' });
    }

    const { subdomainPart } = req.body;

    if (!subdomainPart || subdomainPart.trim() === '') {
        return res.status(400).json({ success: false, message: 'Subdomain part cannot be empty.' });
    }
    if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart) || subdomainPart.startsWith('-') || subdomainPart.endsWith('-')) {
        return res.status(400).json({ success: false, message: 'Subdomain can only contain letters, numbers, and hyphens, and cannot start or end with a hyphen.' });
    }

    const fullDomain = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

    // Cek apakah domain sudah terdaftar di Cloudflare sebelum mencoba menambahkannya
    try {
        const existingDomainsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`, { headers: cloudflareHeaders });
        const existingDomainsData = await parseJsonResponse(existingDomainsRes);

        if (existingDomainsRes.ok) {
            if (existingDomainsData.result && existingDomainsData.result.some(d => d.hostname === fullDomain)) {
                return res.status(409).json({ success: false, message: `Domain '${fullDomain}' is already registered.` });
            }
        } else {
            console.error('Cloudflare API Error (checking existing domains):', existingDomainsData.errors || 'Unknown error');
            return res.status(existingDomainsRes.status).json({ success: false, message: existingDomainsData.errors?.[0]?.message || 'Failed to check existing subdomains on Cloudflare.' });
        }
    } catch (error) {
        console.error('Error checking existing domains:', error.message);
        return res.status(500).json({ success: false, message: `Internal server error during domain check: ${error.message}` });
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
    try {
        const cfRes = await fetch(url, {
            method: 'PUT',
            headers: cloudflareHeaders,
            body: JSON.stringify({
                environment: 'production',
                hostname: fullDomain,
                service: CLOUDFLARE_SERVICE_NAME,
                zone_id: CLOUDFLARE_ZONE_ID,
            })
        });

        const data = await parseJsonResponse(cfRes);

        if (cfRes.ok) {
            res.status(201).json({ success: true, message: `Subdomain '${fullDomain}' added successfully!`, data: data.result });
        } else {
            console.error('Cloudflare API Error (add subdomain):', data.errors || 'Unknown error');
            res.status(cfRes.status).json({ success: false, message: data.errors?.[0]?.message || 'Failed to add subdomain.' });
        }
    } catch (error) {
        console.error('Error adding subdomain:', error.message);
        res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
    }
});

/**
 * @route DELETE /api/subdomains/:id
 * @description Menghapus subdomain dari Cloudflare Workers. Membutuhkan verifikasi password.
 */
app.delete('/api/subdomains/:id', async (req, res) => {
    // Validasi kredensial sebelum melanjutkan
    if (!CLOUDFLARE_API_KEY || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_EMAIL) {
        return res.status(500).json({ success: false, message: 'Server configuration error: Cloudflare credentials are not set.' });
    }

    const { id } = req.params;
    const { password } = req.body;

    // Verifikasi password admin
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Incorrect password.' });
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains/${id}`;
    try {
        const cfRes = await fetch(url, {
            method: 'DELETE',
            headers: cloudflareHeaders,
        });

        let data;
        try {
            data = await parseJsonResponse(cfRes);
        } catch (jsonError) {
            if (cfRes.ok) {
                console.warn(`DELETE Cloudflare API: Successful but received non-JSON or empty response for ID ${id}. Status: ${cfRes.status}`);
                return res.json({ success: true, message: 'Subdomain deleted successfully (Cloudflare response was unusual but operation likely succeeded).' });
            }
            throw jsonError;
        }

        if (cfRes.ok) {
            res.json({ success: true, message: 'Subdomain deleted successfully!' });
        } else {
            console.error('Cloudflare API Error (delete subdomain):', data.errors || 'Unknown error');
            const errorMessage = data.errors?.[0]?.message || 'Failed to delete subdomain from Cloudflare.';
            res.status(cfRes.status).json({ success: false, message: errorMessage });
        }
    } catch (error) {
        console.error(`Error deleting subdomain ID ${id}:`, error.message);
        if (error.message.includes("Origin '") && error.message.includes("' not found.")) {
             res.status(404).json({ success: false, message: `Subdomain with ID '${id}' not found on Cloudflare.` });
        } else {
            res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
        }
    }
});

// --- Penanganan untuk Vercel Serverless Functions ---
// Pada Vercel, fungsi ini akan diekspor sebagai handler.
// Hapus bagian `app.listen` jika Anda mendeploy ini sebagai Vercel Serverless Function.
// Ganti dengan `module.exports = app;`
module.exports = app;

/*
// Hapus atau komen kode ini saat mendeploy ke Vercel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Access the application at http://localhost:${PORT}`);
});
*/
