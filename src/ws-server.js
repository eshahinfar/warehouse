'use strict';
/* ======================================================================
   سرور WebSocket سبک — پیاده‌سازی مستقیم پروتکل استاندارد RFC 6455 با
   ماژول‌های داخلی Node.js (node:crypto برای دست‌دهی/handshake)، بدون
   بسته npm خارجی (مثل ws). فقط برای یک هدف ساده استفاده می‌شود: اطلاع
   آنی به سایر کاربران هنگام ثبت/ویرایش/حذف یک سند، تا رابط کاربری آن‌ها
   بلافاصله (به‌جای هر ۸ ثانیه با polling) تازه‌سازی شود.

   این پیاده‌سازی تعمداً حداقلی است: فقط ارسال/دریافت فریم‌های متنی کوتاه،
   بدون نیاز به fragmentation یا فشرده‌سازی — برای پیام‌های کوتاه اعلان
   تغییر، کاملاً کافی است.
   ====================================================================== */

const crypto = require('node:crypto');

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC_GUID).digest('base64');
}

// ---------------------------------------------------------------------
// ساخت یک فریم متنی خروجی (سرور → کلاینت هرگز نیازی به masking ندارد،
// طبق مشخصات RFC 6455)
// ---------------------------------------------------------------------
function encodeTextFrame(message) {
  const payload = Buffer.from(message, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN=1, opcode=1 (text)
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame() {
  return Buffer.from([0x88, 0x00]); // FIN=1, opcode=8 (close), no payload
}

function encodePongFrame() {
  return Buffer.from([0x8A, 0x00]); // FIN=1, opcode=10 (pong)
}

// ---------------------------------------------------------------------
// پارس حداقلی فریم‌های ورودی از کلاینت (مرورگر همیشه ماسک می‌کند)
// فقط برای شناسایی opcode close/ping کافی است؛ محتوای متنی کلاینت اصلاً
// برای این ویژگی لازم نیست خوانده شود.
// ---------------------------------------------------------------------
function parseIncomingFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) { payloadLen = buffer.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }

  if (masked) offset += 4; // 4-byte masking key follows
  return { opcode, offset, payloadLen };
}

// ---------------------------------------------------------------------
// مدیریت اتصال جدید (فراخوانی‌شده از رویداد 'upgrade' سرور HTTP/HTTPS)
// ---------------------------------------------------------------------
function handleUpgrade(req, socket, head, isAuthorized) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  if (!isAuthorized) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const acceptKey = computeAcceptKey(key);
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ].join('\r\n');
  socket.write(responseHeaders);

  clients.add(socket);
  socket.setKeepAlive(true);

  socket.on('data', (buffer) => {
    const frame = parseIncomingFrame(buffer);
    if (!frame) return;
    if (frame.opcode === 0x8) { // close
      socket.end();
    } else if (frame.opcode === 0x9) { // ping
      socket.write(encodePongFrame());
    }
    // سایر opcode ها (متن/باینری از کلاینت) نادیده گرفته می‌شوند — این
    // کانال فقط یک‌طرفه (سرور → کلاینت) استفاده می‌شود.
  });

  const cleanup = () => clients.delete(socket);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ---------------------------------------------------------------------
// ارسال یک پیام کوتاه به تمام کلاینت‌های متصل
// ---------------------------------------------------------------------
function broadcast(messageObj) {
  if (clients.size === 0) return;
  const frame = encodeTextFrame(JSON.stringify(messageObj));
  for (const socket of clients) {
    if (socket.destroyed) { clients.delete(socket); continue; }
    socket.write(frame, (err) => { if (err) clients.delete(socket); });
  }
}

module.exports = { handleUpgrade, broadcast };
