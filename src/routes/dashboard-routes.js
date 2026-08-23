'use strict';

const { db } = require('../db');
const { getStockStatus } = require('../business');

const routes = [];

routes.push({
  method: 'GET', path: '/api/dashboard', permission: 'dashboard.view',
  handler: () => {
    const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
    let critical = 0, warn = 0;
    products.forEach(p => {
      const s = getStockStatus(p);
      if (s === 'critical') critical++;
      else if (s === 'warn') warn++;
    });

    // اسناد باطل‌شده در شمارش عملیات جاری نمی‌آیند
    const totalTransactions = db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE status = 'معتبر'").get().c;
    const custodyOpen = db.prepare("SELECT COUNT(*) AS c FROM custody_records WHERE status = 'باز'").get().c;
    const repairOpen = db.prepare("SELECT COUNT(*) AS c FROM repair_records WHERE status = 'در حال تعمیر'").get().c;

    const recent = db.prepare(`
      SELECT t.doc_number as docNumber, t.date, t.type, t.quantity, t.source, t.receiver, t.returned_by as returnedBy,
             p.name as productName
      FROM transactions t LEFT JOIN products p ON p.id = t.product_id
      WHERE t.status = 'معتبر'
      ORDER BY t.id DESC LIMIT 8
    `).all();

    return {
      status: 200,
      body: {
        totalProducts: products.length,
        criticalCount: critical,
        warnCount: warn,
        totalTransactions,
        custodyOpenCount: custodyOpen,
        repairOpenCount: repairOpen,
        recentTransactions: recent
      }
    };
  }
});

routes.push({
  method: 'GET', path: '/api/audit-log', permission: 'audit.view',
  handler: (ctx) => {
    const limit = Math.min(Math.max(Number((ctx.query || {}).limit) || 500, 1), 2000);
    const rows = db.prepare(`
      SELECT a.id, a.timestamp, a.action, a.doc_number as docNumber, a.change_description as changeDescription,
             a.reason, u.full_name as performedBy
      FROM audit_log a LEFT JOIN users u ON u.id = a.performed_by_user_id
      ORDER BY a.id DESC LIMIT ?
    `).all(limit);
    return { status: 200, body: { auditLog: rows, limit } };
  }
});

module.exports = routes;
