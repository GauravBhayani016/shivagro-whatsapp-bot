/**
 * ShivAgro WhatsApp Bot & Cloud Sync Hub Server
 * 
 * Uses @whiskeysockets/baileys (pure WebSocket, no browser) to connect WhatsApp.
 * Exposes REST APIs for:
 *   1. Sending WhatsApp messages & PDF invoices
 *   2. Real-time Cloud Sync between Mobile 1, Mobile 2 (Papa's phone), and Netlify PC Web CRM
 *   3. Supabase Cloud Session Persistence (never loses WhatsApp connection on Render restarts)
 *   4. Instant QR Code scanning & 8-Digit Phone Pairing Code Linking
 */

import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[Process Error] Uncaught Exception:', err?.message || err);
  if (err?.stack) console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process Error] Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// CORS: allow the Netlify CRM frontend & mobile apps to call this server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// ─── Constants & Cloud Config ──────────────────────────────────────────────────
const BOT_SECRET = process.env.BOT_SECRET || 'shivagro-secret-2024';
const PORT = parseInt(process.env.PORT || '3030', 10);
const DB_FILE = path.join(process.cwd(), 'crm_cloud_database.json');
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://grltiynyjedlsqmnxkxe.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdybHRpeW55amVkbHNxbW54a3hlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NTQ2MjgsImV4cCI6MjEwMzIzMDYyOH0.aj99P5KzlBloLymjzkExj_UXLj7xwh53uxQmeJJet-g';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helper: Create Timestamp with accurate current clock time ─────────────────
function createTimestampWithTime(dateInput) {
  const now = new Date();
  if (!dateInput) return now.toISOString();
  if (typeof dateInput === 'string' && dateInput.includes('T')) {
    return new Date(dateInput).toISOString();
  }
  if (typeof dateInput === 'string' && dateInput.includes('-')) {
    const parts = dateInput.split('-').map(Number);
    if (parts.length === 3) {
      const [year, month, day] = parts;
      const combined = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
      return combined.toISOString();
    }
  }
  return new Date(dateInput).toISOString();
}

// ─── Default Initial Settings ─────────────────────────────────────────────────
const INITIAL_SHOP_SETTINGS = {
  shopName: 'Shiv Agro Agency',
  shopNameGujarati: 'શિવ એગ્રો એજન્સી',
  proprietor: 'Vijay C. Bhayani',
  proprietorGujarati: 'વિજય સી. ભાયાણી',
  mobile1: '99098 73595',
  mobile2: '94295 39279',
  panNo: 'AUTPB3720D',
  seedLicense: '254',
  pesticideLicense: '3426',
  fertilizerLicense: '333',
  address: 'Vankal, Main Road, Ta. Mangrol, Dist. Surat',
  addressGujarati: 'મુ. વાંકલ, મેઈન રોડ, તા. માંગરોળ, જિ. સુરત',
  jurisdiction: 'Subject to Mangrol Jurisdiction',
  termsGujarati: 'નોંધ : વાવણીમાં ભુલચુક, પ્રતિકુળ હવામાન વગેરે કારણસર બીજના ઓછા ઉગવા કે ન ઉગવાની તેમજ ફસલ અંગેની કોઈપણ ફરિયાદ, નુકશાની માટે પેઢી જવાબદાર નથી. વેચેલો માલ પરત લેવામાં કે બદલી આપવામાં આવશે નહિ. (ખેતીના ઉપયોગ માટે)',
};

const DEFAULT_PACKAGE_SIZES = [
  '100 ML', '250 ML', '500 ML', '1 Litre', '5 Litre',
  '250 GM', '500 GM', '1 KG', '5 KG', '10 KG', '25 KG', '50 KG',
  '1 Pc', '1 Packet', 'Other'
];

// ─── Database Operations (Thread-safe JSON Store + Cloud Fallback) ─────────────
function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return {
        products: Array.isArray(parsed.products) ? parsed.products : [],
        bills: Array.isArray(parsed.bills) ? parsed.bills : [],
        movements: Array.isArray(parsed.movements) ? parsed.movements : [],
        settings: parsed.settings || INITIAL_SHOP_SETTINGS,
        packageSizes: parsed.packageSizes || DEFAULT_PACKAGE_SIZES,
        lastUpdated: parsed.lastUpdated || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[DB] Could not read database file, initializing defaults:', err.message);
  }

  const initialDb = {
    products: [],
    bills: [],
    movements: [],
    settings: INITIAL_SHOP_SETTINGS,
    packageSizes: DEFAULT_PACKAGE_SIZES,
    lastUpdated: new Date().toISOString(),
  };
  saveDb(initialDb);
  return initialDb;
}

function saveDb(data) {
  try {
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[DB] Failed to save database file:', err.message);
  }
}

let db = loadDb();

// ─── Supabase Persistent Session Auth ──────────────────────────────────────────
async function restoreAuthFromSupabase() {
  try {
    if (!fs.existsSync(AUTH_DIR)) {
      await fs.promises.mkdir(AUTH_DIR, { recursive: true });
    }
    if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
      console.log('[WA Auth] Local creds.json found in container.');
      return true;
    }
    console.log('[WA Auth] Local creds not found, checking session in Supabase...');
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('data')
      .eq('session_id', 'shivagro_bot')
      .single();

    if (!error && data && data.data && typeof data.data === 'object') {
      const files = data.data;
      if (files['creds.json']) {
        try {
          const parsedCreds = JSON.parse(files['creds.json']);
          if (parsedCreds.registered === false) {
            console.log('[WA Auth] ⚠️ Stale unregistered session in Supabase. Generating fresh QR code...');
            return false;
          }
        } catch {}
      }
      const entries = Object.entries(files);
      if (entries.length === 0) return false;

      const writePromises = entries.map(([filename, content]) => {
        if (filename && typeof content === 'string') {
          return fs.promises.writeFile(path.join(AUTH_DIR, filename), content, 'utf8');
        }
        return Promise.resolve();
      });
      await Promise.all(writePromises);
      console.log(`[WA Auth] ✅ Restored ${entries.length} valid session files!`);
      return true;
    }
  } catch (err) {
    console.warn('[WA Auth] Supabase auth restore notice:', err.message);
  }
  return false;
}

