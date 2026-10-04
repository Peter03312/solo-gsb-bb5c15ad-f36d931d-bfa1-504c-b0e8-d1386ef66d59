import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeCalibrationInput,
  isCalibrationInPast,
  isLaterThanPrevious,
  checkCalibrationForRun,
} from '../src/calibration.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: 'not-json' }));
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

async function completeVerificationFor(pubId) {
  const created = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const vid = created.json.id;
  const pub = await call('GET', `/api/publications/${pubId}`);
  const entries = pub.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const saved = await call('PUT', `/api/verifications/${vid}`, { version: 1, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const done = await call('POST', `/api/verifications/${vid}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return vid;
}

async function makeReservation(batchNo, pubId, startMs, endMs) {
  const r = await call('POST', '/api/reservations', {
    batchNo,
    publicationId: pubId,
    startUtc: iso(startMs),
    endUtc: iso(endMs),
  });
  assert.equal(r.status, 201, `${batchNo}: ${JSON.stringify(r.json)}`);
  return r.json.id;
}

// 登记一条合格校准（到期由 expiresInMs 指定相对当前的偏移），返回 {id, body}
async function registerCalib(no, deviceNo, { calibratedAgoMs = 60_000, expiresInMs = 3600_000, passed = true } = {}) {
  const now = Date.now();
  const body = {
    calibNo: no,
    deviceNo,
    calibratedAt: iso(now - calibratedAgoMs),
    expiresAt: iso(now + expiresInMs),
    passed,
  };
  const r = await call('POST', '/api/calibrations', body);
  return { status: r.status, json: r.json, body };
}

let pubId;
let verId;

// ---------- 纯函数 ----------

test('纯函数：输入规整（合法/非法）', () => {
  const now = Date.now();
  const ok = normalizeCalibrationInput({
    calibNo: ' C-1 ',
    deviceNo: ' D-1 ',
    calibratedAt: iso(now - 1000),
    expiresAt: iso(now + 1000),
    passed: true,
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.clean.calibNo, 'C-1');
  assert.equal(ok.clean.deviceNo, 'D-1');
  assert.equal(ok.clean.passed, true);
  assert.ok(iso(ok.clean.calibratedAtMs) === ok.clean.calibratedAt);

  for (const body of [
    null,
    {},
    { calibNo: ' ', deviceNo: 'D', calibratedAt: iso(now), expiresAt: iso(now + 1), passed: true },
    { calibNo: 'C', deviceNo: ' ', calibratedAt: iso(now), expiresAt: iso(now + 1), passed: true },
    { calibNo: 'C', deviceNo: 'D', calibratedAt: 'not-a-time', expiresAt: iso(now + 1), passed: true },
    { calibNo: 'C', deviceNo: 'D', calibratedAt: iso(now), expiresAt: 'bad', passed: true },
    { calibNo: 'C', deviceNo: 'D', calibratedAt: iso(now + 1), expiresAt: iso(now), passed: true },
    { calibNo: 'C', deviceNo: 'D', calibratedAt: iso(now), expiresAt: iso(now), passed: true },
    { calibNo: 'C', deviceNo: 'D', calibratedAt: iso(now), expiresAt: iso(now + 1), passed: 'yes' },
    { calibNo: 'C', deviceNo: 'D', calibratedAt: iso(now), expiresAt: iso(now + 1) },
  ]) {
    const r = normalizeCalibrationInput(body);
    assert.ok(r.errors.length > 0, JSON.stringify(body));
    assert.equal(r.clean, null);
  }
});

test('纯函数：时序判定与放行判定', () => {
  assert.equal(isCalibrationInPast(1000, 1000), true); // 恰在当前时刻：不晚于，允许
  assert.equal(isCalibrationInPast(1001, 1000), false);
  assert.equal(isLaterThanPrevious(1001, 1000), true);
  assert.equal(isLaterThanPrevious(1000, 1000), false); // 相等不算晚于
  assert.equal(isLaterThanPrevious(999, 1000), false);

  assert.deepEqual(checkCalibrationForRun(null, 5000), { ok: true, reason: 'none' });
  assert.deepEqual(
    checkCalibrationForRun({ passed: false, expiresUtc: iso(9000) }, 5000),
    { ok: false, reason: 'failed' },
  );
  // 合格但到期早于预约终点 → 有效期不足
  assert.deepEqual(
    checkCalibrationForRun({ passed: true, expiresUtc: iso(4999) }, 5000),
    { ok: false, reason: 'expired' },
  );
  // 到期恰等于预约终点 → 不早于，足够
  assert.deepEqual(
    checkCalibrationForRun({ passed: true, expiresUtc: iso(5000) }, 5000),
    { ok: true, reason: 'valid' },
  );
  assert.deepEqual(
    checkCalibrationForRun({ passed: true, expiresUtc: iso(5001) }, 5000),
    { ok: true, reason: 'valid' },
  );
});

// ---------- HTTP：准备发布图 / 核验 ----------

test('准备：可用发布图与已完成核验', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  const p = await call('POST', '/api/publish');
  assert.equal(p.status, 201, JSON.stringify(p.json));
  pubId = p.json.id;
  verId = await completeVerificationFor(pubId);
});

// ---------- HTTP：登记校验 ----------

test('登记成功：201，记录按时间排序、按设备过滤', async () => {
  const a = await registerCalib('CAL-A-1', 'CAL-DEV-A', { expiresInMs: 7200_000 });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(a.json.calibNo, 'CAL-A-1');
  assert.equal(a.json.deviceNo, 'CAL-DEV-A');
  assert.equal(a.json.passed, true);
  assert.equal(a.json.phase, 'valid');
  assert.ok(Math.abs(Date.parse(a.json.calibratedAt) - Date.parse(a.body.calibratedAt)) < 1000);

  await sleep(5);
  const b = await registerCalib('CAL-B-1', 'CAL-DEV-B', { passed: false, expiresInMs: 10_000 });
  assert.equal(b.status, 201);
  assert.equal(b.json.passed, false);
  assert.equal(b.json.phase, 'failed');

  const all = await call('GET', '/api/calibrations');
  assert.equal(all.status, 200);
  assert.ok(all.json.length >= 2);
  // 最新在前
  assert.equal(all.json[0].calibNo, 'CAL-B-1');

  const onlyA = await call('GET', '/api/calibrations?deviceNo=CAL-DEV-A');
  assert.equal(onlyA.status, 200);
  assert.equal(onlyA.json.length, 1);
  assert.equal(onlyA.json[0].calibNo, 'CAL-A-1');

  const one = await call('GET', `/api/calibrations/${a.json.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.id, a.json.id);

  const notFound = await call('GET', '/api/calibrations/999999');
  assert.equal(notFound.status, 404);
});

test('无效输入 → 400，不留校准记录', async () => {
  const before = (await call('GET', '/api/calibrations')).json.length;
  const now = Date.now();
  for (const body of [
    null,
    {},
    { calibNo: '  ', deviceNo: 'D', calibratedAt: iso(now - 1), expiresAt: iso(now + 1), passed: true },
    { calibNo: 'X', deviceNo: 'D', calibratedAt: iso(now), expiresAt: iso(now - 1), passed: true },
    { calibNo: 'X', deviceNo: 'D', calibratedAt: iso(now), expiresAt: iso(now + 1), passed: 1 },
  ]) {
    const r = await call('POST', '/api/calibrations', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // 校准时间晚于服务端当前时刻 → 400
  const future = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-FUTURE',
    deviceNo: 'CAL-DEV-A',
    calibratedAt: iso(now + 60_000),
    expiresAt: iso(now + 120_000),
    passed: true,
  });
  assert.equal(future.status, 400);
  assert.ok(future.json.errors.join(' ').includes('服务端当前时刻'));

  const after = (await call('GET', '/api/calibrations')).json.length;
  assert.equal(after, before);
});

test('同设备校准时间须晚于上一条：不晚于 → 409 且不留记录', async () => {
  const first = await registerCalib('CAL-ORDER-1', 'CAL-DEV-ORDER', {
    calibratedAgoMs: 120_000,
    expiresInMs: 3600_000,
  });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const firstCalAt = first.json.calibratedAt;
  const countAfter1 = (await call('GET', '/api/calibrations?deviceNo=CAL-DEV-ORDER')).json.length;

  // 更早的校准时间 → 409
  const older = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-ORDER-2',
    deviceNo: 'CAL-DEV-ORDER',
    calibratedAt: iso(Date.parse(firstCalAt) - 60_000),
    expiresAt: iso(Date.now() + 3600_000),
    passed: true,
  });
  assert.equal(older.status, 409);
  assert.equal(older.json.existingId, first.json.id);
  assert.ok(older.json.errors.join(' ').includes('必须晚于上一条'));

  // 与上一条同一校准时间（相等）→ 同样 409
  const equal = await call('POST', '/api/calibrations', {
    calibNo: 'CAL-ORDER-3',
    deviceNo: 'CAL-DEV-ORDER',
    calibratedAt: firstCalAt,
    expiresAt: iso(Date.now() + 3600_000),
    passed: true,
  });
  assert.equal(equal.status, 409);

  const countAfter = (await call('GET', '/api/calibrations?deviceNo=CAL-DEV-ORDER')).json.length;
  assert.equal(countAfter, countAfter1);

  // 不同设备不受影响
  const otherDev = await registerCalib('CAL-ORDER-OTHER', 'CAL-DEV-OTHER', {
    calibratedAgoMs: 1000,
    expiresInMs: 3600_000,
  });
  assert.equal(otherDev.status, 201);

  // 同设备更晚的校准时间 → 成功（按最新一条判定）
  await sleep(5);
  const newer = await registerCalib('CAL-ORDER-4', 'CAL-DEV-ORDER', {
    calibratedAgoMs: 1000,
    expiresInMs: 7200_000,
  });
  assert.equal(newer.status, 201, JSON.stringify(newer.json));
});

