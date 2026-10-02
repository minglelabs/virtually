'use strict';

// 다운로드: a transparent WebM comes as a MOV that keeps its alpha; an MP4 as it is.

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const { serveDownload, disposition } = require('../lib/download');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
let skip = false;
try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch { skip = 'ffmpeg is not installed'; }

test('disposition: an ASCII fallback and the UTF-8 name', () => {
  assert.equal(disposition('원영턴', '.mov'), `attachment; filename="_.mov"; filename*=UTF-8''${encodeURIComponent('원영턴.mov')}`);
  assert.equal(disposition('a/b"c', '.mp4'), `attachment; filename="a b c.mp4"; filename*=UTF-8''${encodeURIComponent('a b c.mp4')}`);
  assert.match(disposition('', '.mp4'), /filename="motion\.mp4"/);
});

test('serveDownload: WebM with alpha -> ProRes 4444 MOV with alpha; MP4 unchanged', { skip }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtually-download-'));
  const webm = path.join(dir, 'clip.webm');
  const mp4 = path.join(dir, 'clip.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "color=c=red:s=64x64:r=10,format=rgba,geq=r=255:g=0:b=0:a='255*lt(X,32)'",
    '-t', '1', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', webm], { stdio: 'ignore' });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64:r=10', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', mp4], { stdio: 'ignore' });
  const server = http.createServer((req, res) => {
    const isWebm = req.url === '/webm';
    serveDownload(req, res, { ffmpegPath: FFMPEG, srcPath: isWebm ? webm : mp4, mime: isWebm ? 'video/webm' : 'video/mp4', name: '원영턴' })
      .catch(error => { res.writeHead(500); res.end(error.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const mov = await fetch(`${base}/webm`);
    assert.equal(mov.status, 200);
    assert.equal(mov.headers.get('content-type'), 'video/quicktime');
    assert.match(mov.headers.get('content-disposition'), /filename\*=UTF-8''%EC%9B%90%EC%98%81%ED%84%B4\.mov/);
    const saved = path.join(dir, 'out.mov');
    await fs.writeFile(saved, Buffer.from(await mov.arrayBuffer()));
    const probe = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv=p=0', saved]).toString().trim();
    assert.match(probe, /^prores,yuva444p/, probe);

    const plain = await fetch(`${base}/mp4`);
    assert.equal(plain.headers.get('content-type'), 'video/mp4');
    assert.match(plain.headers.get('content-disposition'), /\.mp4$/);
    assert.deepEqual(Buffer.from(await plain.arrayBuffer()), await fs.readFile(mp4));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
