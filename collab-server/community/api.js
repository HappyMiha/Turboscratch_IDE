/**
 * TurboScratch community API: accounts, posted projects, friends, studios.
 *
 * JSON over HTTP under /api/. Signed-in requests send
 * "Authorization: Bearer <token>" (from /api/signup or /api/login).
 */

'use strict';

const auth = require('./auth');

const NICKNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const MAX_PASSWORD = 200;
// Request bodies: small for everything except uploading a project.
const SMALL_BODY_BYTES = 16 * 1024;
const PROJECT_BODY_BYTES = 15 * 1024 * 1024;
const MAX_PROJECT_BYTES = 10 * 1024 * 1024;
// Storage limits, so one account can't fill up a free database.
const USER_QUOTA_BYTES = (Number(process.env.USER_QUOTA_MB) || 50) * 1024 * 1024;
const TOTAL_QUOTA_BYTES = (Number(process.env.TOTAL_PROJECT_STORAGE_MB) || 400) * 1024 * 1024;
// Someone who said no can't be asked again for a week.
const DECLINE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TITLE = 100;
const MAX_STUDIO_TITLE = 60;
const MAX_DESCRIPTION = 2000;
const PAGE_SIZE = 40;

class HttpError extends Error {
    constructor (status, message) {
        super(message);
        this.status = status;
    }
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600'
};

const sendJson = (res, status, body) => {
    res.writeHead(status, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    }, CORS_HEADERS));
    res.end(body === null ? '' : JSON.stringify(body));
};

const readJson = (req, maxBytes) => new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes) {
        reject(new HttpError(413, 'That is too big to upload'));
        req.resume();
        return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
            reject(new HttpError(413, 'That is too big to upload'));
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on('end', () => {
        if (size === 0) {
            resolve({});
            return;
        }
        try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(body && typeof body === 'object' ? body : {});
        } catch (e) {
            reject(new HttpError(400, 'Invalid request'));
        }
    });
    req.on('error', reject);
});

const clientIp = auth.clientIp;

const cleanText = (value, max, field, required) => {
    const text = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '';
    if (required && !text) throw new HttpError(400, `Please enter a ${field}`);
    if (text.length > max) throw new HttpError(400, `The ${field} can be at most ${max} characters`);
    return text;
};

const isUniqueViolation = e => e && (e.code === '23505' || /UNIQUE constraint failed/.test(String(e.message)));

const projectSummary = row => ({
    id: row.id,
    title: row.title,
    description: row.description,
    author: row.author,
    size: row.size,
    createdAt: row.created_at,
    updatedAt: row.updated_at
});

const PROJECT_COLUMNS = 'p.id, p.title, p.description, p.size, p.created_at, p.updated_at, u.nickname AS author';

