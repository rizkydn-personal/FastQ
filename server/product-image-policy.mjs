export async function assertProductImagesBelongToOutlet(client, imageIds, outletId, isUuid) {
  const uniqueIds = [...new Set(imageIds.filter((id) => id != null))];
  if (!uniqueIds.length) return;
  if (uniqueIds.some((id) => !isUuid(id)))
    throw Object.assign(new Error('ID gambar produk tidak valid.'), { status: 400 });
  const result = await client.query(
    'SELECT id FROM product_images WHERE outlet_id=$1 AND id=ANY($2::uuid[])',
    [outletId, uniqueIds],
  );
  if (result.rowCount !== uniqueIds.length)
    throw Object.assign(new Error('Gambar produk tidak ditemukan di outlet aktif.'), {
      status: 409,
    });
}
