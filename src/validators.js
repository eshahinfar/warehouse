'use strict';
/* ======================================================================
   اعتبارسنجی متمرکز ورودی‌ها

   قبلاً هر مسیر (route) خودش چند شرط ساده می‌نوشت و در نتیجه چیزهایی مثل
   تعداد اعشاری (۲.۷ عدد پیچ!) یا تاریخ بی‌معنا ("not-a-date") تا داخل
   پایگاه‌داده پیش می‌رفت — چون SQLite برخلاف پایگاه‌داده‌های سخت‌گیر،
   نوع ستون را اجبار نمی‌کند. این ماژول یک لایه‌ی واحد و سخت‌گیر است که
   همه‌ی مسیرها از آن عبور می‌کنند.

   توابع در صورت نامعتبر بودن ورودی، ValidationError پرتاب می‌کنند و
   server.js آن را به پاسخ 400 با پیام فارسی تبدیل می‌کند.
   ====================================================================== */

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_QUANTITY = 1000000000; // یک میلیارد — سقف عقلانی برای هر سند انبار

// عدد صحیح مثبت (تعداد کالا، شناسه و...)
function vInt(value, fieldLabel, { min = 1, max = MAX_QUANTITY } = {}) {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(`${fieldLabel} الزامی است`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ValidationError(`${fieldLabel} باید یک عدد معتبر باشد`);
  }
  if (!Number.isInteger(n)) {
    throw new ValidationError(`${fieldLabel} باید عدد صحیح باشد (مقدار اعشاری پذیرفته نمی‌شود)`);
  }
  if (n < min) throw new ValidationError(`${fieldLabel} نمی‌تواند کوچک‌تر از ${min} باشد`);
  if (n > max) throw new ValidationError(`${fieldLabel} از حد مجاز (${max}) بیشتر است`);
  return n;
}

// شناسه رکورد (عدد صحیح مثبت، بدون سقف تعداد)
function vId(value, fieldLabel) {
  return vInt(value, fieldLabel, { min: 1, max: Number.MAX_SAFE_INTEGER });
}

// تاریخ میلادی ISO: YYYY-MM-DD و واقعاً موجود در تقویم
function vDate(value, fieldLabel) {
  if (!value) throw new ValidationError(`${fieldLabel} الزامی است`);
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValidationError(`${fieldLabel} باید به قالب YYYY-MM-DD باشد`);
  }
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw new ValidationError(`${fieldLabel} یک تاریخ معتبر نیست`);
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError(`${fieldLabel} یک تاریخ معتبر نیست`);
  }
  if (y < 1900 || y > 2200) {
    throw new ValidationError(`${fieldLabel} خارج از بازه‌ی منطقی است`);
  }
  return s;
}

// تاریخ اختیاری (رشته خالی/undefined → null)
function vOptionalDate(value, fieldLabel) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return vDate(value, fieldLabel);
}

// متن الزامی
function vText(value, fieldLabel, { maxLen = 500, minLen = 1 } = {}) {
  if (value === undefined || value === null) {
    throw new ValidationError(`${fieldLabel} الزامی است`);
  }
  const s = String(value).trim();
  if (s.length < minLen) throw new ValidationError(`${fieldLabel} الزامی است`);
  if (s.length > maxLen) throw new ValidationError(`${fieldLabel} نباید بیش از ${maxLen} کاراکتر باشد`);
  return s;
}

// متن اختیاری → null در صورت خالی بودن
function vOptionalText(value, fieldLabel, { maxLen = 2000 } = {}) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (s.length > maxLen) throw new ValidationError(`${fieldLabel} نباید بیش از ${maxLen} کاراکتر باشد`);
  return s;
}

// یکی از مقادیر مجاز
function vEnum(value, fieldLabel, allowed) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (!allowed.includes(s)) {
    throw new ValidationError(`${fieldLabel} معتبر نیست`);
  }
  return s;
}

// دلیل الزامی برای عملیات حساس (ابطال/ویرایش/حذف)
function vReason(value) {
  return vText(value, 'ثبت دلیل', { minLen: 3, maxLen: 1000 });
}

module.exports = {
  ValidationError, MAX_QUANTITY,
  vInt, vId, vDate, vOptionalDate, vText, vOptionalText, vEnum, vReason
};
