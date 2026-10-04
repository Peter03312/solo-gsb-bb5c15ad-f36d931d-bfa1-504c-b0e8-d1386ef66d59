import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeScheduleInput,
  intervalsOverlap,
  deviceOccupancySegments,
  findDeviceConflicts,
} from '../src/schedule.js';

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

let pub;
let vid;

// 依据已发布图建立核验并完成（entries 直接按冻结图构造，必然通过）
async function completeVerificationFor(pubId) {
  const created = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.id;
  const p = await call('GET', `/api/publications/${pubId}`);
  const entries = p.json.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const saved = await call('PUT', `/api/verifications/${id}`, { version: 1, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const done = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return id;
}

async function reservation(batchNo, startMs, endMs) {
  const r = await call('POST', '/api/reservations', {
    batchNo,
    publicationId: pub,
    startUtc: iso(startMs),
    endUtc: iso(endMs),
  });
  assert.equal(r.status, 201, `${batchNo}: ${JSON.stringify(r.json)}`);
  return r.json.id;
}

test('准备：可用发布图 + 已完成核验', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 20 }]);
  await call('POST', '/api/solve');
  pub = (await call('POST', '/api/publish')).json.id;
  vid = await completeVerificationFor(pub);
});

// 运行联动测试的共享预约/排班：预约起点在创建后 300ms（未开始时完成排班），
// 随后用例 sleep 进入预约左闭右开窗口再开始运行。
let ridRun;
let runActiveId;

test('运行联动准备：未开始时排班到 CENT-SCHED', async () => {
  const now = Date.now();
  ridRun = await reservation('RB-SRUN', now + 300, now + 3600_000);
  const s = await call('POST', '/api/schedules', {
    reservationId: ridRun,
    deviceNo: 'CENT-SCHED',
  });
  assert.equal(s.status, 201, JSON.stringify(s.json));
});

