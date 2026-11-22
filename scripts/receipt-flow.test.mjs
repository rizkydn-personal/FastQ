import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const receipts = readFileSync(join(root, 'legacy-scripts/pos/04-sales-receipts.js'), 'utf8');
const reports = readFileSync(join(root, 'legacy-scripts/pos/15-reports-charts.js'), 'utf8');
const roles = readFileSync(join(root, 'legacy-scripts/pos/06-shift-roles.js'), 'utf8');

test('receipt modal has exactly the three buttons Share / Print / Selesai', () => {
  const modal = receipts.match(/function receiptModal\(s\)\{.*?\n/)?.[0] ?? '';
  assert.match(modal, /label:'Share'/);
  assert.match(modal, /label:'Print'/);
  assert.match(modal, /label:'Selesai'/);
  assert.doesNotMatch(modal, /Transaksi baru|Kirim WhatsApp|Cetak struk/);
  assert.match(modal, /label:'Selesai',primary:true/);
});

test('old receipt print/share paths are deleted at the root', () => {
  for (const name of ['chooseReceiptPrinter', 'lanPrinterSettingsModal', 'printReceipt', 'printThermal', 'printLan']) {
    assert.doesNotMatch(receipts, new RegExp(`function ${name}`), `${name} must be deleted`);
  }
  assert.doesNotMatch(receipts, /function shareReceipt\(/);
  assert.doesNotMatch(receipts, /wa\.me\/\?text=/, 'no text receipt share via wa.me');
  assert.doesNotMatch(receipts, /window\.print|print\(\)/, 'no browser print path in receipt flow');
});

test('bluetooth print path and ESC/POS payload are kept', () => {
  assert.match(receipts, /async function printBluetooth\(s\)/);
  assert.match(receipts, /async function escposPayload\(s\)/);
  assert.match(receipts, /navigator\.bluetooth/);
});

test('share sends the receipt as an image, never as text', () => {
  assert.match(receipts, /async function shareReceiptImage\(s\)/);
  assert.match(receipts, /receiptImageBlob/);
  assert.match(receipts, /canvas\.toBlob\(resolve,'image\/png'\)/);
  assert.match(receipts, /navigator\.share\(\{files:/);
  assert.match(receipts, /new File\(\[blob\]/);
  assert.match(receipts, /window\.open\('https:\/\/wa\.me\/'/);
});

test('laporan rows open the receipt detail modal; action buttons keep working', () => {
  assert.match(reports, /tr\[data-sale-id\]/);
  assert.match(reports, /data-sale-id="\$\{esc\(s\.id\)\}"/);
  assert.match(reports, /receiptModal\(sale\)/);
  const handler = reports.slice(reports.indexOf('reportSalesBody.addEventListener'));
  assert.match(handler, /data-settle-sale/);
  assert.ok(handler.indexOf('data-settle-sale') < handler.indexOf('tr[data-sale-id]'),
    'action buttons must be checked before the row fallback');
});

test('receipt template hint no longer promises system print / PDF', () => {
  assert.doesNotMatch(roles, /dicetak ke printer sistem atau disimpan sebagai PDF/);
  assert.match(roles, /dibagikan sebagai gambar dan dicetak melalui Bluetooth/);
});

test('receipt image is pre-rendered at modal open so Share can run in the click gesture', () => {
  // receiptModal harus mem-prime gambar struk begitu dibuka
  assert.match(receipts, /primeReceiptImage\(s\)/);
  assert.match(receipts, /function primeReceiptImage\(s\)/);
  assert.match(receipts, /receiptImageCache/);
  // shareReceiptImage: jalur cepat memakai blob yang sudah siap TANPA await
  // sebelum share/unduh (agar tetap dalam gestur klik)
  const share = receipts.slice(receipts.indexOf('async function shareReceiptImage'));
  const fastPath = share.slice(0, share.indexOf('return shareReceiptBlob(ready,s,true);'));
  assert.match(fastPath, /receiptImageCache\.blob/);
  assert.doesNotMatch(fastPath, /await/, 'fast path must not await before share/download');
  assert.match(receipts, /function downloadReceiptBlob\(blob,s\)/);
  assert.match(receipts, /function shareReceiptBlob\(blob,s,sync\)/);
});
