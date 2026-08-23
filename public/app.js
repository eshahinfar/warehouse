'use strict';

let currentUser = null;
let currentPermissions = [];
let allRoles = [];
let minPasswordLength = 8;

// وضعیت صفحه‌بندی فهرست اسناد
const docPaging = { offset: 0, limit: 50, total: 0 };

// ======================================================================
// API helper
// ======================================================================
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `خطا (${res.status})`);
    err.status = res.status;
    err.mustChangePassword = !!data.mustChangePassword;
    if (err.mustChangePassword) forceAccountTab();
    throw err;
  }
  return data;
}

function hasPermission(p) {
  return currentPermissions.includes('*') || currentPermissions.includes(p);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ======================================================================
// شنونده‌ی رویداد سراسری (event delegation)
//
// نسخه قبلی دکمه‌ها را با onclick درون‌خطی می‌ساخت؛ این کار سیاست امنیتی
// CSP را مجبور می‌کرد 'unsafe-inline' را برای اسکریپت باز بگذارد و عملاً
// بیشترِ فایده‌ی CSP در برابر XSS از بین می‌رفت. حالا هر دکمه فقط
// data-action و data-* دارد و منطق این‌جاست، پس CSP می‌تواند سخت‌گیر
// بماند (script-src 'self').
// ======================================================================
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const d = el.dataset;
  switch (d.action) {
    case 'print-receipt': printLastReceipt(); break;
    case 'delete-product': deleteProduct(Number(d.id), d.name); break;
    case 'restore-product': restoreProduct(Number(d.id), d.name); break;
    case 'toggle-user': toggleUserActive(Number(d.id), d.active === '1'); break;
    case 'cancel-request': cancelRequest(Number(d.id)); break;
    case 'edit-document': editDocument(Number(d.id), Number(d.qty), d.date, d.party); break;
    case 'void-document': voidDocument(Number(d.id), d.docnumber); break;
    case 'edit-custody': editCustody(Number(d.id)); break;
    case 'void-custody': voidCustody(Number(d.id), d.docnumber); break;
    case 'void-repair': voidRepair(Number(d.id), d.docnumber); break;
    default: break;
  }
});

// ======================================================================
// Auth / bootstrap
// ======================================================================
async function checkSession() {
  try {
    const data = await api('GET', '/api/me');
    currentUser = data.user;
    currentPermissions = data.permissions;
    allRoles = data.roles;
    if (data.minPasswordLength) minPasswordLength = data.minPasswordLength;
    showApp();
  } catch (e) {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-screen').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');
  document.getElementById('user-fullname').textContent = currentUser.fullName;
  document.getElementById('user-role').textContent = currentUser.role;
  document.getElementById('must-change-password-alert').classList.toggle('hidden', !currentUser.mustChangePassword);

  document.getElementById('users-tab-btn').classList.toggle('hidden', !hasPermission('users.manage'));
  document.getElementById('audit-tab-btn').classList.toggle('hidden', !hasPermission('audit.view'));
  document.getElementById('stockin-tab-btn').classList.toggle('hidden', !hasPermission('stock.in'));
  document.getElementById('stockout-tab-btn').classList.toggle('hidden', !hasPermission('stock.out'));
  document.getElementById('returns-tab-btn').classList.toggle('hidden', !hasPermission('returns.create'));
  document.getElementById('custody-tab-btn').classList.toggle('hidden', !hasPermission('custody.manage'));
  document.getElementById('repair-tab-btn').classList.toggle('hidden', !hasPermission('repair.manage'));
  document.getElementById('requests-tab-btn').classList.toggle('hidden', !hasPermission('requests.view'));
  document.getElementById('documents-tab-btn').classList.toggle('hidden', !hasPermission('documents.manage'));
  document.getElementById('reports-tab-btn').classList.toggle('hidden', !hasPermission('reports.view'));

  const roleSelect = document.getElementById('uf-role');
  roleSelect.innerHTML = allRoles.map(r => `<option value="${escapeHtml(r.key)}">${escapeHtml(r.label)}</option>`).join('');

  initAllJalaliPickers();
  connectLiveUpdates();
  startLivePolling();

  if (currentUser.mustChangePassword) {
    // تا وقتی رمز اولیه عوض نشده، سرور هیچ مسیر دیگری را پاسخ نمی‌دهد؛
    // پس کاربر را مستقیم به تب حساب کاربری می‌بریم تا سردرگم نشود.
    forceAccountTab();
    return;
  }

  loadDashboard();
  loadProducts();
}

function switchToTab(tabId) {
  const btn = document.querySelector(`nav.tabs button[data-tab="${tabId}"]`);
  if (!btn) return;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('main > section').forEach(sec => sec.classList.add('hidden'));
  btn.classList.add('active');
  document.getElementById(tabId).classList.remove('hidden');
}

function forceAccountTab() {
  if (!currentUser) return;
  switchToTab('account-tab');
  document.getElementById('must-change-password-alert').classList.remove('hidden');
}

// ======================================================================
// Live updates — WebSocket (آنی) با پشتیبان polling (هر ۳۰ ثانیه، فقط
// برای اطمینان در صورت قطع موقت اتصال WebSocket، مثلاً افت شبکه).
// ======================================================================
let liveSocket = null;
let liveSocketRetryDelay = 1000;

function connectLiveUpdates() {
  if (!currentUser) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  liveSocket = new WebSocket(`${protocol}//${window.location.host}/ws`);

  liveSocket.addEventListener('open', () => {
    liveSocketRetryDelay = 1000; // موفقیت‌آمیز بود، تأخیر تلاش مجدد ریست شود
  });

  liveSocket.addEventListener('message', () => {
    const activeTab = document.querySelector('nav.tabs button.active');
    if (activeTab) refreshActiveTab(activeTab.dataset.tab);
  });

  liveSocket.addEventListener('close', () => {
    if (!currentUser) return; // خروج عمدی از سیستم بوده، تلاش مجدد لازم نیست
    setTimeout(connectLiveUpdates, liveSocketRetryDelay);
    liveSocketRetryDelay = Math.min(liveSocketRetryDelay * 2, 30000);
  });

  liveSocket.addEventListener('error', () => {
    liveSocket.close();
  });
}

let livePollingHandle = null;
function startLivePolling() {
  if (livePollingHandle) return;
  livePollingHandle = setInterval(() => {
    if (!currentUser) return;
    const activeTab = document.querySelector('nav.tabs button.active');
    if (!activeTab) return;
    refreshActiveTab(activeTab.dataset.tab);
  }, 30000);
}

function refreshActiveTab(tabId) {
  const refreshers = {
    'dashboard-tab': loadDashboard,
    'products-tab': loadProducts,
    'users-tab': loadUsers,
    'audit-tab': () => { loadAuditLog(); loadBackupStatus(); },
    'stockin-tab': loadRecentStockIn,
    'stockout-tab': loadRecentStockOut,
    'returns-tab': loadRecentReturns,
    'custody-tab': loadCustodyList,
    'repair-tab': loadRepairList,
    'requests-tab': loadRequestsList,
    'documents-tab': loadDocumentsList
  };
  const fn = refreshers[tabId];
  if (fn) fn();
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errDiv = document.getElementById('login-error');
  errDiv.innerHTML = '';
  if (!username || !password) {
    errDiv.innerHTML = '<div class="alert alert-danger">نام کاربری و رمز عبور را وارد کنید</div>';
    return;
  }
  try {
    const data = await api('POST', '/api/login', { username, password });
    currentUser = data.user;
    currentPermissions = data.permissions;
    document.getElementById('login-password').value = '';
    const meData = await api('GET', '/api/me');
    allRoles = meData.roles;
    if (meData.minPasswordLength) minPasswordLength = meData.minPasswordLength;
    showApp();
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ }
  // بارگذاری کامل مجدد صفحه (نه فقط تعویض نما) تا هیچ داده‌ی کاربر قبلی
  // (کش کالاها، دسترسی‌ها، تایمر به‌روزرسانی زنده) در حافظه مرورگر باقی
  // نماند — مهم برای سناریوی کامپیوترهای مشترک در انبار/کارخانه.
  window.location.reload();
});

