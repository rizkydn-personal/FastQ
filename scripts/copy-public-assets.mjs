import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const publicDirectory = 'public';
const serviceWorkerPath = 'sw.js';
const appSources = [
  'app/pos/index.html',
  'styles/design-system.css',
  'styles/shared/pos-fonts.css',
  'app/pos/runtime.js',
  'shared/pos-storage.mjs',
  'shared/pos-utils.mjs',
  'shared/cart-utils.mjs',
  'shared/sale-policy.mjs',
  'shared/shift-utils.mjs',
  'shared/sync-policy.js',
  'shared/sync-role-policy.mjs',
  'assets/fonts/inter.woff2',
  'assets/fonts/plus-jakarta-sans.woff2',
];
const stylesheetCopies = [
  ['styles/shell/landing.css', 'landing.css'],
  ['styles/shell/shell-theme.css', 'shell-theme.css'],
  ['styles/shell/typography.css', 'typography.css'],
  ['styles/shell/shell-layout.css', 'shell-layout.css'],
];
const publicFileCopies = [
  ['app/pos/index.html', 'pos.html'],
  ['app/pos/runtime.js', 'pos-runtime.js'],
  ['shared/pos-storage.mjs', 'pos-storage.mjs'],
  ['shared/pos-utils.mjs', 'pos-utils.mjs'],
  ['shared/cart-utils.mjs', 'cart-utils.mjs'],
  ['shared/sale-policy.mjs', 'sale-policy.mjs'],
  ['shared/shift-utils.mjs', 'shift-utils.mjs'],
  ['shared/sync-policy.js', 'sync-policy.js'],
  ['shared/sync-role-policy.mjs', 'sync-role-policy.mjs'],
  ['icon.svg', 'icon.svg'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
];
const brandAssets = [
  'fastq-mark.png',
  'fastq-icon-192.png',
  'fastq-icon-512.png',
  'favicon.ico',
  'fastq-cart.png',
];
const fontAssets = ['inter.woff2', 'plus-jakarta-sans.woff2'];
const iconStyles = ['duotone', 'bold', 'regular', 'fill'];

async function resetPublicDirectory() {
  await rm(publicDirectory, { recursive: true, force: true });
  await Promise.all([
    mkdir(`${publicDirectory}/vendor`, { recursive: true }),
    mkdir(`${publicDirectory}/assets/fonts`, { recursive: true }),
  ]);
}

async function createVersionedServiceWorker() {
  const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
  const sourceContents = await Promise.all(
    [...appSources, ...stylesheetCopies.map(([source]) => source)].map((path) => readFile(path)),
  );
  const versionHash = createHash('sha256').update(serviceWorker);
  sourceContents.forEach((source) => versionHash.update(source));

  const version = versionHash.digest('hex').slice(0, 12);
  const versionedServiceWorker = serviceWorker.replace(
    /const\s+CACHE\s*=\s*'fastq-pos-app-[^']+';/,
    `const CACHE='fastq-pos-app-${version}';`,
  );

  if (versionedServiceWorker === serviceWorker) {
    throw new Error('Could not update the app service worker cache version');
  }

  return versionedServiceWorker;
}

async function copyIconStyles() {
  await Promise.all(
    iconStyles.flatMap((style) => {
      const fontName =
        style === 'regular' ? 'Phosphor' : `Phosphor-${style[0].toUpperCase()}${style.slice(1)}`;

      return [
        copyFile(
          `node_modules/@phosphor-icons/web/src/${style}/style.css`,
          `${publicDirectory}/vendor/phosphor-${style}.css`,
        ),
        copyFile(
          `node_modules/@phosphor-icons/web/src/${style}/${fontName}.woff2`,
          `${publicDirectory}/vendor/${fontName}.woff2`,
        ),
      ];
    }),
  );
}

async function copyPublicAssets(versionedServiceWorker) {
  await Promise.all([
    ...publicFileCopies.map(([source, output]) => copyFile(source, `${publicDirectory}/${output}`)),
    ...stylesheetCopies.map(([source, output]) => copyFile(source, `${publicDirectory}/${output}`)),
    ...brandAssets.map((name) => copyFile(`assets/branding/${name}`, `${publicDirectory}/${name}`)),
    ...fontAssets.map((name) =>
      copyFile(`assets/fonts/${name}`, `${publicDirectory}/assets/fonts/${name}`),
    ),
    copyFile('styles/shared/pos-fonts.css', `${publicDirectory}/pos-fonts.css`),
    writeFile(`${publicDirectory}/sw.js`, versionedServiceWorker),
    copyIconStyles(),
  ]);
}

await resetPublicDirectory();
await copyPublicAssets(await createVersionedServiceWorker());
