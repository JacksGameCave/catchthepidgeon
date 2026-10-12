#!/usr/bin/env node
/**
 * Pigeon Patrol - tiny high score server (Node standard library only, no npm install).
 *
 * Run:
 *     node server.js
 * Then open:  http://localhost:8000
 *
 * The leaderboard is persisted to `highscores.json` next to this file, so scores
 * survive server restarts. The file is a plain JSON array:
 *
 *     [
 *       { "name": "ACE", "score": 12450, "hits": 87, "accuracy": 72, "combo": 9, "date": "2026-02-14" }
 *     ]
 *
 * Endpoints:
 *     GET  /api/scores  -> { "scores": [ ...top 10, best first... ] }
 *     POST /api/scores  -> JSON body {name, score, hits, accuracy, combo}; saves & returns updated top 10
 *     GET  /healthz     -> { ok: true } (for hosting health checks)
 *
 * How scores survive hosting with TEMPORARY storage (e.g. Render free tier):
 *   - The server keeps scores in highscores.json locally. On hosts with an
 *     ephemeral filesystem that file is only a working cache - it is lost when
 *     the instance spins down (~10 min idle) or redeploys.
 *   - GITHUB is the durable copy. When GITHUB_TOKEN + GITHUB_REPO are set, every
 *     score update is committed & pushed back to the repo (debounced), and on
 *     startup the server PULLS the latest highscores.json from the repo - so scores
 *     survive spin-down/wake cycles. One instance assumed (no locking needed).
 *   - Pushes MERGE with the remote file first, so a wiped instance can never
 *     clobber scores that only exist on GitHub.
 *   - GITHUB_BRANCH / GITHUB_PATH choose where the file lives; GITHUB_API_BASE
 *     points at a GitHub Enterprise API (default: api.github.com).
 *   - If the game is hosted on GitHub Pages it can read highscores.json straight
 *     from the repo. Pages caches a few minutes, so a fresh commit may take
 *     ~1-10 min to appear there.
 *
 * Without GitHub config the server still works using just the local file.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 8000;
const BASE_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || BASE_DIR;
const SCORE_FILE = path.join(DATA_DIR, 'highscores.json');
const DEFAULT_PAGE = path.join(BASE_DIR, 'PidgeonShooter.html');

// GitHub is the durable copy of the score board (the local file is a temporary
// cache). GITHUB_TOKEN: fine-grained PAT with "Contents: Read and write" for that repo.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';          // e.g. "myuser/birdshooter"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_PATH = process.env.GITHUB_PATH || 'highscores.json';
const GITHUB_API = process.env.GITHUB_API_BASE || 'https://api.github.com';
const useGitHub = Boolean(GITHUB_TOKEN && GITHUB_REPO);
const MAX_STORED = 100;   // entries kept in the file
const TOP_N = 10;         // entries returned to the game

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// --- highscores.json reading & writing ------------------------------

function normalize(entries) {
    const list = Array.isArray(entries) ? entries : (Array.isArray(entries && entries.scores) ? entries.scores : []);
    return list
        .filter(e => e && typeof e === 'object')
        .map(e => ({
            name: String(e.name || 'ACE').slice(0, 20),
            score: cleanInt(e.score),
            hits: cleanInt(e.hits),
            accuracy: cleanInt(e.accuracy, 0, 100),
            combo: cleanInt(e.combo),
            date: String(e.date || ''),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_STORED);
}

function mergeEntries(...lists) {
    // Union of score lists, de-duplicated, best first. Used to combine what the
    // local cache has with what the GitHub copy has.
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const e of list) {
            const key = `${e.name}|${e.score}|${e.hits}|${e.accuracy}|${e.combo}|${e.date}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(e);
        }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, MAX_STORED);
}

function readScores() {
    try {
        return normalize(JSON.parse(fs.readFileSync(SCORE_FILE, 'utf8')));
    } catch (err) {
        return [];
    }
}

function writeScores(entries) {
    const trimmed = normalize(entries);
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SCORE_FILE, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.error('Could not write score file:', err.message);
    }
    return trimmed;
}

// --- GitHub sync ------------------------------------------------------
// Commits the updated score board into the GitHub repo via the REST API (no git
// binary needed). Commits are debounced and queued, so bursts of score
// submissions collapse into a single commit.

let ghSyncStatus = 'idle';
let ghSyncTimer = null;
let ghSyncing = false;
let ghSyncQueued = false;
let ghLastPushed = '';

function ghHeaders() {
    return {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

function ghContentsUrl() {
    const encodedPath = GITHUB_PATH.split('/').map(encodeURIComponent).join('/');
    return `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${encodedPath}`;
}

async function pullScoresFromGitHub() {
    const res = await fetch(`${ghContentsUrl()}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
        headers: ghHeaders(),
        signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return []; // file not in the repo yet
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const info = await res.json();
    if (!info.content) return [];
    return normalize(JSON.parse(Buffer.from(info.content, 'base64').toString('utf8')));
}

async function pushScoresToGitHub(localEntries, attempt = 0) {
    // Current file SHA is required when updating an existing file. We also read
    // the remote entries and MERGE them with ours, so a restarted instance with an
    // empty cache can never clobber scores that only exist on GitHub.
    let sha;
    let remoteEntries = [];
    const getRes = await fetch(`${ghContentsUrl()}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
        headers: ghHeaders(),
        signal: AbortSignal.timeout(10000),
    });
    if (getRes.ok) {
        const info = await getRes.json();
        sha = info.sha;
        if (info.content) {
            try {
                remoteEntries = normalize(JSON.parse(Buffer.from(info.content, 'base64').toString('utf8')));
            } catch (err) { /* unparsable remote file: keep our local entries */ }
        }
    }

    const merged = mergeEntries(remoteEntries, localEntries);
    const content = JSON.stringify(merged, null, 2) + '\n';
    if (content === ghLastPushed) return merged;

    const putRes = await fetch(ghContentsUrl(), {
        method: 'PUT',
        headers: ghHeaders(),
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
            message: `Update high scores (${new Date().toISOString().slice(0, 19).replace('T', ' ')})`,
            content: Buffer.from(content, 'utf8').toString('base64'),
            branch: GITHUB_BRANCH,
            ...(sha ? { sha } : {}),
        }),
    });

    if (!putRes.ok) {
        const detail = (await putRes.text()).slice(0, 200);
        // 409/422 usually means the file changed between our GET and PUT - retry
        if ((putRes.status === 409 || putRes.status === 422) && attempt < 2) {
            return pushScoresToGitHub(localEntries, attempt + 1);
        }
        throw new Error(`GitHub API ${putRes.status}: ${detail}`);
    }

    ghLastPushed = content;
    writeScores(merged); // keep the local cache aligned with what we pushed
    return merged;
}