test('提交排班非法（缺预约/空设备/类型错误）→ 400，不留记录', async () => {
  const before0 = (await call('GET', '/api/schedules?all=1')).json.schedules.length;
  for (const body of [
    {},
    { reservationId: 1 },
    { deviceNo: 'D1' },
    { reservationId: 0, deviceNo: 'D1' },
    { reservationId: 'x', deviceNo: 'D1' },
    { reservationId: 1, deviceNo: '   ' },
    { reservationId: 1, deviceNo: '' },
    null,
  ]) {
    const r = await call('POST', '/api/schedules', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const after0 = (await call('GET', '/api/schedules?all=1')).json.schedules.length;
  assert.equal(after0, before0);
});

test('未知预约编号 → 400；未知排班 → 404', async () => {
  const r = await call('POST', '/api/schedules', { reservationId: 999999, deviceNo: 'D1' });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('预约'));
  assert.equal((await call('GET', '/api/schedules/999999')).status, 404);
  assert.equal((await call('POST', '/api/schedules/999999/cancel', {})).status, 404);
});

let rid1;
let rid2;
let rid3;
let sched1Id;
let T0; // 本组排班测试的固定基准时刻（预约创建后立即使用，漂移可忽略）

test('新排班：201，时段沿用预约冻结时段', async () => {
  const now = Date.now();
  rid1 = await reservation('RB-S1', now + 3600_000, now + 7200_000);
  T0 = now;
  const r = await call('POST', '/api/schedules', { reservationId: rid1, deviceNo: 'CENT-A' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  sched1Id = r.json.id;
  assert.equal(r.json.reservationId, rid1);
  assert.equal(r.json.deviceNo, 'CENT-A');
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.phase, 'notStarted');
  assert.equal(r.json.cancellable, true);
  assert.equal(r.json.reassignable, true);
  assert.equal(r.json.usedByRun, false);
  assert.equal(r.json.replacedById, null);
  assert.equal(r.json.startUtc, iso(now + 3600_000));
  assert.equal(r.json.endUtc, iso(now + 7200_000));
});

test('幂等：同预约同设备重复提交 → 200 原记录；不产生新行', async () => {
  const again = await call('POST', '/api/schedules', {
    reservationId: rid1,
    deviceNo: 'CENT-A',
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.id, sched1Id);
  assert.equal(again.json.deviceNo, 'CENT-A');
});

test('同设备重叠 → 409（detail.conflicts 含重叠时段），首尾相接 → 201', async () => {
  rid2 = await reservation('RB-S2', T0 + 5400_000, T0 + 9000_000); // 与 rid1 重叠
  let r = await call('POST', '/api/schedules', { reservationId: rid2, deviceNo: 'CENT-A' });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors.join(' ').includes('已有生效排班占用'));
  assert.equal(r.json.detail.deviceNo, 'CENT-A');
  assert.equal(r.json.detail.conflicts[0].scheduleId, sched1Id);
  assert.equal(r.json.detail.conflicts[0].reservationId, rid1);
  assert.ok(r.json.detail.conflicts[0].overlapStart);
  assert.ok(r.json.detail.conflicts[0].overlapEnd);

  // 冲突尝试不留下排班：rid2 仍无任何排班记录
  assert.equal(
    (await call('GET', `/api/schedules?reservationId=${rid2}&all=1`)).json.schedules.length,
    0,
  );

  // 首尾相接：rid3 起点 == rid1 终点
  rid3 = await reservation('RB-S3', T0 + 7200_000, T0 + 10800_000);
  r = await call('POST', '/api/schedules', { reservationId: rid3, deviceNo: 'CENT-A' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('改派到空闲设备 → 201：旧排班 reassigned 释放、新排班 active 占用', async () => {
  const r = await call('POST', '/api/schedules', {
    reservationId: rid1,
    deviceNo: 'CENT-B',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.notEqual(r.json.id, 1);
  assert.equal(r.json.deviceNo, 'CENT-B');
  assert.equal(r.json.reassignedFrom.scheduleId, sched1Id);
  assert.equal(r.json.reassignedFrom.deviceNo, 'CENT-A');

  const history = (await call('GET', `/api/schedules?reservationId=${rid1}&all=1`)).json
    .schedules;
  assert.equal(history.length, 2);
  const old = history.find((x) => x.id === sched1Id);
  assert.equal(old.status, 'reassigned');
  assert.equal(old.replacedById, r.json.id);
  assert.equal(old.cancellable, false);

  // 每预约只有一条生效排班
  const active = (await call('GET', `/api/schedules?reservationId=${rid1}`)).json.schedules;
  assert.equal(active.length, 1);
  assert.equal(active[0].deviceNo, 'CENT-B');
});

test('改派到冲突设备 → 409，原排班保留（原子回滚）', async () => {
  // rid1 现在在 CENT-B（T0+1h..T0+2h）。
  // rid2（T0+1.5h..T0+2.5h，尚未排班）排到 CENT-A：与 rid3（T0+2h..T0+3h）重叠 → 先验证仍冲突
  let try2 = await call('POST', '/api/schedules', {
    reservationId: rid2,
    deviceNo: 'CENT-A',
  });
  assert.equal(try2.status, 409);

  // 把 rid2 排到 CENT-C（空闲），再改派 rid1 到 CENT-C：与 rid2 重叠 → 409
  const onC = await call('POST', '/api/schedules', {
    reservationId: rid2,
    deviceNo: 'CENT-C',
  });
  assert.equal(onC.status, 201, JSON.stringify(onC.json));

  const conflict = await call('POST', '/api/schedules', {
    reservationId: rid1,
    deviceNo: 'CENT-C',
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.json));
  assert.ok(conflict.json.errors.join(' ').includes('改派未执行'));
  assert.equal(conflict.json.detail.conflicts[0].reservationId, rid2);

  // rid1 仍是 CENT-B 的生效排班；未产生新历史行
  const active = (await call('GET', `/api/schedules?reservationId=${rid1}`)).json.schedules;
  assert.equal(active.length, 1);
  assert.equal(active[0].deviceNo, 'CENT-B');
  const history = (await call('GET', `/api/schedules?reservationId=${rid1}&all=1`)).json
    .schedules;
  assert.equal(history.length, 2); // 1 条 reassigned + 1 条 active

  // 改派到与 rid3 首尾相接的 CENT-A（rid1 终于 T0+2h == rid3 起点）→ 成功
  const moved = await call('POST', '/api/schedules', {
    reservationId: rid1,
    deviceNo: 'CENT-A',
  });
  assert.equal(moved.status, 201, JSON.stringify(moved.json));
  assert.equal(moved.json.deviceNo, 'CENT-A');
});

test('取消排班：200 释放占用；重复取消幂等；取消后可重新排班', async () => {
  const list = await call('GET', '/api/schedules');
  const rid3Sched = list.json.schedules.find((x) => x.reservationId === rid3);
  const r = await call('POST', `/api/schedules/${rid3Sched.id}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'cancelled');
  assert.equal(r.json.cancelledAt !== null, true);
  assert.equal(r.json.cancellable, false);

  const again = await call('POST', `/api/schedules/${rid3Sched.id}/cancel`, {});
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'cancelled');

  // 释放后该时段在同设备可重新排班（CENT-A 此刻仅 rid1 占 +1h..+2h，rid3 +2h..+3h 相接）
  const rebook = await call('POST', '/api/schedules', {
    reservationId: rid3,
    deviceNo: 'CENT-A',
  });
  assert.equal(rebook.status, 201, JSON.stringify(rebook.json));
  assert.equal(rebook.json.deviceNo, 'CENT-A');
});

test('按设备与时段查询占用与冲突（probe）；左闭右开分段', async () => {
  const from = iso(T0 + 3600_000);
  const to = iso(T0 + 10800_000);
  const q = await call('GET', `/api/schedules?deviceNo=CENT-A&from=${from}&to=${to}`);
  assert.equal(q.status, 200);
  assert.equal(q.json.devices.length, 1);
  assert.equal(q.json.devices[0].deviceNo, 'CENT-A');
  // rid1（+1..+2，active）与 rid3（+2..+3，active）首尾相接 → 两个分段
  const segs = q.json.devices[0].segments;
  assert.equal(segs.length, 2);
  assert.equal(segs[0].end, segs[1].start); // 相接
  assert.equal(segs[0].schedules[0].reservationId, rid1);
  assert.equal(segs[1].schedules[0].reservationId, rid3);
  // probe：整窗被占 → unavailable
  assert.equal(q.json.probe.available, false);

  // CENT-D 无排班 → 任意窗口可用
  const freeDev = await call(
    'GET',
    `/api/schedules?deviceNo=CENT-D&from=${iso(T0 + 9000_000)}&to=${iso(T0 + 10800_000)}`,
  );
  assert.equal(freeDev.json.probe.available, true);
  assert.deepEqual(freeDev.json.probe.conflicts, []);
  // 探测窗口压到 CENT-A 上 rid3 占用（+2h..+3h）→ 不可用并附冲突
  const hit = await call(
    'GET',
    `/api/schedules?deviceNo=CENT-A&from=${iso(T0 + 9000_000)}&to=${iso(T0 + 10800_000)}`,
  );
  assert.equal(hit.json.probe.available, false);
  assert.equal(hit.json.probe.conflicts[0].reservationId, rid3);

  // 查询参数非法
  assert.equal((await call('GET', '/api/schedules?status=bogus')).status, 400);
  assert.equal((await call('GET', '/api/schedules?from=nope')).status, 400);
  assert.equal((await call('GET', '/api/schedules?reservationId=x')).status, 400);
  assert.equal((await call('GET', '/api/schedules?from=2026-10-04T00:00:00Z')).status, 400);
});

test('过滤：?reservationId= 非法 → 400；默认仅 active，?all=1 含历史', async () => {
  assert.equal((await call('GET', '/api/schedules?reservationId=x')).status, 400);
  const active = (await call('GET', '/api/schedules')).json.schedules;
  assert.ok(active.every((x) => x.status === 'active'));
  const all = (await call('GET', '/api/schedules?all=1')).json.schedules;
  assert.ok(all.length > active.length);
  assert.ok(all.some((x) => x.status === 'reassigned'));
  assert.ok(all.some((x) => x.status === 'cancelled'));
  const cancelled = (await call('GET', '/api/schedules?status=cancelled')).json.schedules;
  assert.ok(cancelled.every((x) => x.status === 'cancelled'));
});

let ridCancel;

test('预约取消同步取消其生效排班并释放占用（级联）', async () => {
  const now = Date.now();
  ridCancel = await reservation('RB-SCANCEL', now + 3600_000, now + 7200_000);
  const s = await call('POST', '/api/schedules', {
    reservationId: ridCancel,
    deviceNo: 'CENT-CASCADE',
  });
  assert.equal(s.status, 201);
  const sid = s.json.id;

  const r = await call('POST', `/api/reservations/${ridCancel}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.cancelledScheduleId, sid);

  const after = await call('GET', `/api/schedules/${sid}`);
  assert.equal(after.json.status, 'cancelled');
  // 设备时段已释放：另一预约可占用完全相同时段
  const other = await reservation('RB-SREPLACE', now + 3600_000, now + 7200_000);
  const take = await call('POST', '/api/schedules', {
    reservationId: other,
    deviceNo: 'CENT-CASCADE',
  });
  assert.equal(take.status, 201, JSON.stringify(take.json));
});

test('已取消的预约不能排班 → 409', async () => {
  const r = await call('POST', '/api/schedules', {
    reservationId: ridCancel,
    deviceNo: 'CENT-X',
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已取消'));
});

test('运行开始：有排班时设备必须一致（409）；无排班沿用原规则；一致则放行', async () => {
  await sleep(350); // 等待预约窗口开始（左闭右开：now >= start）

  let r = await call('POST', '/api/runs', {
    runNo: 'RUN-SCHED-MISMATCH',
    deviceNo: 'CENT-OTHER',
    verificationId: vid,
    reservationId: ridRun,
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors.join(' ').includes('排班'));
  assert.equal(r.json.detail.scheduledDeviceNo, 'CENT-SCHED');

  // 正确设备放行（开始时刻由服务端记录）
  r = await call('POST', '/api/runs', {
    runNo: 'RUN-SCHED-OK',
    deviceNo: 'CENT-SCHED',
    verificationId: vid,
    reservationId: ridRun,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  runActiveId = r.json.id;

  // 无排班预约沿用原放行规则：任意设备编号均可
  const now = Date.now();
  const ridNoSched = await reservation('RB-NOSCHED', now - 3600_000, now + 3600_000);
  const r2 = await call('POST', '/api/runs', {
    runNo: 'RUN-NO-SCHED',
    deviceNo: 'CENT-FREE-CHOICE',
    verificationId: vid,
    reservationId: ridNoSched,
  });
  assert.equal(r2.status, 201, JSON.stringify(r2.json));
  await call('POST', `/api/runs/${r2.json.id}/complete`, { outcome: 'completed' });
});

test('已用于运行的预约不得改派或新排班；其排班不可取消 → 409', async () => {
  const sid = (await call('GET', `/api/schedules?reservationId=${ridRun}`)).json.schedules[0]
    .id;

  let r = await call('POST', '/api/schedules', {
    reservationId: ridRun,
    deviceNo: 'CENT-NEW',
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已用于运行'));
  assert.equal(r.json.existingRunId, runActiveId);

  r = await call('POST', `/api/schedules/${sid}/cancel`, {});
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已用于运行'));

  // 原排班仍生效
  const still = await call('GET', `/api/schedules/${sid}`);
  assert.equal(still.json.status, 'active');
  assert.equal(still.json.deviceNo, 'CENT-SCHED');
});

test('已开始的预约不得改派或新排班 → 409；已开始排班不可取消/改派', async () => {
  const now = Date.now();
  // 开始时刻已过：新排班直接被拒绝
  const ridStarted = await reservation('RB-STARTED', now - 1000, now + 60_000);
  let r = await call('POST', '/api/schedules', {
    reservationId: ridStarted,
    deviceNo: 'CENT-T',
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(r.json.errors.join(' ').includes('已开始'));

  // 用短时段制造一条已开始的排班：先排未来 100ms 的预约，排班后等待其开始
  const soon = await reservation('RB-SOON2', now + 100, now + 60_000);
  r = await call('POST', '/api/schedules', { reservationId: soon, deviceNo: 'CENT-U' });
  assert.equal(r.status, 201);
  const sid = r.json.id;
  await sleep(150);
  // 已开始：不能取消
  r = await call('POST', `/api/schedules/${sid}/cancel`, {});
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已开始'));
  // 已开始：不能改派
  r = await call('POST', '/api/schedules', { reservationId: soon, deviceNo: 'CENT-V' });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('已开始'));
});

test('同运行编号同内容重放返回原冻结运行（不重新核对排班设备）', async () => {
  const replay = await call('POST', '/api/runs', {
    runNo: 'RUN-SCHED-OK',
    deviceNo: 'CENT-SCHED',
    verificationId: vid,
    reservationId: ridRun,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, runActiveId);
});

test('/api/state 包含 schedules 列表（含历史）', async () => {
  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.ok(Array.isArray(state.json.schedules));
  assert.ok(state.json.schedules.length >= 3);
});

test('纯函数：左闭右开重叠判定', () => {
  assert.equal(intervalsOverlap(0, 10, 10, 20), false); // 首尾相接
  assert.equal(intervalsOverlap(10, 20, 0, 10), false);
  assert.equal(intervalsOverlap(0, 11, 10, 20), true);
  assert.equal(intervalsOverlap(0, 10, 5, 15), true);
  assert.equal(intervalsOverlap(5, 15, 0, 10), true);
  assert.equal(intervalsOverlap(0, 5, 6, 10), false);
});

test('纯函数：输入规整', () => {
  assert.deepEqual(normalizeScheduleInput({ reservationId: '3', deviceNo: ' D ' }).clean, {
    reservationId: 3,
    deviceNo: 'D',
  });
  assert.ok(normalizeScheduleInput({ reservationId: 1, deviceNo: '' }).errors.length > 0);
  assert.ok(normalizeScheduleInput({ reservationId: -1, deviceNo: 'D' }).errors.length > 0);
  assert.ok(normalizeScheduleInput(null).errors.length > 0);
});

test('纯函数：设备占用扫描线（相接分段、同一条跨段合并）', () => {
  const items = [
    { scheduleId: 1, reservationId: 101, startMs: 0, endMs: 10 },
    { scheduleId: 2, reservationId: 102, startMs: 10, endMs: 20 },
    { scheduleId: 3, reservationId: 103, startMs: 3, endMs: 7 },
  ];
  const segs = deviceOccupancySegments(items, 0, 20);
  // [0,3):{1} [3,7):{1,3} [7,10):{1} → 同一条 1 跨段，占用集合变化仍切段
  assert.equal(segs.length, 4);
  assert.deepEqual(segs[0].schedules.map((s) => s.scheduleId), [1]);
  assert.deepEqual(segs[1].schedules.map((s) => s.scheduleId).sort(), [1, 3]);
  assert.deepEqual(segs[2].schedules.map((s) => s.scheduleId), [1]);
  assert.deepEqual(segs[3].schedules.map((s) => s.scheduleId), [2]);
  assert.equal(segs[0].startMs, 0);
  assert.equal(segs[3].endMs, 20);

  // 裁剪到窗口外 → 空
  assert.deepEqual(deviceOccupancySegments(items, 30, 40), []);
});

test('纯函数：findDeviceConflicts（相接不冲突、可排除自身）', () => {
  const cands = [
    { scheduleId: 1, reservationId: 101, startMs: 0, endMs: 10 },
    { scheduleId: 2, reservationId: 102, startMs: 10, endMs: 20 },
  ];
  // 完全重合 → 冲突
  assert.equal(findDeviceConflicts(cands, 0, 10).available, false);
  assert.equal(findDeviceConflicts(cands, 0, 10).conflicts.length, 1);
  // 探测窗口起点恰在既有终点（20）→ 相接不冲突
  assert.equal(findDeviceConflicts(cands, 20, 30).available, true);
  // 跨过相接点 → 与两条都冲突
  assert.equal(findDeviceConflicts(cands, 5, 15).conflicts.length, 2);
  // 排除自身后只剩另一条
  const r = findDeviceConflicts(cands, 5, 15, 1);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].scheduleId, 2);
});
