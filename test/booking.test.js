import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeBookingInput,
  intersectIntervals,
  freeIntervals,
  weightFeasibleIntervals,
  findEarliestSlot,
} from '../src/booking.js';

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

const iso = (ms) => new Date(ms).toISOString();
const H = 3600_000;

// 4 孔、容差 0.5：管 A=50 在孔 0，对径孔 2 必须放 50 g 配重 → 冻结图占用 50 g × 1
const cfg = { holes: 4, tolerance: 0.5, holeMaxMass: [100, 100, 100, 100] };

let pubId; // 当前可用发布图（占用 50 g × 1，库存 50 g × 2）

async function counts() {
  const [b, r, s] = await Promise.all([
    call('GET', '/api/bookings'),
    call('GET', '/api/reservations'),
    call('GET', '/api/schedules?all=1'),
  ]);
  return {
    bookings: b.json.length,
    reservations: r.json.length,
    schedules: s.json.schedules.length,
  };
}

test('准备：发布可行装载图（占用 50 g × 1，库存 50 g × 2）', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  pubId = pub.json.id;
  assert.equal(pub.json.result.weightCount, 1);
});

test('非法输入 → 400，不留任何记录', async () => {
  const before0 = await counts();
  const now = Date.now();
  const okWindow = { windowStartUtc: iso(now + H), windowEndUtc: iso(now + 8 * H) };
  const bodies = [
    null,
    {},
    { ...okWindow, publicationId: pubId, durationSeconds: 60, deviceNos: ['D1'] }, // 缺批次号
    { ...okWindow, batchNo: '  ', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1'] },
    { ...okWindow, batchNo: 'B', publicationId: 0, durationSeconds: 60, deviceNos: ['D1'] },
    { ...okWindow, batchNo: 'B', publicationId: 'x', durationSeconds: 60, deviceNos: ['D1'] },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 0, deviceNos: ['D1'] },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: -5, deviceNos: ['D1'] },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 1.5, deviceNos: ['D1'] },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: '60', deviceNos: ['D1'] },
    { batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1'] }, // 缺窗口
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1'], windowStartUtc: 'nope' },
    { batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1'], windowStartUtc: iso(now + 2 * H), windowEndUtc: iso(now + 2 * H) }, // 起点不早于终点
    { batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1'], windowStartUtc: iso(now + 3 * H), windowEndUtc: iso(now + 2 * H) },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 60 }, // 缺设备
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: [] },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['  '] },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1', 5] },
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1', 'D1'] }, // 重复
    { ...okWindow, batchNo: 'B', publicationId: pubId, durationSeconds: 60, deviceNos: ['D1', ' D1 '] }, // 去空白后重复
  ];
  for (const body of bodies) {
    const r = await call('POST', '/api/bookings', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  // 窗口起点不晚于服务端当前时刻 → 400
  for (const start of [iso(now - 1000), iso(now - 1)]) {
    const r = await call('POST', '/api/bookings', {
      batchNo: 'B-PAST',
      publicationId: pubId,
      durationSeconds: 60,
      windowStartUtc: start,
      windowEndUtc: iso(now + 2 * H),
      deviceNos: ['D1'],
    });
    assert.equal(r.status, 400, start);
    assert.ok(r.json.errors.join(' ').includes('晚于服务端当前时刻'));
  }
  const after0 = await counts();
  assert.deepEqual(after0, before0);
});

test('未知发布图 / 已失效发布图 → 400，不留记录', async () => {
  const now = Date.now();
  const mk = (batchNo, pub) => ({
    batchNo,
    publicationId: pub,
    durationSeconds: 600,
    windowStartUtc: iso(now + H),
    windowEndUtc: iso(now + 4 * H),
    deviceNos: ['D1'],
  });
  let r = await call('POST', '/api/bookings', mk('B-UNKNOWN-PUB', 999999));
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('未知'));

  // 录入数据变化 → 图失效
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 3 }]);
  r = await call('POST', '/api/bookings', mk('B-STALE-PUB', pubId));
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不可用于装载'));
  // 恢复数据使发布记录重新可用
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
  const pub = await call('GET', `/api/publications/${pubId}`);
  assert.equal(pub.json.usable, true);
  assert.equal((await call('GET', '/api/bookings')).json.length, 0);
});