// ======================================================================
// Tabs
// ======================================================================
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.remove('hidden');
    refreshActiveTab(btn.dataset.tab);
  });
});

// ======================================================================
// Dashboard
// ======================================================================
async function loadDashboard() {
  try {
    const d = await api('GET', '/api/dashboard');
    document.getElementById('stat-total-products').textContent = d.totalProducts;
    document.getElementById('stat-warn').textContent = d.warnCount;
    document.getElementById('stat-critical').textContent = d.criticalCount;
    document.getElementById('stat-transactions').textContent = d.totalTransactions;
    document.getElementById('stat-custody-open').textContent = d.custodyOpenCount;
    document.getElementById('stat-repair-open').textContent = d.repairOpenCount;

    const tbody = document.getElementById('recent-tx-body');
    tbody.innerHTML = '';
    if (d.recentTransactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--ink-soft);">سندی ثبت نشده است</td></tr>';
      return;
    }
    d.recentTransactions.forEach(t => {
      const party = t.type === 'ورود' ? (t.source || '-') : (t.returnedBy || t.receiver || '-');
      const badgeClass = t.type === 'ورود' ? 'badge-ok' : t.type === 'مرجوعی' ? 'badge-warn' : 'badge-danger';
      tbody.innerHTML += `<tr>
        <td>${escapeHtml(t.docNumber)}</td><td>${escapeHtml(t.date)}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(t.type)}</span></td>
        <td>${escapeHtml(t.productName || '-')}</td><td>${t.quantity}</td><td>${escapeHtml(party)}</td>
      </tr>`;
    });
  } catch (e) {
    console.error(e);
  }
}

// ======================================================================
// Products
// ======================================================================
// Product picker: uses native <datalist> so the browser itself provides
// reliable, always-correct search/filter behaviour (avoids the class of
// custom-dropdown bugs from earlier iterations). Each product appears as
// "CODE — NAME"; resolveProductByLabel() maps typed text back to a
// productId by matching the leading code.
// ======================================================================
let allProductsCache = [];

// ======================================================================
// Print receipts — official printable documents. Uses a single hidden
// #print-area element: its content is filled just before printing, and
// CSS (@media print) hides everything else on the page so only the
// receipt itself appears on paper. Works with the browser's native
// print dialog, which on virtually every modern browser also offers a
// "Save as PDF" destination — no extra library required.
// ======================================================================
function renderReceiptHtml(title, docNumber, rows, signLabels) {
  const rowsHtml = rows.map(([label, value]) =>
    `<tr><th style="width:35%;text-align:right;padding:.4rem .6rem;border-bottom:1px solid #eee;">${escapeHtml(label)}</th>
     <td style="padding:.4rem .6rem;border-bottom:1px solid #eee;">${escapeHtml(value ?? '-')}</td></tr>`
  ).join('');
  const signHtml = signLabels.map(l =>
    `<div style="text-align:center;flex:1;"><div style="border-top:1px solid #000;margin-top:2.2rem;padding-top:.3rem;font-size:.85rem;">${escapeHtml(l)}</div></div>`
  ).join('');

  return `
    <div class="doc-head">
      <h3>${escapeHtml(title)}</h3>
      <div class="doc-no">شماره سند: ${escapeHtml(docNumber)}</div>
    </div>
    <table>${rowsHtml}</table>
    <div class="sign-row">${signHtml}</div>
  `;
}

function printReceipt(html) {
  const area = document.getElementById('print-area');
  area.innerHTML = html;
  window.print();
}

function todayJalaliDisplay() {
  try { return formatJalali(new Date().toISOString().split('T')[0]); } catch (e) { return ''; }
}

let lastReceiptHtml = '';
function printLastReceipt() { printReceipt(lastReceiptHtml); }

function productLabel(p) {
  return `${p.code} — ${p.name}`;
}

function populateProductDatalists() {
  const all = document.getElementById('products-datalist');
  const tools = document.getElementById('tools-datalist');
  all.innerHTML = allProductsCache.map(p => `<option value="${escapeHtml(productLabel(p))}">`).join('');
  tools.innerHTML = allProductsCache.filter(p => p.type === 'قابل‌برگشت').map(p => `<option value="${escapeHtml(productLabel(p))}">`).join('');
}

function resolveProductByLabel(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // exact label match first
  let match = allProductsCache.find(p => productLabel(p) === trimmed);
  if (match) return match;
  // otherwise try matching just the leading code (in case user only typed the code)
  const code = trimmed.split('—')[0].trim();
  match = allProductsCache.find(p => p.code === code);
  return match || null;
}

function statusBadge(status) {
  if (status === 'critical') return '<span class="badge badge-danger">کمبود</span>';
  if (status === 'warn') return '<span class="badge badge-warn">هشدار</span>';
  return '<span class="badge badge-ok">نرمال</span>';
}

