'use strict';
/* ======================================================================
   سرور اصلی سیستم انبارداری تحت شبکه
   بدون هیچ بسته npm خارجی — فقط ماژول‌های داخلی Node.js (>=22.5)

   دو حالت اجرا (از config.json یا متغیر محیطی WAREHOUSE_MODE):
     - lan   : فقط HTTP روی شبکه داخلی کارخانه (بدون گواهی)
     - https : HTTPS واقعی برای دسترسی از طریق اینترنت با دامنه ثابت،
               به‌همراه یک سرور HTTP کمکی روی پورت ۸۰ برای تمدید خودکار
               گواهی (چالش ACME/certbot) و هدایت به HTTPS

   اجرا: node src/server.js   (یا: npm start)
   ====================================================================== */

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { URL } = require('node:url');

const config = require('./config');
const { Router } = require('./router');
const {
  parseCookies, readJsonBody, sendJson, setSessionCookie, clearSessionCookie, serveStatic, getClientIp
} = require('./http-utils');
const { getSessionUser, roleHasPermission, cleanupExpiredSessions, ensureDefaultAdmin } = require('./auth');
const {
  checkLoginRateLimit, recordLoginFailure, recordLoginSuccess, cleanupLoginAttempts,
  applySecurityHeaders, isOriginAllowed, refreshAllowedOrigins, describeAllowedOrigins
} = require('./security');
const { ValidationError } = require('./validators');
const { BusinessError } = require('./business');
const { loadCertPair, watchAndReloadCert } = require('./cert-manager');
const { startScheduledBackups } = require('./backup');
const { handleUpgrade, broadcast: broadcastChange } = require('./ws-server');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// مسیرهایی که حتی با رمز عبور تغییرنیافته هم باید در دسترس باشند،
// وگرنه کاربر در بن‌بست می‌افتد.
const PASSWORD_CHANGE_EXEMPT = new Set(['/api/me', '/api/me/password', '/api/logout']);

ensureDefaultAdmin();
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);
setInterval(cleanupLoginAttempts, 30 * 60 * 1000);
// آی‌پی سرور ممکن است با DHCP عوض شود؛ فهرست مبدأهای مجاز تازه می‌ماند
setInterval(refreshAllowedOrigins, 10 * 60 * 1000);
startScheduledBackups();

const router = new Router();
const allRouteDefs = [
  ...require('./routes/auth-routes'),
  ...require('./routes/products-routes'),
  ...require('./routes/dashboard-routes'),
  ...require('./routes/transactions-routes'),
  ...require('./routes/requests-routes'),
  ...require('./routes/custody-routes'),
  ...require('./routes/repair-routes'),
  ...require('./routes/reports-routes'),
  ...require('./routes/maintenance-routes')
];
for (const def of allRouteDefs) {
  router[def.method.toLowerCase()](def.path, def);
}

// ======================================================================
// هسته مشترک پردازش درخواست — چه روی HTTP (حالت lan) و چه روی HTTPS
// (حالت اینترنتی) از همین یک تابع عبور می‌کند تا هیچ منطقی دوبار نوشته
// نشود.
// ======================================================================
async function handleRequest(req, res, isHttps) {
  try {
    applySecurityHeaders(res, isHttps);

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, PUBLIC_DIR);
      return;
    }

    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !isOriginAllowed(req.headers.origin)) {
      sendJson(res, 403, { error: 'درخواست از منبع نامعتبر رد شد' });
      return;
    }

    const match = router.match(req.method, pathname);
    if (!match) {
      sendJson(res, 404, { error: 'مسیر یافت نشد' });
      return;
    }

    const { handler: routeDef, params } = match;
    const clientIp = getClientIp(req);

    const isLoginRoute = pathname === '/api/login' && req.method === 'POST';
    if (isLoginRoute) {
      const rl = checkLoginRateLimit(clientIp);
      if (!rl.allowed) {
        res.setHeader('Retry-After', String(rl.retryAfterSeconds));
        sendJson(res, 429, {
          error: `تعداد تلاش‌های ناموفق ورود بیش از حد مجاز است. لطفاً ${Math.ceil(rl.retryAfterSeconds / 60)} دقیقه دیگر دوباره تلاش کنید.`
        });
        return;
      }
    }

    const cookies = parseCookies(req);
    const sessionToken = cookies.session;
    const user = getSessionUser(sessionToken);

    if (routeDef.permission !== null) {
      if (!user) {
        sendJson(res, 401, { error: 'ورود به سامانه الزامی است' });
        return;
      }
      if (routeDef.permission !== 'authenticated' && !roleHasPermission(user.role, routeDef.permission)) {
        sendJson(res, 403, { error: 'دسترسی شما برای این عملیات کافی نیست' });
        return;
      }

      // اجبار تغییر رمز اولیه — سمت سرور، نه فقط یک بنر در رابط کاربری.
      // تا وقتی رمز پیش‌فرض عوض نشده، تنها مسیرهای مجاز مشاهده‌ی حساب،
      // تغییر رمز و خروج هستند.
      if (user.must_change_password && !PASSWORD_CHANGE_EXEMPT.has(pathname)) {
        sendJson(res, 403, {
          error: 'پیش از استفاده از سامانه باید رمز عبور اولیه را تغییر دهید (تب «حساب کاربری»).',
          mustChangePassword: true
        });
        return;
      }
    }

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
        return;
      }
    }

    const query = {};
    for (const [k, v] of parsedUrl.searchParams) query[k] = v;

    const ctx = { params, body, query, user, sessionToken };

    let result;
    try {
      result = await routeDef.handler(ctx);
    } catch (err) {
      // خطاهای اعتبارسنجی و قواعد کسب‌وکار، خطای کاربر هستند نه خطای
      // سرور؛ با پیام فارسی و کد مناسب برمی‌گردند (نه 500 مبهم).
      if (err instanceof ValidationError) {
        if (isLoginRoute) recordLoginFailure(clientIp);
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (err instanceof BusinessError) {
        if (isLoginRoute) recordLoginFailure(clientIp);
        sendJson(res, err.status || 400, { error: err.message });
        return;
      }
      throw err;
    }

    if (isLoginRoute) {
      if (result.status === 200) recordLoginSuccess(clientIp);
      else recordLoginFailure(clientIp);
    }

    // اطلاع آنی به سایر کاربران متصل: هر عملیات موفق تغییردهنده (ثبت/
    // ویرایش/حذف سند، کالا، کاربر و...) پیام کوتاهی برای تمام کلاینت‌های
    // WebSocket ارسال می‌کند تا رابط کاربری‌شان فوراً تازه‌سازی شود.
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && result.status >= 200 && result.status < 300 && !isLoginRoute) {
      broadcastChange({ resource: pathname });
    }

    if (result.setSessionToken) setSessionCookie(res, result.setSessionToken, isHttps);
    if (result.clearSessionToken) clearSessionCookie(res);
    sendJson(res, result.status || 200, result.body || {});

  } catch (err) {
    console.error('خطای سرور:', err);
    sendJson(res, 500, { error: 'خطای داخلی سرور' });
  }
}

