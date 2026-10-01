'use strict';

// Activity log + admin routes (/api/admin/*), the owner of what users upload,
// the history of changes / broadcast switches / motion plays, the admin-only
// gate, the page's DOM-free helpers, and the welcome credits for a new sign-up.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const H = require('./helpers/billing-server');
const A = require('../public/admin-activity.js');
const { ActivityLog, GROUPS } = require('../lib/activity');

const readPublic = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const uploadPhoto = (ctx, cookie, pathname) => H.request(ctx, pathname, { method: 'POST', cookie, body: PNG });

test('admin routes: admins only; everyone else is 403 admin_only, signed out is 401', async t => {
  const ctx = await H.startApp(t);
  for (const route of ['/api/admin/overview', '/api/admin/library', '/api/admin/activity']) {
    assert.equal((await H.get(ctx, route)).status, 401, route);
    const alice = await H.signIn(ctx, H.ALICE);
    const denied = await H.get(ctx, route, alice);
    assert.equal(denied.status, 403, route);
    assert.equal(denied.json.code, 'admin_only');
  }
  const admin = await H.signIn(ctx, H.ADMIN);
  assert.equal((await H.get(ctx, '/api/admin/overview', admin)).status, 200);
});

test('who uploaded what: owners, and the history of a user\'s changes, broadcast switches and plays', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  const bob = await H.signIn(ctx, H.BOB);

  // Alice makes a character (with its base photo) and adds a photo; Bob renames it and puts a photo on air.
  let response = await uploadPhoto(ctx, alice, '/api/characters?name=%EB%AF%BC%ED%8A%B8&filename=a.png');
  assert.equal(response.status, 201, response.text);
  const character = response.json.character;
  const basePhotoId = character.basePhotoId;
  response = await uploadPhoto(ctx, alice, `/api/characters/${character.id}/photos?filename=b.png`);
  assert.equal(response.status, 201, response.text);
  const secondPhotoId = response.json.photo.id;
  response = await H.request(ctx, `/api/characters/${character.id}`, { method: 'PATCH', cookie: bob, body: { name: '레몬' } });
  assert.equal(response.status, 200, response.text);
  response = await H.request(ctx, '/api/active-photo', { method: 'PUT', cookie: bob, body: { photoId: secondPhotoId } });
  assert.equal(response.status, 200, response.text);
  // A failed change leaves no event.
  response = await H.request(ctx, '/api/active-photo', { method: 'PUT', cookie: bob, body: { photoId: 5 } });
  assert.ok(response.status >= 400);

  const library = (await H.get(ctx, '/api/admin/library', admin)).json;
  const row = library.characters.find(item => item.id === character.id);
  assert.equal(row.owner, H.ALICE.email);
  assert.equal(row.name, '레몬');
  assert.equal(row.photos.find(photo => photo.id === basePhotoId).owner, H.ALICE.email);
  assert.equal(row.photos.find(photo => photo.id === secondPhotoId).owner, H.ALICE.email);
  assert.equal(row.photos.find(photo => photo.id === secondPhotoId).onAir, true);

  const events = (await H.get(ctx, '/api/admin/activity', admin)).json.events;
  assert.deepEqual(events.map(event => event.type), ['onair.set', 'character.rename', 'photo.add', 'character.create']);
  assert.deepEqual(events.map(event => event.actor.email), [H.BOB.email, H.BOB.email, H.ALICE.email, H.ALICE.email]);
  assert.equal(events[1].from, '민트');
  assert.equal(events[0].characterName, '레몬');
  assert.equal(events[0].photoId, secondPhotoId);

  // Filters: by account, by group, paging by time.
  const bobOnly = (await H.get(ctx, `/api/admin/activity?email=${encodeURIComponent(H.BOB.email.toUpperCase())}`, admin)).json.events;
  assert.deepEqual(bobOnly.map(event => event.type), ['onair.set', 'character.rename']);
  const uploads = (await H.get(ctx, '/api/admin/activity?type=upload', admin)).json.events;
  assert.deepEqual(uploads.map(event => event.type), ['photo.add', 'character.create']);
  const older = (await H.get(ctx, `/api/admin/activity?limit=1&before=${encodeURIComponent(events[1].ts)}`, admin)).json.events;
  assert.ok(older.length <= 1 && older.every(event => event.ts < events[1].ts));

  // The overview counts per account.
  const users = (await H.get(ctx, '/api/admin/overview', admin)).json.users;
  const aliceRow = users.find(user => user.email === H.ALICE.email);
  assert.equal(aliceRow.counts.upload, 2);
  assert.equal(aliceRow.name, H.ALICE.name);
  assert.equal(users.find(user => user.email === H.BOB.email).counts.onair, 1);

  // Deleting is recorded with the name the character had.
  response = await H.request(ctx, `/api/characters/${character.id}`, { method: 'DELETE', cookie: alice });
  assert.equal(response.status, 200, response.text);
  const last = (await H.get(ctx, '/api/admin/activity?limit=1', admin)).json.events[0];
  assert.equal(last.type, 'character.delete');
  assert.equal(last.characterName, '레몬');
  assert.equal(last.actor.email, H.ALICE.email);
});

