// Minimal static file server for E2E fixtures. Deliberately not using a
// third-party static-server package so we get exact control over
// Content-Length/Content-Type/Range handling, which some of the tests
// (size-threshold, the allow-rule-vs-CORS scenario) depend on.
//
// Two servers are started: PORT serves the fixtures as the "main" origin,
// and PORT + 1 serves the same fixtures as a second origin with no CORS
// headers at all - used to prove the click-to-load allow-rule approach
// works for cross-origin images that a fetch()+blob fallback would choke
// on (opaque response).
const http = require('http');
const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MAIN_PORT = Number(process.env.CTLI_FIXTURES_PORT || 8973);
const CROSS_ORIGIN_PORT = MAIN_PORT + 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8'
};

function serve(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(FIXTURES_DIR, safePath === '/' ? '/static.html' : safePath);

  if (!filePath.startsWith(FIXTURES_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const match = /bytes=(\d+)-(\d+)?/.exec(range);
      const start = match ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function start(port) {
  return new Promise((resolve) => {
    const server = http.createServer(serve);
    server.listen(port, () => resolve(server));
  });
}

async function startFixtureServers() {
  const main = await start(MAIN_PORT);
  const crossOrigin = await start(CROSS_ORIGIN_PORT);
  return {
    mainPort: MAIN_PORT,
    crossOriginPort: CROSS_ORIGIN_PORT,
    close: () => Promise.all([
      new Promise((r) => main.close(r)),
      new Promise((r) => crossOrigin.close(r))
    ])
  };
}

module.exports = { startFixtureServers, MAIN_PORT, CROSS_ORIGIN_PORT };

if (require.main === module) {
  startFixtureServers().then(({ mainPort, crossOriginPort }) => {
    console.log(`Fixture server listening on http://localhost:${mainPort} (main)`);
    console.log(`Fixture server listening on http://localhost:${crossOriginPort} (cross-origin)`);
  });
}
