import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const SESSION_COOKIE = 'pos_session';
const sessionRoles = new Set(['Pemilik', 'Manajer', 'Admin', 'Kasir']);
const sessionUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_NATIVE_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];

export function createAuthSecurity({
  apiToken = '',
  sessionSecret = '',
  totpEncryptionKey = '',
  cookieSecure = true,
  trustProxy = false,
  allowedOrigins = [],
} = {}) {
  const allowedOriginSet = new Set(
    [...DEFAULT_NATIVE_ORIGINS, ...allowedOrigins]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );

  function isAllowedOrigin(origin) {
    if (!origin) return false;
    try {
      return allowedOriginSet.has(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }

  function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=');
      if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
      try {
        return decodeURIComponent(pair.slice(separator + 1).trim());
      } catch {
        return '';
      }
    }
    return '';
  }

  function setSessionCookie(res, token, maxAgeSeconds = 30 * 24 * 60 * 60, options = {}) {
    const crossOrigin = options.crossOrigin === true;
    const sameSite = crossOrigin ? 'None' : 'Lax';
    const secure = crossOrigin ? true : cookieSecure;
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`,
    );
  }

  function requireSameOrigin(req) {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) return;
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw Object.assign(new Error('Permintaan lintas situs ditolak.'), { status: 403 });
    if (!origin) return;
    try {
      const forwardedHost = trustProxy
        ? String(req.headers['x-forwarded-host'] || '')
            .split(',')[0]
            .trim()
        : '';
      const forwardedProtocol = trustProxy
        ? String(req.headers['x-forwarded-proto'] || '')
            .split(',')[0]
            .trim()
            .replace(/:$/, '')
            .toLowerCase()
        : '';
      const protocol = forwardedProtocol
        ? `${forwardedProtocol}:`
        : req.socket.encrypted
          ? 'https:'
          : 'http:';
      if (!['http:', 'https:'].includes(protocol)) throw new Error();
      const expectedOrigin = new URL(`${protocol}//${forwardedHost || req.headers.host}`).origin;
      if (new URL(origin).origin !== expectedOrigin) throw new Error();
    } catch {
      throw Object.assign(new Error('Asal permintaan tidak valid.'), { status: 403 });
    }
  }

  function authorized(req) {
    const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(apiToken);
    return (
      apiToken.length >= 32 &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    );
  }

  function sessionUser(req) {
    const token = readCookie(req, SESSION_COOKIE);
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, signature] = parts;
    if (!body || !signature || sessionSecret.length < 32) return null;
    const expected = createHmac('sha256', sessionSecret).update(body).digest('base64url');
    const a = Buffer.from(signature),
      b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        !sessionUuidPattern.test(payload.sub || '') ||
        !sessionUuidPattern.test(payload.outletId || '') ||
        !sessionUuidPattern.test(payload.sid || '') ||
        !sessionRoles.has(payload.role) ||
        typeof payload.name !== 'string' ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp <= Date.now()
      )
        return null;
      return payload;
    } catch {
      return null;
    }
  }

  function encryptTotpSecret(secret) {
    const key = Buffer.from(totpEncryptionKey, 'hex');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  function decryptTotpSecret(payload) {
    if (!payload || totpEncryptionKey.length !== 64) return '';
    try {
      const data = Buffer.from(payload),
        nonce = data.subarray(0, 12),
        tag = data.subarray(12, 28),
        ciphertext = data.subarray(28);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(totpEncryptionKey, 'hex'),
        nonce,
      );
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  function verifyTotp(secret, code) {
    if (!secret || !/^\d{6}$/.test(code || '')) return false;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0,
      value = 0;
    const key = [];
    for (const char of secret.replace(/=+$/, '').toUpperCase()) {
      const n = alphabet.indexOf(char);
      if (n < 0) return false;
      value = (value << 5) | n;
      bits += 5;
      if (bits >= 8) {
        key.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    for (let drift = -1; drift <= 1; drift++) {
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + drift));
      const digest = createHmac('sha1', Buffer.from(key)).update(counter).digest();
      const offset = digest[digest.length - 1] & 15;
      const num = digest.readUInt32BE(offset) & 0x7fffffff;
      if (String(num % 1000000).padStart(6, '0') === code) return true;
    }
    return false;
  }

  return {
    readCookie,
    setSessionCookie,
    requireSameOrigin,
    isAllowedOrigin,
    corsHeaders,
    authorized,
    sessionUser,
    encryptTotpSecret,
    decryptTotpSecret,
    verifyTotp,
  };
}
