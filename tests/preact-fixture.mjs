// Static, API-free fixture for preact.browser.js. Bind to a private interface
// reachable by the remote browser: node tests/preact-fixture.mjs HOST [PORT].
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../internal/planningui/static/', import.meta.url);
const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 18195);
createServer(async (request, response) => {
  try {
    let body;
    let type;
    if (request.url === '/') {
      type = 'text/html';
      body =
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Preact component tests</title></head><body><main id="content"><section id="fixture" class="panel workspace-gate"></section></main></body></html>';
    } else if (request.url === '/styles.css') {
      type = 'text/css';
      const files = (await readdir(new URL('styles/', root)))
        .filter((name) => name.endsWith('.css'))
        .sort();
      body = (
        await Promise.all(files.map((name) => readFile(new URL(`styles/${name}`, root), 'utf8')))
      ).join('\n');
    } else if (/^\/modules\/[a-z-]+\.js$/.test(request.url)) {
      type = 'text/javascript';
      body = await readFile(new URL(request.url.slice(1), root));
    } else {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'",
      })
      .end(body);
  } catch {
    response.writeHead(500).end();
  }
}).listen(port, host, () => console.log(`Preact fixture: http://${host}:${port}`));
