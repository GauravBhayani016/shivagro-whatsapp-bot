/**
 * ShivAgro WhatsApp Bot & Cloud Sync Hub Server
 * 
 * Uses @whiskeysockets/baileys (pure WebSocket, no browser) to connect WhatsApp.
 * Exposes REST APIs for:
 *   1. Sending WhatsApp messages & PDF invoices
 *   2. Real-time Cloud Sync between Mobile 1, Mobile 2 (Papa's phone), and Netlify PC Web CRM
 *   3. Supabase Cloud Session Persistence (never loses WhatsApp connection on Render restarts)
 */

import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
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
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }
    if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
      console.log('[WA Auth] Local creds.json found in container.');
      return true;
    }
    console.log('[WA Auth] Local creds not found, restoring session from Supabase...');
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('data')
      .eq('session_id', 'shivagro_bot')
      .single();

    if (!error && data && data.data && typeof data.data === 'object') {
      const files = data.data;
      let count = 0;
      for (const [filename, content] of Object.entries(files)) {
        if (filename && typeof content === 'string') {
          fs.writeFileSync(path.join(AUTH_DIR, filename), content, 'utf8');
          count++;
        }
      }
      if (count > 0) {
        console.log(`[WA Auth] ✅ Restored ${count} session files from Supabase! WhatsApp will reconnect automatically.`);
        return true;
      }
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
      const fileNames = fs.readdirSync(AUTH_DIR);
      if (fileNames.length === 0) return;
      const bundle = {};
      for (const file of fileNames) {
        const fullPath = path.join(AUTH_DIR, file);
        if (fs.statSync(fullPath).isFile()) {
          bundle[file] = fs.readFileSync(fullPath, 'utf8');
        }
      }
      await supabase.from('whatsapp_sessions').upsert({
        session_id: 'shivagro_bot',
        data: bundle,
        updated_at: new Date().toISOString(),
      });
      console.log(`[WA Auth] ☁️ WhatsApp session successfully backed up to Supabase Cloud.`);
    } catch (err) {
      console.warn('[WA Auth] Supabase backup notice:', err.message);
    }
  }, 2000);
}

// ─── WhatsApp Connection State ────────────────────────────────────────────────
let sock = null;
let latestQR = null;
let isConnected = false;
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

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      browser: ['ShivAgro Bot', 'Chrome', '124.0'],
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
        reconnectAttempts = 0;
        console.log('[WA] ✅ WhatsApp connected and ready to send messages 24/7!');
        triggerAuthBackupToSupabase();
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        console.log(`[WA] ⚠️ Connection closed. Code: ${statusCode} (Reason: ${lastDisconnect?.error?.message || 'Unknown'})`);

        if (isLoggedOut) {
          connectionStatus = 'logged_out';
          console.log('[WA] ⚠️ Logged out from WhatsApp. Please visit /qr and re-scan.');
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

// ─── Real-Time Cloud Sync Endpoints (Multi-Device Sync) ────────────────────────

/** Get All Live Data for Real-Time Sync */
app.get('/api/sync/all', async (req, res) => {
  db = loadDb();

  // If local DB is empty, try fetching from Supabase directly
  if (!db.products || db.products.length === 0) {
    try {
      const { data: supaProds } = await supabase.from('products').select('*');
      if (supaProds && supaProds.length > 0) {
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
    } catch {}
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

  if (productData.id && db.products.some((p) => p.id === productData.id)) {
    // Update existing
    db.products = db.products.map((p) => {
      if (p.id === productData.id) {
        resultProduct = { ...p, ...productData, updatedAt: now };
        return resultProduct;
      }
      return p;
    });
  } else {
    // Create new
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

  // Sync to Supabase in background
  try {
    await supabase.from('products').upsert({
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
      updated_at: now,
    });
  } catch (err) {
    console.warn('[Sync] Supabase product sync skipped:', err.message);
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
    version: '2.7.0',
    status: connectionStatus,
    connected: isConnected,
    totalProducts: db.products?.length || 0,
    totalBills: db.bills?.length || 0,
    uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
    hint: isConnected ? 'WhatsApp ready & Cloud Sync Active!' : 'Visit /qr to scan QR code',
  });
});

/** Ping / Keep-alive route */
app.get('/ping', (req, res) => {
  res.json({
    pong: true,
    timestamp: new Date().toISOString(),
    status: connectionStatus,
    connected: isConnected,
  });
});

/** Health probe */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    connected: isConnected,
    status: connectionStatus,
    uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
  });
});

/** JSON status for CRM Settings */
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    status: connectionStatus,
    qrAvailable: !!latestQR,
    totalProducts: db.products?.length || 0,
    totalBills: db.bills?.length || 0,
    uptimeSeconds: Math.floor((Date.now() - startTime.getTime()) / 1000),
  });
});

/** QR Code HTML page */
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head><meta charset="UTF-8"><title>Shiv Agro Bot Status</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fdf4">
        <div style="max-width:400px;margin:auto;background:white;border-radius:16px;padding:40px;box-shadow:0 4px 20px #0001">
          <div style="font-size:64px">✅</div>
          <h2 style="color:#16a34a;margin:16px 0 8px">WhatsApp Connected!</h2>
          <p style="color:#555">Your bot is active, running 24/7 with Supabase session backup.</p>
          <p style="color:#888;font-size:13px;margin-top:24px">No QR scan needed. Invoices and alerts will be sent automatically.</p>
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
        <title>Shiv Agro Bot - Generating QR</title>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;background:#fffbeb">
        <div style="max-width:400px;margin:auto;background:white;border-radius:16px;padding:40px;box-shadow:0 4px 20px #0001">
          <div style="font-size:64px">⏳</div>
          <h2 style="color:#d97706">Generating WhatsApp QR...</h2>
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
        <title>Shiv Agro Bot - Scan QR</title>
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
            After scanning once, credentials will be backed up to Supabase permanently.
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
  const clientSecret = req.headers['x-bot-secret'];
  if (clientSecret !== BOT_SECRET && clientSecret !== 'shivagro-bot' && clientSecret !== 'shivagro-secret-2024') {
    console.warn(`[WA] ⛔ Unauthorized /send attempt from ${req.ip}`);
    return res.status(401).json({ success: false, error: 'Unauthorized: invalid secret' });
  }

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
    `https://shivagro-whatsapp-bot.onrender.com`;

  fetch(`${pingUrl.replace(/\/$/, '')}/ping`)
    .then((r) => r.json())
    .catch(() => {});
}, 3 * 60 * 1000);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Shiv Agro WhatsApp Bot & Cloud Sync Hub running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   QR Scan: http://localhost:${PORT}/qr`);
  console.log(`   Cloud Sync API: http://localhost:${PORT}/api/sync/all`);
  console.log(`   Ping: http://localhost:${PORT}/ping\n`);
  await connectToWhatsApp();
});
