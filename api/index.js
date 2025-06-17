// /sdcard/hasil/app.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch'); // Pastikan 'node-fetch' terinstal

const app = express();
const PORT = 3000;

// --- Informasi Sensitif Langsung di Backend ---
// PASTIKAN KREDENSIAL INI AMAN DAN TIDAK BOCOR!
// IDEALNYA, GUNAKAN VARIABEL LINGKUNGAN (e.g., process.env.CLOUDFLARE_API_KEY)
const CLOUDFLARE_API_KEY = "028462e851772f0528310f0ba91d848850886"; // Ganti dengan kunci API Anda
const CLOUDFLARE_ACCOUNT_ID = "d7660aa2e06f4af1d5becb80c0358522"; // Ganti dengan ID Akun Anda
const CLOUDFLARE_ZONE_ID = "d33a71c24bf9c46d634f861e588ab887";    // Ganti dengan ID Zona Anda
const CLOUDFLARE_API_EMAIL = "desalekong24@gmail.com";            // Ganti dengan Email Akun Anda
const CLOUDFLARE_SERVICE_NAME = "joss";                          // Ganti dengan nama Worker Service Anda
const CLOUDFLARE_ROOT_DOMAIN = "joss.krikkrik.tech";              // Domain utama yang Anda kelola
const ADMIN_PASSWORD = "am";                                    // Ganti dengan password yang lebih kuat di produksi!

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Menyajikan file statis (frontend)

// Headers untuk Cloudflare API
const cloudflareHeaders = {
    'Authorization': `Bearer ${CLOUDFLARE_API_KEY}`,
    'X-Auth-Email': CLOUDFLARE_API_EMAIL, // Penting untuk otentikasi API Key
    // 'X-Auth-Key': CLOUDFLARE_API_KEY, // Ini biasanya untuk Global API Key atau Origin CA Key. Jika menggunakan Bearer Token, ini tidak diperlukan. Menggunakan keduanya bisa ambigu.
    'Content-Type': 'application/json'
};

/**
 * Fungsi pembantu untuk memparsing respons JSON dari fetch.
 * Ini menangani kasus di mana respons bukan JSON yang valid.
 * Akan melemparkan error jika respons tidak OK dan tidak bisa diparse sebagai JSON.
 */
async function parseJsonResponse(response) {
    const contentType = response.headers.get('content-type');
    
    // Log status dan content type untuk debugging
    console.log(`[parseJsonResponse] Response status: ${response.status}, Content-Type: ${contentType}`);

    if (contentType && contentType.includes('application/json')) {
        return response.json();
    } else {
        const text = await response.text();
        console.warn(`[parseJsonResponse] Received non-JSON response from Cloudflare API (Status: ${response.status}):`, text.substring(0, 500) + (text.length > 500 ? '...' : '')); // Batasi panjang log
        
        // Jika respons tidak OK, lempar error dengan teks respons untuk debugging lebih lanjut
        if (!response.ok) {
            throw new Error(`Cloudflare API Error (Status ${response.status}): ${text.substring(0, 200)}...`); // Batasi panjang teks error
        }
        // Jika OK tapi bukan JSON, ini juga masalah, berarti API mengembalikan sesuatu yang tidak diharapkan
        throw new Error('Received unexpected non-JSON response from Cloudflare API, but status was OK.');
    }
}

// --- Rute API ---

/**
 * @route GET /api/subdomains
 * @description Mendapatkan daftar subdomain yang terdaftar di Cloudflare Workers.
 */
