'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

/* ---------- passwords (scrypt, built into Node: nothing to install) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

/* A hash to burn time on when the account does not exist, so response time doesn't reveal which accounts exist. */
let dummyHashPromise = null;
function dummyVerify(password) {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('not-a-real-password');
  return dummyHashPromise.then((h) => verifyPassword(password, h)).then(() => false);
}

/* ---------- session tokens ---------- */
// The browser gets a random token. Only its SHA-256 hash is stored, so a leaked database cannot be used to log in.
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------- rate limiting (in memory; fine for a single free-tier instance) ---------- */
function createRateLimiter() {
  const buckets = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  }, 60 * 1000).unref();
  return {
    /** Returns true when the action is allowed, false when the caller has hit the limit. */
    hit(key, max, windowMs) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
      b.count++;
      return b.count <= max;
    },
    /** Forget a key (used after a successful login). */
    clear(key) { buckets.delete(key); },
    reset() { buckets.clear(); }
  };
}

module.exports = { hashPassword, verifyPassword, dummyVerify, sha256, newToken, safeEqual, createRateLimiter };