let backupTimeout = null;
function triggerAuthBackupToSupabase() {
  if (backupTimeout) clearTimeout(backupTimeout);
  backupTimeout = setTimeout(async () => {
    try {
      if (!fs.existsSync(AUTH_DIR)) return;
      const fileNames = await fs.promises.readdir(AUTH_DIR);
      if (fileNames.length === 0) return;
      const bundle = {};
      await Promise.all(
        fileNames.map(async (file) => {
          const fullPath = path.join(AUTH_DIR, file);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.isFile()) {
              bundle[file] = await fs.promises.readFile(fullPath, 'utf8');
            }
          } catch {}
        })
      );
      await supabase.from('whatsapp_sessions').upsert({
        session_id: 'shivagro_bot',
        data: bundle,
        updated_at: new Date().toISOString(),
      });
      console.log(`[WA Auth] ☁️ WhatsApp session successfully backed up to Supabase Cloud.`);
    } catch (err) {
      console.warn('[WA Auth] Supabase backup notice:', err.message);
    }
  }, 3000);
}

// ─── WhatsApp Connection State ────────────────────────────────────────────────
let sock = null;
let latestQR = null;
let latestQrDataUrl = null;
let isConnected = false;
let connectedUserPhone = '';
let connectionStatus = 'connecting';
let reconnectAttempts = 0;
let reconnectTimer = null;
const startTime = new Date();