async function loadProducts() {
  try {
    const d = await api('GET', '/api/products');
    allProductsCache = d.products;
    populateProductDatalists();

    const tbody = document.getElementById('products-body');
    tbody.innerHTML = '';
    const canEdit = hasPermission('products.edit');
    const canDelete = hasPermission('products.delete');
    document.getElementById('product-form-card').classList.toggle('hidden', !canEdit);

    if (d.products.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--ink-soft);">کالایی ثبت نشده است</td></tr>';
      return;
    }
    tbody.innerHTML = d.products.map(p => {
      const actions = canDelete
        ? (p.archived
          ? `<button class="outline" style="padding:.3rem .6rem;font-size:.75rem;" data-action="restore-product" data-id="${p.id}" data-name="${escapeHtml(p.name)}">خروج از بایگانی</button>`
          : `<button class="danger" style="padding:.3rem .6rem;font-size:.75rem;" data-action="delete-product" data-id="${p.id}" data-name="${escapeHtml(p.name)}">حذف/بایگانی</button>`)
        : '-';

      // اگر بخشی از کالا دست کاربران یا در تعمیرگاه باشد، عدد «قابل
      // تخصیص» با موجودی دفتری فرق می‌کند؛ همان‌جا توضیحش را نشان می‌دهیم.
      const outParts = [];
      if (p.inCustody) outParts.push(`${p.inCustody} امانت`);
      if (p.inRepair) outParts.push(`${p.inRepair} تعمیر`);
      const availableCell = outParts.length
        ? `<strong>${p.available}</strong> <span style="font-size:.72rem;color:var(--ink-soft);">(${outParts.join('، ')})</span>`
        : `<strong>${p.available}</strong>`;

      return `<tr>
        <td>${escapeHtml(p.code)}</td><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.type)}</td>
        <td>${escapeHtml(p.unit)}</td><td>${p.stock}</td><td>${availableCell}</td><td>${p.minStock}</td>
        <td>${statusBadge(p.status)}</td><td>${actions}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    console.error(e);
  }
}

document.getElementById('pf-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('product-form-error');
  errDiv.innerHTML = '';
  const payload = {
    code: document.getElementById('pf-code').value.trim(),
    name: document.getElementById('pf-name').value.trim(),
    type: document.getElementById('pf-type').value,
    unit: document.getElementById('pf-unit').value.trim(),
    minStock: Number(document.getElementById('pf-min-stock').value),
    openingStock: Number(document.getElementById('pf-opening-stock').value) || 0,
    openingStockDate: document.getElementById('pf-opening-date').value,
    usageLocation: document.getElementById('pf-usage-location').value.trim(),
    shelf: document.getElementById('pf-shelf').value.trim()
  };
  try {
    await api('POST', '/api/products', payload);
    ['pf-code', 'pf-name', 'pf-unit', 'pf-min-stock', 'pf-usage-location', 'pf-shelf'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('pf-opening-stock').value = '0';
    setJalaliDateValue('pf-opening-date', null);   // بازگشت به تاریخ امروز
    loadProducts();
    loadDashboard();
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

async function deleteProduct(id, name) {
  const reason = prompt(
    `دلیل حذف کالای «${name}» را وارد کنید:\n\n` +
    'توجه: اگر این کالا سند (ورود/خروج/امانت/تعمیر) داشته باشد، حذف نمی‌شود بلکه ' +
    '«بایگانی» می‌شود تا سوابق و گزارش‌های سال‌های گذشته دست‌نخورده بماند.');
  if (reason === null) return;
  if (!reason.trim()) { alert('ثبت دلیل الزامی است'); return; }
  try {
    const res = await api('DELETE', `/api/products/${id}`, { reason: reason.trim() });
    alert(res.mode === 'archived'
      ? (res.message || 'کالا بایگانی شد.')
      : 'کالا حذف شد (سندی نداشت).');
    loadProducts();
    loadDashboard();
  } catch (e) {
    alert(e.message);
  }
}

async function restoreProduct(id, name) {
  if (!confirm(`کالای «${name}» از بایگانی خارج شود؟`)) return;
  try {
    await api('POST', `/api/products/${id}/restore`);
    loadProducts();
  } catch (e) { alert(e.message); }
}

// ======================================================================
// Users (admin only)
// ======================================================================
async function loadUsers() {
  try {
    const d = await api('GET', '/api/users');
    const tbody = document.getElementById('users-body');
    tbody.innerHTML = '';
    d.users.forEach(u => {
      const statusBadgeHtml = u.active ? '<span class="badge badge-ok">فعال</span>' : '<span class="badge badge-danger">غیرفعال</span>';
      const toggleLabel = u.active ? 'غیرفعال کردن' : 'فعال کردن';
      tbody.innerHTML += `<tr>
        <td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.full_name)}</td><td>${escapeHtml(u.role)}</td>
        <td>${statusBadgeHtml}</td>
        <td><button class="outline" style="padding:.3rem .6rem;font-size:.75rem;" data-action="toggle-user" data-id="${u.id}" data-active="${u.active ? '0' : '1'}">${toggleLabel}</button></td>
      </tr>`;
    });
  } catch (e) {
    console.error(e);
  }
}

document.getElementById('uf-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('user-form-error');
  errDiv.innerHTML = '';
  const payload = {
    username: document.getElementById('uf-username').value.trim(),
    password: document.getElementById('uf-password').value,
    fullName: document.getElementById('uf-fullname').value.trim(),
    role: document.getElementById('uf-role').value
  };
  try {
    await api('POST', '/api/users', payload);
    ['uf-username', 'uf-password', 'uf-fullname'].forEach(id => document.getElementById(id).value = '');
    loadUsers();
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

async function toggleUserActive(id, active) {
  try {
    await api('PUT', `/api/users/${id}`, { active });
    loadUsers();
  } catch (e) {
    alert(e.message);
  }
}

// ======================================================================
// Audit log (admin only)
// ======================================================================
async function loadAuditLog() {
  try {
    const d = await api('GET', '/api/audit-log');
    const tbody = document.getElementById('audit-body');
    tbody.innerHTML = '';
    if (d.auditLog.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--ink-soft);">رکوردی ثبت نشده است</td></tr>';
      return;
    }
    d.auditLog.forEach(a => {
      tbody.innerHTML += `<tr>
        <td>${escapeHtml(a.timestamp)}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.docNumber)}</td>
        <td>${escapeHtml(a.changeDescription)}</td><td>${escapeHtml(a.reason)}</td><td>${escapeHtml(a.performedBy)}</td>
      </tr>`;
    });
  } catch (e) {
    console.error(e);
  }
}

// ======================================================================
// Account / password change
// ======================================================================
document.getElementById('pw-submit').addEventListener('click', async () => {
  const statusDiv = document.getElementById('pw-change-status');
  statusDiv.innerHTML = '';
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;
  if (newPassword.length < minPasswordLength) {
    statusDiv.innerHTML = `<div class="alert alert-danger">رمز جدید باید حداقل ${minPasswordLength} کاراکتر باشد</div>`;
    return;
  }
  try {
    await api('PUT', '/api/me/password', { currentPassword, newPassword });
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    statusDiv.innerHTML = '<div class="alert alert-ok">رمز عبور با موفقیت تغییر یافت. نشست‌های باز شما روی دستگاه‌های دیگر بسته شد.</div>';
    const wasBlocked = currentUser.mustChangePassword;
    currentUser.mustChangePassword = false;
    document.getElementById('must-change-password-alert').classList.add('hidden');
    if (wasBlocked) {
      // حالا که رمز عوض شده، بقیه سامانه باز می‌شود
      switchToTab('dashboard-tab');
      loadDashboard();
      loadProducts();
    }
  } catch (e) {
    statusDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

// ======================================================================
// Stock In
// ======================================================================
async function loadRecentStockIn() {
  try {
    const d = await api('GET', '/api/transactions?type=' + encodeURIComponent('ورود'));
    const tbody = document.getElementById('stockin-list-body');
    tbody.innerHTML = '';
    d.transactions.slice(0, 15).forEach(t => {
      const p = allProductsCache.find(x => x.id === t.productId);
      tbody.innerHTML += `<tr><td>${escapeHtml(t.docNumber)}</td><td>${escapeHtml(t.date)}</td>
        <td>${escapeHtml(p ? p.name : '-')}</td><td>${t.quantity}</td><td>${escapeHtml(t.source || '-')}</td></tr>`;
    });
  } catch (e) { console.error(e); }
}

document.getElementById('si-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('stockin-error');
  errDiv.innerHTML = '';
  const product = resolveProductByLabel(document.getElementById('si-product').value);
  if (!product) { errDiv.innerHTML = '<div class="alert alert-danger">یک کالای معتبر از فهرست انتخاب کنید</div>'; return; }
  const payload = {
    productId: product.id,
    quantity: Number(document.getElementById('si-quantity').value),
    date: document.getElementById('si-date').value,
    source: document.getElementById('si-source').value.trim(),
    poNumber: document.getElementById('si-po').value.trim(),
    description: document.getElementById('si-description').value.trim()
  };
  try {
    const result = await api('POST', '/api/stock-in', payload);
    const t = result.transaction;
    document.getElementById('si-product').value = '';
    document.getElementById('si-quantity').value = '';
    document.getElementById('si-source').value = '';
    document.getElementById('si-po').value = '';
    document.getElementById('si-description').value = '';
    loadProducts(); loadDashboard(); loadRecentStockIn();
    const receiptHtml = renderReceiptHtml('رسید ورود کالا', t.docNumber, [
      ['تاریخ', todayJalaliDisplay() || t.date], ['کد کالا', product.code], ['نام کالا', product.name],
      ['تعداد', `${t.quantity} ${product.unit}`], ['تأمین‌کننده/منبع', t.source], ['شماره سفارش خرید', t.poNumber]
    ], ['تحویل‌دهنده انبار', 'تحویل‌گیرنده انبار']);
    lastReceiptHtml = receiptHtml;
    errDiv.innerHTML = `<div class="alert alert-ok">رسید ${escapeHtml(t.docNumber)} ثبت شد.
      <button class="outline" style="margin-right:.6rem;padding:.3rem .7rem;font-size:.78rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ رسید</button></div>`;
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

