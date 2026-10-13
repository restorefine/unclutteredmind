/*
 * Passkeys (WebAuthn) without dependencies: Face ID, Touch ID, Windows Hello, Android, security keys.
 *
 * Only what this app needs: "none" attestation, ES256 and RS256 keys, user verification required.
 * Security rests on three checks: the browser-signed origin, the RP ID hash in the authenticator
 * data, and the signature made with the private key that never leaves the device.
 */
'use strict';
const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(String(s || ''), 'base64url');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest();

class WebAuthnError extends Error {}

/* ------------------------------------------------------------------ CBOR (decode only, the subset WebAuthn uses) */
function cborDecode(buf, offset = 0) {
  function readLen(info) {
    if (info < 24) return info;
    if (info === 24) return buf.readUInt8(offset++);
    if (info === 25) { const v = buf.readUInt16BE(offset); offset += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(offset); offset += 4; return v; }
    if (info === 27) { const v = Number(buf.readBigUInt64BE(offset)); offset += 8; return v; }
    throw new WebAuthnError('Unsupported CBOR length.');
  }
  function item(depth) {
    if (depth > 16) throw new WebAuthnError('CBOR nested too deeply.');
    if (offset >= buf.length) throw new WebAuthnError('CBOR ended early.');
    const first = buf.readUInt8(offset++);
    const major = first >> 5, info = first & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); if (offset + n > buf.length) throw new WebAuthnError('CBOR ended early.'); const v = buf.subarray(offset, offset + n); offset += n; return v; }
      case 3: { const n = readLen(info); if (offset + n > buf.length) throw new WebAuthnError('CBOR ended early.'); const v = buf.toString('utf8', offset, offset + n); offset += n; return v; }
      case 4: { const n = readLen(info); const a = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: { const n = readLen(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new WebAuthnError('Unsupported CBOR value.');
      default: throw new WebAuthnError('Unsupported CBOR type.');
    }
  }
  const value = item(0);
  return { value, offset };
}

/* ------------------------------------------------------------------ COSE key -> JWK */
function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    const x = cose.get(-2), y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new WebAuthnError('Bad EC key.');
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new WebAuthnError('Bad RSA key.');
    return { alg: -257, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  throw new WebAuthnError('This passkey type is not supported.');
}

/* ------------------------------------------------------------------ authenticator data */
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

function parseAuthData(buf, withCredential) {
  if (buf.length < 37) throw new WebAuthnError('Authenticator data too short.');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (withCredential) {
    if (!(out.flags & FLAG_AT)) throw new WebAuthnError('No credential in the response.');
    if (buf.length < 55) throw new WebAuthnError('Authenticator data too short.');
    const idLen = buf.readUInt16BE(53);
    if (idLen < 1 || idLen > 1023 || 55 + idLen > buf.length) throw new WebAuthnError('Bad credential id.');
    out.credentialId = buf.subarray(55, 55 + idLen);
    out.publicKey = cborDecode(buf, 55 + idLen).value;
    if (!(out.publicKey instanceof Map)) throw new WebAuthnError('Bad public key.');
  }
  return out;
}

function checkClientData(clientDataJSON, { type, challenge, origin }) {
  let cd;
  try { cd = JSON.parse(fromB64u(clientDataJSON).toString('utf8')); } catch (_) { throw new WebAuthnError('Bad client data.'); }
  if (cd.type !== type) throw new WebAuthnError('Wrong ceremony type.');
  if (cd.challenge !== challenge) throw new WebAuthnError('The sign-in request expired. Try again.');
  if (cd.origin !== origin) throw new WebAuthnError('This passkey was made for a different site.');
  if (cd.crossOrigin === true) throw new WebAuthnError('Cross-origin passkey use is not allowed.');
  return cd;
}

function checkAuthData(ad, rpId) {
  if (!crypto.timingSafeEqual(ad.rpIdHash, sha256(Buffer.from(rpId)))) throw new WebAuthnError('This passkey was made for a different site.');
  if (!(ad.flags & FLAG_UP)) throw new WebAuthnError('The passkey did not confirm you were present.');
  if (!(ad.flags & FLAG_UV)) throw new WebAuthnError('The passkey did not check Face ID, fingerprint or PIN.');
}

/* ------------------------------------------------------------------ ceremonies */
function newChallenge() { return b64u(crypto.randomBytes(32)); }

// Returns the credential to store.
function verifyRegistration(body, { challenge, origin, rpId }) {
  checkClientData(body.clientDataJSON, { type: 'webauthn.create', challenge, origin });
  let att;
  try { att = cborDecode(fromB64u(body.attestationObject)).value; } catch (e) { throw new WebAuthnError('Bad attestation.'); }
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new WebAuthnError('Bad attestation.');
  const ad = parseAuthData(att.get('authData'), true);
  checkAuthData(ad, rpId);
  const id = b64u(ad.credentialId);
  if (body.id && body.id !== id) throw new WebAuthnError('Credential id mismatch.');
  const { alg, jwk } = coseToJwk(ad.publicKey);
  return { id, alg, jwk, signCount: ad.signCount };
}

// Returns the new signature counter. Throws if anything is off.
function verifyAuthentication(body, cred, { challenge, origin, rpId }) {
  checkClientData(body.clientDataJSON, { type: 'webauthn.get', challenge, origin });
  const authData = fromB64u(body.authenticatorData);
  const ad = parseAuthData(authData, false);
  checkAuthData(ad, rpId);
  const signed = Buffer.concat([authData, sha256(fromB64u(body.clientDataJSON))]);
  const key = crypto.createPublicKey({ key: cred.jwk, format: 'jwk' });
  const sig = fromB64u(body.signature);
  const ok = cred.alg === -7
    ? crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, sig)
    : crypto.verify('sha256', signed, key, sig);
  if (!ok) throw new WebAuthnError('The passkey signature did not match.');
  // Most synced passkeys always report 0; only a counter that goes backwards means a cloned key.
  if (ad.signCount !== 0 && cred.signCount !== 0 && ad.signCount <= cred.signCount) throw new WebAuthnError('This passkey looks cloned. Remove it and add it again.');
  return ad.signCount;
}

module.exports = { newChallenge, verifyRegistration, verifyAuthentication, WebAuthnError, cborDecode, b64u };
