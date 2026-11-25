import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProductImageHandler,
  inspectProductImage,
} from '../server/product-image-handler.mjs';

const outletId = '00000000-0000-4000-8000-000000000001';
const imageId = '00000000-0000-4000-8000-000000000002';
const actor = { id: '00000000-0000-4000-8000-000000000003', outlet_id: outletId, role: 'Admin' };
const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function webp(width = 192, height = 192) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WEBP', 8);
  buffer.write('VP8X', 12);
  buffer.writeUInt32LE(10, 16);
  buffer[24] = (width - 1) & 0xff;
  buffer[25] = ((width - 1) >> 8) & 0xff;
  buffer[26] = ((width - 1) >> 16) & 0xff;
  buffer[27] = (height - 1) & 0xff;
  buffer[28] = ((height - 1) >> 8) & 0xff;
  buffer[29] = ((height - 1) >> 16) & 0xff;
  return buffer;
}

function jpeg(width = 192, height = 192) {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
  ]);
}

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test('image inspection accepts 192-square WebP/JPEG and rejects unsupported formats and dimensions', () => {
  assert.equal(inspectProductImage(webp()).contentType, 'image/webp');
  assert.equal(inspectProductImage(jpeg()).contentType, 'image/jpeg');
  assert.throws(() => inspectProductImage(Buffer.from('not an image')), { status: 415 });
  assert.throws(() => inspectProductImage(webp(400, 192)), { status: 422 });
  assert.throws(() => inspectProductImage(jpeg(192, 400)), { status: 422 });
});

test('authorized image upload stores a validated image and returns its stable ID', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT id,byte_size FROM product_images')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT count(*)'))
        return { rows: [{ image_count: 0, byte_count: 0 }], rowCount: 1 };
      if (sql.includes('INSERT INTO product_images'))
        return { rows: [{ id: imageId, byte_size: webp().length }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const jsonCalls = [];
  const handler = createProductImageHandler({
    pool: { connect: async () => client },
    activeSession: async () => actor,
    requireSameOrigin() {},
    readBinary: async () => webp(),
    isUuid,
    json: (_res, status, body) => {
      jsonCalls.push({ status, body });
      return { status, body };
    },
    now: () => 1000,
  });

  const result = await handler.upload({ method: 'POST' }, {});

  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { imageId, byteSize: 30 });
  assert.ok(calls.includes('BEGIN'));
  assert.ok(calls.includes('COMMIT'));
  assert.equal(jsonCalls.length, 1);
});

test('identical images reuse IDs before outlet quota checks', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT id,byte_size FROM product_images'))
        return { rows: [{ id: imageId, byte_size: 30 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const handler = createProductImageHandler({
    pool: { connect: async () => client },
    activeSession: async () => actor,
    requireSameOrigin() {},
    readBinary: async () => webp(),
    isUuid,
    json: (_res, status, body) => ({ status, body }),
  });

  const result = await handler.upload({ method: 'POST' }, {});

  assert.deepEqual(result.body, { imageId, byteSize: 30 });
  assert.equal(
    calls.some((sql) => sql.includes('SELECT count(*)')),
    false,
  );
  assert.equal(
    calls.some((sql) => sql.includes('INSERT INTO product_images')),
    false,
  );
});

test('upload rejects unauthorized roles and enforces per-outlet storage quota', async () => {
  let binaryReads = 0;
  const noWriteHandler = createProductImageHandler({
    pool: {
      connect: async () => {
        throw new Error('Should not connect.');
      },
    },
    activeSession: async () => ({ ...actor, role: 'Kasir' }),
    requireSameOrigin() {},
    readBinary: async () => {
      binaryReads++;
      return webp();
    },
    isUuid,
    json: (_res, status, body) => ({ status, body }),
  });
  assert.equal((await noWriteHandler.upload({ method: 'POST' }, {})).status, 403);
  assert.equal(binaryReads, 0);

  const client = {
    async query(sql) {
      if (sql.includes('SELECT id,byte_size FROM product_images')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT count(*)'))
        return { rows: [{ image_count: 2000, byte_count: 100 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const quotaHandler = createProductImageHandler({
    pool: { connect: async () => client },
    activeSession: async () => actor,
    requireSameOrigin() {},
    readBinary: async () => webp(),
    isUuid,
    json: (_res, status, body) => ({ status, body }),
  });
  await assert.rejects(
    quotaHandler.upload({ method: 'POST' }, {}),
    (error) => error.status === 409 && error.code === 'PRODUCT_IMAGE_QUOTA',
  );
});

test('media responses are outlet-scoped and carry immutable private image headers', async () => {
  const image = webp();
  const handler = createProductImageHandler({
    pool: {
      async query(_sql, values) {
        assert.deepEqual(values, [imageId, outletId]);
        return { rows: [{ content_type: 'image/webp', data: image }], rowCount: 1 };
      },
    },
    activeSession: async () => actor,
    requireSameOrigin() {},
    readBinary: async () => webp(),
    isUuid,
    json: (_res, status, body) => ({ status, body }),
    securityHeaders: () => ({ 'X-Frame-Options': 'SAMEORIGIN' }),
  });
  const res = responseRecorder();

  await handler.serve({}, res, imageId);

  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/webp');
  assert.equal(res.headers['Cache-Control'], 'private, max-age=31536000, immutable');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(res.body, image);
});
