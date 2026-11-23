'use strict';
/*
 * Bacolor Civil ID: web server.
 * One small Node process that (1) serves the website from /public and (2) answers the /api/* calls.
 * No web framework: only Node's built-in modules (plus "pg" when a Postgres DATABASE_URL is set).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDatabase } = require('./db');
const { HttpError } = require('./util');
const { hashPassword, createRateLimiter } = require('./security');
const S = require('./store');

const MAX_BODY_BYTES = 9 * 1024 * 1024; // three photos + form data, with room to spare

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    databaseUrl: env.DATABASE_URL || '',
    publicDir: env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
    adminUsername: String(env.ADMIN_USERNAME || 'admin').toLowerCase(),
    adminName: env.ADMIN_NAME || 'Registry Admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    adminSignupCode: env.ADMIN_SIGNUP_CODE || '',
    autoVerify: env.AUTO_VERIFY !== 'false',
    allowDobReset: env.ALLOW_DOB_PASSWORD_RESET !== 'false',
    trustProxy: env.TRUST_PROXY !== 'false',
    sessionDays: Number(env.SESSION_DAYS) || 7,
    adminSessionHours: Number(env.ADMIN_SESSION_HOURS) || 8
  };
}

/* Make sure there is always one main administrator. The password comes from the environment, never from the code. */
async function ensureMainAdmin(db, config) {
  const existing = await db.query('SELECT username FROM admins WHERE role = ?', ['superadmin']);
  if (existing.length) return null;
  let password = config.adminPassword;
  let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  await db.run('INSERT INTO admins (username, name, phone, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [config.adminUsername, config.adminName, '', await hashPassword(password), 'superadmin', S.nowIso()]);
  if (generated) {
    console.log('\n==============================================================');
    console.log(' Main admin created.  username: ' + config.adminUsername + '   password: ' + password);
    console.log(' (Shown once. Set ADMIN_PASSWORD in your environment to choose your own.)');
    console.log('==============================================================\n');
  }
  return { generated, password };
}

function compileRoutes(list) {
  return list.map((r) => {
    const keys = [];
    const re = new RegExp('^' + r.path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { ...r, re, keys };
  });
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // the address our own proxy saw; the left side can be faked by the visitor
  }
  return req.socket.remoteAddress || 'unknown';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c); // past the limit we just discard the data
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return reject(new HttpError(413, 'That upload is too large. Try a smaller photo.'));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new HttpError(400, 'The request was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload === undefined ? null : payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function securityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (String(req.headers['x-forwarded-proto'] || '') === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function serveStatic(req, res, config) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (urlPath === '/') urlPath = '/Homepage.html';
  if (urlPath === '/admin' || urlPath === '/admin/') urlPath = '/index.html';
  const root = path.resolve(config.publicDir);
  const file = path.resolve(root, '.' + urlPath);
  const inside = file === root || file.startsWith(root + path.sep);
  const hidden = urlPath.split('/').some((seg) => seg.startsWith('.'));
  if (!inside || hidden) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Page not found');
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const db = await openDatabase({ databaseUrl: config.databaseUrl, sqliteFile: config.sqliteFile });
  const limiter = createRateLimiter();
  await ensureMainAdmin(db, config);

  const ctxBase = { db, config, limiter };
  const routes = compileRoutes([
    ...require('./citizen')(ctxBase),
    ...require('./admin')(ctxBase)
  ]);

  async function handleApi(req, res, pathname) {
    const route = routes.map((r) => ({ r, m: pathname.match(r.re) })).filter((x) => x.m && x.r.method === req.method)[0];
    if (!route) {
      const pathKnown = routes.some((r) => r.re.test(pathname));
      throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed.' : 'Not found.');
    }
    const ctx = { ip: clientIp(req, config), params: {}, body: {}, auth: null, token: '' };
    route.r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(route.m[i + 1]); });
    const header = String(req.headers.authorization || '');
    ctx.token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (route.r.auth) {
      ctx.auth = await S.findSession(db, route.r.auth, ctx.token);
      if (!ctx.auth) throw new HttpError(401, 'Your session has expired. Please log in again.');
    }
    if (req.method !== 'GET') ctx.body = await readJson(req);
    send(res, 200, await route.r.handler(ctx));
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(req, res);
    const pathname = (req.url || '/').split('?')[0];
    try {
      if (pathname === '/healthz') return send(res, 200, { ok: true });
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
      return serveStatic(req, res, config);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('Unexpected error on', req.method, pathname, e);
      return send(res, 500, { error: 'Something went wrong on the server. Please try again.' });
    }
  });

  return {
    server, db, config, limiter,
    listen: (port = config.port) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: async () => { await new Promise((r) => server.close(r)); await db.close(); }
  };
}

module.exports = { createApp, loadConfig };

if (require.main === module) {
  createApp().then(async (app) => {
    const port = await app.listen();
    console.log('Bacolor Civil ID is running on port ' + port + ' (database: ' + app.db.kind + ')');
    if (!app.config.adminSignupCode) console.log('Admin self-sign-up is OFF (set ADMIN_SIGNUP_CODE to allow staff to register).');
    const stop = async () => { await app.close(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error('Could not start the server:', e.message); process.exit(1); });
}
