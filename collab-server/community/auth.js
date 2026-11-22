/**
 * Passwords, sign-in tokens and rate limits.
 *
 * - Passwords are never stored: only a salted scrypt hash.
 * - A sign-in gives the browser a random token; the server stores only the
 *   token's SHA-256, so a leaked database can't be used to sign in.
 * - Repeated sign-in attempts are slowed down per IP address and per nickname.
 */

'use strict';

const crypto = require('crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SESSION_DAYS = 30;

const scrypt = (password, salt, keyLength, options) => new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
});

const hashPassword = async password => {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, KEY_LENGTH, {N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P});
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
};

const verifyPassword = async (password, stored) => {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, keyB64] = parts;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p)
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
};

// Used when a nickname doesn't exist, so a wrong nickname takes as long as a
// wrong password (doesn't reveal which nicknames exist).
let dummyHash = null;
const dummyVerify = async password => {
    if (!dummyHash) dummyHash = await hashPassword('not-a-real-password');
    await verifyPassword(password, dummyHash);
    return false;
};

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = token => crypto.createHash('sha256').update(String(token))
    .digest('hex');
const sessionExpiry = now => now + (SESSION_DAYS * 24 * 60 * 60 * 1000);

/** Simple fixed-window counter: allows `limit` hits per key per window. */
class RateLimiter {
    constructor (limit, windowMs) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.hits = new Map();
    }

    hit (key) {
        const now = Date.now();
        let entry = this.hits.get(key);
        if (!entry || now - entry.start > this.windowMs) {
            entry = {start: now, count: 0};
            this.hits.set(key, entry);
        }
        entry.count++;
        if (this.hits.size > 10000) this.prune(now);
        return entry.count <= this.limit;
    }

    prune (now) {
        for (const [key, entry] of this.hits) {
            if (now - entry.start > this.windowMs) this.hits.delete(key);
        }
    }
}

module.exports = {
    hashPassword,
    verifyPassword,
    dummyVerify,
    newToken,
    hashToken,
    sessionExpiry,
    RateLimiter
};
