import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

const staticFileAllowlist = new Set([
  '/index.html', '/manifest.webmanifest', '/favicon.ico', '/icon.svg', '/fastq-mark.png', '/fastq-icon-192.png', '/fastq-icon-512.png',
  '/account.js', '/pos.js', '/pos-utils.mjs', '/pos-storage.mjs', '/report-utils.mjs', '/attendance-utils.mjs', '/shift-utils.mjs', '/cart-utils.mjs', '/sync-policy.js', '/sync-role-policy.mjs', '/polish.css', '/polish-extra.css', '/polish-kasir.css', '/polish-logo.css', '/polish-laporan.css', '/polish-produk.css', '/polish-shift.css', '/polish-pengguna.css', '/polish-landing.css', '/polish-dashboard.css', '/polish-gemini-kasir.css', '/polish-gemini-laporan.css', '/polish-gemini-produk.css', '/polish-gemini-shift.css', '/polish-gemini-pengguna.css', '/polish-gemini2-cart.css', '/polish-gemini2-fonts.css', '/polish-gemini2-pages.css', '/polish-gemini2-icons.css', '/polish-gemini-shell.css', '/polish-gemini2-shell.css', '/polish-gemini3-chrome.css', '/polish-gemini3-ops.css', '/polish-gemini3-produk.css', '/polish-gemini3-laporan.css', '/polish-gemini3-kasir.css', '/fastq-cart.png', '/sw.js',
  '/legacy/index.html', '/legacy/manifest.webmanifest', '/legacy/account.js', '/legacy/pos.js', '/legacy/pos-utils.mjs', '/legacy/pos-storage.mjs', '/legacy/report-utils.mjs', '/legacy/attendance-utils.mjs', '/legacy/shift-utils.mjs', '/legacy/cart-utils.mjs', '/legacy/sync-policy.js', '/legacy/sync-role-policy.mjs', '/legacy/polish.css', '/legacy/polish-extra.css', '/legacy/polish-kasir.css', '/legacy/polish-logo.css', '/legacy/polish-laporan.css', '/legacy/polish-produk.css', '/legacy/polish-shift.css', '/legacy/polish-pengguna.css', '/legacy/polish-landing.css', '/legacy/polish-dashboard.css', '/legacy/polish-gemini-kasir.css', '/legacy/polish-gemini-laporan.css', '/legacy/polish-gemini-produk.css', '/legacy/polish-gemini-shift.css', '/legacy/polish-gemini-pengguna.css', '/legacy/polish-gemini2-cart.css', '/legacy/polish-gemini2-fonts.css', '/legacy/polish-gemini2-pages.css', '/legacy/polish-gemini2-icons.css', '/legacy/polish-gemini-shell.css', '/legacy/polish-gemini2-shell.css', '/legacy/polish-gemini3-chrome.css', '/legacy/polish-gemini3-ops.css', '/legacy/polish-gemini3-produk.css', '/legacy/polish-gemini3-laporan.css', '/legacy/polish-gemini3-kasir.css', '/legacy/fastq-cart.png',
]);
const staticAssetPath = /^\/assets\/(?:[a-z0-9._-]+\/)*[a-z0-9._-]+\.(?:js|css|svg|ico|png|jpe?g|webp|woff2?)$/i;

export async function serveStaticFile(res, url, { staticRoot, staticBuildAvailable, securityHeaders, json }) {
  if (!staticBuildAvailable) return json(res, 503, { error: 'Build web tidak tersedia. Jalankan proses build sebelum menyajikan aplikasi.' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return res.writeHead(400, securityHeaders()).end('Bad Request'); }
  if (pathname.split('/').some(part => part.startsWith('.')) || pathname.includes('\\')) return res.writeHead(404, securityHeaders()).end('Not Found');
  const appRoute = !['/api', '/assets', '/legacy'].includes(pathname) && !pathname.startsWith('/api/') && !pathname.startsWith('/assets/') && !pathname.startsWith('/legacy/') && !extname(pathname);
  if (!appRoute && !staticFileAllowlist.has(pathname) && !staticAssetPath.test(pathname)) return res.writeHead(404, securityHeaders()).end('Not Found');
  const requested = pathname === '/' ? '/index.html' : pathname;
  let file = resolve(staticRoot, `.${requested}`);
  try { await access(file); } catch {
    if (!extname(pathname)) file = resolve(staticRoot, 'index.html');
    else return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end('Not Found');
  }
  const relativePath = relative(staticRoot, file);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return res.writeHead(403).end('Forbidden');
  let body = await readFile(file);
  const nonce = extname(file) === '.html' ? randomBytes(18).toString('base64') : '';
  if (nonce) body = Buffer.from(body.toString('utf8').replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`));
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] || 'application/octet-stream',
    ...securityHeaders(nonce),
    'Cache-Control': file.endsWith('index.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(body);
}