// ======================================================================
// Stock Out
// ======================================================================
async function loadRecentStockOut() {
  try {
    const d = await api('GET', '/api/transactions?type=' + encodeURIComponent('خروج'));
    const tbody = document.getElementById('stockout-list-body');
    tbody.innerHTML = '';
    d.transactions.slice(0, 15).forEach(t => {
      const p = allProductsCache.find(x => x.id === t.productId);
      tbody.innerHTML += `<tr><td>${escapeHtml(t.docNumber)}</td><td>${escapeHtml(t.date)}</td>
        <td>${escapeHtml(p ? p.name : '-')}</td><td>${t.quantity}</td><td>${escapeHtml(t.receiver || '-')}</td></tr>`;
    });
  } catch (e) { console.error(e); }
}

async function submitStockOut(force) {
  const errDiv = document.getElementById('stockout-error');
  errDiv.innerHTML = '';
  const product = resolveProductByLabel(document.getElementById('so-product').value);
  if (!product) { errDiv.innerHTML = '<div class="alert alert-danger">یک کالای معتبر از فهرست انتخاب کنید</div>'; return; }
  const payload = {
    productId: product.id,
    quantity: Number(document.getElementById('so-quantity').value),
    date: document.getElementById('so-date').value,
    requestingUnit: document.getElementById('so-unit').value,
    receiver: document.getElementById('so-receiver').value.trim(),
    reason: document.getElementById('so-reason').value,
    force: !!force
  };
  try {
    const result = await api('POST', '/api/stock-out', payload);
    const t = result.transaction;
    document.getElementById('so-product').value = '';
    document.getElementById('so-quantity').value = '';
    document.getElementById('so-receiver').value = '';
    loadProducts(); loadDashboard(); loadRecentStockOut();
    lastReceiptHtml = renderReceiptHtml('حواله خروج کالا', t.docNumber, [
      ['تاریخ', todayJalaliDisplay() || t.date], ['کد کالا', product.code], ['نام کالا', product.name],
      ['تعداد', `${t.quantity} ${product.unit}`], ['واحد درخواست‌کننده', t.requestingUnit],
      ['تحویل‌گیرنده', t.receiver], ['دلیل خروج', t.reason]
    ], ['تحویل‌دهنده انبار', 'تحویل‌گیرنده کالا']);
    errDiv.innerHTML = `<div class="alert alert-ok">حواله ${escapeHtml(t.docNumber)} ثبت شد.
      <button class="outline" style="margin-right:.6rem;padding:.3rem .7rem;font-size:.78rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ حواله</button></div>`;
  } catch (e) {
    if (e.status === 409) {
      if (confirm(e.message + '\n\nآیا مطمئنید می‌خواهید این خروج را به‌عنوان مصرف قطعی ثبت کنید؟')) {
        submitStockOut(true);
      }
    } else {
      errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
    }
  }
}

document.getElementById('so-submit').addEventListener('click', () => submitStockOut(false));

// ======================================================================
// Returns
// ======================================================================
async function loadRecentReturns() {
  try {
    const d = await api('GET', '/api/transactions?type=' + encodeURIComponent('مرجوعی'));
    const tbody = document.getElementById('returns-list-body');
    tbody.innerHTML = '';
    d.transactions.slice(0, 15).forEach(t => {
      const p = allProductsCache.find(x => x.id === t.productId);
      tbody.innerHTML += `<tr><td>${escapeHtml(t.docNumber)}</td><td>${escapeHtml(t.date)}</td>
        <td>${escapeHtml(p ? p.name : '-')}</td><td>${t.quantity}</td><td>${escapeHtml(t.returnedBy || '-')}</td><td>${escapeHtml(t.condition || '-')}</td></tr>`;
    });
  } catch (e) { console.error(e); }
}

