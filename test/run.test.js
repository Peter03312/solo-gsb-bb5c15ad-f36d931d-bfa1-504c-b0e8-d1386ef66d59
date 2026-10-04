import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeStartInput,
  normalizeCompleteInput,
  isWithinReservation,
  isOverrun,
} from '../src/run.js';

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
  const json = await res.json();
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

// 依据已发布图建立核验并完成（entries 直接按冻结图构造，必然通过）
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

let pub1;
let pub2;
let pub3;
let v1; // pub1 的已完成核验
let v2; // pub3 的未完成草稿
let v3; // pub2 的已完成核验

test('准备：三张同数据可用发布图 + 核验（完成/草稿）', async () => {
  const now = Date.now();
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  const p1 = await call('POST', '/api/publish');
  pub1 = p1.json.id;
  const p2 = await call('POST', '/api/publish');
  pub2 = p2.json.id;
  const p3 = await call('POST', '/api/publish');
  pub3 = p3.json.id;

  v1 = await completeVerificationFor(pub1);
  v3 = await completeVerificationFor(pub2);
  const draft = await call('POST', '/api/verifications', { publicationId: pub3 });
  assert.equal(draft.status, 201, JSON.stringify(draft.json));
  v2 = draft.json.id;
  assert.ok(now > 0);
});

