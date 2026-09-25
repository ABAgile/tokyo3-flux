// Test-only bridge for tests/run-browser.sh. Demo mode answers loopback Host
// headers only, so a browser on another machine or container reaches it through
// this proxy, which rewrites Host, Origin, Referer and Location to the loopback
// origin. It binds to the given address only and lives as long as one test run.
// Usage: node tests/browser-proxy.mjs <listen-host> <listen-port> <target-port>
import http from 'node:http';

const [listenHost, listenPort, targetPort] = process.argv.slice(2);
if (!listenHost || !Number(listenPort) || !Number(targetPort)) {
  console.error('usage: node tests/browser-proxy.mjs <listen-host> <listen-port> <target-port>');
  process.exit(2);
}
const target = { host: '127.0.0.1', port: Number(targetPort) };
const targetOrigin = `http://${target.host}:${target.port}`;
const publicOrigin = `http://${listenHost}:${listenPort}`;

http
  .createServer((req, res) => {
    const headers = { ...req.headers, host: `${target.host}:${target.port}` };
    for (const name of ['origin', 'referer']) {
      if (headers[name]) headers[name] = headers[name].replace(publicOrigin, targetOrigin);
    }
    const upstream = http.request(
      { ...target, method: req.method, path: req.url, headers },
      (response) => {
        const out = { ...response.headers };
        if (out.location) out.location = out.location.replace(targetOrigin, publicOrigin);
        res.writeHead(response.statusCode, out);
        response.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      res.writeHead(502);
      res.end(String(error));
    });
    req.pipe(upstream);
  })
  .listen(Number(listenPort), listenHost);