test('motion plays are recorded with who played what; reads and refused plays are not', async t => {
  const ctx = await H.startApp(t);
  const admin = await H.signIn(ctx, H.ADMIN);
  const alice = await H.signIn(ctx, H.ALICE);
  await H.get(ctx, '/api/library', alice);
  await H.get(ctx, '/api/characters', alice);
  const count = async () => (await H.get(ctx, '/api/admin/activity', admin)).json.events.length;
  assert.equal(await count(), 0);
  // An unknown motion is 404 and records nothing.
  assert.equal((await H.post(ctx, '/api/trigger', { id: 'nope' }, alice)).status, 404);
  assert.equal(await count(), 0);
  // Nothing on air: the demo avatar's motion plays.
  assert.equal((await H.post(ctx, '/api/trigger', { id: 'demo' }, alice)).status, 200);
  const [event] = (await H.get(ctx, '/api/admin/activity?type=play', admin)).json.events;
  assert.equal(event.type, 'motion.trigger');
  assert.equal(event.motionId, 'demo');
  assert.equal(event.actor.email, H.ALICE.email);
  assert.equal(event.photoId, null);
});

test('the log survives a restart, and a torn last line is skipped', async t => {
  const dir = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'virtually-activity-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const first = await new ActivityLog({ dir }).load();
  const access = { session: { sub: 's1', email: 'Alice@Example.com', name: 'Alice' } };
  first.record(access, 'character.create', { characterId: 'c1', characterName: '민트', photoId: 'p1' });
  first.record(null, 'motion.trigger', { motionId: 'm1', motionName: '인사' });
  await first.flush();
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"type":"photo.add","char');
  const second = await new ActivityLog({ dir }).load();
  assert.equal(second.events.length, 2);
  assert.equal(second.ownerOf('character', 'c1'), 'alice@example.com');
  assert.equal(second.ownerOf('photo', 'p1'), 'alice@example.com');
  assert.equal(second.ownerOf('character', 'nope'), null);
  assert.equal(second.nameOf('c1'), '민트');
  assert.equal(second.events[1].actor, null, 'a play without a login has no actor');
  assert.equal((fs.statSync(path.join(dir, 'events.jsonl')).mode & 0o777), 0o600);
  // Every event type belongs to one filter group.
  for (const types of Object.values(GROUPS)) for (const type of types) assert.ok(A.groupOf(type));
});

test('page helpers: event texts, owner and actor texts, query, errors', () => {
  const d = A.describeEvent({ type: 'character.create', characterName: '민트' });
  assert.deepEqual(d, { group: 'upload', kind: '올림', text: "캐릭터 '민트'을(를) 만들었습니다" });
  assert.equal(A.describeEvent({ type: 'onair.set', photoId: 'p', characterName: '민트' }).text, "'민트'을(를) 방송에 올렸습니다");
  assert.equal(A.describeEvent({ type: 'onair.set', photoId: null }).text, '방송을 내렸습니다');
  assert.equal(A.describeEvent({ type: 'motion.trigger', motionId: 'm', motionName: '인사', characterName: '민트' }).group, 'play');
  assert.match(A.describeEvent({ type: 'motion.trigger', motionId: 'demo' }).text, /데모/);
  assert.match(A.describeEvent({ type: 'job.create', characterName: '민트', routeLabel: 'Wan', drivingName: '인사', credits: 1200 }).text, /\(민트 · Wan · 인사\) · 1,200 크레딧/);
  assert.equal(A.describeEvent({ type: 'something.new' }).text, 'something.new');
  assert.equal(A.actorText({ actor: { email: 'a@b.c' } }), 'a@b.c');
  assert.equal(A.actorText({ actor: null }), '로그인 없음');
  assert.equal(A.ownerText(null), '기록 이전');
  assert.equal(A.ownerText('a@b.c'), 'a@b.c');
  assert.equal(A.eventsQuery({ type: 'play', email: ' A@B.C ', before: '2026-10-01T00:00:00.000Z', limit: 50 }), 'type=play&email=a%40b.c&before=2026-10-01T00%3A00%3A00.000Z&limit=50');
  assert.equal(A.eventsQuery(), 'limit=100');
  assert.equal(A.formatTime('nope'), '');
  assert.equal(A.jobStateText('succeeded'), '완료');
  assert.equal(A.errorText({ error: '관리자만 볼 수 있습니다.' }, 403), '관리자만 볼 수 있습니다.');
  assert.equal(A.errorText(null, 500), 'HTTP 500');
});

