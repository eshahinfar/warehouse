'use strict';

const { db, inTransaction } = require('../db');
const { hashPassword, verifyPassword, createSession, destroySession, ROLES, assertPasswordPolicy } = require('../auth');
const { vId, vText, vEnum } = require('../validators');
const { BusinessError } = require('../business');

const routes = [];

routes.push({
  method: 'POST', path: '/api/login', permission: null,
  handler: (ctx) => {
    const { username, password } = ctx.body || {};
    if (!username || !password) {
      return { status: 400, body: { error: 'نام کاربری و رمز عبور الزامی است' } };
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
    if (!user || !user.active) {
      return { status: 401, body: { error: 'نام کاربری یا رمز عبور اشتباه است' } };
    }
    if (!verifyPassword(password, user.password_hash, user.password_salt)) {
      return { status: 401, body: { error: 'نام کاربری یا رمز عبور اشتباه است' } };
    }
    const token = createSession(user.id);
    return {
      status: 200,
      setSessionToken: token,
      body: {
        user: {
          id: user.id, username: user.username, fullName: user.full_name,
          role: user.role, mustChangePassword: !!user.must_change_password
        },
        permissions: ROLES[user.role] ? ROLES[user.role].permissions : []
      }
    };
  }
});

routes.push({
  method: 'POST', path: '/api/logout', permission: 'authenticated',
  handler: (ctx) => {
    if (ctx.sessionToken) destroySession(ctx.sessionToken);
    return { status: 200, clearSessionToken: true, body: { ok: true } };
  }
});

routes.push({
  method: 'GET', path: '/api/me', permission: 'authenticated',
  handler: (ctx) => {
    const role = ctx.user.role;
    return {
      status: 200,
      body: {
        user: {
          id: ctx.user.id, username: ctx.user.username, fullName: ctx.user.full_name,
          role, mustChangePassword: !!ctx.user.must_change_password
        },
        permissions: ROLES[role] ? ROLES[role].permissions : [],
        roles: Object.keys(ROLES).map(r => ({ key: r, label: ROLES[r].label })),
        minPasswordLength: require('../config').minPasswordLength
      }
    };
  }
});

routes.push({
  method: 'PUT', path: '/api/me/password', permission: 'authenticated',
  handler: (ctx) => {
    const { currentPassword, newPassword } = ctx.body || {};
    const fullUser = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    assertPasswordPolicy(newPassword, fullUser.username);
    if (!verifyPassword(currentPassword || '', fullUser.password_hash, fullUser.password_salt)) {
      return { status: 401, body: { error: 'رمز فعلی اشتباه است' } };
    }
    if (String(newPassword) === String(currentPassword)) {
      throw new BusinessError('رمز جدید باید با رمز فعلی متفاوت باشد');
    }
    const { hash, salt } = hashPassword(newPassword);
    // تغییر رمز، همه‌ی نشست‌های دیگر همان کاربر را باطل می‌کند (مثلاً
    // نشست باز مانده روی کامپیوتر مشترک انبار).
    return inTransaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?')
        .run(hash, salt, ctx.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(ctx.user.id, ctx.sessionToken || '');
      return { status: 200, body: { ok: true } };
    });
  }
});

// ---------------------------------------------------------------------
// User management (admin only — enforced via '*' permission requirement)
// ---------------------------------------------------------------------
routes.push({
  method: 'GET', path: '/api/users', permission: 'users.manage',
  handler: () => {
    const users = db.prepare('SELECT id, username, full_name, role, active, must_change_password, created_at FROM users ORDER BY id ASC').all();
    return { status: 200, body: { users } };
  }
});

routes.push({
  method: 'POST', path: '/api/users', permission: 'users.manage',
  handler: (ctx) => {
    const b = ctx.body || {};
    const username = vText(b.username, 'نام کاربری', { maxLen: 60, minLen: 3 });
    const fullName = vText(b.fullName, 'نام و نام خانوادگی', { maxLen: 200 });
    const role = vEnum(b.role, 'نقش', Object.keys(ROLES));
    assertPasswordPolicy(b.password, username);
    if (!/^[A-Za-z0-9._-]+$/.test(username)) {
      return { status: 400, body: { error: 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط باشد' } };
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return { status: 409, body: { error: 'این نام کاربری قبلاً استفاده شده است' } };
    }
    const { hash, salt } = hashPassword(b.password);
    const result = db.prepare(`INSERT INTO users (username, password_hash, password_salt, full_name, role, active, created_at, must_change_password)
                VALUES (?, ?, ?, ?, ?, 1, ?, 1)`)
      .run(username, hash, salt, fullName, role, new Date().toISOString());
    return { status: 201, body: { id: Number(result.lastInsertRowid) } };
  }
});

routes.push({
  method: 'PUT', path: '/api/users/:id', permission: 'users.manage',
  handler: (ctx) => {
    const id = vId(ctx.params.id, 'شناسه کاربر');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!target) return { status: 404, body: { error: 'کاربر یافت نشد' } };
    if (id === ctx.user.id && ctx.body && ctx.body.active === false) {
      return { status: 400, body: { error: 'نمی‌توانید حساب خودتان را غیرفعال کنید' } };
    }

    const { fullName, role, active, newPassword } = ctx.body || {};
    if (role && !ROLES[role]) return { status: 400, body: { error: 'نقش معتبر نیست' } };
    if (target.role === 'مدیر سیستم' && role && role !== 'مدیر سیستم') {
      const otherAdmins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'مدیر سیستم' AND id != ?").get(id);
      if (otherAdmins.c === 0) {
        return { status: 400, body: { error: 'حداقل یک مدیر سیستم باید در سامانه باقی بماند' } };
      }
    }
    if (target.role === 'مدیر سیستم' && active === false) {
      const otherActiveAdmins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'مدیر سیستم' AND active = 1 AND id != ?").get(id);
      if (otherActiveAdmins.c === 0) {
        return { status: 400, body: { error: 'حداقل یک مدیر سیستم فعال باید در سامانه باقی بماند' } };
      }
    }

    db.prepare(`UPDATE users SET full_name = COALESCE(?, full_name), role = COALESCE(?, role), active = COALESCE(?, active) WHERE id = ?`)
      .run(fullName ?? null, role ?? null, active === undefined ? null : (active ? 1 : 0), id);

    if (newPassword) {
      assertPasswordPolicy(newPassword, target.username);
      const { hash, salt } = hashPassword(newPassword);
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1 WHERE id = ?').run(hash, salt, id);
      // بازنشانی رمز توسط مدیر، نشست‌های باز آن کاربر را می‌بندد
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (ctx.body && ctx.body.active === false) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }

    return { status: 200, body: { ok: true } };
  }
});

module.exports = routes;
