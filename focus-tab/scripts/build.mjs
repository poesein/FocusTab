import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcon } from './icons.mjs';
import { createHash, createPublicKey } from 'node:crypto';
import { validateEndpoint } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.resolve(root, 'dist');
// A personal LAN destination can be supplied at build time without publishing
// deployment-specific network metadata in the repository or CI artifacts.
const aiHost = validateEndpoint(process.env.FOCUSTAB_AI_HOST || 'http://127.0.0.1:11434');
const initialAction = process.env.FOCUSTAB_INITIAL_AI_ACTION || null;
if (initialAction && !['block', 'remind'].includes(initialAction))
  throw new Error('FOCUSTAB_INITIAL_AI_ACTION must be block or remind');
// Keep cleanup confined to this package's generated output.
if (path.dirname(out) !== path.resolve(root) || path.basename(out) !== 'dist')
  throw new Error('Unsafe output path');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(root, 'static'), out, { recursive: true });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
const publicDER = Buffer.from(manifest.key, 'base64');
createPublicKey({ key: publicDER, format: 'der', type: 'spki' });
const extensionId = [...createHash('sha256').update(publicDER).digest().subarray(0, 16)]
  .map((n) => String.fromCharCode(97 + (n >> 4), 97 + (n & 15)))
  .join('');
await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const shared = {
  absWorkingDir: root,
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: 'browser',
  target: ['chrome120'],
  charset: 'utf8',
  legalComments: 'linked',
  metafile: true,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    FOCUSTAB_AI_HOST: JSON.stringify(aiHost),
    FOCUSTAB_INITIAL_AI_ACTION: JSON.stringify(initialAction),
  },
};
const results = [];
for (const [entry, output, format] of [
  ['src/app.jsx', 'app.js', 'esm'],
  ['src/background.mjs', 'background.js', 'esm'],
  ['src/extractor.mjs', 'extractor.js', 'iife'],
]) {
  results.push(
    await build({
      ...shared,
      entryPoints: [entry],
      outfile: path.join(out, output),
      format,
      jsx: 'automatic',
      jsxImportSource: 'preact',
    })
  );
}
await cp(path.join(root, 'src/app.css'), path.join(out, 'app.css'));
await mkdir(path.join(out, 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128])
  await writeFile(path.join(out, 'icons', `icon-${size}.png`), makeIcon(size));

// Derive the license inventory from files actually included in the bundles.
const packages = new Map();
for (const result of results)
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll('\\', '/');
    const match = normalized.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (!match || packages.has(match[1])) continue;
    const dir = path.join(root, 'node_modules', match[1]);
    const metadata = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    packages.set(match[1], { dir, metadata });
  }
await mkdir(path.join(out, 'licenses'), { recursive: true });
await cp(path.join(root, '..', 'LICENSE'), path.join(out, 'LICENSE'));
await cp(path.join(root, 'README.md'), path.join(out, 'README.md'));
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(out, 'THIRD_PARTY_NOTICES.md'));
const inventory = [];
for (const [name, { dir, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const names = (await readdir(dir)).filter((n) =>
    /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(n)
  );
  if (!names.length) throw new Error(`Missing license text for bundled dependency ${name}`);
  const target = name.replaceAll('/', '__').replaceAll('@', '');
  await mkdir(path.join(out, 'licenses', target), { recursive: true });
  for (const name of names)
    await cp(path.join(dir, name), path.join(out, 'licenses', target, name));
  inventory.push({
    name,
    version: metadata.version,
    license: metadata.license,
    source: metadata.repository || metadata.homepage,
    licenseFiles: names.map((n) => `licenses/${target}/${n}`),
  });
}
await writeFile(
  path.join(out, 'licenses', 'inventory.json'),
  JSON.stringify(inventory, null, 2) + '\n'
);
console.log(
  `FocusTab ${pkg.version}: dist ready (${inventory.length} bundled dependencies; all license texts included).`
);
console.log(
  `Stable unpacked extension ID: ${extensionId}\nOllama allowed origin: chrome-extension://${extensionId}`
);
if (initialAction)
  console.log(
    `Personal build: one-time initial AI action = ${initialAction}; saved configuration will be backed up locally and later choices remain editable.`
  );