async function connectToWhatsApp() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  console.log(`[WA] Initializing WhatsApp connection... (Attempt ${reconnectAttempts + 1})`);
  connectionStatus = 'connecting';

  try {
    await restoreAuthFromSupabase();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307],
      isLatest: true,
    }));
    console.log(`[WA] Using WA v${version.join('.')} (isLatest: ${isLatest})`);

    if (sock) {
      try {
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('connection.update');
        sock.end(undefined);
      } catch (cleanupErr) {
        console.warn('[WA] Socket cleanup warning:', cleanupErr.message);
      }
      sock = null;
    }

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      // Browsers.ubuntu('Chrome') ensures WhatsApp backend accepts Pairing Codes & QR handshakes
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      emitOwnEvents: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      triggerAuthBackupToSupabase();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = qr;
        connectionStatus = 'qr_ready';
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#0f172a', light: '#ffffff' },
          });
        } catch {}
        console.log('[WA] 📱 Fresh QR Code generated! Ready to scan or pair with 8-digit code.');
      }

      if (connection === 'open') {
        isConnected = true;
        latestQR = null;
        latestQrDataUrl = null;
        connectionStatus = 'connected';
        reconnectAttempts = 0;
        
        try {
          const rawId = sock?.user?.id || '';
          connectedUserPhone = rawId.split(':')[0].split('@')[0];
        } catch {}

        console.log(`[WA] ✅ WhatsApp connected successfully! Active number: ${connectedUserPhone || 'Shop WhatsApp'}`);
        triggerAuthBackupToSupabase();
      }

      if (connection === 'close') {
        isConnected = false;
        latestQR = null;
        latestQrDataUrl = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        console.log(`[WA] ⚠️ Connection closed. Code: ${statusCode} (Reason: ${lastDisconnect?.error?.message || 'Unknown'})`);

        if (isLoggedOut) {
          connectionStatus = 'logged_out';
          console.log('[WA] ⚠️ Logged out from WhatsApp. Wiping stale auth dir to generate new QR...');
          try {
            if (fs.existsSync(AUTH_DIR)) {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
            await supabase.from('whatsapp_sessions').delete().eq('session_id', 'shivagro_bot');
          } catch {}
          reconnectAttempts = 0;
          reconnectTimer = setTimeout(connectToWhatsApp, 1500);
        } else {
          connectionStatus = 'disconnected';
          reconnectAttempts++;
          const delay = Math.min(3000 * Math.pow(1.3, Math.min(reconnectAttempts, 8)), 30000);
          console.log(`[WA] 🔄 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
          reconnectTimer = setTimeout(connectToWhatsApp, delay);
        }
      }
    });
  } catch (initErr) {
    console.error('[WA] Initialization failed:', initErr.message);
    connectionStatus = 'disconnected';
    reconnectAttempts++;
    reconnectTimer = setTimeout(connectToWhatsApp, 5000);
  }
}

/** Reset Session completely */
async function resetWhatsAppSession() {
  console.log('[WA] 🧹 Resetting WhatsApp session (wiping local files and Supabase record)...');
  isConnected = false;
  latestQR = null;
  latestQrDataUrl = null;
  connectedUserPhone = '';
  connectionStatus = 'connecting';

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (sock) {
    try {
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('connection.update');
      sock.end(undefined);
    } catch {}
    sock = null;
  }

  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    console.warn('[WA] Could not remove local auth dir:', e.message);
  }

  try {
    await supabase.from('whatsapp_sessions').delete().eq('session_id', 'shivagro_bot');
    console.log('[WA] ☁️ Deleted Supabase whatsapp_sessions record.');
  } catch (e) {
    console.warn('[WA] Supabase delete session notice:', e.message);
  }

  reconnectAttempts = 0;
  await connectToWhatsApp();
}

// ─── Real-Time Cloud Sync Endpoints (Multi-Device Sync) ────────────────────────

/** Get All Live Data for Real-Time Sync */
app.get('/api/sync/all', async (req, res) => {
  db = loadDb();

  // Always fetch fresh products & stock from Supabase for guaranteed multi-device accuracy
  try {
    const { data: supaProds, error: pErr } = await supabase
      .from('products')
      .select('*')
      .order('name', { ascending: true });

    if (!pErr && supaProds && supaProds.length > 0) {
      db.products = supaProds.map((p) => ({
        id: p.id,
        name: p.name,
        brand: p.brand || '',
        category: p.category || 'SEEDS',
        packageSize: p.package_size,
        batchNumber: p.batch_number || '',
        expiryDate: p.expiry_date || '',
        sellingPrice: Number(p.selling_price) || 0,
        currentStock: p.current_stock || 0,
        lowStockThreshold: p.low_stock_threshold || 10,
        isActive: p.is_active !== false,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      }));
      saveDb(db);
    }
  } catch (err) {
    console.warn('[Sync] Supabase sync fetch notice:', err.message);
  }

  res.json({
    success: true,
    products: db.products || [],
    bills: db.bills || [],
    movements: db.movements || [],
    settings: db.settings || INITIAL_SHOP_SETTINGS,
    packageSizes: db.packageSizes || DEFAULT_PACKAGE_SIZES,
    lastUpdated: db.lastUpdated,
    serverTime: new Date().toISOString(),
  });
});

/** Create or Update Product */
app.post('/api/sync/product', async (req, res) => {
  const productData = req.body;
  if (!productData.name || !productData.packageSize) {
    return res.status(400).json({ success: false, error: 'Product name and package size are required' });
  }

  db = loadDb();
  const now = new Date().toISOString();
  let resultProduct;

  const existingLocalIdx = db.products.findIndex(
    (p) =>
      p.id === productData.id ||
      (p.name.trim().toLowerCase() === productData.name.trim().toLowerCase() &&
        p.packageSize.trim().toLowerCase() === productData.packageSize.trim().toLowerCase())
  );

  if (existingLocalIdx !== -1) {
    resultProduct = { ...db.products[existingLocalIdx], ...productData, updatedAt: now };
    db.products[existingLocalIdx] = resultProduct;
  } else {
    resultProduct = {
      ...productData,
      id: productData.id || `prod-${Date.now()}`,
      sellingPrice: Number(productData.sellingPrice) || 0,
      currentStock: Number(productData.currentStock) || 0,
      lowStockThreshold: Number(productData.lowStockThreshold) || 10,
      isActive: productData.isActive !== false,
      createdAt: productData.createdAt || now,
      updatedAt: now,
    };
    db.products.unshift(resultProduct);

    if (resultProduct.currentStock > 0) {
      db.movements.unshift({
        id: `mov-${Date.now()}`,
        productId: resultProduct.id,
        productName: resultProduct.name,
        packageSize: resultProduct.packageSize,
        movementType: 'STOCK_IN',
        quantity: resultProduct.currentStock,
        previousStock: 0,
        newStock: resultProduct.currentStock,
        referenceType: 'INITIAL',
        note: 'Initial Product Stock Addition',
        createdBy: 'Vijaybhai Bhayani',
        createdAt: now,
      });
    }
  }

  saveDb(db);

  // Sync to Supabase without creating duplicates
  try {
    const { data: existingSupa } = await supabase
      .from('products')
      .select('id')
      .ilike('name', resultProduct.name.trim())
      .ilike('package_size', resultProduct.packageSize.trim())
      .limit(1);

    if (existingSupa && existingSupa.length > 0) {
      await supabase
        .from('products')
        .update({
          name: resultProduct.name,
          brand: resultProduct.brand || '',
          category: resultProduct.category || 'SEEDS',
          package_size: resultProduct.packageSize,
          batch_number: resultProduct.batchNumber || '',
          expiry_date: resultProduct.expiryDate || '',
          selling_price: resultProduct.sellingPrice,
          current_stock: resultProduct.currentStock,
          low_stock_threshold: resultProduct.lowStockThreshold || 10,
          is_active: resultProduct.isActive !== false,
          updated_at: now,
        })
        .eq('id', existingSupa[0].id);
      resultProduct.id = existingSupa[0].id;
    } else {
      await supabase.from('products').insert({
        id: resultProduct.id,
        name: resultProduct.name,
        brand: resultProduct.brand || '',
        category: resultProduct.category || 'SEEDS',
        package_size: resultProduct.packageSize,
        batch_number: resultProduct.batchNumber || '',
        expiry_date: resultProduct.expiryDate || '',
        selling_price: resultProduct.sellingPrice,
        current_stock: resultProduct.currentStock,
        low_stock_threshold: resultProduct.lowStockThreshold || 10,
        is_active: resultProduct.isActive !== false,
        created_at: resultProduct.createdAt || now,
        updated_at: now,
      });
    }
  } catch (err) {
    console.warn('[Sync] Supabase sync product error:', err.message);
  }

  res.json({ success: true, product: resultProduct });
});

/** Delete Product */
app.post('/api/sync/delete-product', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, error: 'Product ID required' });

  db = loadDb();
  db.products = db.products.filter((p) => p.id !== id);
  db.movements = db.movements.filter((m) => m.productId !== id);
  saveDb(db);

  try {
    await supabase.from('stock_movements').delete().eq('product_id', id);
    await supabase.from('products').delete().eq('id', id);
  } catch {}

  res.json({ success: true, deletedId: id });
});

/** Stock Adjustment */
app.post('/api/sync/stock', async (req, res) => {
  const { productId, quantity, newStock, mode, note, date } = req.body;
  if (!productId) return res.status(400).json({ success: false, error: 'Product ID required' });

  db = loadDb();
  const prodIdx = db.products.findIndex((p) => p.id === productId);
  if (prodIdx === -1) return res.status(404).json({ success: false, error: 'Product not found' });

  const target = db.products[prodIdx];
  const prevStock = target.currentStock;
  const entryDate = createTimestampWithTime(date);
  let finalStock = prevStock;
  let diff = 0;

  if (mode === 'ADD' || (quantity !== undefined && newStock === undefined)) {
    const addQty = parseInt(quantity, 10) || 0;
    if (addQty <= 0) return res.status(400).json({ success: false, error: 'Quantity must be > 0' });
    finalStock = prevStock + addQty;
    diff = addQty;
  } else {
    finalStock = Math.max(0, parseInt(newStock, 10) || 0);
    diff = finalStock - prevStock;
  }

  target.currentStock = finalStock;
  target.updatedAt = entryDate;
  db.products[prodIdx] = target;

  if (diff !== 0) {
    db.movements.unshift({
      id: `mov-${Date.now()}`,
      productId: target.id,
      productName: target.name,
      packageSize: target.packageSize,
      movementType: diff > 0 ? 'STOCK_IN' : 'MANUAL_ADJUSTMENT',
      quantity: diff,
      previousStock: prevStock,
      newStock: finalStock,
      referenceType: 'MANUAL',
      note: note || (diff > 0 ? `Stock added: +${diff}` : `Stock adjusted: ${diff}`),
      createdBy: 'Vijaybhai Bhayani',
      createdAt: entryDate,
    });
    db.movements.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  saveDb(db);

  try {
    await supabase.from('products').update({ current_stock: finalStock, updated_at: entryDate }).eq('id', productId);
  } catch {}

  res.json({ success: true, product: target });
});

/** Create Bill & Deduct Stock */
app.post('/api/sync/bill', async (req, res) => {
  const billData = req.body;
  if (!billData.items || billData.items.length === 0) {
    return res.status(400).json({ success: false, error: 'Bill items are required' });
  }

  db = loadDb();
  const now = new Date().toISOString();

  let maxSeq = 0;
  (db.bills || []).forEach((b) => {
    const m = b.billNumber?.match(/BILL-(\d+)/);
    if (m) {
      const s = parseInt(m[1], 10);
      if (s > maxSeq) maxSeq = s;
    }
  });
  const billNumber = billData.billNumber || `BILL-${String(maxSeq + 1).padStart(6, '0')}`;
  const total = billData.items.reduce((s, it) => s + (Number(it.quantity) * Number(it.rate)), 0);

  const newBill = {
    id: billData.id || `bill-${Date.now()}`,
    billNumber,
    customerName: billData.customerName?.trim() || 'Cash Customer',
    customerPhone: billData.customerPhone?.trim() || undefined,
    customerAddress: billData.customerAddress?.trim() || undefined,
    subtotal: total,
    total,
    paymentMethod: billData.paymentMethod || 'CASH',
    paymentStatus: billData.paymentMethod === 'PENDING' ? 'PENDING' : 'PAID',
    dueDate: billData.dueDate || undefined,
    paidAt: billData.paymentMethod !== 'PENDING' ? now : undefined,
    status: 'FINAL',
    createdBy: billData.createdBy || 'Vijaybhai Bhayani',
    createdAt: billData.createdAt || now,
    items: billData.items.map((it, idx) => ({
      id: it.id || `bi-${Date.now()}-${idx}`,
      productId: it.productId || null,
      itemType: it.itemType || 'INVENTORY',
      itemName: it.itemName,
      manufacturer: it.manufacturer || '',
      packageSize: it.packageSize || '',
      batchNumber: it.batchNumber || '—',
      expiryDate: it.expiryDate || '—',
      quantity: Number(it.quantity),
      rate: Number(it.rate),
      amount: Number(it.quantity) * Number(it.rate),
    })),
  };

  for (const it of newBill.items) {
    if (it.itemType === 'INVENTORY' && it.productId) {
      const prodIdx = db.products.findIndex((p) => p.id === it.productId);
      if (prodIdx !== -1) {
        const prod = db.products[prodIdx];
        const prev = prod.currentStock;
        const next = Math.max(0, prev - it.quantity);
        prod.currentStock = next;
        prod.updatedAt = now;
        db.products[prodIdx] = prod;

        db.movements.unshift({
          id: `mov-${Date.now()}-${it.productId}`,
          productId: prod.id,
          productName: prod.name,
          packageSize: prod.packageSize,
          movementType: 'SALE',
          quantity: -it.quantity,
          previousStock: prev,
          newStock: next,
          referenceType: 'BILL',
          referenceId: billNumber,
          note: `Sold ${it.quantity} units to ${newBill.customerName} (Bill #${billNumber})`,
          createdBy: newBill.createdBy,
          createdAt: now,
        });
      }
    }
  }

  db.movements.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  db.bills.unshift(newBill);
  saveDb(db);

  res.json({ success: true, bill: newBill });
});

