// api/index.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Pastikan 'node-fetch' terinstal

const app = express();

// --- Informasi Sensitif yang Diambil dari Variabel Lingkungan ---
// PENTING: JANGAN MASUKKAN KREDENSIAL INI SECARA LANGSUNG DI KODE ANDA.
// GUNAKAN VARIABEL LINGKUNGAN DI VERCEL.
const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_EMAIL = process.env.CLOUDFLARE_API_EMAIL;
const CLOUDFLARE_SERVICE_NAME = process.env.CLOUDFLARE_SERVICE_NAME;
const CLOUDFLARE_ROOT_DOMAIN = process.env.CLOUDFLARE_ROOT_DOMAIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// Header untuk Cloudflare API
const cloudflareHeaders = {
    'Authorization': `Bearer ${CLOUDFLARE_API_KEY}`,
    'X-Auth-Email': CLOUDFLARE_API_EMAIL,
    'X-Auth-Key': CLOUDFLARE_API_KEY, // Ini adalah kunci API global atau Origin CA Key
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
        console.warn('Respons non-JSON yang tidak diharapkan dari Cloudflare:', text);
        throw new Error('Menerima respons non-JSON dari Cloudflare API.');
    }
}

// --- Rute API ---

/**
 * @route GET /api/subdomains
 * @description Mendapatkan daftar subdomain yang terdaftar di Cloudflare Workers.
 */
app.get('/api/subdomains', async (req, res) => {
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
            console.error('Error Cloudflare API (mendapatkan subdomain):', data.errors || 'Error tidak diketahui');
            res.status(cfRes.status).json({ success: false, message: data.errors?.[0]?.message || 'Gagal mengambil subdomain dari Cloudflare.' });
        }
    } catch (error) {
        console.error('Error saat mengambil subdomain:', error.message);
        res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
    }
});

/**
 * @route POST /api/subdomains
 * @description Menambahkan subdomain baru ke Cloudflare Workers.
 */
app.post('/api/subdomains', async (req, res) => {
    const { subdomainPart } = req.body;

    if (!subdomainPart || subdomainPart.trim() === '') {
        return res.status(400).json({ success: false, message: 'Bagian subdomain tidak boleh kosong.' });
    }
    // Validasi format subdomain: hanya huruf, angka, dan hyphen; tidak diawali/diakhiri hyphen
    if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
        return res.status(400).json({ success: false, message: 'Subdomain hanya boleh berisi huruf, angka, dan tanda hubung, serta tidak boleh diawali atau diakhiri dengan tanda hubung.' });
    }

    const fullDomain = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

    // Cek apakah domain sudah terdaftar di Cloudflare sebelum mencoba menambahkannya
    try {
        const existingDomainsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`, { headers: cloudflareHeaders });
        const existingDomainsData = await parseJsonResponse(existingDomainsRes);

        if (existingDomainsRes.ok) {
            if (existingDomainsData.result && existingDomainsData.result.some(d => d.hostname === fullDomain)) {
                return res.status(409).json({ success: false, message: `Domain '${fullDomain}' sudah terdaftar.` });
            }
        } else {
            console.error('Error Cloudflare API (memeriksa domain yang ada):', existingDomainsData.errors || 'Error tidak diketahui');
            return res.status(existingDomainsRes.status).json({ success: false, message: existingDomainsData.errors?.[0]?.message || 'Gagal memeriksa subdomain yang ada di Cloudflare.' });
        }
    } catch (error) {
        console.error('Error memeriksa domain yang ada:', error.message);
        return res.status(500).json({ success: false, message: `Internal server error selama pemeriksaan domain: ${error.message}` });
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
    try {
        const cfRes = await fetch(url, {
            method: 'PUT', // Menggunakan PUT untuk menambahkan/memperbarui worker domain
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
            res.status(201).json({ success: true, message: `Subdomain '${fullDomain}' berhasil ditambahkan!`, data: data.result });
        } else {
            console.error('Error Cloudflare API (menambahkan subdomain):', data.errors || 'Error tidak diketahui');
            res.status(cfRes.status).json({ success: false, message: data.errors?.[0]?.message || 'Gagal menambahkan subdomain.' });
        }
    } catch (error) {
        console.error('Error menambahkan subdomain:', error.message);
        res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
    }
});

/**
 * @route DELETE /api/subdomains/:id
 * @description Menghapus subdomain dari Cloudflare Workers. Membutuhkan verifikasi password.
 */
app.delete('/api/subdomains/:id', async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;

    // Verifikasi password admin
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Kata sandi salah.' });
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
            // Jika parsing JSON gagal, tapi status OK, berarti mungkin sukses dengan respons kosong/aneh
            if (cfRes.ok) {
                console.warn(`Cloudflare API DELETE: Berhasil tetapi menerima respons non-JSON atau kosong untuk ID ${id}. Status: ${cfRes.status}`);
                return res.json({ success: true, message: 'Subdomain berhasil dihapus (respons Cloudflare tidak biasa tetapi operasi kemungkinan berhasil).' });
            }
            throw jsonError; // Lempar error JSON ke blok catch utama
        }

        if (cfRes.ok) {
            res.json({ success: true, message: 'Subdomain berhasil dihapus!' });
        } else {
            console.error('Error Cloudflare API (menghapus subdomain):', data.errors || 'Error tidak diketahui');
            const errorMessage = data.errors?.[0]?.message || 'Gagal menghapus subdomain dari Cloudflare.';
            res.status(cfRes.status).json({ success: false, message: errorMessage });
        }
    } catch (error) {
        console.error(`Error menghapus subdomain ID ${id}:`, error.message);
        if (error.message.includes("Origin '") && error.message.includes("' not found.")) {
             res.status(404).json({ success: false, message: `Subdomain dengan ID '${id}' tidak ditemukan di Cloudflare.` });
        } else {
            res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
        }
    }
});

// Ekspor aplikasi Express untuk Vercel sebagai fungsi serverless
module.exports = app;
