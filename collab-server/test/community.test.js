'use strict';

// Tests for accounts, posted projects, friends and studios.
// Uses a temporary SQLite file, or PostgreSQL when DATABASE_URL is set (CI).

const {test, before, after} = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 19090 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-community-'));
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(3).toString('hex');
let serverProcess;

// A tiny valid zip ("PK..."), standing in for an .sb3 file
const FAKE_SB3 = Buffer.from('504b0506000000000000000000000000000000000000', 'hex').toString('base64');

const api = async (method, url, {token, body, ip, raw} = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    // The test server trusts one proxy hop, so this simulates visitors' addresses.
    headers['X-Forwarded-For'] = ip || '192.0.2.1';
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${url}`, {method, headers, body: raw || (body ? JSON.stringify(body) : undefined)});
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return {status: res.status, data};
};

const nick = name => `${name}_${RUN}`;

const signup = async name => {
    const res = await api('POST', '/api/signup', {body: {nickname: nick(name), password: `pw-${name}-123`}});
    assert.strictEqual(res.status, 201, JSON.stringify(res.data));
    return res.data.token;
};

before(() => new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
        env: Object.assign({}, process.env, {
            PORT: String(PORT),
            HOST: '127.0.0.1',
            DATA_DIR,
            SIGNUPS_PER_HOUR_PER_IP: '1000',
            TRUSTED_PROXY_HOPS: '1',
            USER_QUOTA_MB: '1'
        }),
        stdio: ['ignore', 'pipe', 'inherit']
    });
    serverProcess.stdout.on('data', chunk => {
        if (chunk.toString().includes('listening')) resolve();
    });
    serverProcess.on('error', reject);
}));

after(async () => {
    await new Promise(resolve => {
        serverProcess.once('exit', resolve);
        serverProcess.kill('SIGINT');
    });
    fs.rmSync(DATA_DIR, {recursive: true, force: true});
});

test('accounts: sign up, sign in, wrong password, duplicates, sign out', async () => {
    const health = await api('GET', '/health');
    assert.strictEqual(health.data.accounts, true);

    const bad = await api('POST', '/api/signup', {body: {nickname: 'x', password: 'secret123'}});
    assert.strictEqual(bad.status, 400);
    const shortPw = await api('POST', '/api/signup', {body: {nickname: nick('alex'), password: 'abc1234'}});
    assert.strictEqual(shortPw.status, 400);
    const common = await api('POST', '/api/signup', {body: {nickname: nick('alex'), password: 'password123'}});
    assert.strictEqual(common.status, 400);
    const hasNick = await api('POST', '/api/signup', {body: {nickname: nick('alex'), password: `my-${nick('alex')}!`}});
    assert.strictEqual(hasNick.status, 400);

    const token = await signup('alex');
    const me = await api('GET', '/api/me', {token});
    assert.strictEqual(me.data.user.nickname, nick('alex'));

    // Nicknames are unique ignoring capitals
    const dup = await api('POST', '/api/signup', {body: {nickname: nick('alex').toUpperCase(), password: 'another-pw'}});
    assert.strictEqual(dup.status, 409);

    const wrong = await api('POST', '/api/login', {body: {nickname: nick('alex'), password: 'not-it'}});
    assert.strictEqual(wrong.status, 401);
    const nobody = await api('POST', '/api/login', {body: {nickname: nick('nobody'), password: 'whatever'}});
    assert.strictEqual(nobody.status, 401);
    assert.strictEqual(nobody.data.error, wrong.data.error, 'same message, so nicknames can\'t be probed');

    const login = await api('POST', '/api/login', {body: {nickname: nick('ALEX'), password: 'pw-alex-123'}});
    assert.strictEqual(login.status, 200);
    assert.ok(login.data.token && login.data.token !== token);

    await api('POST', '/api/logout', {token: login.data.token});
    const after = await api('GET', '/api/me', {token: login.data.token});
    assert.strictEqual(after.status, 401);
    const stillIn = await api('GET', '/api/me', {token});
    assert.strictEqual(stillIn.status, 200, 'other sessions keep working');

    const noAuth = await api('GET', '/api/me', {token: 'made-up-token'});
    assert.strictEqual(noAuth.status, 401);
});

test('accounts: passwords are stored hashed, never as text', async () => {
    if (process.env.DATABASE_URL) return; // only inspectable in the SQLite file
    await signup('hashcheck');
    const {DatabaseSync} = require('node:sqlite');
    const db = new DatabaseSync(path.join(DATA_DIR, 'community.sqlite'));
    const row = db.prepare('SELECT password_hash FROM users WHERE nickname_lower = ?').get(nick('hashcheck').toLowerCase());
    db.close();
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes('pw-hashcheck-123'));
});

test('projects: post, list, download, update, delete, and only the owner may change them', async () => {
    const owner = await signup('poster');
    const other = await signup('lurker');

    const noAuth = await api('POST', '/api/projects', {body: {title: 'x', data: FAKE_SB3}});
    assert.strictEqual(noAuth.status, 401);
    const notZip = await api('POST', '/api/projects', {
        token: owner, body: {title: 'Bad', data: Buffer.from('hello').toString('base64')}
    });
    assert.strictEqual(notZip.status, 400);

    const posted = await api('POST', '/api/projects', {
        token: owner, body: {title: '  Platypus Run  ', description: 'Jump!', data: FAKE_SB3}
    });
    assert.strictEqual(posted.status, 201);
    const project = posted.data.project;
    assert.strictEqual(project.title, 'Platypus Run');
    assert.strictEqual(project.author, nick('poster'));

    const list = await api('GET', '/api/projects');
    assert.ok(list.data.projects.some(p => p.id === project.id));

    const file = await api('GET', `/api/projects/${project.id}/file`);
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.data.toString('base64'), FAKE_SB3);

    const hijack = await api('PUT', `/api/projects/${project.id}`, {token: other, body: {title: 'Mine now'}});
    assert.strictEqual(hijack.status, 403);
    const renamed = await api('PUT', `/api/projects/${project.id}`, {token: owner, body: {title: 'Platypus Run 2'}});
    assert.strictEqual(renamed.data.project.title, 'Platypus Run 2');

    const profile = await api('GET', `/api/users/${nick('poster')}`);
    assert.strictEqual(profile.data.projects[0].id, project.id);

    const deleteOther = await api('DELETE', `/api/projects/${project.id}`, {token: other});
    assert.strictEqual(deleteOther.status, 403);
    const deleted = await api('DELETE', `/api/projects/${project.id}`, {token: owner});
    assert.strictEqual(deleted.status, 200);
    const gone = await api('GET', `/api/projects/${project.id}`);
    assert.strictEqual(gone.status, 404);
});

test('friends: request, accept, both asking, unfriend', async () => {
    const a = await signup('fa');
    const b = await signup('fb');
    const c = await signup('fc');

    const self = await api('POST', '/api/friends/requests', {token: a, body: {nickname: nick('fa')}});
    assert.strictEqual(self.status, 400);
    const unknown = await api('POST', '/api/friends/requests', {token: a, body: {nickname: nick('ghost')}});
    assert.strictEqual(unknown.status, 404);

    const asked = await api('POST', '/api/friends/requests', {token: a, body: {nickname: nick('fb')}});
    assert.strictEqual(asked.data.status, 'requested');
    const bView = await api('GET', '/api/friends', {token: b});
    assert.strictEqual(bView.data.incoming.length, 1);
    assert.strictEqual(bView.data.incoming[0].nickname, nick('fa'));

    // Someone else can't accept B's request
    const steal = await api('POST', `/api/friends/requests/${bView.data.incoming[0].id}/accept`, {token: c});
    assert.strictEqual(steal.status, 404);

    const accepted = await api('POST', `/api/friends/requests/${bView.data.incoming[0].id}/accept`, {token: b});
    assert.strictEqual(accepted.data.status, 'friends');
    const aView = await api('GET', '/api/friends', {token: a});
    assert.deepStrictEqual(aView.data.friends.map(f => f.nickname), [nick('fb')]);
    assert.strictEqual(aView.data.outgoing.length, 0);

    // If both ask each other, they simply become friends
    await api('POST', '/api/friends/requests', {token: c, body: {nickname: nick('fa')}});
    const mutual = await api('POST', '/api/friends/requests', {token: a, body: {nickname: nick('fc')}});
    assert.strictEqual(mutual.data.status, 'friends');

    await api('DELETE', `/api/friends/${nick('fb')}`, {token: a});
    const bAfter = await api('GET', '/api/friends', {token: b});
    assert.strictEqual(bAfter.data.friends.length, 0);
});

test('studios: create, invite, join, add projects, permissions, leave and delete', async () => {
    const owner = await signup('sowner');
    const guest = await signup('sguest');
    const outsider = await signup('sout');

    const created = await api('POST', '/api/studios', {token: owner, body: {title: 'Platypus Club', description: 'Hi'}});
    assert.strictEqual(created.status, 201);
    const studioId = created.data.studio.id;

    const badInvite = await api('POST', `/api/studios/${studioId}/invites`, {token: outsider, body: {nickname: nick('sguest')}});
    assert.strictEqual(badInvite.status, 403);
    const invite = await api('POST', `/api/studios/${studioId}/invites`, {token: owner, body: {nickname: nick('sguest')}});
    assert.strictEqual(invite.status, 201);

    const guestStudios = await api('GET', '/api/studios', {token: guest});
    assert.strictEqual(guestStudios.data.invites.length, 1);
    assert.strictEqual(guestStudios.data.invites[0].studio.title, 'Platypus Club');

    // Outsiders can't add projects; members can
    const posted = await api('POST', '/api/projects', {token: guest, body: {title: 'Guest game', data: FAKE_SB3}});
    const projectId = posted.data.project.id;
    const early = await api('POST', `/api/studios/${studioId}/projects`, {token: guest, body: {projectId}});
    assert.strictEqual(early.status, 403);

    const joined = await api('POST', `/api/studios/invites/${guestStudios.data.invites[0].id}/accept`, {token: guest});
    assert.strictEqual(joined.data.status, 'member');
    const added = await api('POST', `/api/studios/${studioId}/projects`, {token: guest, body: {projectId}});
    assert.strictEqual(added.status, 201);

    const studio = await api('GET', `/api/studios/${studioId}`);
    assert.deepStrictEqual(studio.data.members.map(m => `${m.nickname}:${m.role}`).sort(),
        [`${nick('sguest')}:member`, `${nick('sowner')}:owner`].sort());
    assert.strictEqual(studio.data.projects[0].id, projectId);
    assert.strictEqual(studio.data.projects[0].addedBy, nick('sguest'));

    const kickByGuest = await api('DELETE', `/api/studios/${studioId}/members/${nick('sowner')}`, {token: guest});
    assert.strictEqual(kickByGuest.status, 403);
    const ownerLeave = await api('DELETE', `/api/studios/${studioId}/members/${nick('sowner')}`, {token: owner});
    assert.strictEqual(ownerLeave.status, 400);
    const leave = await api('DELETE', `/api/studios/${studioId}/members/${nick('sguest')}`, {token: guest});
    assert.strictEqual(leave.status, 200);

    const deleteByOutsider = await api('DELETE', `/api/studios/${studioId}`, {token: outsider});
    assert.strictEqual(deleteByOutsider.status, 403);
    const deleted = await api('DELETE', `/api/studios/${studioId}`, {token: owner});
    assert.strictEqual(deleted.status, 200);
    const gone = await api('GET', `/api/studios/${studioId}`);
    assert.strictEqual(gone.status, 404);
});

test('wrong passwords are slowed down per place, without locking the real owner out', async () => {
    const name = nick('target');
    await api('POST', '/api/signup', {body: {nickname: name, password: 'correct-horse-battery'}});
    let limited = false;
    for (let i = 0; i < 12; i++) {
        const res = await api('POST', '/api/login', {ip: '203.0.113.5', body: {nickname: name, password: `guess-${i}`}});
        if (res.status === 429) {
            limited = true;
            break;
        }
    }
    assert.ok(limited, 'repeated wrong passwords from one place get blocked for a while');
    // Faking an address in front doesn't help: only the proxy's entry (last) counts.
    const spoofed = await api('POST', '/api/login', {
        ip: '10.9.8.7, 203.0.113.5', body: {nickname: name, password: 'another-guess'}
    });
    assert.strictEqual(spoofed.status, 429);
    // The real owner, somewhere else, can still sign in.
    const owner = await api('POST', '/api/login', {ip: '198.51.100.7', body: {nickname: name, password: 'correct-horse-battery'}});
    assert.strictEqual(owner.status, 200);
});

test('oversized requests are refused before doing any work', async () => {
    const huge = JSON.stringify({nickname: 'x'.repeat(100000), password: 'whatever-pass'});
    const res = await api('POST', '/api/login', {raw: huge});
    assert.strictEqual(res.status, 413);
    const anonUpload = await api('POST', '/api/projects', {raw: JSON.stringify({title: 't', data: 'A'.repeat(200000)})});
    assert.strictEqual(anonUpload.status, 401, 'not signed in: refused before reading the upload');
});

test('storage quota per person', async () => {
    const token = await signup('quota');
    // A 1.2 MB "project" (valid zip header) is over the test server's 1 MB quota
    const big = Buffer.alloc(1.2 * 1024 * 1024);
    big[0] = 0x50;
    big[1] = 0x4b;
    const res = await api('POST', '/api/projects', {token, body: {title: 'Big', data: big.toString('base64')}});
    assert.strictEqual(res.status, 413);
});

test('after someone declines, they are not asked again right away', async () => {
    const a = await signup('askera');
    const b = await signup('askerb');
    await api('POST', '/api/friends/requests', {token: a, body: {nickname: nick('askerb')}});
    const first = await api('GET', '/api/friends', {token: b});
    await api('POST', `/api/friends/requests/${first.data.incoming[0].id}/decline`, {token: b});
    const again = await api('POST', '/api/friends/requests', {token: a, body: {nickname: nick('askerb')}});
    assert.strictEqual(again.data.status, 'requested', 'the asker isn\'t told they were declined');
    const after = await api('GET', '/api/friends', {token: b});
    assert.strictEqual(after.data.incoming.length, 0);
});

test('a project\'s author can take it out of someone else\'s studio', async () => {
    const owner = await signup('stowner');
    const member = await signup('stmember');
    const author = await signup('stauthor');
    const studio = await api('POST', '/api/studios', {token: owner, body: {title: 'Mixed'}});
    const sid = studio.data.studio.id;
    await api('POST', `/api/studios/${sid}/invites`, {token: owner, body: {nickname: nick('stmember')}});
    const inv = await api('GET', '/api/studios', {token: member});
    await api('POST', `/api/studios/invites/${inv.data.invites[0].id}/accept`, {token: member});
    const posted = await api('POST', '/api/projects', {token: author, body: {title: 'Mine', data: FAKE_SB3}});
    const pid = posted.data.project.id;
    await api('POST', `/api/studios/${sid}/projects`, {token: member, body: {projectId: pid}});
    const removed = await api('DELETE', `/api/studios/${sid}/projects/${pid}`, {token: author});
    assert.strictEqual(removed.status, 200);
    const view = await api('GET', `/api/studios/${sid}`);
    assert.strictEqual(view.data.projects.length, 0);
});
