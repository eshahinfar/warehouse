'use strict';
/* ======================================================================
   لایه پایگاه داده — سیستم انبارداری تحت شبکه
   از node:sqlite (قابلیت بومی Node.js 22+) استفاده می‌کند، بدون هیچ
   بسته خارجی. فایل دیتابیس یک فایل تکی است که مسیر آن از DATA_DIR
   می‌آید تا در Render روی Persistent Disk ذخیره شود.
   ====================================================================== */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// در Render، DATA_DIR باید روی Mount Path دیسک Persistent قرار بگیرد،
// مثلاً /var/data. در اجرای محلی مقدار پیش‌فرض همچنان data/ است.
const DATA_DIR = config.dataDir;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'warehouse.db');
console.log(`[پایگاه داده] مسیر SQLite: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'مصرفی',
  unit TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  usage_location TEXT,
  shelf TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (kind TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  date TEXT NOT NULL,
  source TEXT,
  po_number TEXT,
  requesting_unit TEXT,
  receiver TEXT,
  reason TEXT,
  linked_request_id INTEGER,
  returned_by TEXT,
  condition_text TEXT,
  source_doc_id INTEGER,
  source_doc_number TEXT,
  description TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  date TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'عادی',
  status TEXT NOT NULL DEFAULT 'در انتظار',
  notes TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS custody_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  holder TEXT NOT NULL,
  unit TEXT NOT NULL,
  expected_return TEXT,
  condition_out TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'باز',
  return_date TEXT,
  condition_in TEXT,
  return_notes TEXT,
  return_doc_number TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repair_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  send_date TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  repair_shop TEXT,
  issue_description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'در حال تعمیر',
  result_date TEXT,
  result TEXT,
  technician TEXT,
  approver TEXT,
  result_notes TEXT,
  result_doc_number TEXT,
  source_custody_id INTEGER REFERENCES custody_records(id),
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  doc_number TEXT,
  change_description TEXT,
  reason TEXT,
  performed_by_user_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  attempts TEXT NOT NULL DEFAULT '[]',
  blocked_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_requests_product ON requests(product_id);
CREATE INDEX IF NOT EXISTS idx_custody_product ON custody_records(product_id);
CREATE INDEX IF NOT EXISTS idx_repair_product ON repair_records(product_id);
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[مهاجرت پایگاه‌داده] ستون ${table}.${column} اضافه شد`);
  }
}

ensureColumn('transactions', 'status', "TEXT NOT NULL DEFAULT 'معتبر'");
ensureColumn('transactions', 'voided_at', 'TEXT');
ensureColumn('transactions', 'void_reason', 'TEXT');
ensureColumn('transactions', 'voided_by_user_id', 'INTEGER');
ensureColumn('custody_records', 'void_reason', 'TEXT');
ensureColumn('repair_records', 'void_reason', 'TEXT');
ensureColumn('products', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('products', 'archived_at', 'TEXT');

function tryUniqueIndex(name, table, column) {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`);
  } catch (e) {
    const dups = db.prepare(
      `SELECT ${column} AS v, COUNT(*) AS c FROM ${table} GROUP BY ${column} HAVING c > 1 LIMIT 10`
    ).all();
    console.warn(`[هشدار] شماره سند تکراری در جدول ${table} یافت شد؛ ایندکس یکتا ساخته نشد.`);
    dups.forEach(d => console.warn(`   شماره ${d.v} → ${d.c} بار تکرار شده`));
  }
}
tryUniqueIndex('idx_transactions_docnum', 'transactions', 'doc_number');
tryUniqueIndex('idx_requests_docnum', 'requests', 'doc_number');
tryUniqueIndex('idx_custody_docnum', 'custody_records', 'doc_number');
tryUniqueIndex('idx_repair_docnum', 'repair_records', 'doc_number');

db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);');

const counterKinds = ['in', 'out', 'ret', 'req', 'custIssue', 'custReturn', 'repIn', 'repOut'];
const insertCounter = db.prepare('INSERT OR IGNORE INTO counters (kind, value) VALUES (?, 0)');
for (const k of counterKinds) insertCounter.run(k);

let transactionDepth = 0;
function inTransaction(fn) {
  if (transactionDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  transactionDepth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { /* تراکنش قبلاً بسته شده */ }
    throw err;
  } finally {
    transactionDepth--;
  }
}

module.exports = { db, DB_PATH, inTransaction, ensureColumn };
