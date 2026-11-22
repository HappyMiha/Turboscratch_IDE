'use strict';

const {test, before, after} = require('node:test');
const assert = require('node:assert');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 18090 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-collab-'));
let serverProcess;

const startServer = () => new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR, SNAPSHOT_IDLE_MS: '200'},
        stdio: ['ignore', 'pipe', 'inherit']
    });
    serverProcess.stdout.on('data', chunk => {
        if (chunk.toString().includes('listening')) resolve();
    });
    serverProcess.on('error', reject);
});

const stopServer = () => new Promise(resolve => {
    serverProcess.once('exit', resolve);
    serverProcess.kill('SIGINT');
});

class TestClient {
    constructor (room, name) {
        this.messages = [];
        this.waiters = [];
        this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
        this.ws.addEventListener('message', e => {
            const message = JSON.parse(e.data);
            this.messages.push(message);
            this.waiters = this.waiters.filter(w => {
                if (w.match(message)) {
                    w.resolve(message);
                    return false;
                }
                return true;
            });
        });
        this.opened = new Promise(resolve => this.ws.addEventListener('open', resolve));
        this.opened.then(() => this.send({t: 'hello', protocol: 1, room, name}));
    }
    send (message) {
        this.ws.send(JSON.stringify(message));
    }
    next (type, predicate = () => true) {
        const existing = this.messages.find(m => m.t === type && predicate(m) && !m._seen);
        if (existing) {
            existing._seen = true;
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
            this.waiters.push({
                match: m => m.t === type && predicate(m),
                resolve: m => {
                    clearTimeout(timer);
                    m._seen = true;
                    resolve(m);
                }
            });
        });
    }
    close () {
        this.ws.close();
    }
}

before(startServer);
after(async () => {
    await stopServer();
    fs.rmSync(DATA_DIR, {recursive: true, force: true});
});

test('first person provides the project, second person receives it and edits flow both ways', async () => {
    const alice = new TestClient('demo-room', 'Alice');
    const welcomeA = await alice.next('welcome');
    assert.strictEqual(welcomeA.peers.length, 0);
    assert.strictEqual(welcomeA.hasProject, false);
    const need = await alice.next('need-snapshot');
    assert.strictEqual(need.seq, 0);

    const project = Buffer.from('pretend this is an sb3 file');
    alice.send({t: 'snapshot', seq: 0, data: project.toString('base64')});

    alice.send({t: 'op', ref: 1, op: {kind: 'blocks', event: {type: 'create', blockId: 'a'}}});
    const ack = await alice.next('ack');
    assert.strictEqual(ack.seq, 1);
    assert.strictEqual(ack.ref, 1);

    const bob = new TestClient('demo-room', 'Bob');
    const welcomeB = await bob.next('welcome');
    assert.strictEqual(welcomeB.peers.length, 1);
    assert.strictEqual(welcomeB.peers[0].name, 'Alice');
    const join = await alice.next('peer-join');
    assert.strictEqual(join.peer.name, 'Bob');

    const snapshot = await bob.next('snapshot');
    assert.strictEqual(Buffer.from(snapshot.data, 'base64').toString(), project.toString());
    const replayed = await bob.next('op');
    assert.strictEqual(replayed.seq, 1);
    assert.strictEqual(replayed.op.event.blockId, 'a');
    await bob.next('caught-up');

    bob.send({t: 'op', ref: 7, op: {kind: 'renameSprite', from: 'Sprite1', to: 'Cat'}});
    const fromBob = await alice.next('op', m => m.seq === 2);
    assert.strictEqual(fromBob.op.to, 'Cat');
    assert.strictEqual(fromBob.from, welcomeB.id);

    bob.send({t: 'presence', presence: {target: 'Cat'}});
    const presence = await alice.next('presence');
    assert.strictEqual(presence.presence.target, 'Cat');

    alice.send({t: 'chat', text: 'hi bob'});
    const chat = await bob.next('chat');
    assert.strictEqual(chat.text, 'hi bob');
    assert.strictEqual(chat.name, 'Alice');

    // After a quiet moment the oldest person is asked for a fresh snapshot.
    await alice.next('request-snapshot');
    alice.send({t: 'snapshot', seq: 2, data: Buffer.from('newer project').toString('base64')});

    bob.close();
    await alice.next('peer-leave');
    alice.close();
    await new Promise(resolve => setTimeout(resolve, 200));

    // The room was saved to disk and is restored for the next visitor.
    const carol = new TestClient('demo-room', 'Carol');
    const snapshotC = await carol.next('snapshot');
    assert.strictEqual(Buffer.from(snapshotC.data, 'base64').toString(), 'newer project');
    assert.strictEqual(snapshotC.seq, 2);
    const caughtUp = await carol.next('caught-up');
    assert.strictEqual(caughtUp.seq, 2);
    carol.close();
});

test('people who join while the first project is uploading get it once it arrives', async () => {
    const dana = new TestClient('upload-race', 'Dana');
    await dana.next('need-snapshot');
    const erin = new TestClient('upload-race', 'Erin');
    await erin.next('welcome');
    dana.send({t: 'snapshot', seq: 0, data: Buffer.from('dana project').toString('base64')});
    const snapshot = await erin.next('snapshot');
    assert.strictEqual(Buffer.from(snapshot.data, 'base64').toString(), 'dana project');
    dana.close();
    erin.close();
});

test('if the room creator leaves before uploading, the next person provides the project', async () => {
    const fay = new TestClient('creator-left', 'Fay');
    await fay.next('need-snapshot');
    const gus = new TestClient('creator-left', 'Gus');
    await gus.next('welcome');
    fay.close();
    await gus.next('need-snapshot');
    gus.close();
});

test('bad room codes and old editors are turned away', async () => {
    const bad = new TestClient('../etc/passwd', 'Mallory');
    const error = await bad.next('error');
    assert.strictEqual(error.code, 'bad-room');
});

test('after a snapshot, everyone else is told its fingerprint so they can self-check', async () => {
    const hana = new TestClient('checkpoint-room', 'Hana');
    await hana.next('need-snapshot');
    hana.send({t: 'snapshot', seq: 0, hash: 'first', data: Buffer.from('v1').toString('base64')});
    const ivan = new TestClient('checkpoint-room', 'Ivan');
    await ivan.next('caught-up');
    ivan.send({t: 'op', ref: 1, op: {kind: 'blocks'}});
    await ivan.next('ack');
    await hana.next('request-snapshot');
    hana.send({t: 'snapshot', seq: 1, hash: 'abc123', data: Buffer.from('v2').toString('base64')});
    const checkpoint = await ivan.next('checkpoint');
    assert.strictEqual(checkpoint.seq, 1);
    assert.strictEqual(checkpoint.hash, 'abc123');
    // Presence is reduced to just a sprite name
    ivan.send({t: 'presence', presence: {target: 'Cat', evil: {nested: true}}});
    const presence = await hana.next('presence');
    assert.deepStrictEqual(presence.presence, {target: 'Cat'});
    hana.close();
    ivan.close();
});
