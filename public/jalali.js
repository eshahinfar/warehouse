/* ======================================================================
   ماژول تاریخ هجری شمسی (جلالی)
   - تبدیل دقیق میلادی <-> شمسی (الگوریتم استاندارد بدون وابستگی خارجی)
   - تاریخ‌ها همچنان به‌صورت ISO میلادی (YYYY-MM-DD) در داده ذخیره و
     مرتب‌سازی می‌شوند تا مقایسه رشته‌ای صحیح بماند؛ فقط لایه نمایش و
     ورودی به کاربر، شمسی است.
   - هر فیلد تاریخ با سه <select> روز/ماه/سال جایگزین input[type=date]
     می‌شود.
   ====================================================================== */

const PERSIAN_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

function isoToday(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

// ---- Gregorian <-> Jalali conversion (standard public-domain algorithm) ----
function div(a, b) { return Math.trunc(a / b); }

function gregorianToJalali(gy, gm, gd) {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy;
  const gy2 = (gm > 2) ? (gy + 1) : gy;
  let days = 355666 + (365 * gy) + div(gy2 + 3, 4) - div(gy2 + 99, 100) + div(gy2 + 399, 400) + gd + g_d_m[gm - 1];
  jy = -1595 + (33 * div(days, 12053));
  days %= 12053;
  jy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) {
    jy += div(days - 1, 365);
    days = (days - 1) % 365;
  }
  let jm, jd;
  if (days < 186) {
    jm = 1 + div(days, 31);
    jd = 1 + (days % 31);
  } else {
    jm = 7 + div(days - 186, 30);
    jd = 1 + ((days - 186) % 30);
  }
  return [jy, jm, jd];
}