app.get('/api/subdomains', async (req, res) => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
    console.log(`[Backend] GET /api/subdomains: Fetching from Cloudflare URL: ${url}`); // Log permintaan ke Cloudflare
    try {
        const cfRes = await fetch(url, { headers: cloudflareHeaders });
        
        if (!cfRes.ok) {
            // Jika respons dari Cloudflare tidak OK (misal 4xx, 5xx), coba baca error dari sana
            const errorText = await cfRes.text();
            console.error(`[Backend Error] Cloudflare API responded with status ${cfRes.status} for /workers/domains. Raw response:`, errorText);
            
            let errorData;
            try {
                errorData = JSON.parse(errorText); // Coba parse sebagai JSON
            } catch (e) {
                // Gagal parse JSON, berarti responsnya mungkin HTML/plain text error dari Cloudflare
                console.error(`[Backend Error] Failed to parse Cloudflare error response as JSON. Original error:`, e.message);
                return res.status(cfRes.status).json({ 
                    success: false, 
                    message: `Cloudflare API Error (Status ${cfRes.status}): ${errorText.substring(0, 100)}... (Likely HTML/plain text error from Cloudflare)` 
                });
            }
            // Jika berhasil parse JSON, gunakan pesan error dari Cloudflare
            return res.status(cfRes.status).json({ 
                success: false, 
                message: errorData.errors?.[0]?.message || 'Failed to fetch subdomains from Cloudflare. (Cloudflare JSON Error)' 
            });
        }

        // Jika respons OK, coba parse sebagai JSON
        const data = await parseJsonResponse(cfRes); // Gunakan fungsi pembantu

        // Filter berdasarkan service name dan root domain untuk memastikan hanya yang relevan ditampilkan
        const filteredDomains = data.result
            .filter(domain => domain.service === CLOUDFLARE_SERVICE_NAME && domain.hostname.endsWith(CLOUDFLARE_ROOT_DOMAIN))
            .map(domain => ({
                hostname: domain.hostname,
                id: domain.id
            }));
        
        console.log(`[Backend] Successfully fetched ${filteredDomains.length} subdomains.`); // Log sukses
        res.json({ success: true, subdomains: filteredDomains });
        
    } catch (error) {
        console.error('[Backend Critical Error] Error fetching subdomains in API route:', error); // Log error lebih detail
        res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
    }
});

/**
 * @route POST /api/subdomains
 * @description Menambahkan subdomain baru ke Cloudflare Workers.
 */
