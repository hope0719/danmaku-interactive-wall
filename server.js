'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEW_DIR = path.join(__dirname, 'views');
const FILTER_FILE = path.join(__dirname, 'filter.txt');
const KEY_FILE = path.join(__dirname, '.admin-key');
const MAX_LEN = 40;
const HISTORY_LIMIT = 40;
const SEND_LIMIT = 30; // 每个 IP 10 秒内最多发送条数（现场共用 WiFi 时出口 IP 相同，阈值放宽）
const SEND_WINDOW = 10 * 1000;

const HUES = [188, 205, 268, 288, 320, 8, 28, 45, 96, 160];

/** @type {{id:number,text:string,nick:string,hue:number,ts:number}[]} */
const history = [];
// 词云用：保存本场全部弹幕原文（清屏时一并清空）
const allTexts = [];
const CLOUD_LIMIT = 5000;
const clients = new Set();
const hits = new Map();
let seq = 0;
let blockedCount = 0;
let closed = false; // 停止后封场，不再接收新弹幕

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function broadcast(message) {
  const payload = JSON.stringify({ type: 'danmaku', message });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastControl(type) {
  const payload = JSON.stringify({ type });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function clearScreen() {
  history.length = 0;
  allTexts.length = 0;
  seq = 0;
  closed = false;
  broadcastControl('clear');
}

function pickHue() {
  return HUES[Math.floor(Math.random() * HUES.length)];
}

/* ---------- 敏感词拦截 ---------- */
let filterWords = [];

// 去掉空格、标点、符号并统一全角半角，防止「傻 逼」「傻·逼」绕过
function normalizeForMatch(str) {
  return String(str)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function loadFilter() {
  try {
    const raw = fs.readFileSync(FILTER_FILE, 'utf8');
    filterWords = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map(normalizeForMatch)
      .filter((word) => word.length >= 2);
    console.log(`[敏感词] 已加载 ${filterWords.length} 条`);
  } catch (err) {
    filterWords = [];
    console.warn('[敏感词] filter.txt 读取失败，当前不拦截：', err.message);
  }
}

function matchFilter(str) {
  if (!filterWords.length) return null;
  const s = normalizeForMatch(str);
  if (!s) return null;
  for (const word of filterWords) {
    if (s.includes(word)) return word;
  }
  return null;
}

/* ---------- 管理密钥 ---------- */
function loadAdminKey() {
  if (process.env.ADMIN_KEY) return process.env.ADMIN_KEY.trim();
  try {
    const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch (err) {
    /* 首次运行，后面生成 */
  }
  const key = crypto.randomBytes(9).toString('hex');
  try {
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  } catch (err) {
    console.warn('[管理] 密钥写入失败，本次仅内存有效：', err.message);
  }
  return key;
}

const ADMIN_KEY = loadAdminKey();

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function isAdmin(req, url) {
  const key = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
  return Boolean(ADMIN_KEY) && safeEqual(key, ADMIN_KEY);
}

function normalizeText(raw) {
  return String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

function clientIp(req) {
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + SEND_WINDOW });
    return false;
  }
  rec.count += 1;
  return rec.count > SEND_LIMIT;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleSend(req, res) {
  const ip = clientIp(req);
  if (closed) {
    return sendJSON(res, 403, {
      ok: false,
      code: 'closed',
      error: '本场弹幕已结束，感谢参与',
    });
  }
  if (rateLimited(ip)) {
    return sendJSON(res, 429, { ok: false, error: '发得太快了，歇一秒再发' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJSON(res, 400, { ok: false, error: '请求格式有误' });
  }

  const text = normalizeText(payload.text);
  if (!text) return sendJSON(res, 400, { ok: false, error: '弹幕不能为空' });

  const nick = normalizeText(payload.nick).slice(0, 12);

  const hit = matchFilter(text) || matchFilter(nick);
  if (hit) {
    blockedCount += 1;
    console.log(`[拦截] ${ip} 命中敏感词：${hit}`);
    return sendJSON(res, 400, {
      ok: false,
      code: 'blocked',
      error: '这句话里有不适合上墙的词，换个说法试试',
    });
  }

  const message = {
    id: ++seq,
    text,
    nick,
    hue: pickHue(),
    ts: Date.now(),
  };

  history.push(message);
  if (history.length > HISTORY_LIMIT) history.shift();

  allTexts.push(text);
  if (allTexts.length > CLOUD_LIMIT) allTexts.shift();

  broadcast(message);
  console.log(`[弹幕 #${message.id}] ${ip} ${nick ? nick + ': ' : ''}${text}`);

  sendJSON(res, 200, { ok: true, id: message.id });
}

async function handleQr(req, res, query) {
  const data = (query.get('data') || '').slice(0, 512);
  if (!data) return sendJSON(res, 400, { ok: false, error: 'missing data' });
  try {
    const buf = await QRCode.toBuffer(data, {
      type: 'png',
      width: 640,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b1020ff', light: '#ffffffff' },
    });
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=300',
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch (err) {
    sendJSON(res, 500, { ok: false, error: 'qr failed' });
  }
}

function serveStatic(req, res, pathname) {
  const map = { '/': 'screen.html', '/screen': 'screen.html', '/send': 'send.html' };
  let rel = map[pathname];
  if (!rel) rel = pathname.replace(/^\/+/, '');

  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function serveAdmin(res) {
  fs.readFile(path.join(VIEW_DIR, 'admin.html'), (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('admin page missing');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (req.method === 'POST' && pathname === '/api/send') return await handleSend(req, res);
    if (req.method === 'GET' && pathname === '/api/qr.png') return await handleQr(req, res, url.searchParams);
    if (req.method === 'GET' && pathname === '/api/info') {
      return sendJSON(res, 200, { ok: true, total: seq, closed, history: history.slice(-20) });
    }
    if (req.method === 'GET' && pathname === '/api/cloud') {
      return sendJSON(res, 200, { ok: true, total: allTexts.length, texts: allTexts });
    }
    if (req.method === 'POST' && pathname === '/api/close') {
      if (!closed) {
        closed = true;
        broadcastControl('closed');
        console.log('[停止] 已封场，暂停接收新弹幕');
      }
      return sendJSON(res, 200, { ok: true, closed: true });
    }
    if (req.method === 'POST' && pathname === '/api/open') {
      if (closed) {
        closed = false;
        broadcastControl('open');
        console.log('[停止] 已恢复接收弹幕');
      }
      return sendJSON(res, 200, { ok: true, closed: false });
    }

    if (pathname === '/admin' || pathname === '/api/stats' || pathname === '/api/clear') {
      if (!isAdmin(req, url)) {
        if (pathname === '/api/stats' || pathname === '/api/clear') {
          return sendJSON(res, 403, { ok: false, error: '管理密钥不正确' });
        }
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<meta charset="utf-8"><body style="background:#05070f;color:#aab;font-family:system-ui;display:grid;place-content:center;height:100vh"><div>需要管理密钥<br><small>请使用启动时终端里打印的管理地址</small></div></body>');
      }
      if (pathname === '/admin') return serveAdmin(res);
      if (pathname === '/api/stats') {
        return sendJSON(res, 200, {
          ok: true,
          total: seq,
          blocked: blockedCount,
          words: filterWords.length,
          screens: clients.size,
        });
      }
      if (req.method === 'POST') {
        clearScreen();
        console.log('[管理] 已清屏');
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { ok: false, error: 'method not allowed' });
    }

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET') return serveStatic(req, res, pathname);

    sendJSON(res, 405, { ok: false, error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { ok: false, error: 'server error' });
  }
});

/* ---------- WebSocket 实时推送（大屏与手机共用） ---------- */
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('close', () => clients.delete(ws));

  clients.add(ws);
  // 新连上的大屏补发最近几条，刷新后不至于空场
  ws.send(JSON.stringify({ type: 'init', total: seq, closed, history: history.slice(-3) }));
});

setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

loadFilter();
fs.watchFile(FILTER_FILE, { interval: 1000 }, loadFilter);

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  弹幕大屏已启动');
  console.log(`  大屏地址  http://localhost:${PORT}`);
  for (const ip of localAddresses()) {
    console.log(`  局域网    http://${ip}:${PORT}   （同一 WiFi 的手机可扫码）`);
  }
  console.log(`  管理台    http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
  console.log('');
  console.log('  跨网络公网访问：再开一个终端执行  ./start.sh');
  console.log('  管理台密钥保存在 .admin-key，也可用环境变量 ADMIN_KEY 覆盖。');
  console.log('  敏感词在 filter.txt 里改，保存即生效。');
  console.log('');
});
