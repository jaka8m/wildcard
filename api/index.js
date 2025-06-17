// api/index.js
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Pastikan 'node-fetch' terinstal

const app = express();

// --- Informasi Sensitif ---
// IDEALNYA, GUNAKAN VARIABEL LINGKUNGAN (process.env.NAMA_VARIABEL)
// Di Vercel, Anda bisa mengaturnya di pengaturan proyek: Project Settings -> Environment Variables
const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY || "YOUR_CLOUDFLARE_API_KEY"; // Ganti dengan kunci API Anda atau gunakan ENV
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "YOUR_CLOUDFLARE_ACCOUNT_ID"; // Ganti dengan ID Akun Anda atau gunakan ENV
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || "YOUR_CLOUDFLARE_ZONE_ID";    // Ganti dengan ID Zona Anda atau gunakan ENV
const CLOUDFLARE_API_EMAIL = process.env.CLOUDFLARE_API_EMAIL || "YOUR_CLOUDFLARE_API_EMAIL";            // Ganti dengan Email Akun Anda atau gunakan ENV
const CLOUDFLARE_SERVICE_NAME = process.env.CLOUDFLARE_SERVICE_NAME || "joss";                          // Ganti dengan nama Worker Service Anda
const CLOUDFLARE_ROOT_DOMAIN = process.env.CLOUDFLARE_ROOT_DOMAIN || "joss.krikkrik.tech";              // Domain utama yang Anda kelola
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "am";                                    // Ganti dengan password yang lebih kuat di produksi!

// --- Middleware ---
app.use(cors()); // Izinkan CORS untuk permintaan dari frontend Anda
app.use(express.json()); // Izinkan parsing body JSON

// Headers untuk Cloudflare API
const cloudflareHeaders = {
    'Authorization': `Bearer ${CLOUDFLARE_API_KEY}`,
    'X-Auth-Email': CLOUDFLARE_API_EMAIL,
    'Content-Type': 'application/json'
};

/**
 * Fungsi pembantu untuk memparsing respons JSON dari fetch.
 * Ini menangani kasus di mana respons bukan JSON yang valid.
 * Akan melemparkan error jika respons tidak OK dan tidak bisa diparse sebagai JSON.
 */
async function parseJsonResponse(response) {
    const contentType = response.headers.get('content-type');
    
    console.log(`[parseJsonResponse] Response status: ${response.status}, Content-Type: ${contentType}`);

    if (contentType && contentType.includes('application/json')) {
        return response.json();
    } else {
        const text = await response.text();
        console.warn(`[parseJsonResponse] Received non-JSON response from Cloudflare API (Status: ${response.status}):`, text.substring(0, 500) + (text.length > 500 ? '...' : '')); 
        
        if (!response.ok) {
            throw new Error(`Cloudflare API Error (Status ${response.status}): ${text.substring(0, 200)}...`);
        }
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
    console.log(`[Backend] GET /api/subdomains: Fetching from Cloudflare URL: ${url}`);
    try {
        const cfRes = await fetch(url, { headers: cloudflareHeaders });
        
        if (!cfRes.ok) {
            const errorText = await cfRes.text();
            console.error(`[Backend Error] Cloudflare API responded with status ${cfRes.status} for /workers/domains. Raw response:`, errorText);
            
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch (e) {
                console.error(`[Backend Error] Failed to parse Cloudflare error response as JSON. Original error:`, e.message);
                return res.status(cfRes.status).json({ 
                    success: false, 
                    message: `Cloudflare API Error (Status ${cfRes.status}): ${errorText.substring(0, 100)}... (Likely HTML/plain text error from Cloudflare)` 
                });
            }
            return res.status(cfRes.status).json({ 
                success: false, 
                message: errorData.errors?.[0]?.message || 'Failed to fetch subdomains from Cloudflare. (Cloudflare JSON Error)' 
            });
        }

        const data = await parseJsonResponse(cfRes);
        
        const filteredDomains = data.result
            .filter(domain => domain.service === CLOUDFLARE_SERVICE_NAME && domain.hostname.endsWith(CLOUDFLARE_ROOT_DOMAIN))
            .map(domain => ({
                hostname: domain.hostname,
                id: domain.id
            }));
        
        console.log(`[Backend] Successfully fetched ${filteredDomains.length} subdomains.`);
        res.json({ success: true, subdomains: filteredDomains });
        
    } catch (error) {
        console.error('[Backend Critical Error] Error fetching subdomains in API route:', error);
        res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
    }
});