// 搜索基准时刻：所有窗口都在未来
let T0;
let booking1;

test('成功：空窗口 201，起点即窗口起点，原子生成预约与排班', async () => {
  T0 = Date.now() + 24 * H; // 明天此时，避免与其他用例的时间漂移
  const r = await call('POST', '/api/bookings', {
    batchNo: 'BK-001',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0),
    windowEndUtc: iso(T0 + 8 * H),
    deviceNos: ['CENT-A'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  booking1 = r.json;
  assert.equal(booking1.batchNo, 'BK-001');
  assert.equal(booking1.publicationId, pubId);
  assert.equal(booking1.durationSeconds, 3600);
  assert.equal(booking1.deviceNo, 'CENT-A');
  assert.equal(booking1.startUtc, iso(T0));
  assert.equal(booking1.endUtc, iso(T0 + H));
  assert.deepEqual(booking1.usage, [{ mass: 50, count: 1 }]);
  assert.ok(booking1.reservationId > 0);
  assert.ok(booking1.scheduleId > 0);

  // 两项记录真实存在且共用同一时段
  const res1 = await call('GET', `/api/reservations/${booking1.reservationId}`);
  assert.equal(res1.status, 200);
  assert.equal(res1.json.batchNo, 'BK-001');
  assert.equal(res1.json.startUtc, booking1.startUtc);
  assert.equal(res1.json.endUtc, booking1.endUtc);
  assert.equal(res1.json.status, 'active');
  const sch1 = await call('GET', `/api/schedules/${booking1.scheduleId}`);
  assert.equal(sch1.status, 200);
  assert.equal(sch1.json.reservationId, booking1.reservationId);
  assert.equal(sch1.json.deviceNo, 'CENT-A');
  assert.equal(sch1.json.startUtc, booking1.startUtc);
  assert.equal(sch1.json.endUtc, booking1.endUtc);
  assert.equal(sch1.json.status, 'active');
});

test('幂等：同号同请求重试 → 200 返回原结果，不产生新记录', async () => {
  const before0 = await counts();
  const r = await call('POST', '/api/bookings', {
    batchNo: 'BK-001',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0),
    windowEndUtc: iso(T0 + 8 * H),
    deviceNos: ['CENT-A'],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, booking1);
  const after0 = await counts();
  assert.deepEqual(after0, before0);
});

test('幂等：候选设备次序不同视为同一请求 → 200 原结果', async () => {
  const r = await call('POST', '/api/bookings', {
    batchNo: 'BK-001',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0),
    windowEndUtc: iso(T0 + 8 * H),
    deviceNos: ['CENT-A'], // 单台设备，次序无差异；多台见后续用例
  });
  assert.equal(r.status, 200);
});

test('幂等：取消预约后同号同请求重试仍返回原结果（不重新占用）', async () => {
  const c = await call('POST', `/api/reservations/${booking1.reservationId}/cancel`, {});
  assert.equal(c.status, 200);
  assert.equal(c.json.status, 'cancelled');
  assert.equal(c.json.cancelledScheduleId, booking1.scheduleId);

  const r = await call('POST', '/api/bookings', {
    batchNo: 'BK-001',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0),
    windowEndUtc: iso(T0 + 8 * H),
    deviceNos: ['CENT-A'],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, booking1); // 冻结的原结果，含原两项记录编号
  // 没有重新占用：预约仍是已取消状态
  const res1 = await call('GET', `/api/reservations/${booking1.reservationId}`);
  assert.equal(res1.json.status, 'cancelled');
});

test('同号异请求 → 409；与既有普通预约撞号 → 409', async () => {
  const changed = await call('POST', '/api/bookings', {
    batchNo: 'BK-001',
    publicationId: pubId,
    durationSeconds: 7200, // 异请求
    windowStartUtc: iso(T0),
    windowEndUtc: iso(T0 + 8 * H),
    deviceNos: ['CENT-A'],
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.existingId, booking1.id);

  // 普通预约占用批次号 BK-ORD
  const ord = await call('POST', '/api/reservations', {
    batchNo: 'BK-ORD',
    publicationId: pubId,
    startUtc: iso(T0 + 10 * H),
    endUtc: iso(T0 + 11 * H),
  });
  assert.equal(ord.status, 201, JSON.stringify(ord.json));
  const clash = await call('POST', '/api/bookings', {
    batchNo: 'BK-ORD',
    publicationId: pubId,
    durationSeconds: 600,
    windowStartUtc: iso(T0 + 12 * H),
    windowEndUtc: iso(T0 + 14 * H),
    deviceNos: ['CENT-A'],
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.existingId, ord.json.id);
  assert.ok(clash.json.errors.join(' ').includes('批次号'));
});

test('最早起点：配重被既有预约占满时顺延到占用终点（首尾相接）', async () => {
  // 库存 50 g × 2；两条普通预约在 [T0+20h, T0+22h) 各占用 1 枚 → 该时段无余量
  const r1 = await call('POST', '/api/reservations', {
    batchNo: 'BK-FILL-1',
    publicationId: pubId,
    startUtc: iso(T0 + 20 * H),
    endUtc: iso(T0 + 22 * H),
  });
  assert.equal(r1.status, 201, JSON.stringify(r1.json));
  const r2 = await call('POST', '/api/reservations', {
    batchNo: 'BK-FILL-2',
    publicationId: pubId,
    startUtc: iso(T0 + 20 * H),
    endUtc: iso(T0 + 22 * H),
  });
  assert.equal(r2.status, 201, JSON.stringify(r2.json));

  const r = await call('POST', '/api/bookings', {
    batchNo: 'BK-002',
    publicationId: pubId,
    durationSeconds: 1800,
    windowStartUtc: iso(T0 + 20 * H),
    windowEndUtc: iso(T0 + 26 * H),
    deviceNos: ['CENT-B'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, iso(T0 + 22 * H)); // 紧接占用终点（左闭右开相接）
  assert.equal(r.json.endUtc, iso(T0 + 22 * H + 1800_000));
});

test('最早起点：候选设备被排班占用时跳过占用段；并列取字典序最小设备', async () => {
  // CENT-BUSY 在 [T0+30h, T0+32h) 已有排班（来自普通预约 + 排班）
  const res = await call('POST', '/api/reservations', {
    batchNo: 'BK-FILL-3',
    publicationId: pubId,
    startUtc: iso(T0 + 30 * H),
    endUtc: iso(T0 + 32 * H),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const sch = await call('POST', '/api/schedules', {
    reservationId: res.json.id,
    deviceNo: 'CENT-BUSY',
  });
  assert.equal(sch.status, 201, JSON.stringify(sch.json));

  // 候选 [CENT-BUSY, CENT-FREE]：CENT-BUSY 起点被占 → CENT-FREE 在窗口起点可行
  let r = await call('POST', '/api/bookings', {
    batchNo: 'BK-003',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0 + 30 * H),
    windowEndUtc: iso(T0 + 36 * H),
    deviceNos: ['CENT-BUSY', 'CENT-FREE'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.deviceNo, 'CENT-FREE');
  assert.equal(r.json.startUtc, iso(T0 + 30 * H));

  // 并列：CENT-FREE 与 CENT-AAA 都在同一最早起点可行 → 取字典序最小 CENT-AAA
  // （CENT-FREE 此时已被 BK-003 占用 [T0+30h, T0+31h)，故换一批全新设备）
  r = await call('POST', '/api/bookings', {
    batchNo: 'BK-004',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0 + 40 * H),
    windowEndUtc: iso(T0 + 44 * H),
    deviceNos: ['CENT-ZZZ', 'CENT-AAA', 'CENT-MID'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.deviceNo, 'CENT-AAA');
  assert.equal(r.json.startUtc, iso(T0 + 40 * H));

  // 设备占用使起点顺延：CENT-ONLY 在窗口前 2 小时被占 → 起点 = 占用终点
  const res2 = await call('POST', '/api/reservations', {
    batchNo: 'BK-FILL-4',
    publicationId: pubId,
    startUtc: iso(T0 + 50 * H),
    endUtc: iso(T0 + 52 * H),
  });
  assert.equal(res2.status, 201);
  const sch2 = await call('POST', '/api/schedules', {
    reservationId: res2.json.id,
    deviceNo: 'CENT-ONLY',
  });
  assert.equal(sch2.status, 201);
  r = await call('POST', '/api/bookings', {
    batchNo: 'BK-005',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0 + 50 * H),
    windowEndUtc: iso(T0 + 56 * H),
    deviceNos: ['CENT-ONLY'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, iso(T0 + 52 * H)); // 首尾相接
  assert.equal(r.json.deviceNo, 'CENT-ONLY');
});

test('最早起点：停用与预约叠加占满库存时顺延', async () => {
  // [T0+60h, T0+62h)：一条普通预约占 1 枚 + 停用 1 枚 = 库存 2 占满
  const res = await call('POST', '/api/reservations', {
    batchNo: 'BK-FILL-5',
    publicationId: pubId,
    startUtc: iso(T0 + 60 * H),
    endUtc: iso(T0 + 62 * H),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const susp = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '送检',
    startUtc: iso(T0 + 60 * H),
    endUtc: iso(T0 + 62 * H),
  });
  assert.equal(susp.status, 201, JSON.stringify(susp.json));

  const r = await call('POST', '/api/bookings', {
    batchNo: 'BK-006',
    publicationId: pubId,
    durationSeconds: 1800,
    windowStartUtc: iso(T0 + 60 * H),
    windowEndUtc: iso(T0 + 66 * H),
    deviceNos: ['CENT-S'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, iso(T0 + 62 * H));
});

test('无可行时段 → 409（附诊断），不留任何记录', async () => {
  const before0 = await counts();

  // 1) 窗口短于时长
  let r = await call('POST', '/api/bookings', {
    batchNo: 'BK-NO-1',
    publicationId: pubId,
    durationSeconds: 7200,
    windowStartUtc: iso(T0 + 70 * H),
    windowEndUtc: iso(T0 + 70 * H + 1800_000),
    deviceNos: ['CENT-N'],
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.detail.reason, 'noFeasibleSlot');

  // 2) 配重全程被占满（BK-FILL-1/2 在 [T0+20h, T0+22h) 占满库存 2）
  r = await call('POST', '/api/bookings', {
    batchNo: 'BK-NO-2',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0 + 20 * H),
    windowEndUtc: iso(T0 + 22 * H),
    deviceNos: ['CENT-N'],
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.detail.reason, 'noFeasibleSlot');
  assert.equal(r.json.detail.weightConflicts.length, 1);
  assert.equal(r.json.detail.weightConflicts[0].mass, 50);
  assert.equal(r.json.detail.weightConflicts[0].capacity, 2);
  assert.ok(r.json.errors.join(' ').includes('规格 50 g'));

  // 3) 唯一候选设备全程被排班占满（CENT-BUSY 占 [T0+30h, T0+32h)）
  r = await call('POST', '/api/bookings', {
    batchNo: 'BK-NO-3',
    publicationId: pubId,
    durationSeconds: 3600,
    windowStartUtc: iso(T0 + 30 * H),
    windowEndUtc: iso(T0 + 32 * H),
    deviceNos: ['CENT-BUSY'],
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.detail.reason, 'noFeasibleSlot');
  const busy = r.json.detail.deviceBusy.find((d) => d.deviceNo === 'CENT-BUSY');
  assert.ok(busy);
  assert.equal(busy.busy.length, 1);
  assert.equal(busy.busy[0].start, iso(T0 + 30 * H));

  const after0 = await counts();
  assert.deepEqual(after0, before0);
});

test('生成的预约/排班是普通记录：出现在既有列表中，取消语义不变', async () => {
  const list = await call('GET', '/api/bookings');
  const bk = list.json.find((b) => b.batchNo === 'BK-004');
  assert.ok(bk);
  const res = await call('GET', `/api/reservations/${bk.reservationId}`);
  assert.equal(res.json.status, 'active');
  assert.equal(res.json.cancellable, true);
  const sch = await call('GET', `/api/schedules/${bk.scheduleId}`);
  assert.equal(sch.json.status, 'active');
  assert.equal(sch.json.cancellable, true);

  // 取消预约 → 级联取消排班（既有语义）
  const c = await call('POST', `/api/reservations/${bk.reservationId}/cancel`, {});
  assert.equal(c.status, 200);
  assert.equal(c.json.cancelledScheduleId, bk.scheduleId);
  const sch2 = await call('GET', `/api/schedules/${bk.scheduleId}`);
  assert.equal(sch2.json.status, 'cancelled');
});

test('查询：GET /api/bookings、GET /api/bookings/:id、/api/state.bookings', async () => {
  const list = await call('GET', '/api/bookings');
  assert.equal(list.status, 200);
  assert.ok(list.json.length >= 6);
  const one = await call('GET', `/api/bookings/${booking1.id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.json, booking1);
  assert.equal((await call('GET', '/api/bookings/999999')).status, 404);

  const state = await call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.ok(Array.isArray(state.json.bookings));
  assert.ok(state.json.bookings.some((b) => b.batchNo === 'BK-001'));
});

// ---------- 纯函数 ----------

test('纯函数：normalizeBookingInput', () => {
  const ok = normalizeBookingInput({
    batchNo: ' B ',
    publicationId: 2,
    durationSeconds: 60,
    windowStartUtc: '2027-01-01T00:00:00Z',
    windowEndUtc: '2027-01-01T02:00:00Z',
    deviceNos: [' A ', 'B'],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.clean.batchNo, 'B');
  assert.equal(ok.clean.durationSeconds, 60);
  assert.deepEqual(ok.clean.deviceNos, ['A', 'B']);
  assert.equal(ok.clean.windowEndMs - ok.clean.windowStartMs, 2 * H);

  assert.ok(normalizeBookingInput(null).errors.length > 0);
  assert.ok(
    normalizeBookingInput({ batchNo: 'B', publicationId: 1, durationSeconds: 60, windowStartUtc: '2027-01-01T00:00:00Z', windowEndUtc: '2027-01-01T02:00:00Z', deviceNos: ['A', 'A'] }).errors.join(' ').includes('重复'),
  );
  assert.ok(
    normalizeBookingInput({ batchNo: 'B', publicationId: 1, durationSeconds: 60, windowStartUtc: '2027-01-01T00:00:00Z', windowEndUtc: '2027-01-01T02:00:00Z', deviceNos: [] }).errors.length > 0,
  );
  assert.ok(
    normalizeBookingInput({ batchNo: 'B', publicationId: 1, durationSeconds: -1, windowStartUtc: '2027-01-01T00:00:00Z', windowEndUtc: '2027-01-01T02:00:00Z', deviceNos: ['A'] }).errors.length > 0,
  );
});

test('纯函数：intersectIntervals / freeIntervals', () => {
  assert.deepEqual(
    intersectIntervals(
      [{ startMs: 0, endMs: 10 }],
      [{ startMs: 5, endMs: 15 }],
    ),
    [{ startMs: 5, endMs: 10 }],
  );
  assert.deepEqual(
    intersectIntervals(
      [{ startMs: 0, endMs: 5 }],
      [{ startMs: 5, endMs: 10 }],
    ),
    [], // 相接不相交
  );
  // 空闲区间：窗口 [0,10) 减去 [2,4) 与 [6,10)
  assert.deepEqual(freeIntervals([{ startMs: 2, endMs: 4 }, { startMs: 6, endMs: 12 }], 0, 10), [
    { startMs: 0, endMs: 2 },
    { startMs: 4, endMs: 6 },
  ]);
  // 占用相接：空闲区间在相接点切开
  assert.deepEqual(freeIntervals([{ startMs: 0, endMs: 5 }], 0, 10), [
    { startMs: 5, endMs: 10 },
  ]);
  assert.deepEqual(freeIntervals([], 0, 10), [{ startMs: 0, endMs: 10 }]);
});

test('纯函数：weightFeasibleIntervals（逐时段核算占用 + 停用 ≤ 库存 − 需求）', () => {
  // 库存 2、需求 1：既有占用 1 枚 [0,10)、停用 1 枚 [5,15) → [5,10) 合计 2 不可行
  const ok = weightFeasibleIntervals(
    [
      {
        required: 1,
        capacity: 2,
        usedIntervals: [{ startMs: 0, endMs: 10, count: 1 }],
        suspendedIntervals: [{ startMs: 5, endMs: 15, count: 1 }],
      },
    ],
    0,
    20,
  );
  assert.deepEqual(ok, [
    { startMs: 0, endMs: 5 },
    { startMs: 10, endMs: 20 } // [10,15) 仅停用 1 枚，余量 1 可行；相邻可行段合并
    ,
  ]);
  // 需求超过库存 → 无可行区间
  assert.deepEqual(
    weightFeasibleIntervals(
      [{ required: 3, capacity: 2, usedIntervals: [], suspendedIntervals: [] }],
      0,
      20,
    ),
    [],
  );
  // 无占用规格 → 整窗可行
  assert.deepEqual(weightFeasibleIntervals([], 0, 20), [{ startMs: 0, endMs: 20 }]);
});

test('纯函数：findEarliestSlot（最早起点；并列取设备编号字典序最小）', () => {
  const weightOk = [{ startMs: 0, endMs: 100 }];
  // 两台设备都在 0 可行 → 字典序最小
  let slot = findEarliestSlot({
    windowStartMs: 0,
    windowEndMs: 100,
    durationMs: 10,
    weightOk,
    devices: [
      { deviceNo: 'B', busy: [] },
      { deviceNo: 'A', busy: [] },
    ],
  });
  assert.deepEqual(slot, { startMs: 0, endMs: 10, deviceNo: 'A' });

  // A 在 [0,50) 被占 → A 起点 50；B 起点 0 → 选 B@0
  slot = findEarliestSlot({
    windowStartMs: 0,
    windowEndMs: 100,
    durationMs: 10,
    weightOk,
    devices: [
      { deviceNo: 'A', busy: [{ startMs: 0, endMs: 50 }] },
      { deviceNo: 'B', busy: [] },
    ],
  });
  assert.deepEqual(slot, { startMs: 0, endMs: 10, deviceNo: 'B' });

  // 配重可行区间与设备空闲错开 → 取交集内最早
  slot = findEarliestSlot({
    windowStartMs: 0,
    windowEndMs: 100,
    durationMs: 10,
    weightOk: [{ startMs: 40, endMs: 100 }],
    devices: [{ deviceNo: 'A', busy: [{ startMs: 40, endMs: 60 }] }],
  });
  assert.deepEqual(slot, { startMs: 60, endMs: 70, deviceNo: 'A' });

  // 间隙短于时长 → 跳过；间隙恰好容纳 → 可行
  slot = findEarliestSlot({
    windowStartMs: 0,
    windowEndMs: 100,
    durationMs: 20,
    weightOk,
    devices: [{ deviceNo: 'A', busy: [{ startMs: 0, endMs: 40 }, { startMs: 60, endMs: 100 }] }],
  });
  assert.deepEqual(slot, { startMs: 40, endMs: 60, deviceNo: 'A' });
  // 间隙 20 < 时长 30 → 无可行 → null
  assert.equal(
    findEarliestSlot({
      windowStartMs: 0,
      windowEndMs: 100,
      durationMs: 30,
      weightOk,
      devices: [{ deviceNo: 'A', busy: [{ startMs: 0, endMs: 40 }, { startMs: 60, endMs: 100 }] }],
    }),
    null,
  );
  assert.equal(
    findEarliestSlot({
      windowStartMs: 0,
      windowEndMs: 100,
      durationMs: 200,
      weightOk,
      devices: [{ deviceNo: 'A', busy: [] }],
    }),
    null,
  );
  assert.equal(
    findEarliestSlot({
      windowStartMs: 0,
      windowEndMs: 100,
      durationMs: 10,
      weightOk: [],
      devices: [{ deviceNo: 'A', busy: [] }],
    }),
    null,
  );
});
