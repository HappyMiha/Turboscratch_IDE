/**
 * TurboScratch IDE collaboration server.
 *
 * Copyright (C) 2026 TurboScratch IDE contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * How it works
 * ------------
 * Everyone who opens the same "room" edits the same project.
 *
 *  - The server keeps a snapshot of the room's project (an .sb3 file) plus a
 *    log of every edit ("op") made since that snapshot. Each op gets a
 *    sequence number so every client applies edits in the same order.
 *  - A new person joining the room receives the snapshot and then all the ops
 *    that came after it, so they end up with exactly the same project.
 *  - Every so often the server asks one of the people in the room for a fresh
 *    snapshot so the op log stays short.
 *  - Snapshots and op logs are saved in ./data so rooms survive a restart.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {WebSocketServer} = require('ws');
const {openDatabase} = require('./community/db');
const {createCommunityApi} = require('./community/api');

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 200 * 1024 * 1024;
const MAX_CLIENTS_PER_ROOM = 32;
const SNAPSHOT_IDLE_MS = Number(process.env.SNAPSHOT_IDLE_MS) || 3000;
const SNAPSHOT_MAX_OPS = 150;
const SNAPSHOT_MAX_OP_BYTES = 24 * 1024 * 1024;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30000;
const HEARTBEAT_MS = 30000;
const OPS_SAVE_DELAY_MS = 2000;
// Optional: comma-separated list of web page origins allowed to connect,
// e.g. ALLOWED_ORIGINS=https://turboscratch-ide.github.io,http://localhost:8601
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim())
    .filter(Boolean);
const MAX_CHAT_LENGTH = 500;

const COLORS = [
    '#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8',
    '#ff922b', '#22b8cf', '#f06595', '#94d82d', '#845ef7'
];

const log = (...args) => {
    if (process.env.QUIET) return;
    // eslint-disable-next-line no-console
    console.log(new Date().toISOString(), ...args);
};

/** @type {Map<string, Room>} */
const rooms = new Map();

const sanitizeRoomId = raw => {
    if (typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) return null;
    return id;
};

const sanitizeName = raw => {
    if (typeof raw !== 'string') return 'Guest';
    const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
        .slice(0, 24);
    return name || 'Guest';
};

const sanitizeColor = raw => (typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : null);

const send = (ws, message) => {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
    }
};

const roomFile = (roomId, ext) => path.join(DATA_DIR, `${roomId}.${ext}`);

/** Write to a temporary file first so a crash never leaves a half-written room. */
const writeFileAtomic = (file, data) => {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
};

class Room {
    constructor (id) {
        this.id = id;
        /** @type {Map<string, object>} */
        this.clients = new Map();
        this.seq = 0;
        /** @type {Buffer|null} */
        this.snapshot = null;
        this.snapshotSeq = 0;
        /** @type {Array<{seq: number, from: string, op: object, bytes: number}>} */
        this.ops = [];
        this.opBytes = 0;
        this.snapshotRequestedAt = 0;
        this.snapshotRequestedFrom = null;
        this.snapshotTimer = null;
        this.snapshotRequestTimer = null;
        this.snapshotHash = null;
        this.opsSaveTimer = null;
        this.loadFromDisk();
    }

    loadFromDisk () {
        try {
            const meta = JSON.parse(fs.readFileSync(roomFile(this.id, 'json'), 'utf8'));
            this.snapshot = fs.readFileSync(roomFile(this.id, 'sb3'));
            this.snapshotSeq = meta.snapshotSeq || 0;
            this.snapshotHash = typeof meta.snapshotHash === 'string' ? meta.snapshotHash : null;
            this.seq = meta.seq || this.snapshotSeq;
            this.ops = (meta.ops || []).filter(entry => entry.seq > this.snapshotSeq);
            this.opBytes = this.ops.reduce((total, entry) => total + (entry.bytes || 0), 0);
            log(`[${this.id}] loaded from disk (snapshot seq ${this.snapshotSeq}, ${this.ops.length} ops)`);
        } catch (e) {
            if (e.code !== 'ENOENT') log(`[${this.id}] could not load saved room:`, e.message);
        }
    }

