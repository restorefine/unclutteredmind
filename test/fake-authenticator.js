'use strict';
// A software passkey for tests: does what Face ID / Touch ID would, with a key in memory.
const crypto = require('crypto');

const b64u = b => Buffer.from(b).toString('base64url');
const sha256 = b => crypto.createHash('sha256').update(b).digest();

function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([(major << 5) | 26]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; })()]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

function createAuthenticator(kind) {
  const rsa = kind === 'rsa';
  const { privateKey, publicKey } = rsa
    ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = rsa
    ? new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const credId = crypto.randomBytes(16);
  const userHandle = { value: null };
  let counter = 0;

  function authData(rpId, flags, extra) {
    const c = Buffer.alloc(4); c.writeUInt32BE(counter);
    return Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), c, extra || Buffer.alloc(0)]);
  }

  return {
    id: b64u(credId),
    // opts: { challenge, rpId, origin, userId, flags }
    register(o) {
      userHandle.value = o.userId;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin: o.origin }));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const ad = authData(o.rpId, o.flags == null ? 0x45 : o.flags, Buffer.concat([Buffer.alloc(16), len, credId, cbor(cose)]));
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
      return { id: b64u(credId), clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] };
    },
    // opts: { challenge, rpId, origin, flags, tamper, counter }
    sign(o) {
      if (o.counter != null) counter = o.counter;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin: o.origin }));
      const ad = authData(o.rpId, o.flags == null ? 0x05 : o.flags);
      let signature = crypto.sign('sha256', Buffer.concat([ad, sha256(clientDataJSON)]), privateKey);
      if (o.tamper) signature = Buffer.from(signature.map((b, i) => (i === signature.length - 1 ? b ^ 1 : b)));
      return { id: b64u(credId), clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(ad), signature: b64u(signature), userHandle: userHandle.value };
    }
  };
}

module.exports = { createAuthenticator };