function scheduleGitHubSync() {
    if (!useGitHub) return;
    if (ghSyncTimer) clearTimeout(ghSyncTimer);
    ghSyncTimer = setTimeout(runGitHubSync, 2000); // debounce bursts of scores
}

async function runGitHubSync() {
    ghSyncTimer = null;
    if (ghSyncing) { ghSyncQueued = true; return; }
    ghSyncing = true;
    ghSyncStatus = 'syncing';
    try {
        await pushScoresToGitHub(await readScores());
        ghSyncStatus = `synced ${new Date().toISOString().slice(11, 19)}`;
        console.log(`[github] scores pushed to ${GITHUB_REPO}@${GITHUB_BRANCH}:${GITHUB_PATH}`);
    } catch (err) {
        ghSyncStatus = `error: ${err.message}`;
        console.error('[github] sync failed:', err.message);
    } finally {
        ghSyncing = false;
        if (ghSyncQueued) {
            ghSyncQueued = false;
            scheduleGitHubSync();
        }
    }
}

function cleanName(raw) {
    const name = String(raw || '')
        .replace(/[|\r\n\t]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (name || 'ACE').slice(0, 20);
}

function cleanInt(value, lo = 0, hi = 1e9) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return 0;
    return Math.max(lo, Math.min(hi, n));
}

