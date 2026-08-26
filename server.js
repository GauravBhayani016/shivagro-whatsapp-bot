/**
 * ShivAgro WhatsApp Bot Server
 * 
 * Uses @whiskeysockets/baileys (pure WebSocket, no browser) to connect WhatsApp.
 * Exposes a REST API that the ShivAgroCRM frontend calls to send messages.
 * 
 * Endpoints:
 *   GET  /         → health check + connection status
 *   GET  /status   → JSON connection status (for CRM settings page)
 *   GET  /qr       → HTML page with QR code to scan (first-time setup only)
 *   POST /send     → send a WhatsApp message { phone, message }
 * 
 * Environment Variables:
 *   BOT_SECRET  → secret token to protect /send endpoint (default: shivagro-bot)
 *   PORT        → server port (default: 3030, Railway sets this automatically)
 */

import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// CORS: allow the Netlify CRM frontend to call this bot
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// ─── State ────────────────────────────────────────────────────────────────────
const BOT_SECRET = process.env.BOT_SECRET || 'shivagro-bot';
let sock = null;
let latestQR = null;
let isConnected = false;
let connectionStatus = 'connecting'; // 'connecting' | 'qr_ready' | 'connected' | 'disconnected'

// ─── WhatsApp Connection ──────────────────────────────────────────────────────
async function connectToWhatsApp() {
  console.log('[WA] Initializing WhatsApp connection...');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WA] Using WA v${version.join('.')} (isLatest: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,           // shows QR in Railway logs too
    browser: ['ShivAgro Bot', 'Chrome', '124.0'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
  });

  // Save credentials whenever they update (keeps session alive after restart)
  sock.ev.on('creds.update', saveCreds);

  // Handle connection state changes
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = 'qr_ready';
      console.log('[WA] 📱 QR Code ready! Visit /qr to scan it.');
    }

    if (connection === 'open') {
      isConnected = true;
      latestQR = null;
      connectionStatus = 'connected';
      console.log('[WA] ✅ WhatsApp connected and ready to send messages!');
    }

    if (connection === 'close') {
      isConnected = false;
      connectionStatus = 'disconnected';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[WA] Connection closed. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        connectionStatus = 'connecting';
        // Wait 5 seconds before reconnecting to avoid hammering WhatsApp servers
        setTimeout(connectToWhatsApp, 5000);
      } else {
        connectionStatus = 'logged_out';
        console.log('[WA] ⚠️  Logged out! Please delete auth_info_baileys/ and restart to re-scan QR.');
      }
    }
  });
}

// ─── API Routes ───────────────────────────────────────────────────────────────

/** Health check */
app.get('/', (req, res) => {
  res.json({
    service: 'ShivAgro WhatsApp Bot',
    version: '1.0.0',
    status: connectionStatus,
    connected: isConnected,
    hint: isConnected ? 'Ready to send messages!' : 'Visit /qr to scan QR code',
  });
});

/** JSON status for CRM Settings page to check connectivity */
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    status: connectionStatus,
    qrAvailable: !!latestQR,
  });
});

