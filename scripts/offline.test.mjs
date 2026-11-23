import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
for (const [path, expected] of [
  ['/pos', './index.html'],
  ['/dashboard', './index.html'],
]) {
  test(`offline navigation ${path} uses the correct shell`, async () => {
    const handlers = {};
    let response;
    runInNewContext(source, {
      URL,
      self: {
        location: { origin: 'https://pos.test' },
        addEventListener: (name, handler) => {
          handlers[name] = handler;
        },
      },
      fetch: async () => {
        throw new Error('Offline');
      },
      caches: { match: async (key) => (typeof key === 'string' ? key : undefined) },
    });
    handlers.fetch({
      request: { method: 'GET', mode: 'navigate', url: `https://pos.test${path}` },
      respondWith: (value) => {
        response = value;
      },
    });
    assert.equal(await response, expected);
  });
}

test('authentication requests never use the offline cache', () => {
  const handlers = {};
  runInNewContext(source, {
    URL,
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
    },
  });
  handlers.fetch({
    request: { method: 'GET', url: 'https://pos.test/api/auth/session' },
    respondWith: () => assert.fail('API response must not be cached'),
  });
});

test('POS runtime and sync policy are cached for offline startup without legacy assets', async () => {
  const handlers = {};
  let cachedPaths = [];
  let installation;
  const cache = {
    addAll: async (requests) => {
      cachedPaths = requests.map((request) => request.url);
    },
    match: async () => null,
    add: async () => {},
  };
  runInNewContext(source, {
    URL,
    Request: class {
      constructor(input) {
        this.url = new URL(input, 'https://pos.test').href;
      }
    },
    self: {
      location: { origin: 'https://pos.test' },
      addEventListener: (name, handler) => {
        handlers[name] = handler;
      },
      skipWaiting: async () => {},
    },
    caches: { open: async () => cache },
  });
  handlers.install({
    waitUntil: (promise) => {
      installation = promise;
    },
  });
  await installation;
  assert.ok(cachedPaths.some((path) => path.endsWith('/pos-runtime.js')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/shift-utils.mjs')));
  assert.ok(cachedPaths.some((path) => path.endsWith('/sync-policy.js')));
  assert.ok(cachedPaths.every((path) => !path.includes('/legacy/')));
});
