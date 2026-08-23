'use strict';
/* ======================================================================
   احراز هویت، نشست‌ها (Sessions)، و کنترل سطح دسترسی (Roles)
   رمزنگاری با scrypt (ماژول داخلی node:crypto) — بدون bcrypt یا هر
   بسته خارجی دیگر.
   ====================================================================== */

const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('./config');
const { ValidationError } = require('./validators');

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 ساعت
const SCRYPT_KEYLEN = 64;

// ---------------------------------------------------------------------
// Roles: each role's allowed permission keys. Server routes check these
// — this is the actual enforcement layer; the frontend UI hiding is only
// a convenience, never the security boundary.
// ---------------------------------------------------------------------
const ROLES = {
  'مدیر سیستم': {
    label: 'مدیر سیستم',
    // '*' یعنی همه‌چیز، شامل کلیدهای انحصاری مدیر که به هیچ نقش دیگری
    // داده نمی‌شوند: products.delete, documents.manage, users.manage,
    // audit.view, maintenance.manage
    permissions: ['*']
  },
  'انباردار': {
    label: 'انباردار',
    permissions: [
      'products.view', 'products.edit',
      'stock.in', 'stock.out', 'returns.create',
      'custody.manage', 'repair.manage',
      'requests.view', 'requests.create', 'requests.manage', 'requests.fulfill',
      'reports.view', 'dashboard.view'
    ]
  },
  'درخواست‌دهنده': {
    label: 'درخواست‌دهنده',
    permissions: [
      'products.view', 'requests.view', 'requests.create',
      'dashboard.view'
    ]
  },
  'ناظر': {
    label: 'ناظر (فقط مشاهده)',
    permissions: [
      'products.view', 'requests.view', 'reports.view', 'dashboard.view'
    ]
  }
};

function roleHasPermission(role, permission) {
  const def = ROLES[role];
  if (!def) return false;
  if (def.permissions.includes('*')) return true;
  return def.permissions.includes(permission);
}

// ---------------------------------------------------------------------
// سیاست رمز عبور — نسخه قبلی رمز چهارکاراکتری را می‌پذیرفت که برای
// حالت اینترنتی (mode=https) بسیار ضعیف است.
// ---------------------------------------------------------------------
function assertPasswordPolicy(password, username) {
  const p = String(password ?? '');
  const min = config.minPasswordLength;
  if (p.length < min) {
    throw new ValidationError(`رمز عبور باید حداقل ${min} کاراکتر باشد`);
  }
  if (username && p.toLowerCase() === String(username).toLowerCase()) {
    throw new ValidationError('رمز عبور نمی‌تواند برابر نام کاربری باشد');
  }
  const trivial = ['12345678', '11111111', 'password', 'admin123', '123456789', '00000000'];
  if (trivial.includes(p.toLowerCase())) {
    throw new ValidationError('این رمز عبور بسیار ساده و قابل حدس است؛ رمز دیگری انتخاب کنید');
  }
  return p;
}

// ---------------------------------------------------------------------
// Password hashing (scrypt + random salt, both stored per-user)
// ---------------------------------------------------------------------
function hashPassword(plainPassword, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(plainPassword, salt, SCRYPT_KEYLEN);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

function verifyPassword(plainPassword, storedHashHex, storedSaltHex) {
  const { hash } = hashPassword(plainPassword, storedSaltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(storedHashHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DURATION_MS);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), expires.toISOString());
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = db.prepare('SELECT id, username, full_name, role, active, must_change_password FROM users WHERE id = ?').get(session.user_id);
  if (!user || !user.active) return null;
  return user;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

// ---------------------------------------------------------------------
// Bootstrap: create a default administrator account on first run so the
// facility always has a way in. Credentials are printed to the server
// console once; the admin should change the password immediately from
// the "کاربران" screen.
// ---------------------------------------------------------------------
function ensureDefaultAdmin() {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'مدیر سیستم'").get();
  if (existing.c > 0) return;

  const defaultUsername = 'admin';
  const defaultPassword = config.initialAdminPassword;
  const { hash, salt } = hashPassword(defaultPassword);
  db.prepare(`INSERT INTO users (username, password_hash, password_salt, full_name, role, active, created_at, must_change_password)
              VALUES (?, ?, ?, ?, ?, 1, ?, 1)`)
    .run(defaultUsername, hash, salt, 'مدیر سیستم', 'مدیر سیستم', new Date().toISOString());

  console.log('----------------------------------------------------------');
  console.log(' حساب مدیر پیش‌فرض ایجاد شد:');
  console.log('   نام کاربری : admin');
  console.log(`   رمز عبور   : ${defaultPassword}`);
  console.log(' تغییر این رمز در اولین ورود توسط سرور اجباری است؛ تا زمانی');
  console.log(' که رمز عوض نشود، هیچ بخش دیگری از سامانه در دسترس نیست.');
  console.log('----------------------------------------------------------');
}

module.exports = {
  ROLES,
  roleHasPermission,
  assertPasswordPolicy,
  hashPassword,
  verifyPassword,
  createSession,
  getSessionUser,
  destroySession,
  cleanupExpiredSessions,
  ensureDefaultAdmin
};
