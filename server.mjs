import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { timingSafeEqual, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createConnection, isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeIdentity } from './auth-identity.mjs';
import { createAuthSecurity } from './auth-security.mjs';
import { checkDatabaseReadiness, REQUIRED_SCHEMA_VERSION } from './database-policy.mjs';
import { createDashboardHandler } from './dashboard-handler.mjs';
import { postgresConnectionTlsStatus, postgresSslFromEnv } from './postgres-config.mjs';
import { serveStaticFile } from './static-files.mjs';
import { createSyncHandler } from './sync-handler.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const staticRoot = resolve(root, 'dist');
let staticBuildAvailable = false;
try { await access(resolve(staticRoot, 'index.html')); staticBuildAvailable = true; } catch { /* API-only development mode; static requests fail closed. */ }
try {
  const envFile = await readFile(resolve(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const apiToken = process.env.POS_API_TOKEN || '';
const sessionSecret = process.env.POS_SESSION_SECRET || '';
const totpEncryptionKey = process.env.POS_TOTP_ENCRYPTION_KEY || '';
const isDevelopment = process.env.NODE_ENV === 'development';
const { setSessionCookie, requireSameOrigin, authorized, sessionUser, encryptTotpSecret, decryptTotpSecret, verifyTotp } = createAuthSecurity({
  apiToken,
  sessionSecret,
  totpEncryptionKey,
  cookieSecure: !isDevelopment,
  trustProxy: !isDevelopment,
});
let pool;
let schemaReady = false;
let schemaCheckAt = 0;
let schemaCheckPromise = null;
const loginFailures = new Map();
const loginRequestsByIdentity = new Map();
const loginRequestsByRemote = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_FAILURE_MAX_KEYS = 10_000;
const LOGIN_REQUEST_MAX_KEYS = 10_000;
const LOGIN_MAX_IDENTITY_REQUESTS = 20;
const LOGIN_MAX_REMOTE_REQUESTS = 120;
const DUMMY_LOGIN_SALT = 'fastq-pos-login-dummy-salt-v1';
// T1: pendaftaran outlet/Pemilik adalah endpoint publik tanpa sesi; batasi
// per IP agar tidak dapat dibanjiri outlet + akun (spam/DoS penyimpanan).
// Lebih ketat dari login karena satu pendaftaran membuat satu outlet baru.
const registerRequestsByRemote = new Map();
const REGISTER_MAX_REMOTE_REQUESTS = 10;

function consumeLoginRateLimit(map, key, limit, now) {
  let record = map.get(key);
  if (record && now - record.startedAt >= LOGIN_WINDOW_MS) {
    map.delete(key);
    record = undefined;
  }
  if (record?.count >= limit) return Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - record.startedAt)) / 1000));
  if (!record) {
    if (map.size >= LOGIN_REQUEST_MAX_KEYS) {
      for (const [entry, value] of map) if (now - value.startedAt >= LOGIN_WINDOW_MS) map.delete(entry);
      while (map.size >= LOGIN_REQUEST_MAX_KEYS) map.delete(map.keys().next().value);
    }
    record = { startedAt: now, count: 0 };
  }
  record.count++;
  map.delete(key);
  map.set(key, record);
  return 0;
}