    /**
     * The .sb3 is written before the .json that points at it, so after a crash
     * the json never claims a newer snapshot than the one on disk.
     */
    saveToDisk (includeSnapshot = true) {
        if (!this.snapshot) return;
        clearTimeout(this.opsSaveTimer);
        this.opsSaveTimer = null;
        try {
            fs.mkdirSync(DATA_DIR, {recursive: true});
            if (includeSnapshot) writeFileAtomic(roomFile(this.id, 'sb3'), this.snapshot);
            writeFileAtomic(roomFile(this.id, 'json'), JSON.stringify({
                version: PROTOCOL_VERSION,
                snapshotSeq: this.snapshotSeq,
                snapshotHash: this.snapshotHash,
                seq: this.seq,
                ops: this.ops
            }));
        } catch (e) {
            log(`[${this.id}] could not save room:`, e.message);
        }
    }

    /** Edits are written to disk shortly after they happen, not only on snapshots. */
    saveOpsSoon () {
        if (this.opsSaveTimer || !this.snapshot) return;
        this.opsSaveTimer = setTimeout(() => {
            this.opsSaveTimer = null;
            this.saveToDisk(false);
        }, OPS_SAVE_DELAY_MS);
    }

    peers (exceptId) {
        const result = [];
        for (const client of this.clients.values()) {
            if (client.id !== exceptId) {
                result.push({
                    id: client.id,
                    name: client.name,
                    color: client.color,
                    presence: client.presence
                });
            }
        }
        return result;
    }

    broadcast (message, exceptId) {
        const data = JSON.stringify(message);
        for (const client of this.clients.values()) {
            if (client.id !== exceptId && client.ws.readyState === client.ws.OPEN) {
                client.ws.send(data);
            }
        }
    }

    pickColor () {
        const used = new Set([...this.clients.values()].map(c => c.color));
        return COLORS.find(c => !used.has(c)) || COLORS[this.clients.size % COLORS.length];
    }

    /** Send the snapshot and every op after it so a client catches up. */
    sendState (client) {
        send(client.ws, {
            t: 'snapshot',
            seq: this.snapshotSeq,
            data: this.snapshot.toString('base64')
        });
        for (const entry of this.ops) {
            send(client.ws, {t: 'op', seq: entry.seq, from: entry.from, op: entry.op});
        }
        send(client.ws, {t: 'caught-up', seq: this.seq});
        client.ready = true;
    }

    /** The person who has been in the room longest provides snapshots. */
    snapshotProvider () {
        let best = null;
        for (const client of this.clients.values()) {
            if (client.ready && !client.snapshotUnresponsive && (!best || client.joinedAt < best.joinedAt)) {
                best = client;
            }
        }
        if (!best) {
            // Everyone has missed a request once; give them all another chance.
            for (const client of this.clients.values()) client.snapshotUnresponsive = false;
            for (const client of this.clients.values()) {
                if (client.ready && (!best || client.joinedAt < best.joinedAt)) best = client;
            }
        }
        return best;
    }

    requestSnapshot () {
        if (this.ops.length === 0 && this.snapshot) return;
        const now = Date.now();
        if (this.snapshotRequestedAt && now - this.snapshotRequestedAt < SNAPSHOT_REQUEST_TIMEOUT_MS) return;
        const provider = this.snapshotProvider();
        if (!provider) return;
        this.snapshotRequestedAt = now;
        this.snapshotRequestedFrom = provider.id;
        send(provider.ws, {t: 'request-snapshot'});
        clearTimeout(this.snapshotRequestTimer);
        this.snapshotRequestTimer = setTimeout(() => {
            if (this.snapshotRequestedFrom !== provider.id || !this.snapshotRequestedAt) return;
            // No answer: ask someone else.
            provider.snapshotUnresponsive = true;
            this.snapshotRequestedAt = 0;
            this.snapshotRequestedFrom = null;
            this.requestSnapshot();
        }, SNAPSHOT_REQUEST_TIMEOUT_MS);
    }

    scheduleSnapshot () {
        if (this.ops.length >= SNAPSHOT_MAX_OPS || this.opBytes >= SNAPSHOT_MAX_OP_BYTES) {
            this.requestSnapshot();
            return;
        }
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = setTimeout(() => this.requestSnapshot(), SNAPSHOT_IDLE_MS);
    }