test('开始输入非法（空编号/非法 id/缺字段）→ 400，不留记录', async () => {
  const before0 = (await call('GET', '/api/runs')).json.length;
  for (const body of [
    {},
    { runNo: '  ', deviceNo: 'D1', verificationId: v1, reservationId: 1 },
    { runNo: 'R-X', deviceNo: '', verificationId: v1, reservationId: 1 },
    { runNo: 'R-X', deviceNo: 'D1', verificationId: 0, reservationId: 1 },
    { runNo: 'R-X', deviceNo: 'D1', verificationId: v1, reservationId: -2 },
    { runNo: 'R-X', deviceNo: 'D1', verificationId: '1', reservationId: 1 },
    null,
  ]) {
    const r = await call('POST', '/api/runs', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const after0 = (await call('GET', '/api/runs')).json.length;
  assert.equal(after0, before0);
});

test('未知核验编号 / 未知预约编号 → 400', async () => {
  const now = Date.now();
  const r1 = await makeReservation('RB-UNKNOWN-1', pub1, now - 3600_000, now + 3600_000);
  let r = await call('POST', '/api/runs', {
    runNo: 'R-UNK-V',
    deviceNo: 'D1',
    verificationId: 999999,
    reservationId: r1,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('核验'));

  r = await call('POST', '/api/runs', {
    runNo: 'R-UNK-R',
    deviceNo: 'D1',
    verificationId: v1,
    reservationId: 999999,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('预约'));
});

test('核验未完成 → 409；核验与预约不指同一发布图 → 409；预约已取消 → 409；不在预约时段 → 409', async () => {
  const now = Date.now();
  const wideA = await makeReservation('RB-DRAFT', pub1, now - 3600_000, now + 3600_000);
  const wideB = await makeReservation('RB-MISMATCH', pub1, now - 3600_000, now + 3600_000);
  const future = await makeReservation('RB-FUT', pub1, now + 3600_000, now + 7200_000);
  const cancel = await call('POST', `/api/reservations/${future}/cancel`);
  assert.equal(cancel.status, 200);
  const past = await makeReservation('RB-PAST', pub1, now - 7200_000, now - 3600_000);
  const soon = await makeReservation('RB-SOON', pub1, now + 3600_000, now + 7200_000);

  let r = await call('POST', '/api/runs', {
    runNo: 'R-DRAFT', deviceNo: 'D1', verificationId: v2, reservationId: wideA,
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('尚未完成'));

  // v3 依据 pub2，预约依据 pub1
  r = await call('POST', '/api/runs', {
    runNo: 'R-MISMATCH', deviceNo: 'D1', verificationId: v3, reservationId: wideB,
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('同一张发布图'));

  r = await call('POST', '/api/runs', {
    runNo: 'R-CANCELLED', deviceNo: 'D1', verificationId: v1, reservationId: future,
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已取消'));

  r = await call('POST', '/api/runs', {
    runNo: 'R-PAST', deviceNo: 'D1', verificationId: v1, reservationId: past,
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('预约终点'));

  r = await call('POST', '/api/runs', {
    runNo: 'R-SOON', deviceNo: 'D1', verificationId: v1, reservationId: soon,
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('早于预约开始'));
});

let run1Id;
let r1;

test('开始运行成功：201，服务端记录开始时间并冻结依据', async () => {
  const now = Date.now();
  r1 = await makeReservation('RB-RUN1', pub1, now - 3600_000, now + 3600_000);
  const res = await call('POST', '/api/runs', {
    runNo: 'RUN-001',
    deviceNo: 'CENT-1',
    verificationId: v1,
    reservationId: r1,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const run = res.json;
  run1Id = run.id;
  assert.equal(run.runNo, 'RUN-001');
  assert.equal(run.deviceNo, 'CENT-1');
  assert.equal(run.status, 'running');
  assert.equal(run.outcome, null);
  assert.equal(run.timedOut, false);
  assert.equal(run.endedAt, null);
  assert.equal(run.publicationId, pub1);
  assert.equal(run.verificationId, v1);
  assert.equal(run.reservationId, r1);
  assert.ok(Math.abs(Date.parse(run.startUtc) - Date.now()) < 5000);
  assert.equal(run.frozenBasis.publication.id, pub1);
  assert.equal(run.frozenBasis.publication.currentlyUsable, true);
  assert.equal(run.frozenBasis.verification.passed, true);
  assert.equal(run.frozenBasis.verification.id, v1);
  assert.equal(run.frozenBasis.verification.diffSum, 0);
  assert.ok(run.frozenBasis.verification.checks);
  assert.equal(run.frozenBasis.reservation.id, r1);
  assert.equal(
    run.frozenBasis.reservation.startUtc,
    iso(now - 3600_000),
  );
  assert.deepEqual(run.frozenBasis.reservation.usage, []);
  assert.equal(run.frozenBasis.reservationCurrentStatus, 'active');
  // GET 单条一致
  const detail = await call('GET', `/api/runs/${run1Id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.runNo, 'RUN-001');
});

test('幂等：相同运行编号同内容 → 200 原记录；异内容 → 409', async () => {
  const same = await call('POST', '/api/runs', {
    runNo: 'RUN-001',
    deviceNo: 'CENT-1',
    verificationId: v1,
    reservationId: r1,
  });
  assert.equal(same.status, 200);
  assert.equal(same.json.id, run1Id);
  assert.equal(same.json.status, 'running');

  for (const body of [
    { runNo: 'RUN-001', deviceNo: 'CENT-2', verificationId: v1, reservationId: r1 },
    { runNo: 'RUN-001', deviceNo: 'CENT-1', verificationId: v3, reservationId: r1 },
  ]) {
    const diff = await call('POST', '/api/runs', body);
    assert.equal(diff.status, 409, JSON.stringify(body));
    assert.equal(diff.json.existingId, run1Id);
  }
});

test('预约已被运行占用 → 409（附 existingRunId）；同设备有进行中运行 → 409', async () => {
  const now = Date.now();
  const other = await makeReservation('RB-DEVICE', pub1, now - 3600_000, now + 3600_000);

  let r = await call('POST', '/api/runs', {
    runNo: 'RUN-DUP-RES',
    deviceNo: 'CENT-9',
    verificationId: v1,
    reservationId: r1,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.existingRunId, run1Id);
  assert.ok(r.json.errors.join(' ').includes('已用于运行'));

  r = await call('POST', '/api/runs', {
    runNo: 'RUN-DUP-DEV',
    deviceNo: 'CENT-1',
    verificationId: v1,
    reservationId: other,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.existingRunId, run1Id);
  assert.ok(r.json.errors.join(' ').includes('进行中'));

  // 所有冲突尝试均不留记录：列表仍只有 run1
  const list = await call('GET', '/api/runs');
  assert.equal(list.json.length, 1);
});

test('完结：非法 outcome → 400；完成 → 201；重复同状态 200、异状态 409', async () => {
  let r = await call('POST', `/api/runs/${run1Id}/complete`, { outcome: 'oops' });
  assert.equal(r.status, 400);
  r = await call('POST', `/api/runs/${run1Id}/complete`, {});
  assert.equal(r.status, 400);
  // 运行仍在进行
  assert.equal((await call('GET', `/api/runs/${run1Id}`)).json.status, 'running');

  await sleep(5);
  r = await call('POST', `/api/runs/${run1Id}/complete`, { outcome: 'completed' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.status, 'completed');
  assert.equal(r.json.outcome, 'completed');
  assert.equal(r.json.timedOut, false);
  assert.ok(Date.parse(r.json.endedAt) > Date.parse(r.json.startUtc));
  assert.equal(r.json.phase, 'ended');

  const again = await call('POST', `/api/runs/${run1Id}/complete`, { outcome: 'completed' });
  assert.equal(again.status, 200);
  assert.equal(again.json.endedAt, r.json.endedAt);

  const changed = await call('POST', `/api/runs/${run1Id}/complete`, { outcome: 'aborted' });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.existingOutcome, 'completed');
});

test('完结后设备释放；超过预约终点完结如实完结并标记超时（中止）', async () => {
  const now = Date.now();
  // 短时段：很快越过终点
  const short = await makeReservation('RB-SHORT', pub1, now - 1000, now + 2000);
  const start = await call('POST', '/api/runs', {
    runNo: 'RUN-002',
    deviceNo: 'CENT-1',
    verificationId: v1,
    reservationId: short,
  });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  const id2 = start.json.id;

  await sleep(2100); // 越过预约终点（左闭右开：now >= end）
  const r = await call('POST', `/api/runs/${id2}/complete`, { outcome: 'aborted' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'aborted');
  assert.equal(r.json.timedOut, true);
  assert.ok(
    Date.parse(r.json.endedAt) >
      Date.parse(start.json.frozenBasis.reservation.endUtc),
  );

  const replay = await call('POST', `/api/runs/${id2}/complete`, { outcome: 'aborted' });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.timedOut, true);

  // 预约未被改写：仍为 active（取消仅与时刻有关，运行不改写预约）
  const reservation = await call('GET', `/api/reservations/${short}`);
  assert.equal(reservation.json.status, 'active');

  // 设备已释放：同设备可再开始一次（复用已完成核验 + 新预约）
  const rWide = await makeReservation('RB-RELEASE', pub1, now - 3600_000, now + 3600_000);
  const start3 = await call('POST', '/api/runs', {
    runNo: 'RUN-003',
    deviceNo: 'CENT-1',
    verificationId: v1,
    reservationId: rWide,
  });
  assert.equal(start3.status, 201, JSON.stringify(start3.json));
  await sleep(5);
  const done3 = await call('POST', `/api/runs/${start3.json.id}/complete`, {
    outcome: 'completed',
  });
  assert.equal(done3.status, 201);
  assert.equal(done3.json.timedOut, false);
});

test('发布图失效后不能开始新运行；历史运行冻结依据不改写', async () => {
  const listBefore = await call('GET', '/api/runs');
  const frozenRun1 = listBefore.json.find((x) => x.runNo === 'RUN-001');
  const frozenConfigSnapshot = JSON.stringify(frozenRun1.frozenBasis.publication.config);
  const frozenResultSnapshot = JSON.stringify(frozenRun1.frozenBasis.publication.result);
  const frozenHash = frozenRun1.frozenBasis.publication.basisHash;
  assert.equal(frozenRun1.frozenBasis.publication.currentlyUsable, true);

  // 先在图仍可用时备好预约，再改容差使数据指纹变化（旧发布图不可用）
  const now0 = Date.now();
  const rid = await makeReservation('RB-STALE', pub1, now0 - 3600_000, now0 + 3600_000);
  const chg = await call('PUT', '/api/config', { ...cfg, tolerance: 2 });
  assert.equal(chg.status, 200);

  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-STALE',
    deviceNo: 'CENT-7',
    verificationId: v1,
    reservationId: rid,
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('当前不可用于装载'));

  // 历史冻结依据原样保留，仅展示标记 currentlyUsable 变为 false
  const detail = await call('GET', `/api/runs/${run1Id}`);
  assert.equal(detail.json.frozenBasis.publication.currentlyUsable, false);
  assert.equal(detail.json.frozenBasis.publication.basisHash, frozenHash);
  assert.equal(
    JSON.stringify(detail.json.frozenBasis.publication.config),
    frozenConfigSnapshot,
  );
  assert.equal(
    JSON.stringify(detail.json.frozenBasis.publication.result),
    frozenResultSnapshot,
  );
  assert.equal(detail.json.status, 'completed');
  assert.equal(detail.json.timedOut, false);
  assert.equal(detail.json.frozenBasis.verification.passed, true);
  assert.equal(detail.json.frozenBasis.reservation.id, r1);

  // /api/state 含运行列表
  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.ok(Array.isArray(state.json.runs));
  assert.equal(state.json.runs.length, 3);
});

test('运行不存在 → 404', async () => {
  let r = await call('GET', '/api/runs/999999');
  assert.equal(r.status, 404);
  r = await call('POST', '/api/runs/999999/complete', { outcome: 'completed' });
  assert.equal(r.status, 404);
});

test('纯函数：左闭右开时段判定、超时判定、输入规整', () => {
  const s = 1000;
  const e = 2000;
  assert.equal(isWithinReservation(s, e, 999), false);
  assert.equal(isWithinReservation(s, e, 1000), true); // 左闭
  assert.equal(isWithinReservation(s, e, 1500), true);
  assert.equal(isWithinReservation(s, e, 2000), false); // 右开
  assert.equal(isOverrun(e, 2000), false); // 恰在终点不算超时
  assert.equal(isOverrun(e, 2001), true);
  assert.equal(isOverrun(e, 1999), false);

  let { errors, clean } = normalizeStartInput({
    runNo: ' X ',
    deviceNo: ' D ',
    verificationId: '3',
    reservationId: 4,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(clean, { runNo: 'X', deviceNo: 'D', verificationId: 3, reservationId: 4 });
  ({ errors } = normalizeStartInput({ runNo: '', deviceNo: 'D', verificationId: 1, reservationId: 2 }));
  assert.ok(errors.some((m) => m.includes('运行编号')));
  assert.equal(normalizeCompleteInput({ outcome: 'completed' }).clean.outcome, 'completed');
  assert.equal(normalizeCompleteInput({ outcome: 'aborted' }).clean.outcome, 'aborted');
  assert.ok(normalizeCompleteInput({ outcome: 'x' }).errors.length > 0);
});
