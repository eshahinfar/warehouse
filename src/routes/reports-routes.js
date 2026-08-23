'use strict';

const { db } = require('../db');
const { getStockStatus, stockSnapshot } = require('../business');
const { vId, vDate, vOptionalDate } = require('../validators');
const config = require('../config');

const routes = [];

function serializeProduct(row) {
  const snap = stockSnapshot(row);
  return {
    id: row.id, code: row.code, name: row.name, type: row.type, unit: row.unit,
    stock: row.stock, minStock: row.min_stock, usageLocation: row.usage_location,
    shelf: row.shelf, description: row.description,
    inCustody: snap.inCustody, inRepair: snap.inRepair, available: snap.available,
    status: getStockStatus(row)
  };
}

routes.push({
  method: 'GET', path: '/api/reports/shortage', permission: 'reports.view',
  handler: (ctx) => {
    const level = (ctx.query && ctx.query.level) || 'both';
    const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
    const critical = products.filter(p => getStockStatus(p) === 'critical').map(serializeProduct);
    const warn = products.filter(p => getStockStatus(p) === 'warn').map(serializeProduct);

    const body = {};
    if (level === 'critical' || level === 'both') body.critical = critical;
    if (level === 'warn' || level === 'both') body.warn = warn;
    return { status: 200, body };
  }
});

routes.push({
  method: 'GET', path: '/api/reports/kardex', permission: 'reports.view',
  handler: (ctx) => {
    const q = ctx.query || {};
    const productId = vId(q.productId, 'شناسه کالا');
    const startDate = vOptionalDate(q.startDate, 'تاریخ شروع');
    const endDate = vOptionalDate(q.endDate, 'تاریخ پایان');

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) return { status: 404, body: { error: 'کالا یافت نشد' } };

    const allTx = db.prepare('SELECT * FROM transactions WHERE product_id = ? ORDER BY date ASC, id ASC').all(productId);

    // اسناد باطل‌شده نمایش داده می‌شوند (شفافیت حسابرسی) اما در گردش
    // موجودی اثری ندارند — دقیقاً مثل سندی که در دفتر خط خورده است.
    let running = 0;
    const withBalance = allTx.map(t => {
      const voided = (t.status || 'معتبر') === 'باطل';
      if (!voided) running += (t.type === 'خروج' ? -t.quantity : t.quantity);
      return {
        id: t.id, docNumber: t.doc_number, type: t.type, quantity: t.quantity, date: t.date,
        counterparty: t.type === 'ورود' ? t.source : t.type === 'مرجوعی' ? t.returned_by : t.receiver,
        description: t.description, voided, balance: running
      };
    });

    let filtered = withBalance;
    if (startDate) filtered = filtered.filter(t => t.date >= startDate);
    if (endDate) filtered = filtered.filter(t => t.date <= endDate);

    return {
      status: 200,
      body: {
        product: serializeProduct(product),
        entries: filtered,
        ledgerBalance: running   // برای تطبیق با موجودی ثبت‌شده
      }
    };
  }
});

routes.push({
  method: 'GET', path: '/api/reports/custom', permission: 'reports.view',
  handler: (ctx) => {
    const q = ctx.query || {};
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 2000);
    const includeVoided = q.includeVoided === '1';

    let sql = `SELECT t.*, p.name AS product_name, p.usage_location AS product_usage_location
               FROM transactions t LEFT JOIN products p ON p.id = t.product_id WHERE 1=1`;
    const args = [];
    if (!includeVoided) sql += " AND t.status = 'معتبر'";
    if (q.startDate) { sql += ' AND t.date >= ?'; args.push(vDate(q.startDate, 'تاریخ شروع')); }
    if (q.endDate) { sql += ' AND t.date <= ?'; args.push(vDate(q.endDate, 'تاریخ پایان')); }
    if (q.requestingUnit) { sql += ' AND t.requesting_unit = ?'; args.push(String(q.requestingUnit)); }
    if (q.type && q.type !== 'all') { sql += ' AND t.type = ?'; args.push(String(q.type)); }
    if (q.usageLocation) { sql += ' AND p.usage_location = ?'; args.push(String(q.usageLocation)); }
    if (q.receiver) {
      const term = `%${String(q.receiver).trim().toLowerCase()}%`;
      sql += " AND (LOWER(COALESCE(t.receiver,'')) LIKE ? OR LOWER(COALESCE(t.returned_by,'')) LIKE ?)";
      args.push(term, term);
    }
    sql += ' ORDER BY t.id DESC LIMIT ?';
    args.push(limit);

    const rows = db.prepare(sql).all(...args);

    const results = rows.map(t => ({
      docNumber: t.doc_number, date: t.date, productName: t.product_name, type: t.type,
      quantity: t.quantity, requestingUnit: t.requesting_unit,
      party: t.receiver || t.returned_by || t.source || null,
      usageLocation: t.product_usage_location,
      voided: (t.status || 'معتبر') === 'باطل'
    }));

    return { status: 200, body: { results, limit, truncated: results.length === limit } };
  }
});

module.exports = routes;