test('幂等：同号同内容 → 200 原记录；同号异内容 → 409', async () => {
  const first = await registerCalib('CAL-IDEM-1', 'CAL-IDEM-DEV', { expiresInMs: 3600_000 });
  assert.equal(first.status, 201);

  // 同内容重放（时间字段与首次完全一致）
  const replay = await call('POST', '/api/calibrations', first.body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(replay.json.deviceNo, first.json.deviceNo);

  const list = await call('GET', '/api/calibrations?deviceNo=CAL-IDEM-DEV');
  assert.equal(list.json.length, 1);

  // 异内容（不同结论）→ 409
  const diff = await call('POST', '/api/calibrations', { ...first.body, passed: false });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, first.json.id);

  // 异内容（不同设备）→ 409
  const diffDev = await call('POST', '/api/calibrations', { ...first.body, deviceNo: 'CAL-IDEM-DEV-2' });
  assert.equal(diffDev.status, 409);

  // 异内容未留下新记录
  const list2 = await call('GET', '/api/calibrations?deviceNo=CAL-IDEM-DEV');
  assert.equal(list2.json.length, 1);
});

// ---------- HTTP：放行判定 ----------

test('无校准记录的设备沿用原开始规则（可开始）', async () => {
  const now = Date.now();
  const rid = await makeReservation('RB-CAL-NONE', pubId, now - 3600_000, now + 3600_000);
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-CAL-NONE',
    deviceNo: 'CAL-DEV-NONE',
    verificationId: verId,
    reservationId: rid,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.frozenBasis.calibration, null);
  await call('POST', `/api/runs/${r.json.id}/complete`, { outcome: 'completed' });
});

