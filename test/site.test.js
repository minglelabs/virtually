'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createAppServer } = require('../server');

const PAGES = ['/about', '/terms', '/privacy', '/refund'];

// Login is on, so everything but the public routes redirects to /login.
async function start() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-site-'));
  await fs.mkdir(path.join(dataDir, 'auth'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'auth', 'config.json'), JSON.stringify({
    google: { clientId: 'site-test.apps.googleusercontent.com', clientSecret: 'GOCSPX-site-test' },
    allowedEmails: ['owner@example.com'],
  }));
  const server = await createAppServer({ dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('the public pages open without a session and the app stays behind the login', async () => {
  const { server, base } = await start();
  try {
    for (const pathname of PAGES) {
      const response = await fetch(base + pathname, { redirect: 'manual' });
      assert.equal(response.status, 200, pathname);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      const html = await response.text();
      assert.ok(!html.includes('{{'), `${pathname} has a placeholder`);
      assert.ok(html.includes('namhk5741@gmail.com'), `${pathname} has no contact address`);
    }
    const terms = await (await fetch(`${base}/terms`)).text();
    assert.ok(terms.includes('the laws of the Republic of Korea'));

    const css = await fetch(`${base}/site.css`, { redirect: 'manual' });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /^text\/css/);

    const head = await fetch(`${base}/about`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const app = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(app.status, 302);
    assert.match(app.headers.get('location'), /^\/login/);
    const api = await fetch(`${base}/api/library`, { redirect: 'manual' });
    assert.equal(api.status, 401);

    const post = await fetch(`${base}/about`, { method: 'POST', redirect: 'manual' });
    assert.notEqual(post.status, 200);
  } finally {
    await stop(server);
  }
});
