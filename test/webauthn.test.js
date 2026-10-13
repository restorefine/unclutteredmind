'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const wa = require('../lib/webauthn.js');
const { createAuthenticator } = require('./fake-authenticator.js');

const site = { origin: 'https://app.example.com', rpId: 'app.example.com' };

for (const kind of ['ec', 'rsa']) {
  test(kind.toUpperCase() + ' passkey: register then sign in', () => {
    const a = createAuthenticator(kind);
    const c1 = wa.newChallenge();
    const cred = wa.verifyRegistration(a.register(Object.assign({ challenge: c1, userId: 'u' }, site)), Object.assign({ challenge: c1 }, site));
    assert.equal(cred.id, a.id);
    assert.equal(cred.alg, kind === 'ec' ? -7 : -257);
    const c2 = wa.newChallenge();
    assert.equal(wa.verifyAuthentication(a.sign(Object.assign({ challenge: c2 }, site)), cred, Object.assign({ challenge: c2 }, site)), 0);
  });
}

test('rejects the wrong site, a wrong challenge, no Face ID check, a bad signature and a cloned key', () => {
  const a = createAuthenticator('ec');
  const c = wa.newChallenge();
  const cred = wa.verifyRegistration(a.register(Object.assign({ challenge: c, userId: 'u' }, site)), Object.assign({ challenge: c }, site));
  const ok = Object.assign({ challenge: 'abc' }, site);
  const bad = (o, re) => assert.throws(() => wa.verifyAuthentication(a.sign(Object.assign({}, ok, o)), cred, ok), re);
  bad({ origin: 'https://evil.example' }, /different site/);
  bad({ rpId: 'evil.example' }, /different site/);
  bad({ challenge: 'other' }, /expired/);
  bad({ flags: 0x01 }, /Face ID/);
  bad({ tamper: true }, /signature/);
  assert.throws(() => wa.verifyRegistration(a.register(Object.assign({ challenge: c, userId: 'u', flags: 0x41 }, site)), Object.assign({ challenge: c }, site)), /Face ID/);
  cred.signCount = 10;
  bad({ counter: 5 }, /cloned/);
  assert.equal(wa.verifyAuthentication(a.sign(Object.assign({ counter: 11 }, ok)), cred, ok), 11);
});

test('rejects garbage without crashing', () => {
  const opts = Object.assign({ challenge: 'x' }, site);
  for (const body of [{}, { clientDataJSON: 'zz', attestationObject: 'zz' }, { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'x', origin: site.origin })).toString('base64url'), attestationObject: 'AAAA' }]) {
    assert.throws(() => wa.verifyRegistration(body, opts), wa.WebAuthnError);
  }
});