// --- HTTP plumbing --------------------------------------------------

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendFile(res, filePath) {
    fs.readFile(filePath, (err, body) => {
        if (err) {
            sendJSON(res, 404, { error: 'not found' });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
            'Content-Length': body.length,
        });
        res.end(body);
    });
}

async function handleScoresGet(res) {
    const scores = await readScores();
    sendJSON(res, 200, { scores: scores.slice(0, TOP_N) });
}

async function handleScoresPost(req, res) {
    let chunks = [];
    req.on('data', chunk => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 64 * 1024) req.destroy(); // refuse huge bodies
    });
    req.on('end', async () => {
        let data;
        try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (err) {
            sendJSON(res, 400, { error: 'invalid JSON body' });
            return;
        }

        const entry = {
            name: cleanName(data.name),
            score: cleanInt(data.score),
            hits: cleanInt(data.hits),
            accuracy: cleanInt(data.accuracy, 0, 100),
            combo: cleanInt(data.combo),
            date: new Date().toISOString().slice(0, 10),
        };

        const scores = await readScores();
        scores.push(entry);
        scores.sort((a, b) => b.score - a.score);
        const saved = await writeScores(scores);
        scheduleGitHubSync();

        sendJSON(res, 200, { scores: saved.slice(0, TOP_N), saved: entry });
    });
}

const server = http.createServer((req, res) => {
    cors(res);

    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Content-Length': '0' });
        res.end();
        return;
    }

    if (urlPath === '/healthz') {
        sendJSON(res, 200, {
            ok: true,
            store: 'file (temporary cache)',
            github: useGitHub ? ghSyncStatus : 'off',
        });
        return;
    }

    if (urlPath === '/api/scores') {
        if (req.method === 'GET') return handleScoresGet(res);
        if (req.method === 'POST') return handleScoresPost(req, res);
        sendJSON(res, 405, { error: 'method not allowed' });
        return;
    }

    if (req.method !== 'GET') {
        sendJSON(res, 405, { error: 'method not allowed' });
        return;
    }

    // Static files: the game itself (default page: PidgeonShooter.html)
    const rel = urlPath.replace(/^\/+/, '') || 'PidgeonShooter.html';
    const target = path.resolve(BASE_DIR, rel);
    const safeTarget = target.startsWith(path.resolve(BASE_DIR) + path.sep) ? target : DEFAULT_PAGE;
    sendFile(res, fs.existsSync(safeTarget) && fs.statSync(safeTarget).isFile() ? safeTarget : DEFAULT_PAGE);
});

if (!fs.existsSync(SCORE_FILE)) writeScores([]);

async function boot() {
    // Restore the score board from GitHub BEFORE accepting traffic. This is what
    // brings scores back after a temporary-storage host (e.g. Render free tier)
    // spins the instance down and later rebuilds it on the next visitor.
    if (useGitHub) {
        try {
            const remote = await pullScoresFromGitHub();
            const restored = writeScores(mergeEntries(readScores(), remote));
            ghLastPushed = JSON.stringify(restored, null, 2) + '\n';
            ghSyncStatus = `restored ${restored.length} from github`;
            console.log(`[github] restored ${restored.length} score(s) from ${GITHUB_REPO}@${GITHUB_BRANCH}:${GITHUB_PATH}`);
        } catch (err) {
            ghSyncStatus = `boot pull failed: ${err.message}`;
            console.error('[github] boot pull failed (starting with local cache):', err.message);
        }
    }

    server.listen(PORT, HOST, () => {
        console.log('====================================================');
        console.log('  Pigeon Patrol server');
        console.log(`  Game:         http://localhost:${PORT}`);
        console.log(`  Score cache:  ${SCORE_FILE}`);
        console.log(`  GitHub copy:  ${useGitHub ? `${GITHUB_REPO}@${GITHUB_BRANCH}:${GITHUB_PATH}` : 'off (set GITHUB_TOKEN + GITHUB_REPO to enable)'}`);
        console.log('  Press Ctrl+C to stop');
        console.log('====================================================');
    });
}

boot();