test('最新校准不合格 → 409（说明不合格，不留运行）', async () => {
  const reg = await registerCalib('CAL-GATE-FAIL', 'CAL-GATE-DEV', {
    expiresInMs: 3600_000,
    passed: true,
  });
  assert.equal(reg.status, 201);
  await sleep(5);
  const fail = await registerCalib('CAL-GATE-FAIL-2', 'CAL-GATE-DEV', {
    calibratedAgoMs: 1000,
    expiresInMs: 3600_000,
    passed: false,
  });
  assert.equal(fail.status, 201);

  const now = Date.now();
  const rid = await makeReservation('RB-CAL-FAIL', pubId, now - 3600_000, now + 3600_000);
  const before = (await call('GET', '/api/runs')).json.length;
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-CAL-FAIL',
    deviceNo: 'CAL-GATE-DEV',
    verificationId: verId,
    reservationId: rid,
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors.join(' ').includes('不合格'));
  assert.equal(r.json.detail.reason, 'failed');
  assert.equal(r.json.detail.calibration.id, fail.json.id);
  const after = (await call('GET', '/api/runs')).json.length;
  assert.equal(after, before);
});

test('有效期不足（到期早于预约终点）→ 409（说明有效期不足，不留运行）', async () => {
  const now = Date.now();
  const reg = await registerCalib('CAL-GATE-EXP', 'CAL-GATE-EXP-DEV', {
    expiresInMs: 600_000,
  });
  assert.equal(reg.status, 201);
  // 预约终点在校准到期之后
  const rid = await makeReservation('RB-CAL-EXP', pubId, now - 3600_000, now + 3600_000);
  const before = (await call('GET', '/api/runs')).json.length;
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-CAL-EXP',
    deviceNo: 'CAL-GATE-EXP-DEV',
    verificationId: verId,
    reservationId: rid,
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors.join(' ').includes('有效期不足'));
  assert.equal(r.json.detail.reason, 'expired');
  const afterRuns = (await call('GET', '/api/runs')).json.length;
  assert.equal(afterRuns, before);
});