if (process.env.DATABASE_URL) {
  const { Pool } = await import('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30_000, query_timeout: 30000, statement_timeout: 25000, ssl: postgresSslFromEnv() });
  // Tanpa handler ini, matinya koneksi DB memancarkan 'error' yang tidak
  // tertangani dan membunuh proses Node (insiden 04:57 WIB 2026-11-22:
  // pg_hold mati -> koneksi putus -> server crash). Pool membuat koneksi
  // baru saat dibutuhkan; handler ini hanya mencegah crash.
  pool.on('error', (error) => console.error('Pool database error (koneksi putus?)', error?.message || error));
  try {
    const readiness = await checkDatabaseReadiness(pool, REQUIRED_SCHEMA_VERSION);
    schemaReady = readiness.ready;
    schemaCheckAt = Date.now();
    if (!schemaReady) throw new Error(readiness.reason);
  } catch {
    schemaCheckAt = Date.now();
    console.error('Koneksi, hak role runtime, atau skema database belum siap; endpoint API akan ditahan. Server akan mencoba ulang secara berkala.');
  }
}

async function refreshSchemaReady() {
  if (!pool) return false;
  if (schemaCheckPromise) return schemaCheckPromise;
  if (Date.now() - schemaCheckAt < 5000) return schemaReady;
  schemaCheckAt = Date.now();
  schemaCheckPromise = (async () => {
    try {
      schemaReady = (await checkDatabaseReadiness(pool, REQUIRED_SCHEMA_VERSION)).ready;
      return schemaReady;
    } catch {
      schemaReady = false;
      return false;
    } finally {
      schemaCheckPromise = null;
    }
  })();
  return schemaCheckPromise;
}

function securityHeaders(scriptNonce = '') {
  const scriptSource = scriptNonce ? `'self' 'nonce-${scriptNonce}'` : "'self'";
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(self), geolocation=(self), usb=(self), bluetooth=(self)',
    'Content-Security-Policy': `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src ${scriptSource}; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:*; frame-src 'self'`,
  };
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function isClientDisconnect(error, req, res) {
  return req.aborted || res.destroyed || error?.code === 'ECONNRESET' || error?.code === 'ABORT_ERR' || error?.message === 'aborted';
}

async function health(req, res, pathname) {
  if (pathname === '/api/health/live') {
    return json(res, 200, { status: 'live', uptimeSeconds: Math.floor(process.uptime()), checkedAt: new Date().toISOString() });
  }
  if (!pool) {
    return json(res, 503, { status: 'not_ready', checks: { database: 'not_configured' }, checkedAt: new Date().toISOString() });
  }
  if (!await refreshSchemaReady()) {
    return json(res, 503, { status: 'not_ready', checks: { database: 'role_or_schema_not_ready' }, checkedAt: new Date().toISOString() });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query({ text: 'SELECT 1', query_timeout: 3000 });
    return json(res, 200, { status: 'ready', checks: { database: 'ok', databaseTls: postgresConnectionTlsStatus(client) }, checkedAt: new Date().toISOString() });
  } catch {
    return json(res, 503, { status: 'not_ready', checks: { database: 'unavailable' }, checkedAt: new Date().toISOString() });
  } finally {
    client?.release();
  }
}

async function ownerLogin(req, res) {
  requireSameOrigin(req);
  if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
  if (sessionSecret.length < 32) return json(res, 503, { error: 'POS_SESSION_SECRET minimal 32 karakter wajib dikonfigurasi.' });
  const forwardedAddress = !isDevelopment
    ? String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    : '';
  const remote = forwardedAddress || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const input = await readJson(req, 20_000);
  const identity = normalizeIdentity(input.identifier) || '';
  const identityKey = createHash('sha256').update(identity || 'invalid').digest('hex');
  const key = `${remote}|${identityKey}`;
  if (loginFailures.size > LOGIN_FAILURE_MAX_KEYS) {
    for (const [entry, record] of loginFailures) if (now - record.startedAt >= LOGIN_WINDOW_MS) loginFailures.delete(entry);
    while (loginFailures.size > LOGIN_FAILURE_MAX_KEYS) loginFailures.delete(loginFailures.keys().next().value);
  }
  let attempts = loginFailures.get(key);
  if (attempts && now - attempts.startedAt >= LOGIN_WINDOW_MS) attempts = undefined;
  if (attempts?.count >= LOGIN_MAX_FAILURES) {
    res.setHeader('Retry-After', String(Math.ceil((LOGIN_WINDOW_MS - (now - attempts.startedAt)) / 1000)));
    return json(res, 429, { error: 'Terlalu banyak percobaan login. Coba lagi beberapa menit.' });
  }
  const identityRetryAfter = consumeLoginRateLimit(loginRequestsByIdentity, identityKey, LOGIN_MAX_IDENTITY_REQUESTS, now);
  const remoteRetryAfter = consumeLoginRateLimit(loginRequestsByRemote, remote, LOGIN_MAX_REMOTE_REQUESTS, now);
  const retryAfter = Math.max(identityRetryAfter, remoteRetryAfter);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    return json(res, 429, { error: 'Terlalu banyak permintaan login. Coba lagi beberapa menit.' });
  }
  const rejectLogin = () => {
    const current = loginFailures.get(key);
    const next = current && now - current.startedAt < LOGIN_WINDOW_MS ? current : { startedAt: now, count: 0 };
    next.count++;
    loginFailures.set(key, next);
    return json(res, 401, { error: 'Kredensial tidak sesuai atau akun tidak tersedia.' });
  };
  if (!identity || typeof input.password !== 'string' || input.password.length > 256) return rejectLogin();
  const userResult = await pool.query('SELECT u.*,o.code AS outlet_code,o.name AS outlet_name FROM users u JOIN outlets o ON o.id=u.outlet_id WHERE u.login_identity=$1 AND u.active=true', [identity]);
  const user = userResult.rows[0];
  if (!user?.password_salt) {
    await pbkdf2(input.password, DUMMY_LOGIN_SALT);
    return rejectLogin();
  }
  if (!await verifyPbkdf2(input.password, user.password_salt, user.password_hash)) return rejectLogin();
  {
    if (user.totp_secret_ciphertext) {
      if (!input.totp) return json(res, 200, { requiresTotp: true });
      const secret = decryptTotpSecret(user.totp_secret_ciphertext);
      if (!secret || !verifyTotp(secret, input.totp)) return rejectLogin();
    }
  }
  loginFailures.delete(key);
  const payload = Buffer.from(JSON.stringify({ sub: user.id, name: user.name, role: user.role, outletId: user.outlet_id, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const token = `${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
  const expiresAt = Date.now() + 30 * 86400000;
  setSessionCookie(res, token);
  return json(res, 200, { user: { id: user.id, name: user.name, role: user.role, outletId: user.outlet_id, outletCode: user.outlet_code, outletName: user.outlet_name }, expiresAt });
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function activeSession(req) {
  const session = sessionUser(req);
  if (!session) throw Object.assign(new Error('Sesi berakhir. Silakan login kembali.'), { status: 401 });
  const result = await pool.query('SELECT id,name,role,outlet_id FROM users WHERE id=$1 AND active=true', [session.sub]);
  const user = result.rows[0];
  if (!user || user.role !== session.role || user.outlet_id !== session.outletId) throw Object.assign(new Error('Akses akun telah berubah. Silakan login kembali.'), { status: 401 });
  return user;
}

async function accountRequest(req, res, pathname) {
  if (!pool || sessionSecret.length < 32) return json(res, 503, { error: 'Database dan POS_SESSION_SECRET server harus dikonfigurasi.' });
  const registering = pathname === '/api/auth/register';
  if (registering && req.method === 'POST') {
    const forwardedAddress = !isDevelopment
      ? String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      : '';
    const remote = forwardedAddress || req.socket.remoteAddress || 'unknown';
    const retryAfter = consumeLoginRateLimit(registerRequestsByRemote, remote, REGISTER_MAX_REMOTE_REQUESTS, Date.now());
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      return json(res, 429, { error: 'Terlalu banyak pendaftaran dari alamat ini. Coba lagi beberapa menit.' });
    }
  }
  if (req.method !== 'GET') requireSameOrigin(req);
  const actor = registering ? null : await activeSession(req);
  if (req.method === 'GET') return json(res, 200, { user: { id: actor.id, name: actor.name, role: actor.role, outletId: actor.outlet_id } });
  if (!registering && actor.role !== 'Pemilik' && !(req.method === 'DELETE' && actor.role === 'Admin')) return json(res, 403, { error: 'Hanya Pemilik yang dapat membuat akun; penghapusan akun memerlukan Pemilik atau Admin.' });
  const input = await readJson(req, 20000);
  const outletId = registering ? randomUUID() : actor.outlet_id;
  if (!isUuid(outletId)) return json(res, 400, { error: 'ID outlet tidak valid.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pos-owner-bootstrap:${outletId}`]);
    if (req.method === 'DELETE') {
      if (!isUuid(input.id) || input.id === actor.id) throw Object.assign(new Error('Akun aktif tidak dapat dihapus.'), { status: 400 });
      const removed = await client.query('UPDATE users SET active=false WHERE id=$1 AND outlet_id=$2 AND active=true RETURNING id', [input.id, outletId]);
      if (!removed.rowCount) throw Object.assign(new Error('Akun tidak ditemukan.'), { status: 404 });
      await client.query('COMMIT');
      return json(res, 200, { deleted: input.id });
    }
    const identity = normalizeIdentity(input.identifier);
    if (!identity || typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 256) throw Object.assign(new Error('Isi email/nomor HP yang valid dan password 10-256 karakter.'), { status: 400 });
    input.passwordSalt = randomBytes(16).toString('hex');
    input.passwordHash = await pbkdf2(input.password, input.passwordSalt);
    if (registering) {
      if (typeof input.storeName !== 'string' || !input.storeName.trim() || input.storeName.trim().length > 100) throw Object.assign(new Error('Nama toko wajib diisi, maksimal 100 karakter.'), { status: 400 });
      input.id = randomUUID();
      input.role = 'Pemilik';
      input.pinSalt = randomBytes(16).toString('hex');
      input.pinHash = await pbkdf2(randomBytes(32).toString('hex'), input.pinSalt);
      await client.query('INSERT INTO outlets(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [outletId, String(input.storeName || 'Outlet POS').trim().slice(0,100)]);
    }
    if (!isUuid(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60 || !['Kasir','Manajer','Admin','Pemilik'].includes(input.role) || !/^[a-f0-9]{32}$/.test(input.pinSalt || '') || !/^[a-f0-9]{64}$/.test(input.pinHash || '')) throw Object.assign(new Error('Data akun tidak valid.'), { status: 400 });
    if (input.role !== 'Kasir' && (!/^[a-f0-9]{32}$/.test(input.passwordSalt || '') || !/^[a-f0-9]{64}$/.test(input.passwordHash || ''))) throw Object.assign(new Error('Password pengelola wajib diisi.'), { status: 400 });
    const duplicate = await client.query('SELECT id FROM users WHERE outlet_id=$1 AND lower(name)=lower($2) AND active=true', [outletId, input.name.trim()]);
    if (duplicate.rowCount) throw Object.assign(new Error('Pendaftaran tidak dapat diproses dengan data ini. Periksa kembali data Anda atau masuk bila Anda sudah memiliki akun.'), { status: 409 });
    if (input.twoFactorSecret && (!/^[A-Z2-7]{32}$/.test(input.twoFactorSecret) || !/^[a-f0-9]{64}$/i.test(totpEncryptionKey))) throw Object.assign(new Error('Konfigurasi authenticator tidak valid.'), { status: 400 });
    await client.query('INSERT INTO users(id,outlet_id,name,role,pin_salt,pin_hash,password_salt,password_hash,totp_secret_ciphertext,login_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [input.id,outletId,input.name.trim(),input.role,input.pinSalt,input.pinHash,input.passwordSalt || null,input.passwordHash || null,input.twoFactorSecret ? encryptTotpSecret(input.twoFactorSecret) : null,identity]);
    const outlet = await client.query('SELECT code,name FROM outlets WHERE id=$1', [outletId]);
    await client.query('COMMIT');
    return json(res, 201, { user: { id: input.id, name: input.name.trim(), role: input.role, outletId, outletCode: outlet.rows[0].code, outletName: outlet.rows[0].name } });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505' && error.constraint === 'users_login_identity_unique') throw Object.assign(new Error('Pendaftaran tidak dapat diproses dengan data ini. Periksa kembali data Anda atau masuk bila Anda sudah memiliki akun.'), { status: 409 });
    if (error.code === '2200H') throw Object.assign(new Error('Kode outlet enam angka sudah habis. Hubungi administrator.'), { status: 503 });
    throw error;
  }
  finally { client.release(); }
}

function logout(req, res) {
  requireSameOrigin(req);
  setSessionCookie(res, '', 0);
  return json(res, 200, { loggedOut: true });
}

async function provisionUser(req, res) {
  if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
  return json(res, 410, { error: 'Sinkronisasi akun lokal dihentikan. Gunakan pendaftaran online dan menu Pengguna setelah login sebagai Pemilik.' });
}

async function pbkdf2(value, salt) {
  const { pbkdf2: derive } = await import('node:crypto');
  return new Promise((resolve, reject) => derive(String(value || ''), String(salt), 210000, 32, 'sha256', (error, key) => error ? reject(error) : resolve(key.toString('hex'))));
}
async function verifyPbkdf2(value, salt, expected) {
  const actual = Buffer.from(await pbkdf2(value, salt)); const wanted = Buffer.from(String(expected || ''));
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
async function readJson(req, maxBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Payload terlalu besar'), { status: 413 });
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Format JSON tidak valid.'), { status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Payload harus berupa objek JSON.'), { status: 400 });
  return value;
}

async function saveBackup(req, res) {
  if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
  requireSameOrigin(req);
  const actor = await activeSession(req);
  if (!['Pemilik','Admin'].includes(actor.role)) return json(res, 403, { error: 'Backup hanya tersedia untuk Pemilik atau Admin.' });
  const body = await readJson(req, 20_000_000);
  if (body.outletId !== actor.outlet_id || !/^\d{4}-\d{2}-\d{2}$/.test(body.backupDate || '') || typeof body.encryptedPayload !== 'string' || body.encryptedPayload.length > 19_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.encryptedPayload)) return json(res, 400, { error: 'Data backup outlet atau format payload tidak valid.' });
  await pool.query(
    `INSERT INTO daily_backups(outlet_id,backup_date,encrypted_payload) VALUES($1,$2,$3)
     ON CONFLICT(outlet_id,backup_date) DO UPDATE SET encrypted_payload=EXCLUDED.encrypted_payload,created_at=now()`,
    [body.outletId, body.backupDate, Buffer.from(body.encryptedPayload, 'base64')],
  );
  return json(res, 200, { stored: true, backupDate: body.backupDate });
}

async function getBackup(req, res, url) {
  if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
  const actor = await activeSession(req);
  if (!['Pemilik','Admin'].includes(actor.role)) return json(res, 403, { error: 'Backup hanya tersedia untuk Pemilik atau Admin.' });
  const outletId = url.searchParams.get('outletId');
  const backupDate = url.searchParams.get('date');
  if (outletId !== actor.outlet_id) return json(res, 403, { error: 'Outlet berada di luar akses akun.' });
  if (backupDate && !/^\d{4}-\d{2}-\d{2}$/.test(backupDate)) return json(res, 400, { error: 'Tanggal backup tidak valid.' });
  const result = await pool.query(
    `SELECT backup_date, encrypted_payload FROM daily_backups
     WHERE outlet_id=$1 AND ($2::date IS NULL OR backup_date=$2::date)
     ORDER BY backup_date DESC LIMIT 1`,
    [outletId, backupDate || null],
  );
  if (!result.rowCount) return json(res, 404, { error: 'Backup server untuk outlet ini tidak ditemukan.' });
  return json(res, 200, {
    backupDate: result.rows[0].backup_date instanceof Date
      ? result.rows[0].backup_date.toISOString().slice(0, 10)
      : String(result.rows[0].backup_date).slice(0, 10),
    encryptedPayload: result.rows[0].encrypted_payload.toString('base64'),
  });
}

async function printLan(req, res) {
  if (!authorized(req)) return json(res, 401, { error: 'Token API tidak valid atau belum dikonfigurasi.' });
  const body = await readJson(req, 2_000_000);
  const printerHost = typeof body.host === 'string' ? body.host.trim() : '';
  const printerPort = Number(body.port);
  const octets = printerHost.split('.').map(Number);
  const privateIpv4 = isIP(printerHost) === 4 && (
    octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  );
  if (!privateIpv4 || !Number.isInteger(printerPort) || printerPort < 1024 || printerPort > 65535) {
    return json(res, 400, { error: 'Alamat printer harus berupa IP privat IPv4 dan port TCP yang valid.' });
  }
  if (typeof body.payload !== 'string' || body.payload.length > 1_500_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.payload)) {
    return json(res, 400, { error: 'Payload ESC/POS tidak valid.' });
  }
  const payload = Buffer.from(body.payload, 'base64');
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: printerHost, port: printerPort });
      const timeout = setTimeout(() => socket.destroy(new Error('Waktu koneksi printer habis.')), 5000);
      socket.once('error', reject);
      socket.once('close', () => { clearTimeout(timeout); resolve(); });
      socket.once('connect', () => socket.end(payload));
    });
    return json(res, 200, { printed: true });
  } catch {
    return json(res, 502, { error: 'Printer LAN tidak dapat menerima data. Periksa alamat, port, dan status printer.' });
  }
}

