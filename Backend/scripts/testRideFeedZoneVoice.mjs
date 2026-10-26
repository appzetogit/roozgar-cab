// Smoke test for Ride Feed zone filter + voice posts, against a THROWAWAY Mongo.
//   FEED_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 node scripts/testRideFeedZoneVoice.mjs
// Drops its own database (feed_zone_voice_test) when done. Never point it at production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const uri = process.env.FEED_TEST_MONGODB_URI;
if (!uri) throw new Error('Set FEED_TEST_MONGODB_URI to a throwaway Mongo');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-voice-'));
Object.assign(process.env, {
  MONGODB_URI: uri,
  MONGODB_DB_NAME: 'feed_zone_voice_test',
  JWT_SECRET: 'test-secret',
  UPLOAD_DIR: uploadDir,
  PUBLIC_BACKEND_URL: 'http://test.local',
  FIREBASE_SERVICE_ACCOUNT_JSON: '', // no real pushes from the overdue sweep
  FIREBASE_DATABASE_URL: '',
});

const { default: mongoose } = await import('mongoose');
const { default: express } = await import('express');
const { feedRouter } = await import('../src/modules/taxi/feed/routes/feedRoutes.js');
const { errorHandler } = await import('../src/modules/taxi/middlewares/errorMiddleware.js');
const { signAccessToken } = await import('../src/modules/taxi/services/tokenService.js');
const { RidePost } = await import('../src/modules/taxi/feed/models/RidePost.js');
const { sweepOverduePosts, removePost, setFeedBan } = await import('../src/modules/taxi/feed/services/feedService.js');

await mongoose.connect(uri, { dbName: 'feed_zone_voice_test' });
await mongoose.connection.dropDatabase();

const app = express();
app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use('/api/v1', feedRouter);
app.use(errorHandler);
const server = http.createServer(app).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const objectId = () => new mongoose.Types.ObjectId();
const INDORE = objectId();
const KARNATAKA = objectId();

const makeDriver = async (name, zoneId, extra = {}) => {
  const _id = objectId();
  await mongoose.connection.collection('taxidrivers').insertOne({
    _id, name, phone: `98${Math.floor(Math.random() * 1e8)}`, zoneId, approve: true, status: 'approved', ...extra,
  });
  return { id: String(_id), token: signAccessToken({ sub: String(_id), role: 'driver' }) };
};

const call = async (driver, method, url, body) => {
  const headers = { Authorization: `Bearer ${driver.token}` };
  const init = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`${base}/api/v1${url}`, init);
  return { status: res.status, json: await res.json().catch(() => null) };
};

const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const textPost = (extra = {}) => ({ pickup: 'A', drop: 'B', price: 500, passengers: 2, dateTime: inHours(3), ...extra });
const m4a = (size = 1000) => { const b = Buffer.alloc(size); b.write('ftyp', 4); b.write('M4A ', 8); return b; };
const voiceForm = ({ file = m4a(), mime = 'audio/mp4', durationSec = '20', dateTime = inHours(3) } = {}) => {
  const f = new FormData();
  if (file) f.append('audio', new Blob([file], { type: mime }), 'rec.m4a');
  if (durationSec !== null) f.append('durationSec', durationSec);
  if (dateTime) f.append('dateTime', dateTime);
  return f;
};
const ids = async (driver, query = '') => (await call(driver, 'GET', `/feed/posts${query}`)).json.data.results.map((p) => p.id);
const diskPath = (url) => path.join(uploadDir, url.slice(url.indexOf('/uploads/') + '/uploads/'.length));

const indoreA = await makeDriver('Indore A', INDORE);
const indoreB = await makeDriver('Indore B', INDORE);
const karnatakaC = await makeDriver('Karnataka C', KARNATAKA);
const noZoneD = await makeDriver('No zone D', null);
const banned = await makeDriver('Banned', INDORE, { feedBanned: true });
const busy = await makeDriver('Busy', INDORE);

// ---- Part 1: zone ----
const aPost = (await call(indoreA, 'POST', '/feed/posts', textPost())).json.data;
assert.equal((await RidePost.findById(aPost.id)).zoneId.toString(), INDORE.toString(), 'post stores poster zone');
assert.ok((await ids(indoreB)).includes(aPost.id), 'same-zone driver sees it');
assert.ok(!(await ids(karnatakaC)).includes(aPost.id), 'other-zone driver does not');
assert.ok((await ids(noZoneD)).includes(aPost.id), 'viewer without zone sees everything');

const cPost = (await call(karnatakaC, 'POST', '/feed/posts', textPost())).json.data;
assert.ok(!(await ids(indoreA)).includes(cPost.id), 'Karnataka post hidden from Indore');

const old = await RidePost.collection.insertOne({
  postedBy: objectId(), ownerName: 'Old', phone: '9', pickup: 'x', drop: 'y', price: 100, passengers: 1,
  dateTime: new Date(Date.now() + 3600e3), status: 'active', createdAt: new Date(), updatedAt: new Date(),
});
const oldId = String(old.insertedId);
assert.ok((await ids(indoreA)).includes(oldId) && (await ids(karnatakaC)).includes(oldId), 'zoneless post is visible to all');

