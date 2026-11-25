import { createHash } from 'node:crypto';
import { roleEventTypes } from '../shared/sync-role-policy.mjs';

const IMAGE_LIMIT = 30 * 1024;
const IMAGE_COUNT_LIMIT = 2000;
const OUTLET_BYTES_LIMIT = 50 * 1024 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 20;

function readUint24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpDimensions(buffer) {
  if (
    buffer.length < 20 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP' ||
    buffer.readUInt32LE(4) + 8 > buffer.length
  )
    return null;

  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (length > buffer.length - data) return null;
    if (type === 'VP8X' && length >= 10)
      return {
        width: readUint24LE(buffer, data + 4) + 1,
        height: readUint24LE(buffer, data + 7) + 1,
      };
    if (type === 'VP8L' && length >= 5 && buffer[data] === 0x2f) {
      const b1 = buffer[data + 1];
      const b2 = buffer[data + 2];
      const b3 = buffer[data + 3];
      const b4 = buffer[data + 4];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    if (
      type === 'VP8 ' &&
      length >= 10 &&
      buffer[data + 3] === 0x9d &&
      buffer[data + 4] === 0x01 &&
      buffer[data + 5] === 0x2a
    )
      return {
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff,
      };
    offset = data + length + (length & 1);
  }
  return null;
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if (frameMarkers.has(marker)) {
      if (length < 7) return null;
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

export function inspectProductImage(data) {
  const buffer = Buffer.from(data);
  let contentType;
  let dimensions;
  if (webpDimensions(buffer)) {
    contentType = 'image/webp';
    dimensions = webpDimensions(buffer);
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    contentType = 'image/jpeg';
    dimensions = jpegDimensions(buffer);
  } else {
    throw Object.assign(new Error('Format gambar harus WebP atau JPEG.'), {
      status: 415,
      code: 'PRODUCT_IMAGE_FORMAT',
    });
  }
  if (!dimensions)
    throw Object.assign(new Error('Header gambar tidak valid.'), {
      status: 415,
      code: 'PRODUCT_IMAGE_FORMAT',
    });
  if (dimensions.width !== 192 || dimensions.height !== 192)
    throw Object.assign(new Error('Ukuran gambar harus tepat 192 x 192 piksel.'), {
      status: 422,
      code: 'PRODUCT_IMAGE_DIMENSIONS',
    });
  return { buffer, contentType };
}

export function createProductImageHandler({
  pool,
  activeSession,
  requireSameOrigin,
  readBinary,
  isUuid,
  json,
  securityHeaders = () => ({}),
  corsHeaders = () => ({}),
  now = () => Date.now(),
}) {
  const uploadWindows = new Map();

  function consumeUploadLimit(userId) {
    const currentTime = now();
    let record = uploadWindows.get(userId);
    if (!record || currentTime - record.startedAt >= RATE_WINDOW_MS)
      record = { startedAt: currentTime, count: 0 };
    if (record.count >= RATE_LIMIT) return false;
    record.count++;
    uploadWindows.delete(userId);
    uploadWindows.set(userId, record);
    if (uploadWindows.size > 10_000) {
      for (const [id, window] of uploadWindows)
        if (currentTime - window.startedAt >= RATE_WINDOW_MS) uploadWindows.delete(id);
      while (uploadWindows.size > 10_000) uploadWindows.delete(uploadWindows.keys().next().value);
    }
    return true;
  }

  async function upload(req, res) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    requireSameOrigin(req);
    const actor = await activeSession(req);
    if (!roleEventTypes[actor.role]?.has('product.upsert'))
      return json(res, 403, { error: 'Akun ini tidak memiliki izin mengubah produk.' });
    if (!consumeUploadLimit(actor.id))
      return json(res, 429, { error: 'Batas 20 unggahan gambar per menit telah tercapai.' });

    const data = await readBinary(req, IMAGE_LIMIT);
    if (!data.length)
      throw Object.assign(new Error('Berkas gambar kosong.'), {
        status: 415,
        code: 'PRODUCT_IMAGE_FORMAT',
      });
    const { buffer, contentType } = inspectProductImage(data);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `product-images:${actor.outlet_id}`,
      ]);
      const existing = await client.query(
        'SELECT id,byte_size FROM product_images WHERE outlet_id=$1 AND sha256=$2',
        [actor.outlet_id, sha256],
      );
      if (existing.rowCount) {
        await client.query('COMMIT');
        return json(res, 200, {
          imageId: existing.rows[0].id,
          byteSize: Number(existing.rows[0].byte_size),
        });
      }

      const usage = await client.query(
        'SELECT count(*)::int AS image_count,COALESCE(sum(byte_size),0)::bigint AS byte_count FROM product_images WHERE outlet_id=$1',
        [actor.outlet_id],
      );
      const imageCount = Number(usage.rows[0]?.image_count || 0);
      const byteCount = Number(usage.rows[0]?.byte_count || 0);
      if (imageCount >= IMAGE_COUNT_LIMIT || byteCount + buffer.length > OUTLET_BYTES_LIMIT)
        throw Object.assign(new Error('Batas penyimpanan gambar untuk outlet telah tercapai.'), {
          status: 409,
          code: 'PRODUCT_IMAGE_QUOTA',
        });

      const inserted = await client.query(
        `INSERT INTO product_images(outlet_id,sha256,content_type,byte_size,data)
         VALUES($1,$2,$3,$4,$5) RETURNING id,byte_size`,
        [actor.outlet_id, sha256, contentType, buffer.length, buffer],
      );
      await client.query('COMMIT');
      return json(res, 201, {
        imageId: inserted.rows[0].id,
        byteSize: Number(inserted.rows[0].byte_size),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function serve(req, res, imageId) {
    if (!pool) return json(res, 503, { error: 'DATABASE_URL belum dikonfigurasi.' });
    if (!isUuid(imageId)) return json(res, 400, { error: 'ID gambar tidak valid.' });
    const actor = await activeSession(req);
    const result = await pool.query(
      'SELECT content_type,data FROM product_images WHERE id=$1 AND outlet_id=$2',
      [imageId, actor.outlet_id],
    );
    if (!result.rowCount) return json(res, 404, { error: 'Gambar produk tidak ditemukan.' });
    const data = Buffer.from(result.rows[0].data);
    res.writeHead(200, {
      ...securityHeaders(),
      ...corsHeaders(req),
      'Content-Type': result.rows[0].content_type,
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }

  return { upload, serve };
}
