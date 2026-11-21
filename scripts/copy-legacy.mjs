import { mkdir, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await rm('public', { recursive: true, force: true });
await mkdir('public/legacy', { recursive: true });
await mkdir('public', { recursive: true });
let html = await readFile('index.html', 'utf8');
const [styleSource, workerSource] = await Promise.all([readFile('polish.css'), readFile('sw.js', 'utf8')]);
const posModules = (await readdir('legacy-scripts/pos'))
  .filter(name => name.endsWith('.js'))
  .sort();
if (!posModules.length) throw new Error('No POS source modules found');
const posScript = (await Promise.all(posModules.map(name => readFile(`legacy-scripts/pos/${name}`, 'utf8')))).join('');
const styleVersion = createHash('sha256').update(styleSource).update(workerSource).update(posScript).digest('hex').slice(0, 12);
for (const page of ['pos', 'products', 'shift', 'attendance', 'reports', 'outlets', 'users']) {
  const marker = `    <!-- PAGE:${page} -->`;
  if (!html.includes(marker)) throw new Error(`Missing page marker: ${page}`);
  html = html.replace(marker, await readFile(`legacy-pages/${page}.html`, 'utf8'));
}
if (html.includes('<!-- PAGE:')) throw new Error('Unresolved legacy page marker');
if (!html.includes('href="./polish.css"')) throw new Error('Missing POS stylesheet link');
if (!html.includes('src="./pos.js"')) throw new Error('Missing POS script link');
html = html
  .replaceAll('href="./polish.css"', `href="./polish.css?v=${styleVersion}"`)
  .replaceAll('src="./pos.js"', `src="./pos.js?v=${styleVersion}"`);
const legacyHtml = html
  .replaceAll('./fastq-mark.png', '../fastq-mark.png')
  .replaceAll('./fastq-icon-192.png', '../fastq-icon-192.png')
  .replaceAll('./fastq-icon-512.png', '../fastq-icon-512.png')
  .replaceAll('./icon.svg', '../icon.svg')
  .replaceAll('./favicon.ico', '../favicon.ico');
const versionedWorker = workerSource
  .replace(/const CACHE='fastq-pos-app-[^']+';/, `const CACHE='fastq-pos-app-${styleVersion}';`)
  .replace("'./legacy/polish.css'", `'./legacy/polish.css?v=${styleVersion}'`);
if (versionedWorker === workerSource || !versionedWorker.includes(`./legacy/polish.css?v=${styleVersion}`)) {
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
  ...['pos-utils.mjs', 'pos-storage.mjs', 'report-utils.mjs', 'attendance-utils.mjs', 'shift-utils.mjs', 'cart-utils.mjs', 'sync-policy.js', 'sync-role-policy.mjs', 'polish.css'].map(name => Promise.all([
    copyFile(name, `public/${name}`),
    copyFile(name, `public/legacy/${name}`),
  ])),
]);
const legacyManifest = (await readFile('manifest.webmanifest', 'utf8'))
  .replaceAll('./fastq-icon-192.png', '../fastq-icon-192.png')
  .replaceAll('./fastq-icon-512.png', '../fastq-icon-512.png');
await writeFile('public/legacy/manifest.webmanifest', legacyManifest);
for (const name of ['fastq-mark.png', 'fastq-icon-192.png', 'fastq-icon-512.png', 'favicon.ico']) {
  await copyFile(`assets/branding/${name}`, `public/${name}`);
}
for (const name of ['icon.svg', 'fast-logo.png', 'fastq-mark.png', 'fastq-icon-192.png', 'fastq-icon-512.png', 'favicon.ico']) {
  await rm(`public/legacy/${name}`, { force: true });
}
await rm('public/fast-logo.png', { force: true });