    handleSnapshot (client, message) {
        const seq = Number(message.seq);
        if (!Number.isInteger(seq) || seq < this.snapshotSeq || seq > this.seq || typeof message.data !== 'string') {
            send(client.ws, {t: 'error', code: 'bad-snapshot', message: 'Snapshot rejected'});
            this.snapshotRequestedAt = 0;
            return;
        }
        const firstSnapshot = !this.snapshot;
        this.snapshot = Buffer.from(message.data, 'base64');
        this.snapshotSeq = seq;
        this.snapshotHash = typeof message.hash === 'string' && message.hash.length <= 128 ? message.hash : null;
        client.snapshotUnresponsive = false;
        clearTimeout(this.snapshotRequestTimer);
        this.ops = this.ops.filter(entry => entry.seq > seq);
        this.opBytes = this.ops.reduce((total, entry) => total + entry.bytes, 0);
        this.snapshotRequestedAt = 0;
        log(`[${this.id}] snapshot at seq ${seq} (${Math.round(this.snapshot.length / 1024)} KB) from ${client.name}`);
        this.saveToDisk();

        if (firstSnapshot) {
            for (const other of this.clients.values()) {
                if (!other.ready) this.sendState(other);
            }
        } else if (this.snapshotHash) {
            // Everyone at this exact point compares their project with the snapshot
            // and reloads it if theirs ended up different.
            const checkpoint = JSON.stringify({t: 'checkpoint', seq, hash: this.snapshotHash});
            for (const other of this.clients.values()) {
                if (other.id !== client.id && other.ready && other.ws.readyState === other.ws.OPEN) {
                    other.ws.send(checkpoint);
                }
            }
        }
        if (this.ops.length > 0) this.scheduleSnapshot();
    }

    handleOp (client, message, rawBytes) {
        if (!client.ready) return;
        if (!message.op || typeof message.op !== 'object') return;
        const seq = ++this.seq;
        const entry = {seq, from: client.id, op: message.op, bytes: rawBytes};
        this.ops.push(entry);
        this.opBytes += rawBytes;
        const out = JSON.stringify({t: 'op', seq, from: client.id, op: message.op});
        for (const other of this.clients.values()) {
            if (other.id !== client.id && other.ready && other.ws.readyState === other.ws.OPEN) {
                other.ws.send(out);
            }
        }
        send(client.ws, {t: 'ack', seq, ref: message.ref});
        this.scheduleSnapshot();
        this.saveOpsSoon();
    }

    join (client) {
        this.clients.set(client.id, client);
        send(client.ws, {
            t: 'welcome',
            protocol: PROTOCOL_VERSION,
            id: client.id,
            color: client.color,
            room: this.id,
            peers: this.peers(client.id),
            hasProject: !!this.snapshot
        });
        this.broadcast({
            t: 'peer-join',
            peer: {id: client.id, name: client.name, color: client.color, presence: client.presence}
        }, client.id);

        if (this.snapshot) {
            this.sendState(client);
        } else if (![...this.clients.values()].some(c => c.ready)) {
            // First person in a brand new room: their project becomes the room's project.
            client.ready = true;
            send(client.ws, {t: 'need-snapshot', seq: this.seq});
        }
        // Otherwise the room's first snapshot is still uploading; this client
        // gets the state as soon as it arrives (see handleSnapshot).
    }

    leave (client) {
        if (!this.clients.delete(client.id)) return;
        this.broadcast({t: 'peer-leave', id: client.id});
        if (this.snapshotRequestedFrom === client.id) {
            // They were asked for a snapshot but left; ask someone else.
            this.snapshotRequestedAt = 0;
        }
        if (!this.snapshot && this.clients.size > 0 && ![...this.clients.values()].some(c => c.ready)) {
            // The room creator left before uploading the project. The next
            // person in line provides the project instead.
            let next = null;
            for (const other of this.clients.values()) {
                if (!next || other.joinedAt < next.joinedAt) next = other;
            }
            next.ready = true;
            send(next.ws, {t: 'need-snapshot', seq: this.seq});
        }
        if (this.clients.size === 0) {
            clearTimeout(this.snapshotTimer);
            clearTimeout(this.snapshotRequestTimer);
            this.saveToDisk();
            rooms.delete(this.id);
            log(`[${this.id}] empty, saved and closed`);
        } else if (this.ops.length > 0) {
            this.scheduleSnapshot();
        }
    }
}

