import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthSecurity } from '../auth-security.mjs';

function request(origin, host, { encrypted = false, headers = {} } = {}) {
  return { headers: { origin, host, ...headers }, socket: { encrypted } };
}

test('same-origin login accepts HTTP localhost while secure cookies stay enabled', () => {
  const auth = createAuthSecurity({ cookieSecure: true });
  assert.doesNotThrow(() => auth.requireSameOrigin(request('http://localhost:4173', 'localhost:4173')));

  let cookie = '';
  auth.setSessionCookie({ setHeader: (_name, value) => { cookie = value; } }, 'signed-token');
  assert.match(cookie, /; Secure(?:;|$)/);
});

test('same-origin compares HTTPS to the direct encrypted request', () => {
  const auth = createAuthSecurity({ cookieSecure: false });
  assert.doesNotThrow(() => auth.requireSameOrigin(request('https://pos.example.test', 'pos.example.test', { encrypted: true })));
  assert.throws(
    () => auth.requireSameOrigin(request('http://pos.example.test', 'pos.example.test', { encrypted: true })),
    error => error.status === 403,
  );
});

test('trusted proxy origin uses forwarded host and protocol only when enabled', () => {
  const auth = createAuthSecurity({ cookieSecure: true, trustProxy: true });
  assert.doesNotThrow(() => auth.requireSameOrigin(request('https://pos.example.test', '127.0.0.1:4173', {
    headers: { 'x-forwarded-host': 'pos.example.test', 'x-forwarded-proto': 'https' },
  })));
  assert.throws(
    () => createAuthSecurity({ cookieSecure: true }).requireSameOrigin(request('https://pos.example.test', '127.0.0.1:4173', {
      headers: { 'x-forwarded-host': 'pos.example.test', 'x-forwarded-proto': 'https' },
    })),
    error => error.status === 403,
  );
});
