import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.FOCUSTAB_PREVIEW_PORT || 5668);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid FOCUSTAB_PREVIEW_PORT');
await stat(path.join(root, 'index.html')).catch(() => {
  throw new Error('Run npm run build before preview');
});
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};
const server = http.createServer(async (req, res) => {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }
  if (![`${host}:${port}`, `localhost:${port}`].includes(req.headers.host)) {
    res.writeHead(403, headers);
    return res.end('Invalid Host');
  }
  try {
    const raw = new URL(req.url, `http://${host}:${port}`).pathname;
    const decoded = decodeURIComponent(raw);
    const file = path.resolve(root, '.' + (decoded === '/' ? '/index.html' : decoded));
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      /[\\\0]/.test(decoded)
    ) {
      res.writeHead(403, headers);
      return res.end('Forbidden');
    }
    const data = await readFile(file);
    res.writeHead(200, {
      ...headers,
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 400, headers);
    res.end('Not found');
  }
});
server.on('error', (error) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Reuse the existing preview or set FOCUSTAB_PREVIEW_PORT to another free port.`
      : `Preview failed: ${error.message}`
  );
  process.exitCode = 1;
});
server.listen(port, host, () =>
  console.log(
    `FocusTab UI preview: http://${host}:${port}/\nInterface preview only. Blocking and AI require the installed extension. No proxy to ActivityWatch, FocusCompanion, or NAS.`
  )
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