document.getElementById('rt-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('returns-error');
  errDiv.innerHTML = '';
  const product = resolveProductByLabel(document.getElementById('rt-product').value);
  if (!product) { errDiv.innerHTML = '<div class="alert alert-danger">یک کالای معتبر از فهرست انتخاب کنید</div>'; return; }
  const payload = {
    productId: product.id,
    quantity: Number(document.getElementById('rt-quantity').value),
    date: document.getElementById('rt-date').value,
    returnedBy: document.getElementById('rt-returned-by').value.trim(),
    condition: document.getElementById('rt-condition').value
  };
  try {
    const result = await api('POST', '/api/returns', payload);
    const t = result.transaction;
    document.getElementById('rt-product').value = '';
    document.getElementById('rt-quantity').value = '';
    document.getElementById('rt-returned-by').value = '';
    loadProducts(); loadDashboard(); loadRecentReturns();
    lastReceiptHtml = renderReceiptHtml('رسید مرجوعی کالا', t.docNumber, [
      ['تاریخ', todayJalaliDisplay() || t.date], ['کد کالا', product.code], ['نام کالا', product.name],
      ['تعداد', `${t.quantity} ${product.unit}`], ['تحویل‌دهنده', t.returnedBy], ['وضعیت کالا', t.condition]
    ], ['تحویل‌دهنده مرجوعی', 'تحویل‌گیرنده انبار']);
    errDiv.innerHTML = `<div class="alert alert-ok">مرجوعی ${escapeHtml(t.docNumber)} ثبت شد.
      <button class="outline" style="margin-right:.6rem;padding:.3rem .7rem;font-size:.78rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ رسید</button></div>`;
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

// ======================================================================
// Custody (امانت ابزار)
// ======================================================================
function custodyStatusBadge(c) {
  if (c.status === 'باطل') return '<span class="badge badge-neutral">باطل شده</span>';
  if (c.status === 'باز') {
    if (c.expectedReturn && c.expectedReturn < new Date().toISOString().split('T')[0]) {
      return '<span class="badge badge-danger">عقب‌افتاده</span>';
    }
    return '<span class="badge badge-purple">در گردش</span>';
  }
  if (c.conditionIn === 'مفقود') return '<span class="badge badge-danger">مفقود</span>';
  if (c.conditionIn === 'نیازمند تعمیر') return '<span class="badge badge-warn">ارسال به تعمیر</span>';
  return '<span class="badge badge-ok">سالم بازگشته</span>';
}

let custodyRecordsCache = [];

async function loadCustodyList() {
  try {
    const d = await api('GET', '/api/custody');
    custodyRecordsCache = d.custodyRecords;
    const tbody = document.getElementById('custody-list-body');
    tbody.innerHTML = '';
    tbody.innerHTML = d.custodyRecords.map(c => {
      const p = allProductsCache.find(x => x.id === c.productId);
      const actions = c.status === 'باز'
        ? `<button class="outline" style="padding:.3rem .5rem;font-size:.72rem;" data-action="edit-custody" data-id="${c.id}">ویرایش</button>
           <button class="danger" style="padding:.3rem .5rem;font-size:.72rem;" data-action="void-custody" data-id="${c.id}" data-docnumber="${escapeHtml(c.docNumber)}">ابطال</button>`
        : '-';
      const rowStyle = c.status === 'باطل' ? ' style="opacity:.55;text-decoration:line-through;"' : '';
      return `<tr${rowStyle}><td>${escapeHtml(c.docNumber)}</td><td>${escapeHtml(p ? p.name : '-')}</td>
        <td>${c.quantity}</td><td>${escapeHtml(c.holder)}</td><td>${escapeHtml(c.issueDate)}</td>
        <td>${escapeHtml(c.expectedReturn || '-')}</td><td>${custodyStatusBadge(c)}</td><td>${actions}</td></tr>`;
    }).join('');
    const recordSelect = document.getElementById('cr-record');
    const openRecords = d.custodyRecords.filter(c => c.status === 'باز');
    recordSelect.innerHTML = '<option value="">انتخاب کنید</option>' + openRecords.map(c => {
      const p = allProductsCache.find(x => x.id === c.productId);
      return `<option value="${c.id}">${escapeHtml(c.docNumber)} — ${escapeHtml(p ? p.name : '-')} (${escapeHtml(c.holder)})</option>`;
    }).join('');
  } catch (e) { console.error(e); }
}

document.getElementById('ci-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('custody-issue-error');
  errDiv.innerHTML = '';
  const product = resolveProductByLabel(document.getElementById('ci-product').value);
  if (!product) { errDiv.innerHTML = '<div class="alert alert-danger">یک ابزار معتبر از فهرست انتخاب کنید</div>'; return; }
  const payload = {
    productId: product.id,
    quantity: Number(document.getElementById('ci-quantity').value),
    date: document.getElementById('ci-date').value,
    holder: document.getElementById('ci-holder').value.trim(),
    unit: document.getElementById('ci-unit').value,
    expectedReturn: document.getElementById('ci-expected-return').value
  };
  try {
    const result = await api('POST', '/api/custody/issue', payload);
    const c = result.custodyRecord;
    document.getElementById('ci-product').value = '';
    document.getElementById('ci-quantity').value = '1';
    document.getElementById('ci-holder').value = '';
    loadProducts(); loadDashboard(); loadCustodyList();
    lastReceiptHtml = renderReceiptHtml('رسید تحویل امانی ابزار', c.docNumber, [
      ['تاریخ تحویل', todayJalaliDisplay() || c.issueDate], ['کد ابزار', product.code], ['نام ابزار', product.name],
      ['تعداد', `${c.quantity} ${product.unit}`], ['تحویل‌گیرنده', c.holder], ['واحد', c.unit],
      ['موعد بازگشت', c.expectedReturn]
    ], ['تحویل‌دهنده انبار', 'تحویل‌گیرنده (متعهد به بازگشت سالم)']);
    errDiv.innerHTML = `<div class="alert alert-ok">تحویل امانی ${escapeHtml(c.docNumber)} ثبت شد.
      <button class="outline" style="margin-right:.6rem;padding:.3rem .7rem;font-size:.78rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ رسید</button></div>`;
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

document.getElementById('cr-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('custody-return-error');
  errDiv.innerHTML = '';
  const recordId = document.getElementById('cr-record').value;
  if (!recordId) { errDiv.innerHTML = '<div class="alert alert-danger">یک رکورد باز انتخاب کنید</div>'; return; }
  const payload = {
    date: document.getElementById('cr-date').value,
    conditionIn: document.getElementById('cr-condition').value,
    notes: document.getElementById('cr-notes').value.trim()
  };
  try {
    const result = await api('POST', `/api/custody/${recordId}/return`, payload);
    document.getElementById('cr-notes').value = '';
    let msg = 'بازگشت با موفقیت ثبت شد.';
    if (result.repairDocNumber) msg += ` رکورد تعمیر ${result.repairDocNumber} به‌طور خودکار ایجاد شد.`;
    if (result.stockAdjusted) msg += ' موجودی به دلیل مفقودی اصلاح شد.';
    alert(msg);
    loadProducts(); loadDashboard(); loadCustodyList(); loadRepairList();
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

async function editCustody(id) {
  const record = custodyRecordsCache.find(c => c.id === id);
  if (!record) return;
  const holder = prompt('نام تحویل‌گیرنده:', record.holder);
  if (holder === null) return;
  const quantity = prompt('تعداد:', record.quantity);
  if (quantity === null) return;
  const expectedReturn = prompt('موعد بازگشت (میلادی، YYYY-MM-DD، خالی = بدون موعد):', record.expectedReturn || '');
  if (expectedReturn === null) return;
  const reason = prompt('دلیل ویرایش (الزامی):');
  if (!reason || !reason.trim()) { alert('ثبت دلیل الزامی است'); return; }
  try {
    await api('PUT', `/api/custody/${id}`, {
      quantity: Number(quantity), holder: holder.trim(), unit: record.unit,
      expectedReturn: expectedReturn.trim(), notes: record.notes, reason: reason.trim()
    });
    loadCustodyList(); loadProducts();
  } catch (e) { alert(e.message); }
}

async function voidCustody(id, docNumber) {
  const reason = prompt(`دلیل ابطال سند امانت ${docNumber} (الزامی):\n\n` +
    'ابطال یعنی این سند اشتباهی ثبت شده و ابزار اصلاً تحویل نشده است. ' +
    'برای بازگشت واقعی ابزار، از فرم «ثبت بازگشت» استفاده کنید.');
  if (reason === null) return;
  if (!reason.trim()) { alert('ثبت دلیل الزامی است'); return; }
  try {
    await api('POST', `/api/custody/${id}/void`, { reason: reason.trim() });
    loadCustodyList(); loadProducts(); loadDashboard();
  } catch (e) { alert(e.message); }
}

// ======================================================================
// Repair (تعمیرگاه)
// ======================================================================
function repairStatusBadge(r) {
  if (r.status === 'باطل') return '<span class="badge badge-neutral">باطل شده</span>';
  if (r.status === 'در حال تعمیر') return '<span class="badge badge-warn">در حال تعمیر</span>';
  if (r.result === 'غیرقابل تعمیر - اسقاط') return '<span class="badge badge-danger">اسقاط شده</span>';
  return '<span class="badge badge-ok">تعمیر و تحویل شد</span>';
}

async function loadRepairList() {
  try {
    const d = await api('GET', '/api/repair');
    const tbody = document.getElementById('repair-list-body');
    tbody.innerHTML = '';
    tbody.innerHTML = d.repairRecords.map(r => {
      const p = allProductsCache.find(x => x.id === r.productId);
      const actions = r.status === 'در حال تعمیر'
        ? `<button class="danger" style="padding:.3rem .5rem;font-size:.72rem;" data-action="void-repair" data-id="${r.id}" data-docnumber="${escapeHtml(r.docNumber)}">ابطال</button>`
        : '-';
      const rowStyle = r.status === 'باطل' ? ' style="opacity:.55;text-decoration:line-through;"' : '';
      return `<tr${rowStyle}><td>${escapeHtml(r.docNumber)}</td><td>${escapeHtml(p ? p.name : '-')}</td>
        <td>${r.quantity}</td><td>${escapeHtml(r.submittedBy)}</td><td>${escapeHtml(r.sendDate)}</td>
        <td>${repairStatusBadge(r)}</td><td>${actions}</td></tr>`;
    }).join('');
    const recordSelect = document.getElementById('rc-record');
    const openRecords = d.repairRecords.filter(r => r.status === 'در حال تعمیر');
    recordSelect.innerHTML = '<option value="">انتخاب کنید</option>' + openRecords.map(r => {
      const p = allProductsCache.find(x => x.id === r.productId);
      return `<option value="${r.id}">${escapeHtml(r.docNumber)} — ${escapeHtml(p ? p.name : '-')}</option>`;
    }).join('');
  } catch (e) { console.error(e); }
}

document.getElementById('rs-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('repair-send-error');
  errDiv.innerHTML = '';
  const product = resolveProductByLabel(document.getElementById('rs-product').value);
  if (!product) { errDiv.innerHTML = '<div class="alert alert-danger">یک کالای معتبر از فهرست انتخاب کنید</div>'; return; }
  const payload = {
    productId: product.id,
    quantity: Number(document.getElementById('rs-quantity').value),
    date: document.getElementById('rs-date').value,
    submittedBy: document.getElementById('rs-submitted-by').value.trim(),
    issueDescription: document.getElementById('rs-issue').value.trim()
  };
  try {
    const result = await api('POST', '/api/repair/send', payload);
    const r = result.repairRecord;
    document.getElementById('rs-product').value = '';
    document.getElementById('rs-quantity').value = '1';
    document.getElementById('rs-submitted-by').value = '';
    document.getElementById('rs-issue').value = '';
    loadRepairList();
    lastReceiptHtml = renderReceiptHtml('رسید ارسال به تعمیر', r.docNumber, [
      ['تاریخ ارسال', todayJalaliDisplay() || r.sendDate], ['کد کالا', product.code], ['نام کالا', product.name],
      ['تعداد', `${r.quantity} ${product.unit}`], ['تحویل‌دهنده', r.submittedBy], ['شرح خرابی', r.issueDescription]
    ], ['تحویل‌دهنده', 'مسئول تعمیرگاه']);
    errDiv.innerHTML = `<div class="alert alert-ok">ارسال به تعمیر ${escapeHtml(r.docNumber)} ثبت شد.
      <button class="outline" style="margin-right:.6rem;padding:.3rem .7rem;font-size:.78rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ رسید</button></div>`;
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

document.getElementById('rc-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('repair-complete-error');
  errDiv.innerHTML = '';
  const recordId = document.getElementById('rc-record').value;
  if (!recordId) { errDiv.innerHTML = '<div class="alert alert-danger">یک رکورد باز انتخاب کنید</div>'; return; }
  const payload = {
    date: document.getElementById('rc-date').value,
    result: document.getElementById('rc-result').value,
    technician: document.getElementById('rc-technician').value.trim(),
    approver: document.getElementById('rc-approver').value.trim()
  };
  try {
    const result = await api('POST', `/api/repair/${recordId}/complete`, payload);
    const r = result.repairRecord;
    document.getElementById('rc-technician').value = '';
    document.getElementById('rc-approver').value = '';
    loadProducts(); loadDashboard(); loadRepairList();
    lastReceiptHtml = renderReceiptHtml('رسید تکمیل و بازگشت از تعمیر', r.resultDocNumber, [
      ['سند ارسال مرجع', r.docNumber], ['تاریخ تکمیل', todayJalaliDisplay() || r.resultDate],
      ['نتیجه تعمیر', r.result], ['نام تعمیرکار', r.technician], ['تأییدکننده تعمیرات', r.approver]
    ], ['تعمیرکار', 'تأییدکننده تعمیرات']);
    let msg = `تکمیل تعمیر ${escapeHtml(r.resultDocNumber)} ثبت شد.`;
    if (result.stockAdjusted) msg += ' موجودی به دلیل اسقاط اصلاح شد.';
    errDiv.innerHTML = `<div class="alert alert-ok">${msg}
      <button class="outline" style="margin-right:.6rem;padding:.3rem .7rem;font-size:.78rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ رسید</button></div>`;
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

async function voidRepair(id, docNumber) {
  const reason = prompt(`دلیل ابطال سند تعمیر ${docNumber} (الزامی):`);
  if (reason === null) return;
  if (!reason.trim()) { alert('ثبت دلیل الزامی است'); return; }
  try {
    await api('POST', `/api/repair/${id}/void`, { reason: reason.trim() });
    loadRepairList(); loadProducts(); loadDashboard();
  } catch (e) { alert(e.message); }
}

// ======================================================================
// Requests
// ======================================================================
function requestStatusBadge(r) {
  if (r.status === 'تأمین شده') return '<span class="badge badge-ok">تأمین شده</span>';
  if (r.status === 'لغو شده') return '<span class="badge badge-danger">لغو شده</span>';
  if (r.priority === 'بحرانی') return '<span class="badge badge-danger">در انتظار (بحرانی)</span>';
  if (r.priority === 'فوری') return '<span class="badge badge-warn">در انتظار (فوری)</span>';
  return '<span class="badge badge-neutral">در انتظار</span>';
}

async function loadRequestsList() {
  try {
    const d = await api('GET', '/api/requests');
    const tbody = document.getElementById('requests-list-body');
    tbody.innerHTML = '';
    const canManage = hasPermission('requests.manage');
    d.requests.forEach(r => {
      const p = allProductsCache.find(x => x.id === r.productId);
      const actions = (canManage && r.status === 'در انتظار')
        ? `<button class="outline" style="padding:.3rem .5rem;font-size:.72rem;" data-action="cancel-request" data-id="${r.id}">لغو</button>`
        : '-';
      tbody.innerHTML += `<tr><td>${escapeHtml(r.docNumber)}</td><td>${escapeHtml(p ? p.name : '-')}</td>
        <td>${r.quantity}</td><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.priority)}</td>
        <td>${requestStatusBadge(r)}</td><td>${actions}</td></tr>`;
    });
  } catch (e) { console.error(e); }
}

document.getElementById('rq-submit').addEventListener('click', async () => {
  const errDiv = document.getElementById('requests-error');
  errDiv.innerHTML = '';
  const product = resolveProductByLabel(document.getElementById('rq-product').value);
  if (!product) { errDiv.innerHTML = '<div class="alert alert-danger">یک کالای معتبر از فهرست انتخاب کنید</div>'; return; }
  const payload = {
    productId: product.id,
    quantity: Number(document.getElementById('rq-quantity').value),
    date: document.getElementById('rq-date').value,
    priority: document.getElementById('rq-priority').value
  };
  try {
    await api('POST', '/api/requests', payload);
    document.getElementById('rq-product').value = '';
    document.getElementById('rq-quantity').value = '';
    loadRequestsList();
  } catch (e) {
    errDiv.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
});

document.getElementById('rq-auto-generate').addEventListener('click', async () => {
  try {
    const result = await api('POST', '/api/requests/auto-generate');
    alert(`${result.createdCount} درخواست جدید ایجاد شد`);
    loadRequestsList();
  } catch (e) { alert(e.message); }
});

// درخواست حذف نمی‌شود، «لغو» می‌شود: شماره درخواست برای همیشه محفوظ
// می‌ماند تا ارجاع رسیدهای ورود به آن معتبر بماند.
async function cancelRequest(id) {
  const reason = prompt('دلیل لغو این درخواست (الزامی):');
  if (reason === null) return;
  if (!reason.trim()) { alert('ثبت دلیل الزامی است'); return; }
  try {
    await api('POST', `/api/requests/${id}/cancel`, { reason: reason.trim() });
    loadRequestsList();
  } catch (e) { alert(e.message); }
}

// ======================================================================
// Document management (edit/delete transactions) — admin only
// ======================================================================
async function loadDocumentsList() {
  try {
    const search = document.getElementById('doc-search').value.trim();
    const showVoided = document.getElementById('doc-show-voided').checked;
    const params = new URLSearchParams({ limit: String(docPaging.limit), offset: String(docPaging.offset) });
    if (search) params.set('search', search);
    if (showVoided) params.set('includeVoided', '1');

    const d = await api('GET', `/api/transactions?${params.toString()}`);
    docPaging.total = d.total;

    const tbody = document.getElementById('documents-list-body');
    if (d.transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--ink-soft);">سندی یافت نشد</td></tr>';
    } else {
      tbody.innerHTML = d.transactions.map(t => {
        const p = allProductsCache.find(x => x.id === t.productId);
        const party = t.type === 'ورود' ? (t.source || '-') : t.type === 'مرجوعی' ? (t.returnedBy || '-') : (t.receiver || '-');
        const voided = t.status === 'باطل';
        const statusCell = voided
          ? `<span class="badge badge-neutral" title="${escapeHtml(t.voidReason || '')}">باطل</span>`
          : '<span class="badge badge-ok">معتبر</span>';
        const actions = voided ? '-' : `
          <button class="outline" style="padding:.3rem .5rem;font-size:.72rem;" data-action="edit-document"
            data-id="${t.id}" data-qty="${t.quantity}" data-date="${escapeHtml(t.date)}" data-party="${escapeHtml(party)}">ویرایش</button>
          <button class="danger" style="padding:.3rem .5rem;font-size:.72rem;" data-action="void-document"
            data-id="${t.id}" data-docnumber="${escapeHtml(t.docNumber)}">ابطال</button>`;
        const rowStyle = voided ? ' style="opacity:.55;"' : '';
        return `<tr${rowStyle}><td>${escapeHtml(t.docNumber)}</td><td>${escapeHtml(t.date)}</td>
          <td>${escapeHtml(t.type)}</td><td>${escapeHtml(p ? p.name : '-')}</td><td>${t.quantity}</td>
          <td>${escapeHtml(party)}</td><td>${statusCell}</td><td>${actions}</td></tr>`;
      }).join('');
    }

    const from = docPaging.total === 0 ? 0 : docPaging.offset + 1;
    const to = Math.min(docPaging.offset + docPaging.limit, docPaging.total);
    document.getElementById('doc-page-info').textContent = `نمایش ${from} تا ${to} از ${docPaging.total} سند`;
    document.getElementById('doc-prev').disabled = docPaging.offset === 0;
    document.getElementById('doc-next').disabled = to >= docPaging.total;
  } catch (e) { console.error(e); }
}

let docSearchTimer = null;
document.getElementById('doc-search').addEventListener('input', () => {
  // جست‌وجو سمت پایگاه‌داده انجام می‌شود؛ با هر حرف یک درخواست نفرستیم
  clearTimeout(docSearchTimer);
  docSearchTimer = setTimeout(() => { docPaging.offset = 0; loadDocumentsList(); }, 300);
});
document.getElementById('doc-show-voided').addEventListener('change', () => {
  docPaging.offset = 0;
  loadDocumentsList();
});
document.getElementById('doc-prev').addEventListener('click', () => {
  docPaging.offset = Math.max(0, docPaging.offset - docPaging.limit);
  loadDocumentsList();
});
document.getElementById('doc-next').addEventListener('click', () => {
  if (docPaging.offset + docPaging.limit < docPaging.total) {
    docPaging.offset += docPaging.limit;
    loadDocumentsList();
  }
});

async function editDocument(id, currentQty, currentDate, currentParty) {
  const newQty = prompt('تعداد جدید:', currentQty);
  if (newQty === null) return;
  if (!/^\d+$/.test(newQty.trim()) || Number(newQty) <= 0) {
    alert('تعداد باید یک عدد صحیح بزرگ‌تر از صفر باشد'); return;
  }
  const newParty = prompt('طرف حساب جدید:', currentParty);
  if (newParty === null) return;
  const reason = prompt('دلیل ویرایش (الزامی):');
  if (!reason || !reason.trim()) { alert('ثبت دلیل الزامی است'); return; }
  try {
    await api('PUT', `/api/documents/${id}`, { quantity: Number(newQty), date: currentDate, party: newParty, reason: reason.trim() });
    loadDocumentsList(); loadProducts(); loadDashboard();
  } catch (e) { alert(e.message); }
}

async function voidDocument(id, docNumber) {
  const reason = prompt(
    `دلیل ابطال سند ${docNumber} (الزامی):\n\n` +
    'سند حذف نمی‌شود؛ شماره‌اش محفوظ می‌ماند، با برچسب «باطل» در سوابق باقی می‌ماند ' +
    'و اثرش بر موجودی برگردانده می‌شود.');
  if (reason === null) return;
  if (!reason.trim()) { alert('ثبت دلیل الزامی است'); return; }
  try {
    await api('DELETE', `/api/documents/${id}`, { reason: reason.trim() });
    loadDocumentsList(); loadProducts(); loadDashboard();
  } catch (e) { alert(e.message); }
}

// ======================================================================
// Reports
// ======================================================================
document.getElementById('report-shortage-btn').addEventListener('click', async () => {
  try {
    const d = await api('GET', '/api/reports/shortage?level=both');
    let html = `<h3 style="margin-bottom:.6rem;">کالاهای بحرانی (${d.critical.length})</h3>`;
    html += renderProductStatusTable(d.critical, 'همه کالاها بالای سطح بحرانی هستند');
    html += `<h3 style="margin:1rem 0 .6rem;">کالاهای در آستانه هشدار (${d.warn.length})</h3>`;
    html += renderProductStatusTable(d.warn, 'کالایی در آستانه هشدار نیست');
    document.getElementById('shortage-report-result').innerHTML = html;

    lastReceiptHtml = `<div class="doc-head"><h3>گزارش موجودی — کمبود و هشدار</h3><div class="doc-no">تاریخ گزارش: ${todayJalaliDisplay()}</div></div>${html}`;
    document.getElementById('shortage-report-result').innerHTML += `
      <button class="outline" style="margin-top:.8rem;padding:.4rem .8rem;font-size:.8rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ گزارش</button>`;
  } catch (e) { alert(e.message); }
});

function renderProductStatusTable(products, emptyMsg) {
  if (products.length === 0) return `<div class="alert alert-ok">${emptyMsg}</div>`;
  let html = '<table><thead><tr><th>کد</th><th>نام</th><th>موجودی</th><th>حداقل</th><th>وضعیت</th></tr></thead><tbody>';
  products.forEach(p => {
    html += `<tr><td>${escapeHtml(p.code)}</td><td>${escapeHtml(p.name)}</td><td>${p.stock}</td><td>${p.minStock}</td><td>${statusBadge(p.status)}</td></tr>`;
  });
  return html + '</tbody></table>';
}

document.getElementById('kx-submit').addEventListener('click', async () => {
  const product = resolveProductByLabel(document.getElementById('kx-product').value);
  if (!product) { alert('یک کالای معتبر انتخاب کنید'); return; }
  const start = document.getElementById('kx-start').value;
  const end = document.getElementById('kx-end').value;
  try {
    const d = await api('GET', `/api/reports/kardex?productId=${product.id}&startDate=${start}&endDate=${end}`);
    let html = `<h3>کاردکس: ${escapeHtml(d.product.name)} — موجودی فعلی: ${d.product.stock} ${escapeHtml(d.product.unit)}</h3>`;
    if (d.entries.length === 0) {
      html += '<div class="alert alert-warn">رکوردی در این بازه یافت نشد</div>';
    } else {
      html += '<table><thead><tr><th>شماره سند</th><th>تاریخ</th><th>نوع</th><th>تعداد</th><th>طرف حساب</th><th>موجودی پس از سند</th></tr></thead><tbody>';
      d.entries.forEach(e => {
        const rowStyle = e.voided ? ' style="opacity:.55;text-decoration:line-through;"' : '';
        const typeCell = e.voided ? `${escapeHtml(e.type)} <span class="badge badge-neutral">باطل</span>` : escapeHtml(e.type);
        html += `<tr${rowStyle}><td>${escapeHtml(e.docNumber)}</td><td>${escapeHtml(e.date)}</td><td>${typeCell}</td>
          <td>${e.quantity}</td><td>${escapeHtml(e.counterparty || '-')}</td><td>${e.balance}</td></tr>`;
      });
      html += '</tbody></table>';
    }
    document.getElementById('kardex-result').innerHTML = html;
    if (d.entries.length > 0) {
      lastReceiptHtml = `<div class="doc-head"><h3>کاردکس کالا</h3><div class="doc-no">تاریخ گزارش: ${todayJalaliDisplay()}</div></div>${html}`;
      document.getElementById('kardex-result').innerHTML += `
        <button class="outline" style="margin-top:.8rem;padding:.4rem .8rem;font-size:.8rem;" data-action="print-receipt"><span class="icon icon-print"></span>چاپ کاردکس</button>`;
    }
  } catch (e) { alert(e.message); }
});

// ======================================================================
// نگه‌داری و تطبیق موجودی (فقط مدیر سیستم)
// ======================================================================
const mtCheckBtn = document.getElementById('mt-check-btn');
if (mtCheckBtn) {
  mtCheckBtn.addEventListener('click', async () => {
    const box = document.getElementById('maintenance-result');
    box.innerHTML = 'در حال بررسی...';
    try {
      const d = await api('GET', '/api/maintenance/stock-check');
      if (d.ok) {
        box.innerHTML = `<div class="alert alert-ok">${escapeHtml(d.message)}</div>`;
        return;
      }
      let html = `<div class="alert alert-warn">${escapeHtml(d.message)}</div>`;
      html += '<table><thead><tr><th>کد</th><th>نام</th><th>موجودی ثبت‌شده</th><th>مجموع اسناد</th><th>اختلاف</th></tr></thead><tbody>';
      d.discrepancies.forEach(r => {
        html += `<tr><td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.name)}</td>
          <td>${r.storedStock}</td><td>${r.ledgerStock}</td><td>${r.storedStock - r.ledgerStock}</td></tr>`;
      });
      html += '</tbody></table>';
      html += '<button class="danger" id="mt-fix-btn" style="margin-top:.8rem;">اصلاح موجودی بر اساس اسناد</button>';
      box.innerHTML = html;

      document.getElementById('mt-fix-btn').addEventListener('click', async () => {
        if (!confirm('موجودی کالاهای بالا با مجموع اسناد معتبر هم‌تراز شود؟ این کار در لاگ حسابرسی ثبت می‌شود.')) return;
        try {
          const res = await api('POST', '/api/maintenance/stock-repair');
          box.innerHTML = `<div class="alert alert-ok">${escapeHtml(res.message)}</div>`;
          loadProducts(); loadDashboard(); loadAuditLog();
        } catch (e) { alert(e.message); }
      });
    } catch (e) {
      box.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
    }
  });
}

// ----------------------------------------------------------------------
// وضعیت پشتیبان‌گیری — مهم‌ترین کارش این است که خرابی خاموشِ مسیر آینه‌ای
// (قطع شدن پوشه شبکه) را قابل دیدن کند، نه دفن‌شده در لاگ ترمینال.
// ----------------------------------------------------------------------
function formatWhen(iso) {
  if (!iso) return 'هرگز';
  try {
    const d = new Date(iso);
    const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    return `${formatJalali(iso.split('T')[0])} ساعت ${time}`;
  } catch (e) { return iso; }
}

async function loadBackupStatus() {
  const box = document.getElementById('backup-status');
  if (!box) return;
  try {
    const d = await api('GET', '/api/maintenance/backup-status');

    let mirrorRow;
    if (!d.mirrorConfigured) {
      mirrorRow = `<div class="alert alert-warn" style="margin-top:.7rem;">
        <strong>مسیر آینه‌ای تنظیم نشده است.</strong> نسخه‌های پشتیبان فقط روی همان دیسک سرور
        ذخیره می‌شوند؛ اگر آن دیسک خراب شود، داده و پشتیبان با هم از دست می‌روند.
        در <code>config.json</code> کلید <code>backupMirrorDir</code> را روی یک پوشه‌ی شبکه یا
        هارد اکسترنال تنظیم کنید و سرور را دوباره اجرا کنید.</div>`;
    } else if (d.mirrorOk) {
      mirrorRow = `<div class="alert alert-ok" style="margin-top:.7rem;">
        مسیر آینه‌ای فعال و قابل نوشتن است: <code>${escapeHtml(d.mirrorPath)}</code><br>
        آخرین نسخه آینه‌ای: ${escapeHtml(formatWhen(d.lastMirrorAt))}</div>`;
    } else {
      mirrorRow = `<div class="alert alert-danger" style="margin-top:.7rem;">
        <strong>مسیر آینه‌ای در دسترس نیست:</strong> <code>${escapeHtml(d.mirrorPath)}</code><br>
        علت: ${escapeHtml(d.mirrorError || 'نامشخص')}<br>
        پشتیبان‌گیری محلی ادامه دارد، ولی نسخه‌ی بیرونی ساخته نمی‌شود. اگر پوشه شبکه است،
        بررسی کنید که در دسترس باشد و کاربرِ اجراکننده‌ی سرویس اجازه‌ی نوشتن داشته باشد.</div>`;
    }

    const errRow = d.lastError
      ? `<div class="alert alert-danger" style="margin-top:.7rem;">آخرین تلاش ناموفق بود: ${escapeHtml(d.lastError)}</div>`
      : '';

    box.innerHTML = `
      <table>
        <tbody>
          <tr><th style="width:40%;text-align:right;">پشتیبان‌گیری خودکار</th>
              <td>${d.enabled ? `فعال — هر ${d.intervalHours} ساعت` : 'غیرفعال'}</td></tr>
          <tr><th style="text-align:right;">آخرین نسخه موفق</th>
              <td>${escapeHtml(formatWhen(d.lastSuccessAt))}${d.lastFile ? ` — <code>${escapeHtml(d.lastFile)}</code>` : ''}</td></tr>
          <tr><th style="text-align:right;">محل ذخیره</th><td><code>${escapeHtml(d.dir)}</code></td></tr>
          <tr><th style="text-align:right;">تعداد نسخه‌های نگه‌داشته‌شده</th><td>${d.keepCount}</td></tr>
        </tbody>
      </table>
      ${mirrorRow}${errRow}`;
  } catch (e) {
    box.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
  }
}

const mtBackupBtn = document.getElementById('mt-backup-btn');
if (mtBackupBtn) {
  mtBackupBtn.addEventListener('click', async () => {
    const box = document.getElementById('maintenance-result');
    box.innerHTML = 'در حال ساخت نسخه پشتیبان...';
    try {
      const res = await api('POST', '/api/maintenance/backup-now');
      box.innerHTML = `<div class="alert alert-ok">نسخه پشتیبان ساخته شد: ${escapeHtml(res.file)}` +
        (res.mirrored ? ' (نسخه آینه‌ای هم در مسیر دوم ذخیره شد)' : '') + '</div>';
      loadBackupStatus();
    } catch (e) {
      box.innerHTML = `<div class="alert alert-danger">${escapeHtml(e.message)}</div>`;
    }
  });
}

// ======================================================================
// Init
// ======================================================================
checkSession();