const getRoom = id => {
    let room = rooms.get(id);
    if (!room) {
        room = new Room(id);
        rooms.set(id, room);
    }
    return room;
};

/** Accounts, posted projects, friends and studios (null if storage failed to open). */
let community = null;
let communityError = null;

const httpServer = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
        if (community) {
            community.handle(req, res);
        } else {
            res.writeHead(503, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
            res.end(JSON.stringify({error: 'Accounts aren\'t available on this server right now'}));
        }
        return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({
            name: 'TurboScratch IDE collaboration server',
            protocol: PROTOCOL_VERSION,
            rooms: rooms.size,
            people: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
            accounts: !!community,
            accountStorage: community ? (process.env.DATABASE_URL ? 'postgres' : 'sqlite') : communityError
        }));
        return;
    }
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not found');
});

const wss = new WebSocketServer({server: httpServer, maxPayload: MAX_MESSAGE_BYTES});

wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
        send(ws, {t: 'error', code: 'origin', message: 'This server does not accept connections from that website'});
        ws.close();
        return;
    }
    /** @type {null | {id: string, name: string, color: string, ws: any, room: Room, ready: boolean, presence: object, joinedAt: number}} */
    let client = null;
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let message;
        try {
            message = JSON.parse(data.toString('utf8'));
        } catch (e) {
            return;
        }
        if (!message || typeof message.t !== 'string') return;

        if (!client) {
            if (message.t !== 'hello') return;
            const roomId = sanitizeRoomId(message.room);
            if (!roomId) {
                send(ws, {t: 'error', code: 'bad-room', message: 'Room codes can use letters, numbers, - and _'});
                ws.close();
                return;
            }
            if (message.protocol !== PROTOCOL_VERSION) {
                send(ws, {t: 'error', code: 'protocol', message: 'Your editor and the server are different versions'});
                ws.close();
                return;
            }
            const room = getRoom(roomId);
            if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
                send(ws, {t: 'error', code: 'room-full', message: 'This room is full'});
                ws.close();
                return;
            }
            client = {
                id: crypto.randomUUID(),
                name: sanitizeName(message.name),
                color: sanitizeColor(message.color) || room.pickColor(),
                ws,
                room,
                ready: false,
                presence: {},
                joinedAt: Date.now()
            };
            log(`[${room.id}] ${client.name} joined (${room.clients.size + 1} here)`);
            room.join(client);
            return;
        }

        const room = client.room;
        switch (message.t) {
        case 'op':
            room.handleOp(client, message, data.length);
            break;
        case 'snapshot':
            room.handleSnapshot(client, message);
            break;
        case 'presence': {
            const target = message.presence && typeof message.presence.target === 'string' ?
                message.presence.target.slice(0, 100) :
                null;
            const presence = {target};
            client.presence = presence;
            room.broadcast({t: 'presence', id: client.id, presence}, client.id);
            break;
        }
        case 'chat': {
            if (typeof message.text !== 'string') return;
            const text = message.text.trim().slice(0, MAX_CHAT_LENGTH);
            if (!text) return;
            room.broadcast({
                t: 'chat',
                id: client.id,
                name: client.name,
                color: client.color,
                text,
                time: Date.now()
            });
            break;
        }
        case 'resync':
            if (room.snapshot) room.sendState(client);
            break;
        case 'ping':
            send(ws, {t: 'pong'});
            break;
        }
    });

    ws.on('close', () => {
        if (client) {
            log(`[${client.room.id}] ${client.name} left`);
            client.room.leave(client);
            client = null;
        }
    });
    ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, HEARTBEAT_MS);

const shutdown = () => {
    clearInterval(heartbeat);
    for (const room of rooms.values()) room.saveToDisk();
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const start = async () => {
    try {
        const db = await openDatabase({databaseUrl: process.env.DATABASE_URL, dataDir: DATA_DIR});
        community = createCommunityApi({db, log});
        log(`Accounts enabled (${process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite file in the data folder'})`);
    } catch (e) {
        communityError = 'storage unavailable';
        log('Accounts are disabled: could not open storage:', e.message);
    }
    httpServer.listen(PORT, HOST, () => {
        log(`TurboScratch collaboration server listening on ws://${HOST}:${PORT}`);
    });
};
start();

module.exports = {httpServer, wss, rooms};