app.post('/api/subdomains', async (req, res) => {
    const { subdomainPart } = req.body;
    console.log(`[Backend] POST /api/subdomains: Received request to add subdomain: ${subdomainPart}`); // Log permintaan

    if (!subdomainPart || subdomainPart.trim() === '') {
        return res.status(400).json({ success: false, message: 'Subdomain part cannot be empty.' });
    }
    // Validasi format subdomain: hanya huruf, angka, dan hyphen; tidak diawali/diakhiri hyphen
    if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
        return res.status(400).json({ success: false, message: 'Subdomain can only contain letters, numbers, and hyphens, and cannot start or end with a hyphen.' });
    }

    const fullDomain = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

    // Cek apakah domain sudah terdaftar di Cloudflare sebelum mencoba menambahkannya
    try {
        console.log(`[Backend] Checking if domain '${fullDomain}' already exists.`);
        const existingDomainsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`, { headers: cloudflareHeaders });
        
        if (!existingDomainsRes.ok) {
            const errorText = await existingDomainsRes.text();
            console.error(`[Backend Error] Cloudflare API responded with status ${existingDomainsRes.status} during existing domain check. Raw response:`, errorText);
            let errorData;
            try { 
                errorData = JSON.parse(errorText); 
            } catch(e) { /* ignore parse error for raw text error */ }
            return res.status(existingDomainsRes.status).json({ 
                success: false, 
                message: errorData?.errors?.[0]?.message || `Failed to check existing subdomains (Cloudflare error status: ${existingDomainsRes.status})` 
            });
        }
        
        const existingDomainsData = await parseJsonResponse(existingDomainsRes);

        if (existingDomainsData.result && existingDomainsData.result.some(d => d.hostname === fullDomain)) {
            console.warn(`[Backend Warning] Domain '${fullDomain}' is already registered.`);
            return res.status(409).json({ success: false, message: `Domain '${fullDomain}' is already registered.` });
        }
        console.log(`[Backend] Domain '${fullDomain}' is not yet registered.`);

    } catch (error) {
        console.error('[Backend Critical Error] Error checking existing domains in API route:', error);
        return res.status(500).json({ success: false, message: `Internal server error during domain check: ${error.message}` });
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains`;
    try {
        console.log(`[Backend] Sending PUT request to Cloudflare: ${url} for hostname: ${fullDomain}`); // Log request
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

        // Selalu coba parse respons, tapi bersiap untuk kegagalan
        const data = await parseJsonResponse(cfRes); // Gunakan fungsi pembantu

        if (cfRes.ok) {
            console.log(`[Backend] Subdomain '${fullDomain}' added successfully! Cloudflare response:`, data);
            res.status(201).json({ success: true, message: `Subdomain '${fullDomain}' added successfully!`, data: data.result });
        } else {
            console.error('[Backend Error] Cloudflare API Error (add subdomain):', data.errors || 'Unknown error', data); // Log detail error
            res.status(cfRes.status).json({ success: false, message: data.errors?.[0]?.message || 'Failed to add subdomain.' });
        }
    } catch (error) {
        console.error('[Backend Critical Error] Error adding subdomain in API route:', error);
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
    console.log(`[Backend] DELETE /api/subdomains/:id: Received request to delete subdomain ID: ${id}`); // Log permintaan

    // Verifikasi password admin
    if (password !== ADMIN_PASSWORD) {
        console.warn(`[Backend Warning] Incorrect password for deleting subdomain ID: ${id}`);
        return res.status(401).json({ success: false, message: 'Incorrect password.' });
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains/${id}`;
    try {
        console.log(`[Backend] Sending DELETE request to Cloudflare: ${url}`); // Log request
        const cfRes = await fetch(url, {
            method: 'DELETE',
            headers: cloudflareHeaders,
        });

        // Selalu coba parse respons, tapi bersiap untuk kegagalan
        let data;
        try {
            data = await parseJsonResponse(cfRes);
        } catch (jsonError) {
            // Jika parsing JSON gagal, tapi status OK, berarti mungkin sukses dengan respons kosong/aneh
            if (cfRes.ok) {
                console.warn(`[Backend Warning] DELETE Cloudflare API: Successful but received non-JSON or empty response for ID ${id}. Status: ${cfRes.status}. Original JSON error: ${jsonError.message}`);
                return res.json({ success: true, message: 'Subdomain deleted successfully (Cloudflare response was unusual but operation likely succeeded).' });
            }
            // Jika tidak OK dan JSON gagal, ini adalah error serius. Lempar ulang.
            console.error(`[Backend Error] Failed to parse JSON response for DELETE (Status: ${cfRes.status}). Original JSON error: ${jsonError.message}`);
            throw jsonError; 
        }

        if (cfRes.ok) {
            console.log(`[Backend] Subdomain ID ${id} deleted successfully! Cloudflare response:`, data);
            // Cloudflare API DELETE worker domain biasanya mengembalikan { success: true, errors: [], messages: [], result: null }
            res.json({ success: true, message: 'Subdomain deleted successfully!' });
        } else {
            // Cloudflare mengembalikan error, seperti 'Origin not found' (code 100114)
            console.error('[Backend Error] Cloudflare API Error (delete subdomain):', data.errors || 'Unknown error', data); // Log detail error
            const errorMessage = data.errors?.[0]?.message || 'Failed to delete subdomain from Cloudflare.';
            res.status(cfRes.status).json({ success: false, message: errorMessage });
        }
    } catch (error) {
        console.error(`[Backend Critical Error] Error deleting subdomain ID ${id} in API route:`, error);
        // Tangani spesifik error jika pesan 'Origin not found' dari Cloudflare API
        if (error.message.includes("Origin '") && error.message.includes("' not found.")) {
             res.status(404).json({ success: false, message: `Subdomain with ID '${id}' not found on Cloudflare.` });
        } else {
            res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
        }
    }
});

// Redirect root URL ke index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Jalankan server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Access the application at http://localhost:${PORT}`);
    console.log('--- Server Started ---');
});