test('到期恰等于预约终点 → 放行（不早于）；成功后冻结校准依据', async () => {
  const now = Date.now();
  const end = now + 1800_000;
  const reg = await registerCalib('CAL-GATE-EQ', 'CAL-GATE-EQ-DEV', {
    calibratedAgoMs: 1000,
    expiresInMs: end - Date.now(),
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const rid = await makeReservation('RB-CAL-EQ', pubId, now - 3600_000, end);
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-CAL-EQ',
    deviceNo: 'CAL-GATE-EQ-DEV',
    verificationId: verId,
    reservationId: rid,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const c = r.json.frozenBasis.calibration;
  assert.ok(c);
  assert.equal(c.id, reg.json.id);
  assert.equal(c.calibNo, 'CAL-GATE-EQ');
  assert.equal(c.passed, true);
  assert.equal(c.expiresAt, reg.json.expiresAt);
  await call('POST', `/api/runs/${r.json.id}/complete`, { outcome: 'completed' });
});

test('开始冻结后新增不合格/到期记录，不改写历史运行与放行依据', async () => {
  const now = Date.now();
  const reg = await registerCalib('CAL-FREEZE-1', 'CAL-FREEZE-DEV', {
    expiresInMs: 7200_000,
  });
  assert.equal(reg.status, 201);
  const rid = await makeReservation('RB-CAL-FREEZE', pubId, now - 3600_000, now + 3600_000);
  const start = await call('POST', '/api/runs', {
    runNo: 'RUN-CAL-FREEZE',
    deviceNo: 'CAL-FREEZE-DEV',
    verificationId: verId,
    reservationId: rid,
  });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  const runId = start.json.id;
  const frozenSnapshot = JSON.stringify(start.json.frozenBasis.calibration);

  // 之后新增一条不合格校准（时间晚于上一条，允许登记）
  await sleep(5);
  const bad = await registerCalib('CAL-FREEZE-2', 'CAL-FREEZE-DEV', {
    calibratedAgoMs: 1000,
    expiresInMs: 7200_000,
    passed: false,
  });
  assert.equal(bad.status, 201, JSON.stringify(bad.json));

  // 历史运行冻结依据不变；进行中运行不被改写
  const detail = await call('GET', `/api/runs/${runId}`);
  assert.equal(JSON.stringify(detail.json.frozenBasis.calibration), frozenSnapshot);
  assert.equal(detail.json.status, 'running');

  // 超时完结也不改写校准依据
  const done = await call('POST', `/api/runs/${runId}/complete`, { outcome: 'aborted' });
  assert.equal(done.status, 201);
  assert.equal(JSON.stringify(done.json.frozenBasis.calibration), frozenSnapshot);
});

test('同号重放原运行开始约定兼容：已开始运行同内容重放返回原记录，不受后增校准影响', async () => {
  const now = Date.now();
  const rid = await makeReservation('RB-CAL-REPLAY', pubId, now - 3600_000, now + 3600_000);
  const body = {
    runNo: 'RUN-CAL-REPLAY',
    deviceNo: 'CAL-REPLAY-DEV',
    verificationId: verId,
    reservationId: rid,
  };
  const first = await call('POST', '/api/runs', body);
  assert.equal(first.status, 201);

  // 开始后再登记不合格校准（设备已有一条合格记录，新记录时间更晚）
  await registerCalib('CAL-REPLAY-OK', 'CAL-REPLAY-DEV', { expiresInMs: 7200_000 });
  await sleep(5);
  const bad = await registerCalib('CAL-REPLAY-BAD', 'CAL-REPLAY-DEV', {
    calibratedAgoMs: 1000,
    expiresInMs: 7200_000,
    passed: false,
  });
  assert.equal(bad.status, 201);

  // 同号同内容重放 → 200 原记录（不重新核对校准）
  const replay = await call('POST', '/api/runs', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(replay.json.frozenBasis.calibration, null); // 开始时无校准记录

  // 完结释放设备（超时/完结不改写校准依据）
  const done = await call('POST', `/api/runs/${first.json.id}/complete`, {
    outcome: 'completed',
  });
  assert.equal(done.status, 201);

  // 但同设备下一次新运行会按最新（不合格）记录拒绝
  const rid2 = await makeReservation('RB-CAL-REPLAY-2', pubId, now - 3600_000, now + 3600_000);
  const blocked = await call('POST', '/api/runs', {
    runNo: 'RUN-CAL-REPLAY-NEW',
    deviceNo: 'CAL-REPLAY-DEV',
    verificationId: verId,
    reservationId: rid2,
  });
  assert.equal(blocked.status, 409);
  assert.ok(blocked.json.errors.join(' ').includes('不合格'));
});

test('/api/state 含校准列表；/api/devices 呈现设备最新校准', async () => {
  const s = await call('GET', '/api/state');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.json.calibrations));
  assert.ok(s.json.calibrations.some((c) => c.calibNo === 'CAL-A-1'));

  const devs = await call('GET', '/api/devices');
  assert.equal(devs.status, 200);
  const a = devs.json.find((d) => d.deviceNo === 'CAL-DEV-A');
  assert.ok(a, '仅有校准记录的设备也应出现在 /api/devices');
  assert.ok(a.latestCalibration);
  assert.equal(a.latestCalibration.calibNo, 'CAL-A-1');
  assert.equal(a.calibrationCount, 1);

  const one = await call('GET', '/api/devices/CAL-DEV-A');
  assert.equal(one.status, 200);
  assert.equal(one.json.latestCalibration.deviceNo, 'CAL-DEV-A');
});

test('到期后校准 phase=expired；登记失败不留记录（综合）', async () => {
  const reg = await registerCalib('CAL-PHASE', 'CAL-PHASE-DEV', {
    calibratedAgoMs: 120_000,
    expiresInMs: 20, // 20ms 后到期
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.phase, 'valid');
  await sleep(40);
  const got = await call('GET', `/api/calibrations/${reg.json.id}`);
  assert.equal(got.json.phase, 'expired');
});