/** Delete Bill & Restore Stock */
app.post('/api/sync/delete-bill', (req, res) => {
  const { id, restoreStock } = req.body;
  if (!id) return res.status(400).json({ success: false, error: 'Bill ID required' });

  db = loadDb();
  const bill = db.bills.find((b) => b.id === id);

  if (bill && restoreStock !== false) {
    const now = new Date().toISOString();
    for (const it of bill.items || []) {
      if (it.itemType === 'INVENTORY' && it.productId) {
        const prodIdx = db.products.findIndex((p) => p.id === it.productId);
        if (prodIdx !== -1) {
          const prod = db.products[prodIdx];
          const prev = prod.currentStock;
          const next = prev + it.quantity;
          prod.currentStock = next;
          prod.updatedAt = now;
          db.products[prodIdx] = prod;

          db.movements.unshift({
            id: `mov-${Date.now()}-${it.productId}`,
            productId: prod.id,
            productName: prod.name,
            packageSize: prod.packageSize,
            movementType: 'CORRECTION',
            quantity: it.quantity,
            previousStock: prev,
            newStock: next,
            referenceType: 'BILL',
            referenceId: bill.billNumber,
            note: `Restored stock from deleted Bill #${bill.billNumber}`,
            createdBy: 'Vijaybhai Bhayani',
            createdAt: now,
          });
        }
      }
    }
  }

  db.bills = db.bills.filter((b) => b.id !== id);
  db.movements.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  saveDb(db);

  res.json({ success: true, deletedId: id });
});

