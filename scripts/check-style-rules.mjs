import { readFile } from 'node:fs/promises';

const files = [
  'app/pos/index.html',
  'app/pos/runtime.js',
  'app/src/pages/OwnerDashboard.tsx',
  'README.md',
];
const violations = [];

for (const file of files) {
  const content = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  if (content.includes('·')) violations.push(`${file}: middle-dot separator`);
  if (
    /class\s*=\s*["'][^"']*(?:h-[0-3](?:\.\d+)?\s+w-[0-3](?:\.\d+)?|w-[0-3](?:\.\d+)?\s+h-[0-3](?:\.\d+)?)[^"']*rounded-full/i.test(
      content,
    )
  )
    violations.push(`${file}: small circular status indicator`);
  if (
    /<(?:span|p)[^>]*class=["'][^"']*rounded-(?:md|full)[^"']*bg-[^"']*text-\[(?:9|10|11)px\]/i.test(
      content,
    )
  )
    violations.push(`${file}: compact pill badge`);
  if (file.endsWith('.md') && /<img\b[^>]*shields\.io/i.test(content))
    violations.push(`${file}: external Shields badge image`);
}

if (violations.length) {
  console.error(`Style rules failed:\n${violations.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Style rules passed.');
}
