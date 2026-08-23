'use strict';
/* ======================================================================
   لایه پایگاه داده — سیستم انبارداری تحت شبکه
   از node:sqlite (قابلیت بومی Node.js 22+) استفاده می‌کند، بدون هیچ
   بسته خارجی. فایل دیتابیس یک فایل تکی روی دیسک است (data/warehouse.db)
   که به‌سادگی قابل پشتیبان‌گیری (کپی فایل) است.

   این فایل علاوه بر تعریف اسکیما، دو چیز مهم دیگر هم فراهم می‌کند:
     ۱. مهاجرت (migration) امن برای پایگاه‌داده‌های موجود — ستون‌های جدید
        فقط در صورت نبودن اضافه می‌شوند، پس نسخه‌های قبلی بدون از دست
        رفتن داده به‌روزرسانی می‌شوند.
     ۲. inTransaction() — پوششی برای اجرای اتمیک چند دستور. اگر وسط کار
        خطایی رخ دهد (یا برق برود) هیچ نیمه‌عملیاتی روی دیسک نمی‌ماند.
   ====================================================================== */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'warehouse.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ======================================================================
// Schema
// ======================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,           -- 'مدیر سیستم' | 'انباردار' | 'درخواست‌دهنده' | 'ناظر'
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
  type TEXT NOT NULL DEFAULT 'مصرفی',   -- 'مصرفی' | 'قابل‌برگشت'
  unit TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  usage_location TEXT,
  shelf TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  kind TEXT PRIMARY KEY,   -- 'in' | 'out' | 'ret' | 'req' | 'custIssue' | 'custReturn' | 'repIn' | 'repOut'
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_number TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type TEXT NOT NULL,             -- 'ورود' | 'خروج' | 'مرجوعی'
  quantity INTEGER NOT NULL,
  date TEXT NOT NULL,             -- ISO (Gregorian) date, YYYY-MM-DD
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
  status TEXT NOT NULL DEFAULT 'در انتظار',   -- در انتظار | تأمین شده | لغو شده
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
  status TEXT NOT NULL DEFAULT 'باز',   -- باز | بسته | باطل
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
  status TEXT NOT NULL DEFAULT 'در حال تعمیر',   -- در حال تعمیر | تکمیل شده | باطل
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

-- محدودیت تلاش ورود؛ برخلاف نسخه قبلی که فقط در حافظه بود و با هر
-- ری‌استارت سرور پاک می‌شد، این‌جا ماندگار است.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  attempts TEXT NOT NULL DEFAULT '[]',   -- JSON array of epoch ms
  blocked_until INTEGER
);

CREATE INDEX IF NOT EXISTS idx_transactions_product ON transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_requests_product ON requests(product_id);
CREATE INDEX IF NOT EXISTS idx_custody_product ON custody_records(product_id);
CREATE INDEX IF NOT EXISTS idx_repair_product ON repair_records(product_id);
`);

// ======================================================================
// مهاجرت — افزودن ستون‌های نسخه جدید به پایگاه‌داده‌های موجود
// ======================================================================
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[مهاجرت پایگاه‌داده] ستون ${table}.${column} اضافه شد`);
  }
}

// ابطال سند به‌جای حذف فیزیکی: شماره سند دست‌نخورده می‌ماند و ردّ حسابرسی
// حفظ می‌شود (نسخه قبلی سند را پاک و بقیه را دوباره شماره‌گذاری می‌کرد که
// باعث می‌شد ارجاع‌های لاگ حسابرسی و رسیدهای چاپ‌شده به سند دیگری بیفتد).
ensureColumn('transactions', 'status', "TEXT NOT NULL DEFAULT 'معتبر'");     // معتبر | باطل
ensureColumn('transactions', 'voided_at', 'TEXT');
ensureColumn('transactions', 'void_reason', 'TEXT');
ensureColumn('transactions', 'voided_by_user_id', 'INTEGER');

ensureColumn('custody_records', 'void_reason', 'TEXT');
ensureColumn('repair_records', 'void_reason', 'TEXT');

// بایگانی کالا به‌جای حذف زنجیره‌ای اسناد
ensureColumn('products', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('products', 'archived_at', 'TEXT');

// شماره سند باید یکتا باشد. اگر پایگاه‌داده‌ی موجود به‌خاطر باگ
// شماره‌گذاری مجدد نسخه قبلی شماره تکراری داشته باشد، ساخت ایندکس
// شکست می‌خورد؛ در آن صورت فقط هشدار می‌دهیم و کار متوقف نمی‌شود.
function tryUniqueIndex(name, table, column) {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`);
  } catch (e) {
    const dups = db.prepare(
      `SELECT ${column} AS v, COUNT(*) AS c FROM ${table} GROUP BY ${column} HAVING c > 1 LIMIT 10`
    ).all();
    console.warn(`[هشدار] شماره سند تکراری در جدول ${table} یافت شد؛ ایندکس یکتا ساخته نشد.`);
    dups.forEach(d => console.warn(`   شماره ${d.v} → ${d.c} بار تکرار شده`));
    console.warn('   این نتیجه‌ی باگ شماره‌گذاری مجدد در نسخه قبلی است. پس از اصلاح دستی، سرور را دوباره اجرا کنید.');
  }
}
tryUniqueIndex('idx_transactions_docnum', 'transactions', 'doc_number');
tryUniqueIndex('idx_requests_docnum', 'requests', 'doc_number');
tryUniqueIndex('idx_custody_docnum', 'custody_records', 'doc_number');
tryUniqueIndex('idx_repair_docnum', 'repair_records', 'doc_number');

db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);');

// Seed default counters if empty
const counterKinds = ['in', 'out', 'ret', 'req', 'custIssue', 'custReturn', 'repIn', 'repOut'];
const insertCounter = db.prepare('INSERT OR IGNORE INTO counters (kind, value) VALUES (?, 0)');
for (const k of counterKinds) insertCounter.run(k);

// ======================================================================
// اجرای اتمیک — همه‌ی عملیات چندمرحله‌ای (مثل «کم کردن موجودی + ثبت سند»)
// باید داخل این تابع اجرا شوند تا یا کامل انجام شوند یا اصلاً انجام نشوند.
// ======================================================================
let transactionDepth = 0;

function inTransaction(fn) {
  if (transactionDepth > 0) return fn();   // تراکنش تودرتو: از تراکنش بیرونی استفاده می‌شود
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
