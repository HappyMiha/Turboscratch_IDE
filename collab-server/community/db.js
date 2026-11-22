/**
 * Storage for accounts, projects, friends and studios.
 *
 * - Online: PostgreSQL, when DATABASE_URL is set (e.g. a free Neon database).
 * - On your own computer: a SQLite file in the data folder (Node's built-in
 *   node:sqlite), so nothing extra has to be installed.
 *
 * Queries are written once with `?` placeholders and work on both.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS users (
        id {{ID}},
        nickname TEXT NOT NULL,
        nickname_lower TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at {{BIGINT}} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at {{BIGINT}} NOT NULL,
        expires_at {{BIGINT}} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
        id {{ID}},
        owner_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        data {{BLOB}} NOT NULL,
        size INTEGER NOT NULL,
        created_at {{BIGINT}} NOT NULL,
        updated_at {{BIGINT}} NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS projects_updated ON projects (updated_at)',
    'CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id)',
    `CREATE TABLE IF NOT EXISTS friend_requests (
        id {{ID}},
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        created_at {{BIGINT}} NOT NULL,
        UNIQUE (from_id, to_id)
    )`,
    `CREATE TABLE IF NOT EXISTS friendships (
        user_id INTEGER NOT NULL,
        friend_id INTEGER NOT NULL,
        created_at {{BIGINT}} NOT NULL,
        PRIMARY KEY (user_id, friend_id)
    )`,
    `CREATE TABLE IF NOT EXISTS studios (
        id {{ID}},
        owner_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at {{BIGINT}} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS studio_members (
        studio_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        joined_at {{BIGINT}} NOT NULL,
        PRIMARY KEY (studio_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS studio_invites (
        id {{ID}},
        studio_id INTEGER NOT NULL,
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        created_at {{BIGINT}} NOT NULL,
        UNIQUE (studio_id, to_id)
    )`,
    `CREATE TABLE IF NOT EXISTS declines (
        kind TEXT NOT NULL,
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        created_at {{BIGINT}} NOT NULL,
        PRIMARY KEY (kind, from_id, to_id, target_id)
    )`,
    `CREATE TABLE IF NOT EXISTS studio_projects (
        studio_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        added_by INTEGER NOT NULL,
        added_at {{BIGINT}} NOT NULL,
        PRIMARY KEY (studio_id, project_id)
    )`
];

const DIALECT_TYPES = {
    sqlite: {ID: 'INTEGER PRIMARY KEY AUTOINCREMENT', BIGINT: 'INTEGER', BLOB: 'BLOB'},
    postgres: {ID: 'SERIAL PRIMARY KEY', BIGINT: 'BIGINT', BLOB: 'BYTEA'}
};

const ddl = (statement, dialect) => statement.replace(/\{\{(\w+)\}\}/g, (_, key) => DIALECT_TYPES[dialect][key]);

/** `?` placeholders → `$1, $2, ...` for PostgreSQL. */
const toPostgres = sql => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
};

/** Turn SQLite's Uint8Array blobs into Buffers so both databases look the same. */
const normalizeRow = row => {
    if (!row) return row;
    const out = {};
    for (const key of Object.keys(row)) {
        const value = row[key];
        out[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
    }
    return out;
};

class SqliteDb {
    constructor (file) {
        // Loaded lazily: only needed when running without DATABASE_URL.
        const {DatabaseSync} = require('node:sqlite');
        fs.mkdirSync(path.dirname(file), {recursive: true});
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.dialect = 'sqlite';
        this.queue = Promise.resolve();
    }

    async all (sql, params = []) {
        return this.db.prepare(sql).all(...params)
            .map(normalizeRow);
    }

    async get (sql, params = []) {
        return normalizeRow(this.db.prepare(sql).get(...params));
    }

    async run (sql, params = []) {
        const result = this.db.prepare(sql).run(...params);
        return {changes: Number(result.changes)};
    }

    /** Transactions run one at a time. */
    tx (fn) {
        const next = this.queue.then(async () => {
            this.db.exec('BEGIN');
            try {
                const result = await fn(this);
                this.db.exec('COMMIT');
                return result;
            } catch (e) {
                this.db.exec('ROLLBACK');
                throw e;
            }
        });
        this.queue = next.catch(() => {});
        return next;
    }

    async close () {
        this.db.close();
    }
}

class PostgresDb {
    constructor (databaseUrl) {
        const pg = require('pg');
        // BIGINT columns hold millisecond timestamps, which fit in a JS number.
        pg.types.setTypeParser(20, value => parseInt(value, 10));
        this.pool = new pg.Pool({connectionString: databaseUrl, max: 5});
        // A dropped idle connection must not crash the whole server.
        this.pool.on('error', err => {
            // eslint-disable-next-line no-console
            console.error('[db] idle connection error:', err.message);
        });
        this.dialect = 'postgres';
    }

    async all (sql, params = [], client = this.pool) {
        const result = await client.query(toPostgres(sql), params);
        return result.rows;
    }

    async get (sql, params = [], client = this.pool) {
        const rows = await this.all(sql, params, client);
        return rows[0];
    }

    async run (sql, params = [], client = this.pool) {
        const result = await client.query(toPostgres(sql), params);
        return {changes: result.rowCount};
    }

    async tx (fn) {
        const client = await this.pool.connect();
        const scoped = {
            dialect: this.dialect,
            all: (sql, params) => this.all(sql, params, client),
            get: (sql, params) => this.get(sql, params, client),
            run: (sql, params) => this.run(sql, params, client)
        };
        let result;
        try {
            await client.query('BEGIN');
            result = await fn(scoped);
            await client.query('COMMIT');
        } catch (e) {
            let broken = false;
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                broken = true;
            }
            // A connection whose rollback failed is thrown away, not reused.
            client.release(broken);
            throw e;
        }
        client.release();
        return result;
    }

    async close () {
        await this.pool.end();
    }
}

const openDatabase = async ({databaseUrl, dataDir}) => {
    const db = databaseUrl ?
        new PostgresDb(databaseUrl) :
        new SqliteDb(path.join(dataDir, 'community.sqlite'));
    for (const statement of SCHEMA) {
        await db.run(ddl(statement, db.dialect));
    }
    return db;
};

module.exports = {openDatabase};