/** QR Code HTML page (only needed once on first setup) */
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><title>ShivAgro Bot Status</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4">
        <div style="max-width:400px;margin:auto;background:white;border-radius:16px;padding:40px;box-shadow:0 4px 20px #0001">
          <div style="font-size:64px">✅</div>
          <h2 style="color:#16a34a;margin:16px 0 8px">WhatsApp Connected!</h2>
          <p style="color:#555">Your bot is running and ready to send messages.</p>
          <p style="color:#888;font-size:13px;margin-top:24px">No QR scan needed. Messages will be sent automatically.</p>
        </div>
      </body>
      </html>
    `);
  }

  if (!latestQR) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="5">
        <title>ShivAgro Bot - Generating QR</title>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#fffbeb">
        <div style="max-width:400px;margin:auto;background:white;border-radius:16px;padding:40px;box-shadow:0 4px 20px #0001">
          <div style="font-size:64px">⏳</div>
          <h2 style="color:#d97706">Generating QR Code...</h2>
          <p style="color:#555">Please wait a few seconds. This page will auto-refresh.</p>
          <p style="color:#aaa;font-size:12px">Status: ${connectionStatus}</p>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const qrImageUrl = await QRCode.toDataURL(latestQR, {
      width: 300,
      margin: 2,
      color: { dark: '#000', light: '#fff' },
    });

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="30">
        <title>ShivAgro Bot - Scan QR</title>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:40px;background:#f0fdf4">
        <div style="max-width:440px;margin:auto;background:white;border-radius:16px;padding:40px;box-shadow:0 4px 20px #0001">
          <h2 style="color:#16a34a;margin-bottom:4px">📱 Scan QR with WhatsApp</h2>
          <p style="color:#555;font-size:14px;margin-bottom:20px">
            Open <strong>WhatsApp</strong> → <strong>Linked Devices</strong> → <strong>Link a Device</strong>
          </p>
          <img src="${qrImageUrl}"
               alt="WhatsApp QR Code"
               style="border:4px solid #16a34a;border-radius:12px;width:280px;height:280px" />
          <p style="color:#888;font-size:12px;margin-top:16px">
            ⏱ QR expires every ~60 seconds. Page auto-refreshes every 30s.<br>
            After scanning, this page will show "Connected ✅".
          </p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error generating QR: ' + err.message);
  }
});

/** Send a WhatsApp message or PDF document */
app.post('/send', async (req, res) => {
  // Validate secret token
  const clientSecret = req.headers['x-bot-secret'];
  if (clientSecret !== BOT_SECRET) {
    console.warn(`[WA] ⛔ Unauthorized /send attempt from ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid secret' });
  }

  // Check connection
  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp not connected. Visit /qr to scan QR code.',
      status: connectionStatus,
    });
  }

  const { phone, message, pdfBase64, fileName, caption } = req.body;
  if (!phone || (!message && !pdfBase64)) {
    return res.status(400).json({
      success: false,
      error: '"phone" and either "message" or "pdfBase64" are required',
    });
  }

  try {
    // Clean and format phone number for India
    const digits = String(phone).replace(/[^0-9]/g, '');
    const fullPhone = digits.length === 10 ? `91${digits}` : digits;
    const chatId = `${fullPhone}@s.whatsapp.net`;

    if (pdfBase64) {
      // Strip any data URL prefix e.g. "data:application/pdf;base64,"
      const cleanBase64 = String(pdfBase64)
        .replace(/^data:application\/pdf;base64,/, '')
        .replace(/^data:.*?;base64,/, '');
      const pdfBuffer = Buffer.from(cleanBase64, 'base64');
      const docName = fileName || 'ShivAgro-Invoice.pdf';
      const docCaption = caption || message || '🧾 Shiv Agro Agency - Retail Invoice';

      await sock.sendMessage(chatId, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: docName,
        caption: docCaption,
      });

      console.log(`[WA] 📄 PDF Document sent to ${fullPhone} (${docName})`);
      return res.json({ success: true, to: fullPhone, provider: 'baileys', type: 'pdf' });
    }

    // Otherwise send plain text message
    await sock.sendMessage(chatId, { text: message });
    console.log(`[WA] 💬 Text message sent to ${fullPhone}`);

    res.json({ success: true, to: fullPhone, provider: 'baileys', type: 'text' });
  } catch (err) {
    console.error('[WA] ❌ Send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3030', 10);

// Keep-alive timer for Render / cloud free tiers (pings itself every 10 minutes)
setInterval(() => {
  const pingUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  fetch(`${pingUrl}/status`).catch(() => {});
}, 10 * 60 * 1000);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 ShivAgro WhatsApp Bot running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   QR Scan: http://localhost:${PORT}/qr`);
  console.log(`   Secret: ${BOT_SECRET === 'shivagro-bot' ? '⚠️  using default (set BOT_SECRET env var!)' : '✅ custom secret set'}\n`);
  await connectToWhatsApp();
});
