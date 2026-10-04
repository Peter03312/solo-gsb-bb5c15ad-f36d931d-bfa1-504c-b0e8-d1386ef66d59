import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeLimitInput,
  normalizeDeviceNo,
  normalizeMaintenanceInput,
  summarizeDevice,
} from '../src/maintenance.js';

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

let pub1;
let v1;
let batchSeq = 0;
let runSeq = 0;

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

// 在指定设备上开始一次运行（每次使用新的宽时段预约）
async function startRun(deviceNo, runNo) {
  const now = Date.now();
  batchSeq += 1;
  const res = await call('POST', '/api/reservations', {
    batchNo: `MB-${batchSeq}`,
    publicationId: pub1,
    startUtc: iso(now - 3600_000),
    endUtc: iso(now + 3600_000),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const r = await call('POST', '/api/runs', {
    runNo,
    deviceNo,
    verificationId: v1,
    reservationId: res.json.id,
  });
  return r;
}

async function deviceView(deviceNo) {
  const r = await call('GET', `/api/devices/${encodeURIComponent(deviceNo)}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

async function runCount() {
  return (await call('GET', '/api/runs')).json.length;
}

test('准备：发布图 + 已完成核验', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  const p1 = await call('POST', '/api/publish');
  assert.equal(p1.status, 201, JSON.stringify(p1.json));
  pub1 = p1.json.id;
  v1 = await completeVerificationFor(pub1);
});

test('纯函数：上限/设备编号/保养登记输入规整', () => {
  assert.deepEqual(normalizeLimitInput({ limitSeconds: 3600 }).clean, {
    limitSeconds: 3600,
  });
  for (const bad of [0, -3, 1.5, '3600', null, undefined, NaN, Infinity]) {
    assert.ok(normalizeLimitInput({ limitSeconds: bad }).errors.length > 0, String(bad));
  }
  assert.ok(normalizeLimitInput(null).errors.length > 0);
  assert.ok(normalizeLimitInput({}).errors.length > 0);

  assert.deepEqual(normalizeDeviceNo('  CENT-01 ').clean, { deviceNo: 'CENT-01' });
  assert.ok(normalizeDeviceNo('   ').errors.length > 0);
  assert.ok(normalizeDeviceNo('x'.repeat(101)).errors.length > 0);

  const ok = normalizeMaintenanceInput({
    maintNo: ' M-1 ',
    deviceNo: ' D1 ',
    reason: ' 月度保养 ',
  });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, { maintNo: 'M-1', deviceNo: 'D1', reason: '月度保养' });
  assert.ok(normalizeMaintenanceInput(null).errors.length > 0);
  assert.ok(
    normalizeMaintenanceInput({ maintNo: '', deviceNo: 'D', reason: 'r' }).errors.length > 0,
  );
  assert.ok(
    normalizeMaintenanceInput({ maintNo: 'M', deviceNo: '', reason: 'r' }).errors.length > 0,
  );
  assert.ok(
    normalizeMaintenanceInput({ maintNo: 'M', deviceNo: 'D', reason: ' ' }).errors.length > 0,
  );
});

test('纯函数：累计时长汇总（周期、完成/中止计入、进行中不计入、达到上限）', () => {
  const runs = [
    { startUtc: iso(1000), endedAt: iso(4000) }, // 3 秒，已完结
    { startUtc: iso(5000), endedAt: iso(6000) }, // 1 秒，已完结（完成/中止均计入）
    { startUtc: iso(7000), endedAt: null }, // 进行中：不提前计入
  ];
  // 无保养记录：计入全部已完结运行
  let s = summarizeDevice({
    deviceNo: 'D',
    limitSeconds: 10,
    runs,
    lastMaintenanceAt: null,
  });
  assert.equal(s.usedSeconds, 4);
  assert.equal(s.countedRuns, 2);
  assert.equal(s.remainingSeconds, 6);
  assert.equal(s.maintenanceDue, false);
  assert.equal(s.cycleStartAt, null);

  // 有保养记录：仅计入周期起点之后开始的已完结运行
  s = summarizeDevice({
    deviceNo: 'D',
    limitSeconds: 1,
    runs,
    lastMaintenanceAt: iso(4500),
  });
  assert.equal(s.usedSeconds, 1);
  assert.equal(s.countedRuns, 1);
  assert.equal(s.maintenanceDue, true); // 达到上限（used >= limit）
  assert.equal(s.remainingSeconds, 0);
  assert.equal(s.cycleStartAt, iso(4500));

  // 越过上限：剩余额度如实为负
  s = summarizeDevice({
    deviceNo: 'D',
    limitSeconds: 3,
    runs,
    lastMaintenanceAt: null,
  });
  assert.equal(s.usedSeconds, 4);
  assert.equal(s.remainingSeconds, -1);
  assert.equal(s.maintenanceDue, true);

  // 未设置上限：不核对额度
  s = summarizeDevice({
    deviceNo: 'D',
    limitSeconds: null,
    runs,
    lastMaintenanceAt: null,
  });
  assert.equal(s.limitSeconds, null);
  assert.equal(s.remainingSeconds, null);
  assert.equal(s.maintenanceDue, false);
  assert.equal(s.usedSeconds, 4);
});

test('上限设置：非法输入 → 400；合法设置/调整 → 200', async () => {
  for (const body of [
    {},
    { limitSeconds: 0 },
    { limitSeconds: -10 },
    { limitSeconds: 1.5 },
    { limitSeconds: '3600' },
    null,
  ]) {
    const r = await call('PUT', '/api/devices/DEV-L/limit', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const set = await call('PUT', '/api/devices/DEV-L/limit', { limitSeconds: 7200 });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.deviceNo, 'DEV-L');
  assert.equal(set.json.limitSeconds, 7200);
  assert.equal(set.json.usedSeconds, 0);
  assert.equal(set.json.maintenanceDue, false);

  // 调整上限：立即生效于视图判定（历史不改写由后续用例覆盖）
  const adj = await call('PUT', '/api/devices/DEV-L/limit', { limitSeconds: 3600 });
  assert.equal(adj.status, 200);
  assert.equal(adj.json.limitSeconds, 3600);

  // 设备编号非法（空白）→ 400
  const blank = await call('PUT', '/api/devices/%20%20/limit', { limitSeconds: 10 });
  assert.equal(blank.status, 400);
});

let run1Id;
const RUN1_NO = 'MRUN-001';

test('越过上限也如实完结并释放设备；达到上限后拒绝新运行且不留记录', async () => {
  // DEV-A 上限 1 秒：开始运行（累计 0 < 1，允许）
  await call('PUT', '/api/devices/DEV-A/limit', { limitSeconds: 1 });
  const start = await startRun('DEV-A', RUN1_NO);
  assert.equal(start.status, 201, JSON.stringify(start.json));
  run1Id = start.json.id;

  // 运行越过上限（约 1.1 秒 > 1 秒上限）仍如实完结并释放设备
  await sleep(1100);
  const done = await call('POST', `/api/runs/${run1Id}/complete`, { outcome: 'completed' });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.outcome, 'completed');

  // 设备已释放（空闲）；累计时长按服务端起止时间计入，达到上限 → 待保养
  const view = await deviceView('DEV-A');
  assert.equal(view.running, false);
  assert.equal(view.activeRunId, null);
  assert.ok(view.usedSeconds >= 1, JSON.stringify(view));
  assert.equal(view.countedRuns, 1);
  assert.equal(view.limitSeconds, 1);
  assert.ok(view.remainingSeconds <= 0);
  assert.equal(view.maintenanceDue, true);
  assert.equal(view.lastMaintenanceAt, null); // 尚无保养记录时计入全部已完结运行

  // 达到上限：后续开始运行在事务内核对额度 → 409 拒绝且不留新运行
  const before0 = await runCount();
  const rejected = await startRun('DEV-A', 'MRUN-REJ');
  assert.equal(rejected.status, 409, JSON.stringify(rejected.json));
  assert.ok(rejected.json.errors.join(' ').includes('保养'));
  assert.equal(rejected.json.detail.device.maintenanceDue, true);
  assert.equal(rejected.json.detail.device.deviceNo, 'DEV-A');
  assert.equal(await runCount(), before0);
});

test('既有运行编号重试不受额度变化影响', async () => {
  // 同号同内容：返回原记录（200），不因额度已达上限而拒绝
  const now = Date.now();
  const res = await call('POST', '/api/reservations', {
    batchNo: 'MB-REPLAY',
    publicationId: pub1,
    startUtc: iso(now - 3600_000),
    endUtc: iso(now + 3600_000),
  });
  // 原运行的开始内容：runNo + deviceNo + verificationId + reservationId
  const orig = await call('GET', `/api/runs/${run1Id}`);
  const replay = await call('POST', '/api/runs', {
    runNo: RUN1_NO,
    deviceNo: 'DEV-A',
    verificationId: orig.json.verificationId,
    reservationId: orig.json.reservationId,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.id, run1Id);
  assert.equal(replay.json.status, 'completed');

  // 同号异内容：409（与原行为一致）
  const diff = await call('POST', '/api/runs', {
    runNo: RUN1_NO,
    deviceNo: 'DEV-A',
    verificationId: orig.json.verificationId,
    reservationId: res.json.id,
  });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, run1Id);
});

test('登记保养开启新累计周期；同号同内容重试返回原记录，异内容拒绝', async () => {
  // 设备空闲：登记成功（201），服务端记录登记时刻
  const m = await call('POST', '/api/maintenances', {
    maintNo: 'MNT-001',
    deviceNo: 'DEV-A',
    reason: '月度保养',
  });
  assert.equal(m.status, 201, JSON.stringify(m.json));
  assert.equal(m.json.maintNo, 'MNT-001');
  assert.equal(m.json.deviceNo, 'DEV-A');
  assert.equal(m.json.reason, '月度保养');
  assert.ok(Date.parse(m.json.createdAt) > 0);

  // 新累计周期：累计时长与待保养状态归零
  const view = await deviceView('DEV-A');
  assert.equal(view.usedSeconds, 0);
  assert.equal(view.countedRuns, 0);
  assert.equal(view.maintenanceDue, false);
  assert.equal(view.remainingSeconds, 1);
  assert.equal(view.lastMaintenanceAt, m.json.createdAt);
  assert.equal(view.cycleStartAt, m.json.createdAt);
  assert.equal(view.maintenanceCount, 1);

  // 同号同内容重试 → 200 返回原记录（不产生第二条）
  const replay = await call('POST', '/api/maintenances', {
    maintNo: 'MNT-001',
    deviceNo: 'DEV-A',
    reason: '月度保养',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, m.json.id);
  assert.equal((await call('GET', '/api/maintenances')).json.length, 1);

  // 同号异内容（不同原因 / 不同设备）→ 409
  for (const body of [
    { maintNo: 'MNT-001', deviceNo: 'DEV-A', reason: '更换轴承' },
    { maintNo: 'MNT-001', deviceNo: 'DEV-OTHER', reason: '月度保养' },
  ]) {
    const r = await call('POST', '/api/maintenances', body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(r.json.existingId, m.json.id);
  }
  assert.equal((await call('GET', '/api/maintenances')).json.length, 1);
});

test('保养登记非法输入 → 400；单条查询 404', async () => {
  for (const body of [
    {},
    { maintNo: '', deviceNo: 'D', reason: 'r' },
    { maintNo: 'M', deviceNo: '', reason: 'r' },
    { maintNo: 'M', deviceNo: 'D', reason: '' },
    { maintNo: 'x'.repeat(101), deviceNo: 'D', reason: 'r' },
    null,
  ]) {
    const r = await call('POST', '/api/maintenances', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const notFound = await call('GET', '/api/maintenances/999999');
  assert.equal(notFound.status, 404);
});

let run2Id;

test('新周期可开始运行；进行中不计入累计；设备运行中拒绝登记保养；中止计入', async () => {
  // 保养后额度重置：DEV-A 可再次开始运行
  const start = await startRun('DEV-A', 'MRUN-002');
  assert.equal(start.status, 201, JSON.stringify(start.json));
  run2Id = start.json.id;

  // 进行中的运行不提前计入累计时长
  let view = await deviceView('DEV-A');
  assert.equal(view.running, true);
  assert.equal(view.activeRunId, run2Id);
  assert.equal(view.usedSeconds, 0);
  assert.equal(view.countedRuns, 0);

  // 设备运行中：拒绝登记保养（409，附 existingRunId）
  const busy = await call('POST', '/api/maintenances', {
    maintNo: 'MNT-002',
    deviceNo: 'DEV-A',
    reason: '运行中尝试保养',
  });
  assert.equal(busy.status, 409, JSON.stringify(busy.json));
  assert.equal(busy.json.existingRunId, run2Id);
  assert.ok(busy.json.errors.join(' ').includes('空闲'));

  // 中止完结：按服务端起止时间计入累计
  await sleep(5);
  const done = await call('POST', `/api/runs/${run2Id}/complete`, { outcome: 'aborted' });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  view = await deviceView('DEV-A');
  assert.equal(view.running, false);
  assert.equal(view.countedRuns, 1);
  assert.ok(view.usedSeconds > 0 && view.usedSeconds < 1, JSON.stringify(view));
  assert.equal(view.maintenanceDue, false); // 0.00x 秒 < 1 秒上限
});

test('调整上限仅影响后续开始判定，不改写运行及保养历史', async () => {
  const runsBefore = await runCount();
  const maintBefore = (await call('GET', '/api/maintenances')).json.length;
  const run2Before = (await call('GET', `/api/runs/${run2Id}`)).json;

  // 调大上限：判定立即按新上限
  const up = await call('PUT', '/api/devices/DEV-A/limit', { limitSeconds: 3600 });
  assert.equal(up.status, 200);
  assert.equal(up.json.limitSeconds, 3600);
  assert.equal(up.json.maintenanceDue, false);

  // 调回 1 秒：本周期累计（< 1 秒）未达上限，可开始新运行
  const back = await call('PUT', '/api/devices/DEV-A/limit', { limitSeconds: 1 });
  assert.equal(back.json.limitSeconds, 1);
  assert.equal(back.json.maintenanceDue, false);
  const start = await startRun('DEV-A', 'MRUN-003');
  assert.equal(start.status, 201, JSON.stringify(start.json));
  await sleep(5);
  await call('POST', `/api/runs/${start.json.id}/complete`, { outcome: 'completed' });

  // 历史不改写：运行与保养记录保持原样
  assert.equal(await runCount(), runsBefore + 1); // 仅新增 MRUN-003
  assert.equal((await call('GET', '/api/maintenances')).json.length, maintBefore);
  const run2After = (await call('GET', `/api/runs/${run2Id}`)).json;
  assert.equal(run2After.outcome, 'aborted');
  assert.equal(run2After.endedAt, run2Before.endedAt);
  assert.equal(
    JSON.stringify(run2After.frozenBasis),
    JSON.stringify(run2Before.frozenBasis),
  );
});

test('清除上限后恢复原行为（不再核对额度）', async () => {
  // DEV-D 上限 1 秒，累计越过上限 → 待保养，新运行被拒
  await call('PUT', '/api/devices/DEV-D/limit', { limitSeconds: 1 });
  const start = await startRun('DEV-D', 'MRUN-D1');
  assert.equal(start.status, 201, JSON.stringify(start.json));
  await sleep(1100);
  const done = await call('POST', `/api/runs/${start.json.id}/complete`, {
    outcome: 'completed',
  });
  assert.equal(done.status, 201);
  assert.equal((await deviceView('DEV-D')).maintenanceDue, true);
  const rejected = await startRun('DEV-D', 'MRUN-D2');
  assert.equal(rejected.status, 409);

  // 清除上限：未设置上限的设备沿用原行为，不再核对额度
  const cleared = await call('DELETE', '/api/devices/DEV-D/limit');
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.limitSeconds, null);
  assert.equal(cleared.json.remainingSeconds, null);
  assert.equal(cleared.json.maintenanceDue, false);
  assert.ok(cleared.json.usedSeconds >= 1); // 累计统计保留，仅不再判定

  const allowed = await startRun('DEV-D', 'MRUN-D3');
  assert.equal(allowed.status, 201, JSON.stringify(allowed.json));
  await sleep(5);
  await call('POST', `/api/runs/${allowed.json.id}/complete`, { outcome: 'completed' });

  // 重复清除幂等成功
  const again = await call('DELETE', '/api/devices/DEV-D/limit');
  assert.equal(again.status, 200);
});

test('无运行历史的设备可登记保养；设备列表与单台查询；/api/state 汇总', async () => {
  // 从未运行的设备视为空闲，可登记保养
  const m = await call('POST', '/api/maintenances', {
    maintNo: 'MNT-NEW',
    deviceNo: 'DEV-NEW',
    reason: '启用前保养',
  });
  assert.equal(m.status, 201, JSON.stringify(m.json));
  const viewNew = await deviceView('DEV-NEW');
  assert.equal(viewNew.usedSeconds, 0);
  assert.equal(viewNew.maintenanceCount, 1);

  // 设备列表：出现过的设备（运行/上限/保养）均在列
  const list = await call('GET', '/api/devices');
  assert.equal(list.status, 200);
  const byNo = new Map(list.json.map((d) => [d.deviceNo, d]));
  for (const no of ['DEV-A', 'DEV-D', 'DEV-L', 'DEV-NEW']) {
    assert.ok(byNo.has(no), `缺少设备 ${no}`);
  }
  assert.equal(byNo.get('DEV-A').limitSeconds, 1);
  assert.equal(byNo.get('DEV-A').maintenanceCount, 1);
  assert.equal(byNo.get('DEV-D').limitSeconds, null);
  assert.equal(byNo.get('DEV-L').limitSeconds, 3600);

  // 未知设备 → 404
  const notFound = await call('GET', '/api/devices/NO-SUCH-DEVICE');
  assert.equal(notFound.status, 404);

  // 保养记录列表 / 单条
  const maints = await call('GET', '/api/maintenances');
  assert.equal(maints.status, 200);
  assert.equal(maints.json.length, 2); // MNT-001（DEV-A）+ MNT-NEW（DEV-NEW）
  const one = await call('GET', `/api/maintenances/${maints.json[0].id}`);
  assert.equal(one.status, 200);
  assert.ok(one.json.maintNo);

  // /api/state 携带设备状态与保养记录
  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.ok(Array.isArray(state.json.devices));
  assert.ok(Array.isArray(state.json.maintenances));
  assert.ok(state.json.devices.some((d) => d.deviceNo === 'DEV-A'));
  assert.equal(state.json.maintenances.length, 2);
});