function printBanner(lines) {
  console.log('============================================================');
  lines.forEach(l => console.log(' ' + l));
  console.log('============================================================');
}

// ======================================================================
// WebSocket upgrade handling — احراز هویت با همان کوکی نشست HTTP معمولی
// ======================================================================
function onUpgrade(req, socket, head) {
  if (!req.url || !req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  const cookies = parseCookies(req);
  const user = getSessionUser(cookies.session);
  handleUpgrade(req, socket, head, !!user);
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  return addresses;
}

if (config.mode === 'https') {
  if (!config.domain) {
    console.error('خطا: در حالت https باید مقدار "domain" در config.json تنظیم شود.');
    process.exit(1);
  }
  if (!config.certPath || !config.keyPath) {
    console.error('خطا: در حالت https باید مسیر certPath و keyPath (فایل‌های گواهی Let\'s Encrypt) در config.json تنظیم شود.');
    console.error('راهنمای دریافت گواهی رایگان در README.md، بخش «اتصال اینترنتی» موجود است.');
    process.exit(1);
  }

  if (!fs.existsSync(config.webrootPath)) fs.mkdirSync(config.webrootPath, { recursive: true });
  const challengeDir = path.join(config.webrootPath, '.well-known', 'acme-challenge');
  if (!fs.existsSync(challengeDir)) fs.mkdirSync(challengeDir, { recursive: true });

  let certPair;
  try {
    certPair = loadCertPair(config.certPath, config.keyPath);
  } catch (e) {
    console.error('خطا در بارگذاری گواهی TLS:', e.message);
    process.exit(1);
  }

  const httpsServer = https.createServer(certPair, (req, res) => handleRequest(req, res, true));
  httpsServer.on('upgrade', onUpgrade);
  httpsServer.listen(config.httpsPort, () => {
    printBanner([
      'سرور سیستم انبارداری (حالت اینترنتی/HTTPS) اجرا شد',
      `آدرس عمومی: https://${config.domain}${config.httpsPort !== 443 ? ':' + config.httpsPort : ''}`
    ]);
  });

  watchAndReloadCert(httpsServer, config.certPath, config.keyPath);

  const redirectServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    if (parsedUrl.pathname.startsWith('/.well-known/acme-challenge/')) {
      serveStatic(req, res, config.webrootPath);
      return;
    }
    const location = `https://${config.domain}${config.httpsPort !== 443 ? ':' + config.httpsPort : ''}${parsedUrl.pathname}${parsedUrl.search}`;
    res.writeHead(301, { Location: location });
    res.end();
  });
  redirectServer.listen(config.httpPort, () => {
    console.log(` سرور هدایت HTTP→HTTPS و تمدید گواهی روی پورت ${config.httpPort} فعال شد`);
  });

} else {
  const server = http.createServer((req, res) => handleRequest(req, res, false));
  server.on('upgrade', onUpgrade);
  server.listen(config.httpPort, () => {
    const addresses = getLanAddresses();
    const lines = ['سرور سیستم انبارداری (حالت شبکه داخلی) اجرا شد',
      `روی همین کامپیوتر : http://localhost:${config.httpPort}`];
    addresses.forEach(addr => lines.push(`روی شبکه داخلی    : http://${addr}:${config.httpPort}`));
    printBanner(lines);
    console.log(' مبدأهای مجاز (برای بررسی CSRF): ' + describeAllowedOrigins().join('، '));
    console.log(' اگر کاربری با آدرس دیگری (مثلاً نام میزبان یا آی‌پی جدید) وصل می‌شود،');
    console.log(' آن آدرس را در config.json → extraAllowedOrigins اضافه کنید.');
  });
}