const outstation = (await call(indoreA, 'POST', '/feed/posts', textPost({ price: 1500 }))).json.data;
const out = (await call(indoreB, 'GET', '/feed/posts?filter=outstation')).json.data;
assert.ok(out.results.some((p) => p.id === outstation.id), 'outstation works with zone filter');
assert.ok(!(await ids(karnatakaC, '?filter=outstation')).includes(outstation.id));
for (const f of ['today', 'tomorrow']) assert.equal((await call(indoreB, 'GET', `/feed/posts?filter=${f}`)).status, 200);
const page = (await call(indoreB, 'GET', '/feed/posts?limit=1')).json.data;
const everything = await ids(indoreB);
assert.equal(page.pagination.total, everything.length, 'total matches the filtered list');
assert.equal(page.pagination.hasMore, everything.length > 1);

// ---- Part 2: voice ----
assert.equal((await call(indoreA, 'POST', '/feed/posts/voice', voiceForm())).status, 201);
const voice = (await call(indoreA, 'POST', '/feed/posts/voice', voiceForm({ durationSec: '20' }))).json.data;
assert.ok(voice.audioUrl.startsWith('http://test.local/uploads/') && voice.audioUrl.endsWith('.m4a'));
assert.equal(voice.audioDurationSec, 20);
assert.deepEqual([voice.pickup, voice.drop, voice.price, voice.passengers], ['', '', 0, 1]);
assert.ok(fs.existsSync(diskPath(voice.audioUrl)), 'file stored');

const ranged = await fetch(voice.audioUrl.replace('http://test.local', base), { headers: { Range: 'bytes=0-9' } });
assert.equal(ranged.status, 206, 'audio supports Range');
assert.equal(ranged.headers.get('content-type'), 'audio/mp4');

assert.ok((await ids(indoreB)).includes(voice.id), 'voice post visible in zone');
assert.ok(!(await ids(karnatakaC)).includes(voice.id), 'voice post hidden from other zone');
assert.ok(!(await ids(indoreB, '?filter=outstation')).includes(voice.id), 'voice post not in outstation');
assert.equal((await call(indoreB, 'GET', '/feed/posts')).json.data.results.find((p) => p.id === voice.id).audioUrl, voice.audioUrl);
assert.equal((await RidePost.findById(voice.id)).zoneId.toString(), INDORE.toString());

const rejected = async (label, form, status) => {
  const before = fs.readdirSync(uploadDir).length;
  const res = await call(indoreA, 'POST', '/feed/posts/voice', form);
  assert.equal(res.status, status, `${label}: ${JSON.stringify(res.json)}`);
  assert.equal(fs.readdirSync(uploadDir).length, before, `${label}: no file left behind`);
};
await rejected('2 s', voiceForm({ durationSec: '2' }), 422);
await rejected('301 s', voiceForm({ durationSec: '301' }), 422);
await rejected('no duration', voiceForm({ durationSec: null }), 422);
await rejected('past time', voiceForm({ dateTime: new Date(Date.now() - 60e3).toISOString() }), 422);
await rejected('not audio mime', voiceForm({ mime: 'text/plain' }), 422);
await rejected('audio mime, garbage bytes', voiceForm({ file: Buffer.alloc(500, 1) }), 422);
await rejected('no file', voiceForm({ file: null }), 422);
await rejected('over 2 MB', voiceForm({ file: m4a(2 * 1024 * 1024 + 10) }), 413);

assert.equal((await fetch(`${base}/api/v1/feed/posts/voice`, { method: 'POST', body: voiceForm() })).status, 401);
assert.equal((await call(banned, 'POST', '/feed/posts/voice', voiceForm())).json.code, 'FEED_BANNED');
for (let i = 0; i < 10; i += 1) await call(busy, 'POST', '/feed/posts', textPost());
const limited = await call(busy, 'POST', '/feed/posts/voice', voiceForm());
assert.deepEqual([limited.status, limited.json.code], [429, 'ACTIVE_LIMIT']);

// typed posts still validate as before
assert.equal((await call(indoreA, 'POST', '/feed/posts', textPost({ pickup: '' }))).status, 422);

// lifecycle: audio is deleted on delete, expiry, admin removal and ban
const fresh = async () => (await call(indoreA, 'POST', '/feed/posts/voice', voiceForm())).json.data;

const toDelete = await fresh();
assert.equal((await call(indoreA, 'DELETE', `/feed/posts/${toDelete.id}`)).status, 200);
assert.ok(!fs.existsSync(diskPath(toDelete.audioUrl)), 'deleted post frees its audio');

const toExpire = await fresh();
await RidePost.updateOne({ _id: toExpire.id }, { $set: { status: 'needs_update', dateTime: new Date(Date.now() - 25 * 3600e3) } });
await sweepOverduePosts();
assert.equal((await RidePost.findById(toExpire.id)).status, 'expired');
assert.ok(!fs.existsSync(diskPath(toExpire.audioUrl)), 'expired post frees its audio');

const toRemove = await fresh();
await removePost(toRemove.id);
assert.ok(!fs.existsSync(diskPath(toRemove.audioUrl)), 'admin removal frees its audio');

const toBan = await fresh();
await setFeedBan(indoreA.id, true);
assert.ok(!fs.existsSync(diskPath(toBan.audioUrl)), 'ban frees its audio');

const kept = (await call(indoreB, 'POST', '/feed/posts/voice', voiceForm())).json.data;
assert.ok(fs.existsSync(diskPath(kept.audioUrl)), 'unrelated audio untouched');

console.log('ride feed zone + voice: all checks passed');
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
fs.rmSync(uploadDir, { recursive: true, force: true });
process.exit(0);
