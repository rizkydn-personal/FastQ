import { isProductIcon } from '../shared/product-icons.mjs';
import { assertProductImagesBelongToOutlet } from './product-image-policy.mjs';

function movementId(createHash, eventId, productId) {
  return createHash('sha256')
    .update(`bulk-import-stock:${eventId}:${productId}`)
    .digest('hex')
    .slice(0, 32)
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function validQuantity(value) {
  return (
    Number.isFinite(value) &&
    value > -1e15 &&
    value < 1e15 &&
    Math.abs(value * 1000 - Math.round(value * 1000)) <= 1e-6
  );
}

export async function applyBulkCatalogEvent({ client, event, scope, actor, isUuid, createHash }) {
  const products = event.payload.products;
  if (!Array.isArray(products) || products.length < 1 || products.length > 500)
    throw Object.assign(new Error('Impor produk harus berisi 1 sampai 500 produk.'), {
      status: 400,
    });
  if (Buffer.byteLength(JSON.stringify(event.payload)) > 400 * 1024)
    throw Object.assign(new Error('Ukuran impor produk melebihi 400 KB.'), { status: 413 });

  const ids = new Set();
  const skus = new Set();
  for (const product of products) {
    const sku = typeof product?.sku === 'string' ? product.sku.trim() : '';
    const name = typeof product?.name === 'string' ? product.name.trim() : '';
    const unit = product?.unit ?? 'pcs';
    const minStock = Number(product?.minStock ?? 0);
    const stock = Number(product?.stock);
    const stockDelta = product?.stockDelta == null ? null : Number(product.stockDelta);
    if (
      !product ||
      typeof product !== 'object' ||
      Array.isArray(product) ||
      !isUuid(product.id) ||
      !sku ||
      sku.length > 40 ||
      !name ||
      name.length > 80 ||
      typeof product.category !== 'string' ||
      !product.category.trim() ||
      product.category.length > 40 ||
      typeof unit !== 'string' ||
      !unit.trim() ||
      unit.length > 40 ||
      !Number.isSafeInteger(product.price) ||
      product.price < 0 ||
      !Number.isSafeInteger(product.cost ?? 0) ||
      (product.cost ?? 0) < 0 ||
      !validQuantity(minStock) ||
      minStock < 0 ||
      !validQuantity(stock) ||
      stock < 0 ||
      (stockDelta != null && !validQuantity(stockDelta)) ||
      (product.barcode != null &&
        (typeof product.barcode !== 'string' || product.barcode.length > 50)) ||
      (product.icon != null && !isProductIcon(product.icon)) ||
      (product.imageId != null && !isUuid(product.imageId)) ||
      (product.variants != null && (!Array.isArray(product.variants) || product.variants.length))
    )
      throw Object.assign(new Error('Data produk impor tidak valid.'), { status: 400 });
    const normalizedSku = sku.toLocaleLowerCase('id-ID');
    if (ids.has(product.id) || skus.has(normalizedSku))
      throw Object.assign(new Error('ID atau SKU berulang dalam impor produk.'), {
        status: 409,
      });
    ids.add(product.id);
    skus.add(normalizedSku);
  }

  const identity = await client.query(
    `SELECT id,sku,barcode,outlet_id,metadata FROM products
     WHERE id=ANY($1::uuid[]) OR (outlet_id=$2 AND lower(sku)=ANY($3::text[]))
     FOR UPDATE`,
    [
      products.map((product) => product.id),
      scope,
      products.map((product) => product.sku.trim().toLocaleLowerCase('id-ID')),
    ],
  );
  const existingById = new Map();
  for (const row of identity.rows) {
    if (row.outlet_id !== scope)
      throw Object.assign(new Error('Produk tidak ditemukan di toko aktif.'), { status: 404 });
    const incomingBySku = products.find(
      (product) =>
        product.sku.trim().toLocaleLowerCase('id-ID') === row.sku.toLocaleLowerCase('id-ID'),
    );
    if (incomingBySku && incomingBySku.id !== row.id)
      throw Object.assign(new Error('SKU produk sudah dipakai produk lain.'), { status: 409 });
    if (products.some((product) => product.id === row.id)) existingById.set(row.id, row);
  }
  await assertProductImagesBelongToOutlet(
    client,
    products.map((product) => product.imageId),
    scope,
    isUuid,
  );

  const categoryNames = [...new Set(products.map((product) => product.category.trim()))];
  const categories = await client.query(
    `WITH names AS (
       SELECT DISTINCT name FROM unnest($2::text[]) AS categories(name)
     )
     INSERT INTO categories(id,outlet_id,name)
     SELECT gen_random_uuid(),$1,name FROM names
     ON CONFLICT(outlet_id,name) DO UPDATE SET name=EXCLUDED.name
     RETURNING id,name`,
    [scope, categoryNames],
  );
  const categoryIdByName = new Map(categories.rows.map((row) => [row.name, row.id]));

  const productRows = products.map((product) => {
    const existing = existingById.get(product.id);
    const oldMetadata = existing?.metadata || {};
    return {
      id: product.id,
      sku: product.sku.trim(),
      barcode: product.barcode || null,
      name: product.name.trim(),
      category: product.category.trim(),
      unit: product.unit || 'pcs',
      price: product.price,
      cost: product.cost ?? 0,
      minStock: Number(product.minStock ?? 0),
      metadata: {
        ...oldMetadata,
        variants: [],
        stockByOutlet: {
          ...(oldMetadata.stockByOutlet || {}),
          ...(product.stockByOutlet || {}),
          [scope]: product.stock,
        },
        favorite: oldMetadata.favorite ?? !!product.favorite,
        icon: product.icon ?? oldMetadata.icon ?? 'cube',
        imageId: Object.prototype.hasOwnProperty.call(product, 'imageId')
          ? product.imageId
          : oldMetadata.imageId || null,
      },
    };
  });
  const savedProducts = await client.query(
    `INSERT INTO products(id,outlet_id,sku,barcode,name,category_id,unit,price_rupiah,cost_rupiah,min_stock,metadata,updated_at)
     SELECT incoming.id,$2,incoming.sku,incoming.barcode,incoming.name,category.id,
            incoming.unit,incoming.price,incoming.cost,COALESCE(incoming.min_stock,0),incoming.metadata,now()
     FROM jsonb_to_recordset($1::jsonb) AS incoming(
       id uuid,sku text,barcode text,name text,category text,unit text,
       price bigint,cost bigint,min_stock numeric,metadata jsonb
     )
     JOIN categories category ON category.outlet_id=$2 AND category.name=incoming.category
     ON CONFLICT(id) DO UPDATE SET
       sku=EXCLUDED.sku,barcode=EXCLUDED.barcode,name=EXCLUDED.name,
       category_id=EXCLUDED.category_id,unit=EXCLUDED.unit,
       price_rupiah=EXCLUDED.price_rupiah,cost_rupiah=EXCLUDED.cost_rupiah,
       min_stock=EXCLUDED.min_stock,metadata=EXCLUDED.metadata,updated_at=now()
     WHERE products.outlet_id=EXCLUDED.outlet_id
     RETURNING id`,
    [
      JSON.stringify(
        productRows.map((row) => ({
          ...row,
          categoryId: categoryIdByName.get(row.category),
          min_stock: row.minStock,
        })),
      ),
      scope,
    ],
  );
  if (savedProducts.rowCount !== products.length)
    throw Object.assign(new Error('Produk tidak dapat disimpan dalam impor.'), { status: 409 });

  const stockChanges = products.flatMap((product) => {
    const isNew = !existingById.has(product.id);
    const delta = isNew ? Number(product.stock) : Number(product.stockDelta || 0);
    if (!delta) return [];
    return [
      {
        id: product.id,
        delta,
        reason: isNew ? 'Stok awal' : 'Impor Excel',
        movementId: movementId(createHash, event.id, product.id),
      },
    ];
  });
  if (stockChanges.length) {
    const savedBalances = await client.query(
      `INSERT INTO stock_balances(outlet_id,product_id,variant_id,quantity)
       SELECT $2,incoming.id,NULL,incoming.delta
       FROM jsonb_to_recordset($1::jsonb) AS incoming(id uuid,delta numeric)
       ON CONFLICT(outlet_id,product_id,variant_id) DO UPDATE
         SET quantity=stock_balances.quantity+EXCLUDED.quantity,updated_at=now()
         WHERE stock_balances.quantity+EXCLUDED.quantity>=0
       RETURNING product_id`,
      [JSON.stringify(stockChanges), scope],
    );
    if (savedBalances.rowCount !== stockChanges.length)
      throw Object.assign(new Error('Stok berubah atau tidak mencukupi saat impor.'), {
        status: 409,
      });
    await client.query(
      `INSERT INTO stock_movements(id,outlet_id,product_id,variant_id,delta,reason,occurred_at,user_id)
       SELECT incoming.id,$2,incoming.product_id,NULL,incoming.delta,incoming.reason,
              $3,$4
       FROM jsonb_to_recordset($1::jsonb) AS incoming(
         id uuid,product_id uuid,delta numeric,reason text
       )
       ON CONFLICT(id) DO NOTHING`,
      [
        JSON.stringify(
          stockChanges.map((change) => ({
            id: change.movementId,
            product_id: change.id,
            delta: change.delta,
            reason: change.reason,
          })),
        ),
        scope,
        event.at || new Date().toISOString(),
        actor.id,
      ],
    );
  }
}
