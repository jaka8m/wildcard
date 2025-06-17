require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json());

// ...cloudflareFetch sama ENV setup seperti sebelumnya...

// NOTE: Tanpa `/api` di depan path-nya
app.get('/subdomains', async (req, res, next) => {
  // ...logic GET subdomains...
});

app.post('/subdomains', async (req, res, next) => {
  // ...logic POST subdomains...
});

app.delete('/subdomains/:id', async (req, res, next) => {
  // ...logic DELETE subdomain...
});

// 404 JSON fallback
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

module.exports = app;
