'use strict';

// POLAR_ACCESS_TOKEN and POLAR_WEBHOOK_SECRET fill in a billing config that has no polar object.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withPolarEnv } = require('../lib/billing/config');

test('withPolarEnv: both variables are needed; the config\'s own polar object wins', () => {
  const text = JSON.stringify({ adminEmails: ['a@b.co'] });
  assert.equal(withPolarEnv(text, {}), text);
  assert.equal(withPolarEnv(text, { POLAR_ACCESS_TOKEN: 'polar_oat_x' }), text);
  const env = { POLAR_ACCESS_TOKEN: ' polar_oat_x ', POLAR_WEBHOOK_SECRET: 'whsec_abcdefghijklmnop' };
  assert.deepEqual(JSON.parse(withPolarEnv(text, env)).polar, { server: 'production', accessToken: 'polar_oat_x', webhookSecret: 'whsec_abcdefghijklmnop' });
  assert.equal(JSON.parse(withPolarEnv(text, { ...env, POLAR_SERVER: 'sandbox' })).polar.server, 'sandbox');
  const own = JSON.stringify({ adminEmails: ['a@b.co'], polar: { server: 'sandbox' } });
  assert.equal(withPolarEnv(own, env), own);
  assert.equal(withPolarEnv('not json', env), 'not json');
});
