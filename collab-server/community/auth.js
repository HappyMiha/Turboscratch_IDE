/**
 * Passwords, sign-in tokens and rate limits.
 *
 * - Passwords are never stored: only a salted scrypt hash.
 * - A sign-in gives the browser a random token; the server stores only the
 *   token's SHA-256, so a leaked database can't be used to sign in.
 * - Repeated failed sign-ins are slowed down per nickname+address, with a
 *   higher limit per nickname, so nobody can lock someone else out easily.
 */

'use strict';

const crypto = require('crypto');
const net = require('net');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

// Passwords people (and password-guessing scripts) try first.
const COMMON_PASSWORDS = new Set([
    '12345678', '123456789', '1234567890', 'password', 'password1', 'password123', 'qwertyuiop', 'qwerty123',
    '11111111', '00000000', '12341234', '87654321', 'iloveyou', 'abcd1234', 'abc12345', 'football', 'baseball',
    'sunshine', 'princess', 'starwars', 'whatever', 'trustno1', 'superman', 'pokemon1', 'minecraft', 'scratch1',
    'scratchcat', 'turbowarp', 'turboscratch', 'letmein1', 'welcome1', 'asdfghjk', 'zxcvbnm1', 'qwertyui',
    '1q2w3e4r', '1qaz2wsx', 'aaaaaaaa', 'passw0rd', 'monkey12', 'dragon12'
]);

const passwordProblem = (password, nickname) => {
    if (password.length < MIN_PASSWORD) return `Passwords need at least ${MIN_PASSWORD} characters`;
    if (password.length > 200) return 'That password is too long';
    const lower = password.toLowerCase();
    if (lower === String(nickname).toLowerCase() || lower.includes(String(nickname).toLowerCase())) {
        return 'Your password can\'t contain your nickname';
    }
    if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password) || /^(0123456789|123456789|abcdefgh)/.test(lower)) {
        return 'That password is too easy to guess. Try a few words together, like "purple-rocket-pizza"';
    }
    return null;
};

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

/**
 * The visitor's address. Behind a hosting proxy (Render sets RENDER=true) the
 * real address is the entry the proxy itself appended to X-Forwarded-For, i.e.
 * the last one; anything before it was sent by the visitor and can be faked.
 * TRUSTED_PROXY_HOPS overrides how many proxies to trust (0 = ignore the header).
 */
const TRUSTED_PROXY_HOPS = process.env.TRUSTED_PROXY_HOPS !== undefined ?
    Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS) || 0) :
    (process.env.RENDER ? 1 : 0);

const clientIp = req => {
    const socketIp = req.socket.remoteAddress || 'unknown';
    if (TRUSTED_PROXY_HOPS === 0) return socketIp;
    const header = req.headers['x-forwarded-for'];
    if (typeof header !== 'string' || header.length > 2000) return socketIp;
    const entries = header.split(',').map(s => s.trim());
    const candidate = entries[entries.length - TRUSTED_PROXY_HOPS];
    return candidate && net.isIP(candidate) ? candidate : socketIp;
};

const MAX_LIMITER_KEYS = 50000;

/**
 * Fixed-window counters. Keys are hashed (so attacker-chosen keys can't use
 * lots of memory), expired windows are cleared on a timer, and the oldest
 * entries are dropped if there are ever too many.
 */
class RateLimiter {
    constructor (limit, windowMs) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.hits = new Map();
        this.timer = setInterval(() => this.prune(Date.now()), windowMs);
        this.timer.unref();
    }

    key (raw) {
        const text = String(raw);
        return text.length <= 64 ? text : crypto.createHash('sha256').update(text)
            .digest('base64');
    }

    entry (raw, create) {
        const key = this.key(raw);
        const now = Date.now();
        let entry = this.hits.get(key);
        if (entry && now - entry.start > this.windowMs) {
            this.hits.delete(key);
            entry = null;
        }
        if (!entry && create) {
            if (this.hits.size >= MAX_LIMITER_KEYS) {
                // Map keeps insertion order: drop the oldest.
                this.hits.delete(this.hits.keys().next().value);
            }
            entry = {start: now, count: 0};
            this.hits.set(key, entry);
        }
        return entry;
    }

    /** Counts a hit; false once the limit is passed. */
    hit (raw) {
        const entry = this.entry(raw, true);
        entry.count++;
        return entry.count <= this.limit;
    }

    /** True if `raw` already used up its allowance (doesn't count a hit). */
    blocked (raw) {
        const entry = this.entry(raw, false);
        return !!entry && entry.count >= this.limit;
    }

    reset (raw) {
        this.hits.delete(this.key(raw));
    }

    prune (now) {
        for (const [key, entry] of this.hits) {
            if (now - entry.start > this.windowMs) this.hits.delete(key);
        }
    }
}

module.exports = {
    MIN_PASSWORD,
    passwordProblem,
    hashPassword,
    verifyPassword,
    dummyVerify,
    newToken,
    hashToken,
    sessionExpiry,
    clientIp,
    RateLimiter
};