function jalaliToGregorian(jy, jm, jd) {
  let gy;
  jy += 1595;
  let days = -355668 + (365 * jy) + (div(jy, 33) * 8) + div((jy % 33) + 3, 4) + jd + ((jm < 7) ? (jm - 1) * 31 : ((jm - 7) * 30) + 186);
  gy = 400 * div(days, 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * div(--days, 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) {
    gy += div(days - 1, 365);
    days = (days - 1) % 365;
  }
  const gd = days + 1;
  const sal_a = [0, 31, ((gy % 4 === 0 && gy % 100 !== 0) || (gy % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  let remaining = gd;
  for (let i = 1; i <= 12; i++) {
    if (remaining <= sal_a[i]) { gm = i; break; }
    remaining -= sal_a[i];
  }
  return [gy, gm, remaining];
}

function isJalaliLeapYear(jy) {
  const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  let jp = breaks[0];
  let jump = 0;
  for (let j = 1; j < breaks.length; j++) {
    const jm = breaks[j];
    jump = jm - jp;
    if (jy < jm) break;
    jp = jm;
  }
  let n = jy - jp;
  if (n < jump) {
    if (jump - n < 6) n = n - jump + (div(jump + 4, 33) * 33);
    let leap = ((n + 1) % 33) % 4;
    if (jump === 33 && leap === 1) leap = 0;
    return leap === 1;
  }
  return false;
}

function jalaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeapYear(jy) ? 30 : 29;
}

// ---- ISO (YYYY-MM-DD, Gregorian) <-> Jalali parts ----
function isoToJalali(isoDate) {
  if (!isoDate) return null;
  const [gy, gm, gd] = isoDate.split('-').map(Number);
  if (!gy || !gm || !gd) return null;
  const [jy, jm, jd] = gregorianToJalali(gy, gm, gd);
  return { jy, jm, jd };
}

function jalaliToIso(jy, jm, jd) {
  if (!jy || !jm || !jd) return '';
  const [gy, gm, gd] = jalaliToGregorian(jy, jm, jd);
  return `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}

function formatJalali(isoDate, withWeekday = false) {
  const j = isoToJalali(isoDate);
  if (!j) return '-';
  const base = `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`;
  return base;
}

function formatJalaliLong(isoDate) {
  const j = isoToJalali(isoDate);
  if (!j) return '-';
  return `${j.jd} ${PERSIAN_MONTHS[j.jm - 1]} ${j.jy}`;
}

function todayJalali() {
  return isoToJalali(isoToday());
}

// Accepts either a Jalali date string (YYYY/MM/DD, e.g. 1405/05/26) or an
// ISO Gregorian date string (YYYY-MM-DD) and always returns ISO Gregorian
// internally. Used when importing Excel backups so both old (Gregorian)
// and new (Jalali) backup files load correctly.
function parseAnyDateToIso(value) {
  if (!value) return '';
  const str = String(value).trim();
  const jalaliMatch = str.match(/^(\d{3,4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (jalaliMatch) {
    const y = parseInt(jalaliMatch[1], 10);
    const m = parseInt(jalaliMatch[2], 10);
    const d = parseInt(jalaliMatch[3], 10);
    // Jalali years for any realistic warehouse record fall in 1300-1500;
    // Gregorian ISO dates always start with 19xx or 20xx (4 digits >=1900)
    if (y >= 1300 && y <= 1500) {
      return jalaliToIso(y, m, d);
    }
    // otherwise treat as an already-ISO-like Gregorian date
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return str; // unrecognized format — return as-is (best effort)
}

// ======================================================================
// Jalali date-picker widget: converts a container marked with
// data-jalali-date="<hidden-input-id>" into three <select> boxes
// (day/month/year) that write the resulting Gregorian ISO date into the
// named hidden input, keeping every existing piece of logic (which reads
// date values via that hidden input's id) working unmodified.
// ======================================================================
function buildJalaliPicker(hiddenInputId) {
  const hiddenInput = document.getElementById(hiddenInputId);
  if (!hiddenInput) return;
  if (hiddenInput._jalaliSetIso) return; // already built (idempotent — avoids duplicate widgets on re-login without page reload)

  const wrapper = document.createElement('div');
  wrapper.className = 'jalali-date-picker';
  wrapper.style.display = 'flex';
  wrapper.style.gap = '6px';

  const daySelect = document.createElement('select');
  daySelect.className = 'jalali-day';
  daySelect.setAttribute('aria-label', 'روز');

  const monthSelect = document.createElement('select');
  monthSelect.className = 'jalali-month';
  monthSelect.setAttribute('aria-label', 'ماه');
  PERSIAN_MONTHS.forEach((m, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx + 1);
    opt.textContent = m;
    monthSelect.appendChild(opt);
  });

  const yearSelect = document.createElement('select');
  yearSelect.className = 'jalali-year';
  yearSelect.setAttribute('aria-label', 'سال');
  const currentJalaliYear = todayJalali().jy;
  for (let y = currentJalaliYear + 2; y >= currentJalaliYear - 10; y--) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    yearSelect.appendChild(opt);
  }

  function rebuildDays() {
    const jy = parseInt(yearSelect.value, 10) || currentJalaliYear;
    const jm = parseInt(monthSelect.value, 10) || 1;
    const len = jalaliMonthLength(jy, jm);
    const prevDay = parseInt(daySelect.value, 10) || 1;
    daySelect.innerHTML = '';
    for (let d = 1; d <= len; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = String(d);
      daySelect.appendChild(opt);
    }
    daySelect.value = String(Math.min(prevDay, len));
  }

  function syncHiddenInput() {
    const jy = parseInt(yearSelect.value, 10);
    const jm = parseInt(monthSelect.value, 10);
    const jd = parseInt(daySelect.value, 10);
    if (jy && jm && jd) {
      hiddenInput.value = jalaliToIso(jy, jm, jd);
      hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
      hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  monthSelect.addEventListener('change', () => { rebuildDays(); syncHiddenInput(); });
  yearSelect.addEventListener('change', () => { rebuildDays(); syncHiddenInput(); });
  daySelect.addEventListener('change', syncHiddenInput);

  rebuildDays();

  wrapper.appendChild(daySelect);
  wrapper.appendChild(monthSelect);
  wrapper.appendChild(yearSelect);

  hiddenInput.style.display = 'none';
  hiddenInput.insertAdjacentElement('afterend', wrapper);

  // expose a setter so code can programmatically set this picker's value
  hiddenInput._jalaliSetIso = function (isoDate) {
    const j = isoToJalali(isoDate) || todayJalali();
    yearSelect.value = String(j.jy);
    monthSelect.value = String(j.jm);
    rebuildDays();
    daySelect.value = String(j.jd);
    hiddenInput.value = jalaliToIso(j.jy, j.jm, j.jd);
  };

  // initialize with existing value or today
  hiddenInput._jalaliSetIso(hiddenInput.value || isoToday());
}

// Helper used by app code: set a jalali-picker-bound date field's value
// programmatically (equivalent to el.value = x for a plain input[date]).
function setJalaliDateValue(hiddenInputId, isoDate) {
  const el = document.getElementById(hiddenInputId);
  if (!el) return;
  if (el._jalaliSetIso) {
    el._jalaliSetIso(isoDate || isoToday());
  } else {
    el.value = isoDate || '';
  }
}

// Initializes jalali pickers for every input carrying data-jalali="1"
function initAllJalaliPickers() {
  document.querySelectorAll('input[data-jalali="1"]').forEach(input => {
    buildJalaliPicker(input.id);
  });
}
