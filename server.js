// Local dev server. No dependencies — plain Node.
//
//   node server.js          -> http://localhost:8787
//
// Serves the static site and runs the functions in api/ the way Vercel does,
// so the chat and the parcel check both work locally. Reads .env if present.
//
// This exists only for local work; in production Vercel serves the static
// files and runs api/*.js itself, and this file is never executed.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

try {
  const env = await readFile(join(ROOT, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  console.log('loaded .env');
} catch {
  console.log('no .env file — /api/chat will report a missing key');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Minimal stand-in for the Vercel request/response objects the handlers use. */
function adapt(req, res, url) {
  const query = Object.fromEntries(url.searchParams);
  const shim = {
    status(code) { res.statusCode = code; return shim; },
    setHeader(k, v) { res.setHeader(k, v); return shim; },
    json(body) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return shim; },
    write(chunk) { return res.write(chunk); },
    end(body) { res.end(body); return shim; },
  };
  return { query, shim };
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/[^\w-]/g, '');
    try {
      const mod = await import(new URL(`./api/${name}.js`, import.meta.url).href);
      const { query, shim } = adapt(req, res, url);
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await mod.default({ method: req.method, query, body, headers: req.headers }, shim);
    } catch (err) {
      console.error(`api/${name}:`, err.message);
      res.statusCode = err.code === 'ERR_MODULE_NOT_FOUND' ? 404 : 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: err.code === 'ERR_MODULE_NOT_FOUND' ? 'no such function' : 'handler threw' }));
    }
    return;
  }

  // Static. normalize() before joining keeps ../ out of the served path.
  if (pathname === '/') pathname = '/index.html';
  const file = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  try {
    const info = await stat(file);
    if (info.isDirectory()) throw new Error('directory');
    const data = await readFile(file);
    res.setHeader('content-type', TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`landev dev server -> http://localhost:${PORT}`);
});