/** Save Settings */
app.post('/api/sync/settings', (req, res) => {
  const { settings, packageSizes } = req.body;
  db = loadDb();
  if (settings) db.settings = { ...db.settings, ...settings };
  if (packageSizes) db.packageSizes = packageSizes;
  saveDb(db);
  res.json({ success: true, settings: db.settings, packageSizes: db.packageSizes });
});

/** Wipe / Reset All Data */
app.post('/api/sync/reset-database', (req, res) => {
  db = {
    products: [],
    bills: [],
    movements: [],
    settings: db.settings || INITIAL_SHOP_SETTINGS,
    packageSizes: db.packageSizes || DEFAULT_PACKAGE_SIZES,
    lastUpdated: new Date().toISOString(),
  };
  saveDb(db);
  res.json({ success: true, message: 'All database records wiped clean for fresh start.' });
});

// ─── Health & QR Routes ───────────────────────────────────────────────────────

/** Health check */
app.get('/', (req, res) => {
  res.json({
    service: 'Shiv Agro WhatsApp Bot & Cloud Sync Hub',
    version: '3.0.0',
    status: connectionStatus,
    connected: isConnected,
    userPhone: connectedUserPhone,
    totalProducts: db.products?.length || 0,
    totalBills: db.bills?.length || 0,
    uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
    hint: isConnected ? `WhatsApp ready (${connectedUserPhone}) & Cloud Sync Active!` : 'Visit /qr to scan QR code or get 8-digit pairing code',
  });
});

/** Ping / Keep-alive route */
app.get('/ping', (req, res) => {
  res.json({
    pong: true,
    timestamp: new Date().toISOString(),
    status: connectionStatus,
    connected: isConnected,
    userPhone: connectedUserPhone,
  });
});

/** Health probe */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    connected: isConnected,
    status: connectionStatus,
    userPhone: connectedUserPhone,
    uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
  });
});

/** JSON status for CRM Settings */
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    status: connectionStatus,
    userPhone: connectedUserPhone,
    qrAvailable: !!latestQR,
    totalProducts: db.products?.length || 0,
    totalBills: db.bills?.length || 0,
    uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
  });
});

/** Live Poll Endpoint for QR Web UI */
app.get('/api/qr-status', async (req, res) => {
  res.json({
    connected: isConnected,
    status: connectionStatus,
    userPhone: connectedUserPhone,
    hasQr: !!latestQR,
    qrDataUrl: latestQrDataUrl,
    uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
  });
});

/** Force Reconnect using Supabase Session */
app.get('/reconnect', async (req, res) => {
  reconnectAttempts = 0;
  connectToWhatsApp();
  res.json({
    success: true,
    message: 'Reconnecting to WhatsApp using saved Supabase session...',
    status: connectionStatus,
    connected: isConnected,
  });
});