const createCommunityApi = ({db, log}) => {
    // All sign-in attempts from one address (a whole school can share one).
    const ipSignInLimiter = new auth.RateLimiter(100, 10 * 60 * 1000);
    // Wrong passwords: strict per nickname+address, looser per nickname, so a
    // bully can't lock someone out and guessers get stopped quickly.
    const failedByNicknameAndIp = new auth.RateLimiter(8, 15 * 60 * 1000);
    const failedByNickname = new auth.RateLimiter(50, 15 * 60 * 1000);
    const signupLimiter = new auth.RateLimiter(Number(process.env.SIGNUPS_PER_HOUR_PER_IP) || 20, 60 * 60 * 1000);
    const postLimiter = new auth.RateLimiter(30, 60 * 60 * 1000);
    const actionLimiter = new auth.RateLimiter(300, 10 * 60 * 1000);
    const downloadLimiter = new auth.RateLimiter(300, 10 * 60 * 1000);

    const routes = [];
    const route = (method, pattern, handler, options = {}) => {
        routes.push({
            method,
            pattern,
            handler,
            signedIn: !!options.signedIn,
            maxBody: options.maxBody || SMALL_BODY_BYTES
        });
    };

    // ---- helpers ----------------------------------------------------------

    const currentUser = async req => {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
        const token = header.slice(7).trim();
        if (!token || token.length > 200) return null;
        const row = await db.get(
            `SELECT u.id, u.nickname, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > ?`,
            [auth.hashToken(token), Date.now()]
        );
        return row || null;
    };

    const findUser = async nickname => {
        if (typeof nickname !== 'string' || !NICKNAME_RE.test(nickname)) return null;
        return db.get('SELECT id, nickname, created_at FROM users WHERE nickname_lower = ?', [nickname.toLowerCase()]);
    };

    const requireUser = async nickname => {
        const user = await findUser(nickname);
        if (!user) throw new HttpError(404, `There's nobody called "${String(nickname).slice(0, 30)}"`);
        return user;
    };

    const startSession = async user => {
        const token = auth.newToken();
        const now = Date.now();
        await db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
            [auth.hashToken(token), user.id, now, auth.sessionExpiry(now)]);
        return {token, user: {nickname: user.nickname, createdAt: user.created_at}};
    };

    const limitActions = me => {
        if (!actionLimiter.hit(`u${me.id}`)) throw new HttpError(429, 'Slow down a little and try again soon');
    };

    const getProjectRow = async id => {
        const row = await db.get(`SELECT ${PROJECT_COLUMNS}, p.owner_id FROM projects p
            JOIN users u ON u.id = p.owner_id WHERE p.id = ?`, [id]);
        if (!row) throw new HttpError(404, 'That project doesn\'t exist (anymore)');
        return row;
    };

    const decodeProjectData = data => {
        if (typeof data !== 'string' || !data) throw new HttpError(400, 'The project file is missing');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length > MAX_PROJECT_BYTES) {
            throw new HttpError(413, `Projects can be at most ${MAX_PROJECT_BYTES / 1024 / 1024} MB`);
        }
        // .sb3 files are zip files, which start with "PK"
        if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
            throw new HttpError(400, 'That is not a Scratch project file');
        }
        return bytes;
    };

    /** Refuse uploads that would go over the per-person or total storage limit. */
    const checkQuota = async (me, newBytes, replacingProjectId) => {
        const mine = await db.get('SELECT COALESCE(SUM(size), 0) AS total FROM projects WHERE owner_id = ? AND id <> ?',
            [me.id, replacingProjectId || 0]);
        if (Number(mine.total) + newBytes > USER_QUOTA_BYTES) {
            throw new HttpError(413, `Your projects can use at most ${USER_QUOTA_BYTES / 1024 / 1024} MB in total. ` +
                'Delete an old one to make room');
        }
        const all = await db.get('SELECT COALESCE(SUM(size), 0) AS total FROM projects');
        if (Number(all.total) + newBytes > TOTAL_QUOTA_BYTES) {
            throw new HttpError(507, 'The server is full right now, so new projects can\'t be posted');
        }
    };

    const getStudio = async id => {
        const studio = await db.get(`SELECT s.id, s.title, s.description, s.created_at, s.owner_id, u.nickname AS owner
            FROM studios s JOIN users u ON u.id = s.owner_id WHERE s.id = ?`, [id]);
        if (!studio) throw new HttpError(404, 'That studio doesn\'t exist (anymore)');
        return studio;
    };

    const membership = (studioId, userId) => db.get(
        'SELECT role FROM studio_members WHERE studio_id = ? AND user_id = ?', [studioId, userId]);

    const recentlyDeclined = async (kind, fromId, toId, targetId) => !!await db.get(
        'SELECT 1 AS yes FROM declines WHERE kind = ? AND from_id = ? AND to_id = ? AND target_id = ? AND created_at > ?',
        [kind, fromId, toId, targetId, Date.now() - DECLINE_COOLDOWN_MS]);

    const rememberDecline = async (kind, fromId, toId, targetId) => {
        await db.run('DELETE FROM declines WHERE kind = ? AND from_id = ? AND to_id = ? AND target_id = ?',
            [kind, fromId, toId, targetId]);
        await db.run('INSERT INTO declines (kind, from_id, to_id, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
            [kind, fromId, toId, targetId, Date.now()]);
    };

    // ---- accounts ---------------------------------------------------------

    route('POST', /^\/api\/signup$/, async ({req, body}) => {
        const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!NICKNAME_RE.test(nickname)) {
            throw new HttpError(400, 'Nicknames are 3-20 letters, numbers, - or _');
        }
        const problem = auth.passwordProblem(password, nickname);
        if (problem) throw new HttpError(400, problem);
        if (!signupLimiter.hit(clientIp(req))) throw new HttpError(429, 'Too many new accounts. Try again later');
        if (await findUser(nickname)) throw new HttpError(409, 'That nickname is already taken');
        const passwordHash = await auth.hashPassword(password);
        let user;
        try {
            user = await db.get(
                'INSERT INTO users (nickname, nickname_lower, password_hash, created_at) VALUES (?, ?, ?, ?) ' +
                'RETURNING id, nickname, created_at',
                [nickname, nickname.toLowerCase(), passwordHash, Date.now()]);
        } catch (e) {
            if (isUniqueViolation(e)) throw new HttpError(409, 'That nickname is already taken');
            throw e;
        }
        return [201, await startSession(user)];
    });

    route('POST', /^\/api\/login$/, async ({req, body}) => {
        const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const ip = clientIp(req);
        if (!ipSignInLimiter.hit(ip)) {
            throw new HttpError(429, 'Too many sign-in attempts. Wait a few minutes and try again');
        }
        if (!NICKNAME_RE.test(nickname) || password.length > MAX_PASSWORD) {
            throw new HttpError(401, 'Wrong nickname or password');
        }
        const lower = nickname.toLowerCase();
        const pairKey = `${lower}|${ip}`;
        if (failedByNicknameAndIp.blocked(pairKey) || failedByNickname.blocked(lower)) {
            throw new HttpError(429, 'Too many wrong passwords. Wait a few minutes and try again');
        }
        const user = await db.get('SELECT id, nickname, created_at, password_hash FROM users WHERE nickname_lower = ?',
            [lower]);
        const ok = user ?
            await auth.verifyPassword(password, user.password_hash) :
            await auth.dummyVerify(password);
        if (!ok) {
            failedByNicknameAndIp.hit(pairKey);
            failedByNickname.hit(lower);
            throw new HttpError(401, 'Wrong nickname or password');
        }
        failedByNicknameAndIp.reset(pairKey);
        return [200, await startSession(user)];
    });

    route('POST', /^\/api\/logout$/, async ({req}) => {
        const header = req.headers.authorization || '';
        if (header.startsWith('Bearer ')) {
            await db.run('DELETE FROM sessions WHERE token_hash = ?', [auth.hashToken(header.slice(7).trim())]);
        }
        return [200, {ok: true}];
    });

    route('GET', /^\/api\/me$/, ({me}) => [200, {user: {nickname: me.nickname, createdAt: me.created_at}}],
        {signedIn: true});

    route('GET', /^\/api\/users\/([A-Za-z0-9_-]+)$/, async ({params}) => {
        const user = await requireUser(params[0]);
        const projects = await db.all(`SELECT ${PROJECT_COLUMNS} FROM projects p JOIN users u ON u.id = p.owner_id
            WHERE p.owner_id = ? ORDER BY p.updated_at DESC LIMIT 100`, [user.id]);
        const friends = await db.get('SELECT COUNT(*) AS count FROM friendships WHERE user_id = ?', [user.id]);
        return [200, {
            user: {nickname: user.nickname, createdAt: user.created_at},
            friendCount: Number(friends.count),
            projects: projects.map(projectSummary)
        }];
    });

    // ---- projects ---------------------------------------------------------

    route('GET', /^\/api\/projects$/, async ({url}) => {
        const offset = Math.max(0, Math.min(10000, parseInt(url.searchParams.get('offset'), 10) || 0));
        const rows = await db.all(`SELECT ${PROJECT_COLUMNS} FROM projects p JOIN users u ON u.id = p.owner_id
            ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`, [PAGE_SIZE, offset]);
        return [200, {projects: rows.map(projectSummary)}];
    });

    route('POST', /^\/api\/projects$/, async ({me, body}) => {
        if (!postLimiter.hit(`u${me.id}`)) throw new HttpError(429, 'You posted a lot! Try again later');
        const title = cleanText(body.title, MAX_TITLE, 'title', true);
        const description = cleanText(body.description, MAX_DESCRIPTION, 'description', false);
        const data = decodeProjectData(body.data);
        await checkQuota(me, data.length, 0);
        const now = Date.now();
        const row = await db.get(`INSERT INTO projects (owner_id, title, description, data, size, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, [me.id, title, description, data, data.length, now, now]);
        return [201, {project: projectSummary(await getProjectRow(row.id))}];
    }, {signedIn: true, maxBody: PROJECT_BODY_BYTES});

    route('GET', /^\/api\/projects\/(\d+)$/, async ({params}) => (
        [200, {project: projectSummary(await getProjectRow(Number(params[0])))}]
    ));

    route('GET', /^\/api\/projects\/(\d+)\/file$/, async ({req, params, res}) => {
        if (!downloadLimiter.hit(clientIp(req))) throw new HttpError(429, 'Too many downloads. Try again soon');
        const id = Number(params[0]);
        const meta = await db.get('SELECT updated_at FROM projects WHERE id = ?', [id]);
        if (!meta) throw new HttpError(404, 'That project doesn\'t exist (anymore)');
        const etag = `"p${id}-${meta.updated_at}"`;
        const headers = Object.assign({
            'ETag': etag,
            'Cache-Control': 'public, max-age=60',
            'X-Content-Type-Options': 'nosniff'
        }, CORS_HEADERS);
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, headers);
            res.end();
            return null;
        }
        const row = await db.get('SELECT data FROM projects WHERE id = ?', [id]);
        if (!row) throw new HttpError(404, 'That project doesn\'t exist (anymore)');
        res.writeHead(200, Object.assign({
            'Content-Type': 'application/x.scratch.sb3',
            'Content-Length': row.data.length
        }, headers));
        res.end(row.data);
        return null;
    });

    route('PUT', /^\/api\/projects\/(\d+)$/, async ({me, body, params}) => {
        const project = await getProjectRow(Number(params[0]));
        if (project.owner_id !== me.id) throw new HttpError(403, 'Only the person who posted this can change it');
        if (!postLimiter.hit(`u${me.id}`)) throw new HttpError(429, 'You saved a lot! Try again later');
        const title = body.title === undefined ? project.title : cleanText(body.title, MAX_TITLE, 'title', true);
        const description = body.description === undefined ?
            project.description :
            cleanText(body.description, MAX_DESCRIPTION, 'description', false);
        const now = Date.now();
        if (body.data === undefined) {
            await db.run('UPDATE projects SET title = ?, description = ?, updated_at = ? WHERE id = ?',
                [title, description, now, project.id]);
        } else {
            const data = decodeProjectData(body.data);
            await checkQuota(me, data.length, project.id);
            await db.run('UPDATE projects SET title = ?, description = ?, data = ?, size = ?, updated_at = ? WHERE id = ?',
                [title, description, data, data.length, now, project.id]);
        }
        return [200, {project: projectSummary(await getProjectRow(project.id))}];
    }, {signedIn: true, maxBody: PROJECT_BODY_BYTES});

    route('DELETE', /^\/api\/projects\/(\d+)$/, async ({me, params}) => {
        const project = await getProjectRow(Number(params[0]));
        if (project.owner_id !== me.id) throw new HttpError(403, 'Only the person who posted this can delete it');
        await db.tx(async t => {
            await t.run('DELETE FROM studio_projects WHERE project_id = ?', [project.id]);
            await t.run('DELETE FROM projects WHERE id = ?', [project.id]);
        });
        return [200, {ok: true}];
    }, {signedIn: true});

    // ---- friends ----------------------------------------------------------

    route('GET', /^\/api\/friends$/, async ({me}) => {
        const friends = await db.all(`SELECT u.nickname, f.created_at FROM friendships f
            JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.nickname_lower`, [me.id]);
        const incoming = await db.all(`SELECT r.id, u.nickname, r.created_at FROM friend_requests r
            JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC`, [me.id]);
        const outgoing = await db.all(`SELECT r.id, u.nickname, r.created_at FROM friend_requests r
            JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC`, [me.id]);
        const map = row => ({id: row.id, nickname: row.nickname, createdAt: row.created_at});
        return [200, {
            friends: friends.map(row => ({nickname: row.nickname, since: row.created_at})),
            incoming: incoming.map(map),
            outgoing: outgoing.map(map)
        }];
    }, {signedIn: true});

    const makeFriends = (t, a, b) => {
        const now = Date.now();
        return Promise.all([
            t.run('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
                [a, b, now]),
            t.run('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
                [b, a, now]),
            t.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)',
                [a, b, b, a])
        ]);
    };

    route('POST', /^\/api\/friends\/requests$/, async ({me, body}) => {
        limitActions(me);
        const other = await requireUser(body.nickname);
        if (other.id === me.id) throw new HttpError(400, 'You can\'t add yourself as a friend');
        const already = await db.get('SELECT 1 AS yes FROM friendships WHERE user_id = ? AND friend_id = ?',
            [me.id, other.id]);
        if (already) return [200, {status: 'friends'}];
        const theyAsked = await db.get('SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ?',
            [other.id, me.id]);
        if (theyAsked) {
            // They already asked us, so this counts as saying yes.
            await db.tx(t => makeFriends(t, me.id, other.id));
            return [200, {status: 'friends'}];
        }
        if (!await recentlyDeclined('friend', me.id, other.id, 0)) {
            await db.run('INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?) ' +
                'ON CONFLICT DO NOTHING', [me.id, other.id, Date.now()]);
        }
        // Same answer either way, so nobody learns they were declined.
        return [201, {status: 'requested'}];
    }, {signedIn: true});

    route('POST', /^\/api\/friends\/requests\/(\d+)\/accept$/, async ({me, params}) => {
        limitActions(me);
        const request = await db.get('SELECT id, from_id FROM friend_requests WHERE id = ? AND to_id = ?',
            [Number(params[0]), me.id]);
        if (!request) throw new HttpError(404, 'That friend request isn\'t there anymore');
        await db.tx(t => makeFriends(t, me.id, request.from_id));
        return [200, {status: 'friends'}];
    }, {signedIn: true});

    route('POST', /^\/api\/friends\/requests\/(\d+)\/decline$/, async ({me, params}) => {
        const request = await db.get('SELECT id, from_id, to_id FROM friend_requests WHERE id = ? AND (to_id = ? OR from_id = ?)',
            [Number(params[0]), me.id, me.id]);
        if (!request) return [200, {ok: true}];
        await db.run('DELETE FROM friend_requests WHERE id = ?', [request.id]);
        if (request.to_id === me.id) await rememberDecline('friend', request.from_id, me.id, 0);
        return [200, {ok: true}];
    }, {signedIn: true});

    route('DELETE', /^\/api\/friends\/([A-Za-z0-9_-]+)$/, async ({me, params}) => {
        const other = await requireUser(params[0]);
        await db.run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [me.id, other.id, other.id, me.id]);
        return [200, {ok: true}];
    }, {signedIn: true});

    // ---- studios ----------------------------------------------------------

    route('GET', /^\/api\/studios$/, async ({me}) => {
        const studios = await db.all(`SELECT s.id, s.title, s.description, s.created_at, m.role, o.nickname AS owner
            FROM studio_members m JOIN studios s ON s.id = m.studio_id JOIN users o ON o.id = s.owner_id
            WHERE m.user_id = ? ORDER BY s.created_at DESC`, [me.id]);
        const invites = await db.all(`SELECT i.id, i.created_at, s.id AS studio_id, s.title AS studio_title,
            u.nickname AS from_nickname FROM studio_invites i JOIN studios s ON s.id = i.studio_id
            JOIN users u ON u.id = i.from_id WHERE i.to_id = ? ORDER BY i.created_at DESC`, [me.id]);
        return [200, {
            studios: studios.map(s => ({
                id: s.id,
                title: s.title,
                description: s.description,
                owner: s.owner,
                role: s.role,
                createdAt: s.created_at
            })),
            invites: invites.map(i => ({
                id: i.id,
                studio: {id: i.studio_id, title: i.studio_title},
                from: i.from_nickname,
                createdAt: i.created_at
            }))
        }];
    }, {signedIn: true});

    route('POST', /^\/api\/studios$/, async ({me, body}) => {
        limitActions(me);
        const title = cleanText(body.title, MAX_STUDIO_TITLE, 'studio name', true);
        const description = cleanText(body.description, MAX_DESCRIPTION, 'description', false);
        const now = Date.now();
        const studio = await db.tx(async t => {
            const row = await t.get('INSERT INTO studios (owner_id, title, description, created_at) VALUES (?, ?, ?, ?) ' +
                'RETURNING id', [me.id, title, description, now]);
            await t.run('INSERT INTO studio_members (studio_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
                [row.id, me.id, 'owner', now]);
            return row;
        });
        return [201, {studio: {id: studio.id, title, description, owner: me.nickname, role: 'owner', createdAt: now}}];
    }, {signedIn: true});

    route('GET', /^\/api\/studios\/(\d+)$/, async ({params}) => {
        const studio = await getStudio(Number(params[0]));
        const members = await db.all(`SELECT u.nickname, m.role FROM studio_members m JOIN users u ON u.id = m.user_id
            WHERE m.studio_id = ? ORDER BY m.joined_at`, [studio.id]);
        const projects = await db.all(`SELECT ${PROJECT_COLUMNS}, a.nickname AS added_by FROM studio_projects sp
            JOIN projects p ON p.id = sp.project_id JOIN users u ON u.id = p.owner_id
            JOIN users a ON a.id = sp.added_by WHERE sp.studio_id = ? ORDER BY sp.added_at DESC`, [studio.id]);
        return [200, {
            studio: {
                id: studio.id,
                title: studio.title,
                description: studio.description,
                owner: studio.owner,
                createdAt: studio.created_at
            },
            members: members.map(m => ({nickname: m.nickname, role: m.role})),
            projects: projects.map(p => Object.assign(projectSummary(p), {addedBy: p.added_by}))
        }];
    });

    route('POST', /^\/api\/studios\/(\d+)\/invites$/, async ({me, body, params}) => {
        limitActions(me);
        const studio = await getStudio(Number(params[0]));
        if (studio.owner_id !== me.id) throw new HttpError(403, 'Only the studio\'s owner can invite people');
        const other = await requireUser(body.nickname);
        if (await membership(studio.id, other.id)) throw new HttpError(409, `${other.nickname} is already in this studio`);
        if (!await recentlyDeclined('studio', me.id, other.id, studio.id)) {
            await db.run('INSERT INTO studio_invites (studio_id, from_id, to_id, created_at) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT DO NOTHING', [studio.id, me.id, other.id, Date.now()]);
        }
        return [201, {status: 'invited'}];
    }, {signedIn: true});

    route('POST', /^\/api\/studios\/invites\/(\d+)\/accept$/, async ({me, params}) => {
        const invite = await db.get('SELECT id, studio_id FROM studio_invites WHERE id = ? AND to_id = ?',
            [Number(params[0]), me.id]);
        if (!invite) throw new HttpError(404, 'That invite isn\'t there anymore');
        await getStudio(invite.studio_id);
        await db.tx(async t => {
            await t.run('DELETE FROM studio_invites WHERE id = ?', [invite.id]);
            await t.run('INSERT INTO studio_members (studio_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ' +
                'ON CONFLICT DO NOTHING', [invite.studio_id, me.id, 'member', Date.now()]);
        });
        return [200, {status: 'member', studioId: invite.studio_id}];
    }, {signedIn: true});

    route('POST', /^\/api\/studios\/invites\/(\d+)\/decline$/, async ({me, params}) => {
        const invite = await db.get('SELECT id, studio_id, from_id, to_id FROM studio_invites WHERE id = ? AND ' +
            '(to_id = ? OR from_id = ?)', [Number(params[0]), me.id, me.id]);
        if (!invite) return [200, {ok: true}];
        await db.run('DELETE FROM studio_invites WHERE id = ?', [invite.id]);
        if (invite.to_id === me.id) await rememberDecline('studio', invite.from_id, me.id, invite.studio_id);
        return [200, {ok: true}];
    }, {signedIn: true});

    route('POST', /^\/api\/studios\/(\d+)\/projects$/, async ({me, body, params}) => {
        limitActions(me);
        const studio = await getStudio(Number(params[0]));
        if (!await membership(studio.id, me.id)) throw new HttpError(403, 'Only studio members can add projects');
        const project = await getProjectRow(Number(body.projectId));
        await db.run('INSERT INTO studio_projects (studio_id, project_id, added_by, added_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT DO NOTHING', [studio.id, project.id, me.id, Date.now()]);
        return [201, {status: 'added'}];
    }, {signedIn: true});

    route('DELETE', /^\/api\/studios\/(\d+)\/projects\/(\d+)$/, async ({me, params}) => {
        const studio = await getStudio(Number(params[0]));
        const link = await db.get('SELECT added_by FROM studio_projects WHERE studio_id = ? AND project_id = ?',
            [studio.id, Number(params[1])]);
        if (!link) return [200, {ok: true}];
        const project = await db.get('SELECT owner_id FROM projects WHERE id = ?', [Number(params[1])]);
        const isAuthor = project && project.owner_id === me.id;
        const addedItAndStillMember = link.added_by === me.id && await membership(studio.id, me.id);
        if (studio.owner_id !== me.id && !isAuthor && !addedItAndStillMember) {
            throw new HttpError(403, 'Only the studio owner, the project\'s author or whoever added it can remove it');
        }
        await db.run('DELETE FROM studio_projects WHERE studio_id = ? AND project_id = ?', [studio.id, Number(params[1])]);
        return [200, {ok: true}];
    }, {signedIn: true});

    route('DELETE', /^\/api\/studios\/(\d+)\/members\/([A-Za-z0-9_-]+)$/, async ({me, params}) => {
        const studio = await getStudio(Number(params[0]));
        const other = await requireUser(params[1]);
        const leavingMyself = other.id === me.id;
        if (leavingMyself && studio.owner_id === me.id) {
            throw new HttpError(400, 'The owner can\'t leave; delete the studio instead');
        }
        if (!leavingMyself && studio.owner_id !== me.id) {
            throw new HttpError(403, 'Only the studio\'s owner can remove people');
        }
        await db.run('DELETE FROM studio_members WHERE studio_id = ? AND user_id = ?', [studio.id, other.id]);
        return [200, {ok: true}];
    }, {signedIn: true});

    route('DELETE', /^\/api\/studios\/(\d+)$/, async ({me, params}) => {
        const studio = await getStudio(Number(params[0]));
        if (studio.owner_id !== me.id) throw new HttpError(403, 'Only the studio\'s owner can delete it');
        await db.tx(async t => {
            await t.run('DELETE FROM studio_projects WHERE studio_id = ?', [studio.id]);
            await t.run('DELETE FROM studio_invites WHERE studio_id = ?', [studio.id]);
            await t.run('DELETE FROM studio_members WHERE studio_id = ?', [studio.id]);
            await t.run('DELETE FROM studios WHERE id = ?', [studio.id]);
        });
        return [200, {ok: true}];
    }, {signedIn: true});

    // ---- dispatch ---------------------------------------------------------

    const cleanupTimer = setInterval(() => {
        db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(() => {});
    }, 60 * 60 * 1000);
    cleanupTimer.unref();

    const handle = async (req, res) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }
        const url = new URL(req.url, 'http://localhost');
        const candidates = routes.filter(r => r.pattern.test(url.pathname));
        const match = candidates.find(r => r.method === req.method);
        try {
            if (!match) {
                throw new HttpError(candidates.length ? 405 : 404, 'Not found');
            }
            const params = url.pathname.match(match.pattern).slice(1);
            // Check who's asking before reading (possibly large) request bodies.
            const me = await currentUser(req);
            if (match.signedIn && !me) throw new HttpError(401, 'Please sign in first');
            const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req, match.maxBody) : {};
            const result = await match.handler({req, res, url, params, body, me});
            if (result) sendJson(res, result[0], result[1]);
        } catch (e) {
            if (e instanceof HttpError) {
                sendJson(res, e.status, {error: e.message});
            } else {
                log('[api] error', e && e.stack ? e.stack : e);
                sendJson(res, 500, {error: 'Something went wrong on the server'});
            }
        }
    };

    return {handle};
};

module.exports = {createCommunityApi};
