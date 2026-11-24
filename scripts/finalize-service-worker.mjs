import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const distRoot = path.resolve('dist');
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(absolute) : [absolute];
    }),
  );
  return nested.flat();
}

const files = (await listFiles(distRoot)).filter((file) => path.basename(file) !== 'sw.js');
const manifest = [];
const hash = createHash('sha256');
for (const file of files) {
  const relative = `./${path.relative(distRoot, file).split(path.sep).join('/')}`;
  const contents = await readFile(file);
  manifest.push(relative);
  hash.update(relative).update(contents);
}
const version = hash.digest('hex').slice(0, 12);
for (const file of [path.resolve('public/sw.js'), path.join(distRoot, 'sw.js')]) {
  let source = await readFile(file, 'utf8');
  source = source.replace(
    /const\s+CACHE\s*=\s*'fastq-pos-app-[^']+';/,
    `const CACHE='fastq-pos-app-${version}';`,
  );
  source = source.replace(
    /const\s+BUILD_ASSETS\s*=\s*\[[\s\S]*?\];/,
    `const BUILD_ASSETS=${JSON.stringify(manifest)};`,
  );
  await writeFile(file, source);
}