/** Reset Session Endpoint (Wipes local & cloud session files for clean fresh QR/Pairing) */
app.all(['/reset-session', '/api/reset-session'], async (req, res) => {
  try {
    await resetWhatsAppSession();
    res.json({
      success: true,
      message: 'WhatsApp session wiped cleanly. Initializing fresh QR Code & Pairing Code...',
      status: connectionStatus,
      connected: isConnected,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Pairing Code Route: Link via 8-digit code on phone without camera */
app.all('/pair', async (req, res) => {
  const rawPhone = req.query.phone || req.body?.phone || '9909873595';
  let digits = String(rawPhone).replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) digits = digits.substring(1);
  if (digits.length === 10) digits = '91' + digits;

  if (isConnected) {
    return res.json({
      success: true,
      connected: true,
      userPhone: connectedUserPhone,
      message: 'WhatsApp is already connected!',
    });
  }

  if (!sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp socket is starting up. Please wait 3 seconds and retry.',
    });
  }

  try {
    const code = await sock.requestPairingCode(digits);
    const formattedCode = code ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    console.log(`[WA] 🔢 Pairing code generated for ${digits}: ${formattedCode} (Raw: ${code})`);
    res.json({
      success: true,
      phone: digits,
      pairingCode: formattedCode,
      rawCode: code,
      instructions: 'Open WhatsApp -> Linked Devices -> Link a Device -> Link with phone number instead -> Enter 8-digit code',
    });
  } catch (err) {
    console.error(`[WA] ❌ Pairing code generation failed for ${digits}:`, err.message);
    if (err.message?.includes('registered') || err.message?.includes('closed') || err.message?.includes('401')) {
      return res.status(400).json({
        success: false,
        error: `Could not generate code: ${err.message}. Please click "Reset Session" and retry.`,
        needsReset: true,
      });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Interactive, Real-Time QR Code & 8-Digit Pairing Code HTML Page */
app.get('/qr', async (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Shiv Agro Bot - Connect WhatsApp</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 50%, #f8fafc 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px 12px;
          color: #0f172a;
        }
        .container {
          width: 100%;
          max-width: 480px;
          background: #ffffff;
          border-radius: 24px;
          box-shadow: 0 20px 40px -15px rgba(22, 101, 52, 0.12), 0 0 0 1px rgba(22, 101, 52, 0.08);
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #15803d 0%, #166534 100%);
          padding: 28px 24px 20px;
          text-align: center;
          color: #ffffff;
        }
        .brand-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: rgba(255, 255, 255, 0.2);
          backdrop-filter: blur(8px);
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          margin-bottom: 8px;
        }
        .header h1 { font-size: 22px; font-weight: 900; margin-bottom: 4px; }
        .header p { font-size: 12px; opacity: 0.9; font-weight: 600; }
        
        .body { padding: 24px; }

        /* Tabs */
        .tabs {
          display: flex;
          background: #f1f5f9;
          padding: 4px;
          border-radius: 14px;
          gap: 4px;
          margin-bottom: 20px;
        }
        .tab-btn {
          flex: 1;
          padding: 10px 12px;
          border: none;
          background: transparent;
          font-family: inherit;
          font-size: 12px;
          font-weight: 800;
          color: #64748b;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .tab-btn.active {
          background: #ffffff;
          color: #166534;
          box-shadow: 0 2px 8px rgba(0,0,0,0.06);
        }

        .view-section { display: none; }
        .view-section.active { display: block; }

        /* QR View */
        .qr-wrapper {
          text-align: center;
          padding: 10px 0;
        }
        .qr-box {
          display: inline-block;
          padding: 14px;
          background: #ffffff;
          border-radius: 20px;
          border: 2px solid #bbf7d0;
          box-shadow: 0 10px 25px -5px rgba(22, 163, 74, 0.15);
          position: relative;
        }
        .qr-img {
          width: 240px;
          height: 240px;
          display: block;
          border-radius: 10px;
        }
        .qr-spinner {
          width: 240px;
          height: 240px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          background: #f8fafc;
          border-radius: 10px;
          color: #64748b;
          font-size: 13px;
          font-weight: 700;
        }
        .spin {
          width: 32px;
          height: 32px;
          border: 3px solid #cbd5e1;
          border-top-color: #16a34a;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .scan-steps {
          margin-top: 18px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 14px 16px;
          text-align: left;
        }
        .scan-steps p { font-size: 12px; font-weight: 800; color: #1e293b; margin-bottom: 8px; }
        .scan-steps ol { margin-left: 18px; font-size: 12px; color: #475569; line-height: 1.6; }

        /* Pairing Code View */
        .pair-container {
          text-align: center;
        }
        .input-group {
          margin-bottom: 14px;
          text-align: left;
        }
        .input-group label {
          display: block;
          font-size: 11px;
          font-weight: 800;
          color: #475569;
          text-transform: uppercase;
          margin-bottom: 6px;
        }
        .phone-input {
          width: 100%;
          padding: 12px 14px;
          font-size: 16px;
          font-weight: 800;
          font-family: inherit;
          border: 1.5px solid #cbd5e1;
          border-radius: 12px;
          outline: none;
          color: #0f172a;
          background: #f8fafc;
          transition: all 0.2s;
        }
        .phone-input:focus {
          border-color: #16a34a;
          background: #ffffff;
          box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.15);
        }
        .btn-primary {
          width: 100%;
          padding: 14px;
          background: #16a34a;
          color: #ffffff;
          border: none;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 800;
          font-family: inherit;
          cursor: pointer;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
        }
        .btn-primary:hover { background: #15803d; }
        .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

        .code-card {
          margin-top: 18px;
          padding: 16px;
          background: #f0fdf4;
          border: 2px dashed #86efac;
          border-radius: 16px;
          text-align: center;
        }
        .code-display {
          font-family: monospace;
          font-size: 32px;
          font-weight: 900;
          letter-spacing: 4px;
          color: #15803d;
          background: #ffffff;
          padding: 12px 16px;
          border-radius: 12px;
          border: 1px solid #bbf7d0;
          margin: 10px 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
        }
        .btn-copy {
          background: #16a34a;
          color: #ffffff;
          border: none;
          border-radius: 8px;
          padding: 6px 10px;
          font-size: 11px;
          font-weight: 800;
          cursor: pointer;
        }

        /* Connected View */
        .connected-card {
          text-align: center;
          padding: 24px 16px;
        }
        .success-icon {
          width: 64px;
          height: 64px;
          background: #dcfce7;
          border: 3px solid #86efac;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 32px;
          margin-bottom: 14px;
        }
        .connected-card h2 { color: #166534; font-size: 20px; font-weight: 900; margin-bottom: 6px; }
        .connected-card p { font-size: 13px; color: #475569; font-weight: 600; }
        .phone-badge {
          display: inline-block;
          margin-top: 10px;
          background: #166534;
          color: #ffffff;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 0.5px;
        }

        /* Test message tool */
        .test-box {
          margin-top: 20px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          padding: 14px;
          text-align: left;
        }
        .test-box p { font-size: 12px; font-weight: 800; color: #1e293b; margin-bottom: 8px; }

        /* Footer & Reset */
        .footer {
          margin-top: 20px;
          padding-top: 16px;
          border-top: 1px solid #e2e8f0;
          text-align: center;
        }
        .btn-reset {
          background: transparent;
          border: 1px solid #cbd5e1;
          color: #64748b;
          padding: 8px 14px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 800;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-reset:hover {
          background: #fee2e2;
          color: #991b1b;
          border-color: #fca5a5;
        }
        .pulse-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          background: #16a34a;
          border-radius: 50%;
          margin-right: 4px;
          animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
          0% { transform: scale(0.95); opacity: 0.8; }
          50% { transform: scale(1.3); opacity: 1; }
          100% { transform: scale(0.95); opacity: 0.8; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="brand-badge">🌿 Shiv Agro Agency Bot</div>
          <h1>WhatsApp Connection Hub</h1>
          <p>Link your phone once to send instant bills & stock alerts 24/7</p>
        </div>

        <div class="body">
          <!-- Main Connected State View -->
          <div id="view-connected" class="view-section">
            <div class="connected-card">
              <div class="success-icon">✅</div>
              <h2>WhatsApp Connected!</h2>
              <p>Your bot is live, authenticated, and ready to send invoices.</p>
              <div id="conn-phone" class="phone-badge">Active Connection</div>

              <div class="test-box">
                <p>⚡ Send Test WhatsApp Message</p>
                <input type="text" id="test-phone" class="phone-input" placeholder="Enter recipient phone (e.g. 9909873595)" value="9909873595" style="margin-bottom:8px;font-size:13px;padding:9px;" />
                <button class="btn-primary" onclick="sendTestMessage()" id="btn-test-send">
                  <span>Send Test Message 💬</span>
                </button>
                <div id="test-status" style="font-size:11px;font-weight:700;margin-top:6px;display:none;"></div>
              </div>
            </div>
          </div>

          <!-- Connecting / Pairing Tabs View -->
          <div id="view-linking" class="view-section active">
            <div class="tabs">
              <button class="tab-btn active" onclick="setTab('qr')">
                <span>📷 Scan QR Code</span>
              </button>
              <button class="tab-btn" onclick="setTab('pair')">
                <span>🔢 8-Digit Pairing Code</span>
              </button>
            </div>

            <!-- Tab 1: QR Code -->
            <div id="tab-qr" class="tab-pane">
              <div class="qr-wrapper">
                <div class="qr-box">
                  <div id="qr-loading" class="qr-spinner">
                    <div class="spin"></div>
                    <span>Generating fresh QR code...</span>
                  </div>
                  <img id="qr-image" class="qr-img" src="" alt="WhatsApp QR Code" style="display:none;" />
                </div>
                <div style="font-size:11px;color:#166534;font-weight:800;margin-top:10px;">
                  <span class="pulse-dot"></span> Live auto-refreshing every 20s
                </div>
              </div>

              <div class="scan-steps">
                <p>📋 Quick Steps to Scan:</p>
                <ol>
                  <li>Open <strong>WhatsApp</strong> on your phone</li>
                  <li>Tap <strong>Settings (or ⋮)</strong> → <strong>Linked Devices</strong></li>
                  <li>Tap <strong>Link a Device</strong> & scan the QR above</li>
                </ol>
              </div>
            </div>

            <!-- Tab 2: 8-Digit Code -->
            <div id="tab-pair" class="tab-pane" style="display:none;">
              <div class="pair-container">
                <div class="input-group">
                  <label>WhatsApp Phone Number</label>
                  <input type="text" id="phone-input" class="phone-input" value="99098 73595" placeholder="e.g. 9909873595" />
                </div>

                <button class="btn-primary" id="btn-pair" onclick="getPairingCode()">
                  <span>Get 8-Digit Code</span>
                </button>

                <div id="code-result" class="code-card" style="display:none;">
                  <p style="font-size:12px;font-weight:800;color:#166534;">Enter this code on your WhatsApp:</p>
                  <div class="code-display">
                    <span id="code-text">----</span>
                    <button class="btn-copy" onclick="copyCode()">Copy</button>
                  </div>
                  <div style="font-size:11px;color:#64748b;line-height:1.5;text-align:left;margin-top:8px;">
                    1. Open <strong>WhatsApp</strong> → <strong>Linked Devices</strong><br>
                    2. Tap <strong>Link a Device</strong><br>
                    3. Tap <strong>"Link with phone number instead"</strong> at bottom<br>
                    4. Type the 8-digit code above!
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="footer">
            <button class="btn-reset" onclick="resetSession()">
              🔄 Reset Session & Generate Fresh QR
            </button>
          </div>
        </div>
      </div>

      <script>
        let currentTab = 'qr';
        let pollTimer = null;
        let lastRawCode = '';

        function setTab(tab) {
          currentTab = tab;
          document.querySelectorAll('.tab-btn').forEach((b, idx) => {
            if ((tab === 'qr' && idx === 0) || (tab === 'pair' && idx === 1)) {
              b.classList.add('active');
            } else {
              b.classList.remove('active');
            }
          });
          document.getElementById('tab-qr').style.display = tab === 'qr' ? 'block' : 'none';
          document.getElementById('tab-pair').style.display = tab === 'pair' ? 'block' : 'none';
        }

        async function pollStatus() {
          try {
            const res = await fetch('/api/qr-status');
            const data = await res.json();

            if (data.connected) {
              document.getElementById('view-linking').classList.remove('active');
              document.getElementById('view-connected').classList.add('active');
              document.getElementById('conn-phone').innerText = 'Phone: ' + (data.userPhone ? '+' + data.userPhone : 'Shop WhatsApp');
              return;
            }

            document.getElementById('view-linking').classList.add('active');
            document.getElementById('view-connected').classList.remove('active');

            if (data.qrDataUrl) {
              const img = document.getElementById('qr-image');
              const load = document.getElementById('qr-loading');
              if (img.src !== data.qrDataUrl) {
                img.src = data.qrDataUrl;
              }
              img.style.display = 'block';
              load.style.display = 'none';
            }
          } catch (e) {
            console.warn('Poll error:', e);
          }
        }

        async function getPairingCode() {
          const raw = document.getElementById('phone-input').value;
          const digits = raw.replace(/[^0-9]/g, '');
          const btn = document.getElementById('btn-pair');
          btn.disabled = true;
          btn.innerHTML = '<span>Generating code...</span>';

          try {
            const res = await fetch('/pair?phone=' + digits);
            const data = await res.json();

            if (data.success && data.pairingCode) {
              document.getElementById('code-result').style.display = 'block';
              document.getElementById('code-text').innerText = data.pairingCode;
              lastRawCode = data.rawCode || data.pairingCode.replace(/[^a-zA-Z0-9]/g, '');
            } else {
              alert(data.error || 'Failed to generate pairing code. Please click "Reset Session" and try again.');
            }
          } catch (err) {
            alert('Error contacting server: ' + err.message);
          } finally {
            btn.disabled = false;
            btn.innerHTML = '<span>Get 8-Digit Code</span>';
          }
        }

        function copyCode() {
          const text = lastRawCode || document.getElementById('code-text').innerText.replace(/-/g, '');
          navigator.clipboard.writeText(text).then(() => alert('Code copied to clipboard!'));
        }

        async function resetSession() {
          if (!confirm('This will wipe any old or corrupted WhatsApp session data and generate a brand new QR & pairing code. Proceed?')) return;
          const load = document.getElementById('qr-loading');
          const img = document.getElementById('qr-image');
          img.style.display = 'none';
          load.style.display = 'flex';
          load.innerHTML = '<div class="spin"></div><span>Resetting session...</span>';
          document.getElementById('code-result').style.display = 'none';

          try {
            await fetch('/reset-session');
            setTimeout(pollStatus, 2000);
          } catch (err) {
            alert('Reset error: ' + err.message);
          }
        }

        async function sendTestMessage() {
          const phone = document.getElementById('test-phone').value;
          const statusDiv = document.getElementById('test-status');
          const btn = document.getElementById('btn-test-send');
          btn.disabled = true;
          statusDiv.style.display = 'block';
          statusDiv.style.color = '#15803d';
          statusDiv.innerText = 'Sending test WhatsApp message...';

          try {
            const res = await fetch('/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-bot-secret': 'shivagro-secret-2024' },
              body: JSON.stringify({
                phone: phone,
                message: '🌿 *Shiv Agro Agency - Test Alert*\n\nYour WhatsApp Bot is connected and operational 24/7!\nInvoices and inventory notifications are active.',
              }),
            });
            const data = await res.json();
            if (data.success) {
              statusDiv.innerText = '✅ Test message sent successfully!';
            } else {
              statusDiv.style.color = '#b91c1c';
              statusDiv.innerText = '❌ Failed: ' + (data.error || 'Unknown error');
            }
          } catch (e) {
            statusDiv.style.color = '#b91c1c';
            statusDiv.innerText = '❌ Error: ' + e.message;
          } finally {
            btn.disabled = false;
          }
        }

        // Start real-time polling every 2.5 seconds
        pollStatus();
        pollTimer = setInterval(pollStatus, 2500);
      </script>
    </body>
    </html>
  `);
});

/** Send a WhatsApp message or PDF document */
app.post('/send', async (req, res) => {
  const clientSecret = req.headers['x-bot-secret'];
  if (clientSecret !== BOT_SECRET && clientSecret !== 'shivagro-bot' && clientSecret !== 'shivagro-secret-2024') {
    console.warn(`[WA] ⛔ Unauthorized /send attempt from ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid secret' });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp not connected. Visit /qr to scan QR code or enter 8-digit pairing code.',
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
    let digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    if (digits.length === 10) digits = '91' + digits;
    const chatId = `${digits}@s.whatsapp.net`;

    if (pdfBase64) {
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

      console.log(`[WA] 📄 PDF Document sent to ${digits} (${docName})`);
      return res.json({ success: true, to: digits, provider: 'baileys', type: 'pdf' });
    }

    await sock.sendMessage(chatId, { text: message });
    console.log(`[WA] 💬 Text message sent to ${digits}`);

    res.json({ success: true, to: digits, provider: 'baileys', type: 'text' });
  } catch (err) {
    console.error('[WA] ❌ Send error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Continuous Self-Ping Keep-Alive (Prevents Cloud Free Tiers from sleeping) ──
setInterval(() => {
  const pingUrl =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.SERVER_URL ||
    process.env.BOT_PUBLIC_URL ||
    `https://shivagro-whatsapp-bot-ecz2.onrender.com`;

  fetch(`${pingUrl.replace(/\/$/, '')}/ping`)
    .then((r) => r.json())
    .catch(() => {});
}, 3 * 60 * 1000);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Shiv Agro WhatsApp Bot & Cloud Sync Hub running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   QR Scan & Pair: http://localhost:${PORT}/qr`);
  console.log(`   Cloud Sync API: http://localhost:${PORT}/api/sync/all`);
  console.log(`   Ping: http://localhost:${PORT}/ping\n`);
  await connectToWhatsApp();
});
