// Serves demo/index.html on http://localhost:5179 so the extension can be tried without a social login.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 5179);
const html = readFileSync(new URL('../demo/index.html', import.meta.url));
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(port, '127.0.0.1', () => console.log(`demo feed: http://localhost:${port}`));
