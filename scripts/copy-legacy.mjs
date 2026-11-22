import { mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await rm('public', { recursive: true, force: true });
await mkdir('public/legacy', { recursive: true });
await mkdir('public', { recursive: true });
let html = await readFile('index.html', 'utf8');
const posStyles = ['polish-kasir.css', 'polish-logo.css', 'polish-laporan.css', 'polish-produk.css', 'polish-shift.css', 'polish-pengguna.css', 'polish-gemini-kasir.css', 'polish-gemini-laporan.css', 'polish-gemini-produk.css', 'polish-gemini-shift.css', 'polish-gemini-pengguna.css', 'polish-gemini2-cart.css', 'polish-gemini2-fonts.css', 'polish-gemini2-pages.css', 'polish-gemini2-icons.css', 'polish-gemini3-chrome.css', 'polish-gemini3-ops.css', 'polish-gemini3-produk.css', 'polish-gemini3-laporan.css', 'polish-gemini3-kasir.css'];
const shellStyles = ['polish-landing.css', 'polish-dashboard.css', 'polish-gemini-shell.css', 'polish-gemini2-shell.css'];
const [styleSource, extraStyleSource, workerSource, ...extraStyleSources] = await Promise.all([readFile('polish.css'), readFile('polish-extra.css'), readFile('sw.js', 'utf8'), ...posStyles.map(name => readFile(name)), ...shellStyles.map(name => readFile(name))]);
const posModules = (await readdir('legacy-scripts/pos'))
  .filter(name => name.endsWith('.js'))
  .sort();
if (!posModules.length) throw new Error('No POS source modules found');
const posScript = (await Promise.all(posModules.map(name => readFile(`legacy-scripts/pos/${name}`, 'utf8')))).join('');
const styleHash = createHash('sha256').update(styleSource).update(extraStyleSource).update(workerSource).update(posScript);
for (const source of extraStyleSources) styleHash.update(source);
const styleVersion = styleHash.digest('hex').slice(0, 12);
for (const page of ['pos', 'products', 'shift', 'attendance', 'reports', 'outlets', 'users']) {
  const marker = `    <!-- PAGE:${page} -->`;
  if (!html.includes(marker)) throw new Error(`Missing page marker: ${page}`);
  html = html.replace(marker, await readFile(`legacy-pages/${page}.html`, 'utf8'));
}
if (html.includes('<!-- PAGE:')) throw new Error('Unresolved legacy page marker');
if (!html.includes('href="./polish.css"')) throw new Error('Missing POS stylesheet link');
if (!html.includes('href="./polish-extra.css"')) throw new Error('Missing POS extra stylesheet link');
for (const name of posStyles) {
  if (!html.includes(`href="./${name}"`)) throw new Error(`Missing POS stylesheet link: ${name}`);
}
if (!html.includes('src="./pos.js"')) throw new Error('Missing POS script link');
html = html
  .replaceAll('href="./polish.css"', `href="./polish.css?v=${styleVersion}"`)
  .replaceAll('href="./polish-extra.css"', `href="./polish-extra.css?v=${styleVersion}"`)
  .replaceAll('src="./pos.js"', `src="./pos.js?v=${styleVersion}"`);
for (const name of posStyles) {
  html = html.replaceAll(`href="./${name}"`, `href="./${name}?v=${styleVersion}"`);
}
const legacyHtml = html
  .replaceAll('./fastq-mark.png', '../fastq-mark.png')
  .replaceAll('./fastq-icon-192.png', '../fastq-icon-192.png')
  .replaceAll('./fastq-icon-512.png', '../fastq-icon-512.png')
  .replaceAll('./icon.svg', '../icon.svg')
  .replaceAll('./favicon.ico', '../favicon.ico');
let versionedWorker = workerSource
  .replace(/const CACHE='fastq-pos-app-[^']+';/, `const CACHE='fastq-pos-app-${styleVersion}';`)
  .replace("'./legacy/polish.css'", `'./legacy/polish.css?v=${styleVersion}'`)
  .replace("'./legacy/polish-extra.css'", `'./legacy/polish-extra.css?v=${styleVersion}'`);
for (const name of posStyles) {
  versionedWorker = versionedWorker.replace(`'./legacy/${name}'`, `'./legacy/${name}?v=${styleVersion}'`);
}
if (versionedWorker === workerSource || !versionedWorker.includes(`./legacy/polish.css?v=${styleVersion}`) || !versionedWorker.includes(`./legacy/polish-extra.css?v=${styleVersion}`) || !posStyles.every(name => versionedWorker.includes(`./legacy/${name}?v=${styleVersion}`))) {
  throw new Error('Could not version the service-worker cache and POS stylesheet');
}
await Promise.all([
  writeFile('public/index.html', html),
  writeFile('public/legacy/index.html', legacyHtml),
  writeFile('public/pos.js', posScript),
  writeFile('public/legacy/pos.js', posScript),
]);
await Promise.all([
  copyFile('icon.svg', 'public/icon.svg'),
  copyFile('manifest.webmanifest', 'public/manifest.webmanifest'),
  writeFile('public/sw.js', versionedWorker),
  copyFile('account.js', 'public/account.js'),
  copyFile('account.js', 'public/legacy/account.js'),
  ...['pos-utils.mjs', 'pos-storage.mjs', 'report-utils.mjs', 'attendance-utils.mjs', 'shift-utils.mjs', 'cart-utils.mjs', 'sync-policy.js', 'sync-role-policy.mjs', 'polish.css', 'polish-extra.css', ...posStyles, ...shellStyles].map(name => Promise.all([
    copyFile(name, `public/${name}`),
    copyFile(name, `public/legacy/${name}`),
  ])),
]);
const legacyManifest = (await readFile('manifest.webmanifest', 'utf8'))
  .replaceAll('./fastq-icon-192.png', '../fastq-icon-192.png')
  .replaceAll('./fastq-icon-512.png', '../fastq-icon-512.png');
await writeFile('public/legacy/manifest.webmanifest', legacyManifest);
for (const name of ['fastq-mark.png', 'fastq-icon-192.png', 'fastq-icon-512.png', 'favicon.ico', 'fastq-cart.png']) {
  await copyFile(`assets/branding/${name}`, `public/${name}`);
}
// polish-logo.css memakai ./fastq-cart.png relatif terhadap file CSS-nya,
// jadi salinan legacy butuh PNG yang sama di public/legacy/.
await copyFile('assets/branding/fastq-cart.png', 'public/legacy/fastq-cart.png');
// Font lokal Gemini (Inter + Plus Jakarta Sans) — @font-face di
// polish-gemini2-fonts.css memakai ../assets/fonts/... relatif terhadap
// file CSS-nya, jadi font harus ada di public/assets/fonts/ (dan salinan
// legacy untuk jaga-jaga).
await mkdir('public/assets/fonts', { recursive: true });
await mkdir('public/legacy/assets/fonts', { recursive: true });
for (const name of ['inter-400.woff2', 'inter-500.woff2', 'inter-600.woff2', 'inter-700.woff2', 'plus-jakarta-sans-600.woff2', 'plus-jakarta-sans-700.woff2', 'plus-jakarta-sans-800.woff2']) {
  await copyFile(`assets/fonts/${name}`, `public/assets/fonts/${name}`);
  await copyFile(`assets/fonts/${name}`, `public/legacy/assets/fonts/${name}`);
}
for (const name of ['icon.svg', 'fast-logo.png', 'fastq-mark.png', 'fastq-icon-192.png', 'fastq-icon-512.png', 'favicon.ico']) {
  await rm(`public/legacy/${name}`, { force: true });
}
await rm('public/fast-logo.png', { force: true });
