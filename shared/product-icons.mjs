export const PRODUCT_ICONS = Object.freeze([
  { key: 'cube', icon: 'cube', label: 'Produk' },
  { key: 'coffee', icon: 'coffee', label: 'Kopi' },
  { key: 'bread', icon: 'bread', label: 'Roti' },
  { key: 'cake', icon: 'cake', label: 'Kue' },
  { key: 'cookie', icon: 'cookie', label: 'Camilan' },
  { key: 'bowl-food', icon: 'bowl-food', label: 'Makanan' },
  { key: 'wine', icon: 'wine', label: 'Minuman' },
  { key: 'drop', icon: 'drop', label: 'Cairan' },
  { key: 'leaf', icon: 'leaf', label: 'Organik' },
  { key: 'fish', icon: 'fish', label: 'Hasil laut' },
  { key: 'basket', icon: 'basket', label: 'Belanja' },
  { key: 'shirt', icon: 't-shirt', label: 'Pakaian' },
  { key: 'shoe', icon: 'sneaker', label: 'Sepatu' },
  { key: 'watch', icon: 'watch', label: 'Aksesori' },
  { key: 'book', icon: 'book-open', label: 'Buku' },
  { key: 'stationery', icon: 'pencil', label: 'Alat tulis' },
  { key: 'health', icon: 'first-aid-kit', label: 'Kesehatan' },
  { key: 'medicine', icon: 'pill', label: 'Obat' },
  { key: 'beauty', icon: 'flower', label: 'Kecantikan' },
  { key: 'plant', icon: 'plant', label: 'Tanaman' },
  { key: 'pet', icon: 'paw-print', label: 'Hewan' },
  { key: 'gift', icon: 'gift', label: 'Hadiah' },
  { key: 'light', icon: 'lightbulb', label: 'Lampu' },
  { key: 'electronics', icon: 'plug', label: 'Elektronik' },
  { key: 'phone', icon: 'device-mobile', label: 'Ponsel' },
  { key: 'computer', icon: 'laptop', label: 'Komputer' },
  { key: 'tools', icon: 'wrench', label: 'Perkakas' },
  { key: 'paint', icon: 'paint-brush', label: 'Kerajinan' },
  { key: 'car', icon: 'car', label: 'Otomotif' },
  { key: 'toy', icon: 'game-controller', label: 'Mainan' },
  { key: 'home', icon: 'house', label: 'Rumah tangga' },
  { key: 'store', icon: 'storefront', label: 'Toko' },
]);

const productIconKeys = new Set(PRODUCT_ICONS.map(({ key }) => key));

export function isProductIcon(value) {
  return typeof value === 'string' && productIconKeys.has(value);
}