/**
 * @route POST /api/subdomains
 * @description Menambahkan subdomain baru ke Cloudflare Workers.
 */
app.post('/api/subdomains', async (req, res) => {
    const { subdomainPart } = req.body;
    console.log(`[Backend] POST /api/subdomains: Received request to add subdomain: ${subdomainPart}`);

    if (!subdomainPart || subdomainPart.trim() === '') {
        return res.status(400).json({ success: false, message: 'Subdomain part cannot be empty.' });
    }
    if (!/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(subdomainPart)) {
        return res.status(400).json({ success: false, message: 'Subdomain can only contain letters, numbers, and hyphens, and cannot start or end with a hyphen.' });
    }

    const fullDomain = `${subdomainPart.toLowerCase()}.${CLOUDFLARE_ROOT_DOMAIN}`;

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
        console.log(`[Backend] Sending PUT request to Cloudflare: ${url} for hostname: ${fullDomain}`);
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
            console.log(`[Backend] Subdomain '${fullDomain}' added successfully! Cloudflare response:`, data);
            res.status(201).json({ success: true, message: `Subdomain '${fullDomain}' added successfully!`, data: data.result });
        } else {
            console.error('[Backend Error] Cloudflare API Error (add subdomain):', data.errors || 'Unknown error', data);
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
    console.log(`[Backend] DELETE /api/subdomains/:id: Received request to delete subdomain ID: ${id}`);

    if (password !== ADMIN_PASSWORD) {
        console.warn(`[Backend Warning] Incorrect password for deleting subdomain ID: ${id}`);
        return res.status(401).json({ success: false, message: 'Incorrect password.' });
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains/${id}`;
    try {
        console.log(`[Backend] Sending DELETE request to Cloudflare: ${url}`);
        const cfRes = await fetch(url, {
            method: 'DELETE',
            headers: cloudflareHeaders,
        });

        let data;
        try {
            data = await parseJsonResponse(cfRes);
        } catch (jsonError) {
            if (cfRes.ok) {
                console.warn(`[Backend Warning] DELETE Cloudflare API: Successful but received non-JSON or empty response for ID ${id}. Status: ${cfRes.status}. Original JSON error: ${jsonError.message}`);
                return res.json({ success: true, message: 'Subdomain deleted successfully (Cloudflare response was unusual but operation likely succeeded).' });
            }
            console.error(`[Backend Error] Failed to parse JSON response for DELETE (Status: ${cfRes.status}). Original JSON error: ${jsonError.message}`);
            throw jsonError; 
        }

        if (cfRes.ok) {
            console.log(`[Backend] Subdomain ID ${id} deleted successfully! Cloudflare response:`, data);
            res.json({ success: true, message: 'Subdomain deleted successfully!' });
        } else {
            console.error('[Backend Error] Cloudflare API Error (delete subdomain):', data.errors || 'Unknown error', data);
            const errorMessage = data.errors?.[0]?.message || 'Failed to delete subdomain from Cloudflare.';
            res.status(cfRes.status).json({ success: false, message: errorMessage });
        }
    } catch (error) {
        console.error(`[Backend Critical Error] Error deleting subdomain ID ${id} in API route:`, error);
        if (error.message.includes("Origin '") && error.message.includes("' not found.")) {
             res.status(404).json({ success: false, message: `Subdomain with ID '${id}' not found on Cloudflare.` });
        } else {
            res.status(500).json({ success: false, message: `Internal server error: ${error.message}` });
        }
    }
});

// Penting: Export app untuk Vercel sebagai Serverless Function
module.exports = app;

// Untuk pengembangan lokal, Anda bisa menambahkan ini:
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//     console.log(`Server running on http://localhost:${PORT}`);
//     console.log(`Access the application at http://localhost:${PORT}`);
//     console.log('--- Server Started ---');
// });
