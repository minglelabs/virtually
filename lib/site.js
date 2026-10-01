'use strict';

// The public pages (site/*.html): the landing page and the terms, privacy and
// refund pages, served without login at /about, /terms, /privacy and /refund
// (and their stylesheet at /site.css) so a visitor, or a payment provider's
// reviewer, can read them before signing in.

const fs = require('node:fs');
const path = require('node:path');

const SITE_DIR = path.join(__dirname, '..', 'site');
const HTML = 'text/html; charset=utf-8';

const ROUTES = new Map([
  ['/about', ['index.html', HTML]],
  ['/terms', ['terms.html', HTML]],
  ['/privacy', ['privacy.html', HTML]],
  ['/refund', ['refund.html', HTML]],
  ['/site.css', ['style.css', 'text/css; charset=utf-8']],
]);

function createSite({ dir = SITE_DIR } = {}) {
  const pages = new Map();
  for (const [pathname, [filename, mime]] of ROUTES) {
    pages.set(pathname, { body: fs.readFileSync(path.join(dir, filename)), mime });
  }

  // Returns true when the request was answered.
  function handle(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const page = pages.get(pathname);
    if (!page) return false;
    res.writeHead(200, {
      'Content-Type': page.mime,
      'Content-Length': page.body.length,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : page.body);
    return true;
  }

  return { handle };
}

module.exports = { createSite };