test('page wiring: admin-only page, three tabs, text via textContent only', () => {
  const html = readPublic('admin-activity.html');
  assert.match(html, /<title>활동 · 자료 · Virtually<\/title>/);
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map(m => m[1]), ['billing.css', 'admin.css', 'admin-activity.css', 'auth.css']);
  assert.deepEqual([...html.matchAll(/<script src="\/([^"]+)"><\/script>/g)].map(m => m[1]), ['auth.js', 'admin-activity.js']);
  for (const tab of ['users', 'library', 'events']) assert.match(html, new RegExp(`data-tab="${tab}"`));
  const js = readPublic('admin-activity.js');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /if \(typeof document !== 'undefined'\) \(\(\) => \{/);
  assert.match(readPublic('admin.html'), /<a href="\/admin\/activity" class="back-link">활동 · 자료<\/a>/);
});

test('welcome credits: a new sign-up gets 100 once; a returning user, a free account and 0 get none', async t => {
  const ctx = await H.startApp(t, { billing: { adminEmails: [H.ADMIN.email], freeEmails: [H.BOB.email], welcomeCredits: 100 } });
  const alice = await H.signIn(ctx, H.ALICE);
  let billing = (await H.billingOf(ctx, alice));
  assert.equal(billing.balance, 100);
  assert.deepEqual(billing.history.map(entry => [entry.kind, entry.delta, entry.label]), [['welcome', 100, '가입 환영 크레딧']]);
  // Asking again (or signing in again) does not repeat it.
  await H.billingOf(ctx, alice);
  const again = await H.signIn(ctx, H.ALICE);
  assert.equal((await H.billingOf(ctx, again)).balance, 100);
  // Free accounts are never charged and get no welcome credits.
  const bob = await H.signIn(ctx, H.BOB);
  assert.equal((await H.billingOf(ctx, bob)).balance, 0);

  // The default is 100 without the key; 0 turns it off; garbage is a config problem.
  await H.setBillingConfig(ctx, { adminEmails: [H.ADMIN.email], welcomeCredits: undefined });
  const carol = await H.signIn(ctx, { sub: '200000000000000000004', email: 'carol@example.com', name: 'Carol' });
  assert.equal((await H.billingOf(ctx, carol)).balance, 100, 'without the key the default is 100');
  await H.setBillingConfig(ctx, { adminEmails: [H.ADMIN.email], welcomeCredits: 0 });
  const dave = await H.signIn(ctx, { sub: '200000000000000000005', email: 'dave@example.com', name: 'Dave' });
  assert.equal((await H.billingOf(ctx, dave)).balance, 0);
  await H.setBillingConfig(ctx, { adminEmails: [H.ADMIN.email], welcomeCredits: -5 });
  const broken = (await H.billingOf(ctx, alice));
  assert.equal(broken.mode, 'invalid');
  assert.equal(broken.problem, 'bad_welcome_credits');
});

test('the welcome default is 100 in the config validator', () => {
  const { validateBillingConfig } = require('../lib/billing/config');
  assert.equal(validateBillingConfig({ adminEmails: ['a@b.c'] }).config.welcomeCredits, 100);
  assert.equal(validateBillingConfig({ adminEmails: ['a@b.c'], welcomeCredits: 0 }).config.welcomeCredits, 0);
  assert.equal(validateBillingConfig({ adminEmails: ['a@b.c'], welcomeCredits: 2.5 }).problem, 'bad_welcome_credits');
});