const ownerDashboard = createDashboardHandler({ pool, activeSession, json });
const syncEvents = createSyncHandler({
  pool,
  activeSession,
  json,
  readJson,
  requireSameOrigin,
  isUuid,
  createHash,
});

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/health' || url.pathname === '/api/health/live') return await health(req, res, url.pathname);
    if (url.pathname.startsWith('/api/') && !await refreshSchemaReady()) return json(res, 503, { error: 'Role runtime, koneksi, atau skema database belum memenuhi syarat. Periksa konfigurasi dan migrasi sebelum mengaktifkan API.' });
    if (url.pathname === '/api/auth/login' && req.method === 'POST') return await ownerLogin(req, res);
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') return logout(req, res);
    if ((url.pathname === '/api/auth/register' && req.method === 'POST') || (url.pathname === '/api/auth/session' && req.method === 'GET') || (url.pathname === '/api/auth/accounts' && ['POST','DELETE'].includes(req.method))) return await accountRequest(req, res, url.pathname);
    if (url.pathname === '/api/auth/users/sync' && req.method === 'POST') return await provisionUser(req, res);
    if (url.pathname === '/api/auth/users' && req.method === 'GET') {
      if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
      const actor = await activeSession(req);
      if (!['Pemilik','Manajer','Admin'].includes(actor.role)) return json(res, 403, { error: 'Daftar pengguna hanya tersedia untuk Pemilik, Manajer, atau Admin.' });
      const requestedOutlet = url.searchParams.get('outletId');
      if (requestedOutlet && requestedOutlet !== actor.outlet_id) return json(res, 403, { error: 'Outlet berada di luar akses akun.' });
      const result = await pool.query(`SELECT id,name,role,(totp_secret_ciphertext IS NOT NULL) AS "hasTotp" FROM users WHERE active=true AND outlet_id=$1 ORDER BY name`, [actor.outlet_id]);
      return json(res, 200, { users: result.rows });
    }
    if (url.pathname === '/api/dashboard' && req.method === 'GET') return await ownerDashboard(req, res, url);
    if (url.pathname === '/api/sync') return await syncEvents(req, res, url);
    if (url.pathname === '/api/backup' && req.method === 'POST') return await saveBackup(req, res);
    if (url.pathname === '/api/backup' && req.method === 'GET') return await getBackup(req, res, url);
    if (url.pathname === '/api/print' && req.method === 'POST') return await printLan(req, res);
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Endpoint API tidak ditemukan.' });

    return await serveStaticFile(res, url, { staticRoot, staticBuildAvailable, securityHeaders, json });
  } catch (error) {
    if (isClientDisconnect(error, req, res)) return;
    if (error.status) return json(res, error.status, { error: error.message, code: error.code || null, conflict: error.conflict || null });
    console.error(error);
    json(res, 500, { error: 'Permintaan tidak dapat diproses.' });
  }
}).listen(port, host, () => console.log(`FastQ siap di http://${host}:${port}`));
