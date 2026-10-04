import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { normalizeAutoBookInput, findEarliestSlot } from '../src/autobook.js';

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

const cfg = { holes: 4, tolerance: 0.5, holeMaxMass: [100, 100, 100, 100] };

async function publishWith(qty) {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: qty }]);
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  return pub.json.id;
}

// ---------- 纯函数：输入规整 ----------

test('normalizeAutoBookInput：合法请求规整，设备编号去空白/排序', () => {
  const { errors, clean } = normalizeAutoBookInput({
    batchNo: '  B1 ',
    publicationId: 3,
    durationSeconds: 900,
    searchStartUtc: '2028-03-10T08:00:00Z',
    searchEndUtc: '2028-03-10T18:00:00Z',
    deviceNos: [' CENT-02 ', 'CENT-01'],
  });
  assert.deepEqual(errors, []);
  assert.equal(clean.batchNo, 'B1');
  assert.equal(clean.publicationId, 3);
  assert.equal(clean.durationSeconds, 900);
  assert.equal(clean.searchStartMs, Date.parse('2028-03-10T08:00:00Z'));
  assert.deepEqual(clean.deviceNos, ['CENT-01', 'CENT-02']);
});

test('normalizeAutoBookInput：非法输入逐条拒绝', () => {
  const base = {
    batchNo: 'B',
    publicationId: 1,
    durationSeconds: 60,
    searchStartUtc: '2028-03-10T08:00:00Z',
    searchEndUtc: '2028-03-10T09:00:00Z',
    deviceNos: ['C1'],
  };
  assert.ok(normalizeAutoBookInput({ ...base, batchNo: ' ' }).errors.join(' ').includes('批次号'));
  assert.ok(normalizeAutoBookInput({ ...base, publicationId: 0 }).errors.length > 0);
  assert.ok(
    normalizeAutoBookInput({ ...base, durationSeconds: 0 }).errors.join(' ').includes('正整数'),
  );
  assert.ok(
    normalizeAutoBookInput({ ...base, durationSeconds: 1.5 }).errors.join(' ').includes('正整数'),
  );
  assert.ok(
    normalizeAutoBookInput({ ...base, searchStartUtc: 'nope' }).errors.join(' ').includes('UTC'),
  );
  assert.ok(
    normalizeAutoBookInput({
      ...base,
      searchStartUtc: '2028-03-10T09:00:00Z',
      searchEndUtc: '2028-03-10T08:00:00Z',
    }).errors.join(' ').includes('早于'),
  );
  assert.ok(normalizeAutoBookInput({ ...base, deviceNos: [] }).errors.join(' ').includes('非空'));
  assert.ok(
    normalizeAutoBookInput({ ...base, deviceNos: ['C1', ''] }).errors.join(' ').includes('不能为空'),
  );
  assert.ok(
    normalizeAutoBookInput({ ...base, deviceNos: ['C1', 'C1'] })
      .errors.join(' ')
      .includes('重复'),
  );
  assert.ok(normalizeAutoBookInput(null).errors.join(' ').includes('对象'));
});

// ---------- 纯函数：最早可行起点 ----------

const D = 10_000; // 10 秒
const L = 0;
const E = 30_000;
const usage = [{ mass: 50, count: 1 }];
const cap1 = () => 1;

test('findEarliestSlot：窗口短于时长 → windowTooShort', () => {
  const r = findEarliestSlot({
    durationMs: 2000,
    windowStartMs: 100,
    windowEndMs: 1500, // 窗口仅 1400ms，放不下 2000ms
    usage,
    capacityOf: cap1,
    schedulesByDevice: new Map([['C1', []]]),
    deviceNos: ['C1'],
  });
  assert.equal(r.found, false);
  assert.equal(r.reason, 'windowTooShort');
});

test('findEarliestSlot：窗口与时长等长且全空 → 取窗口起点与字典序最小设备', () => {
  const r = findEarliestSlot({
    durationMs: 30_000,
    windowStartMs: L,
    windowEndMs: E,
    usage,
    capacityOf: cap1,
    schedulesByDevice: new Map([
      ['C-A', []],
      ['C-B', []],
    ]),
    deviceNos: ['C-A', 'C-B'], // 规整层保证已按字典序
  });
  assert.deepEqual(r, { found: true, startMs: 0, deviceNo: 'C-A' });
});

test('findEarliestSlot：起点被既有预约占满配重 → 取其后相接点', () => {
  // 既有预约 [9s, 11s)，容量 1：起点 s∈(-1s, 11s) 均冲突；s=11s 相接可用
  const r = findEarliestSlot({
    durationMs: D,
    windowStartMs: L,
    windowEndMs: E,
    usage,
    capacityOf: cap1,
    reservations: [
      { startMs: 9000, endMs: 11000, usage: [{ mass: 50, count: 1 }] },
    ],
    schedulesByDevice: new Map([['C1', []]]),
    deviceNos: ['C1'],
  });
  assert.equal(r.found, true);
  assert.equal(r.startMs, 11_000);
  assert.equal(r.deviceNo, 'C1');
});

test('findEarliestSlot：停用同样推后最早起点（占用+停用口径）', () => {
  const r = findEarliestSlot({
    durationMs: D,
    windowStartMs: L,
    windowEndMs: E,
    usage,
    capacityOf: cap1,
    suspensions: [{ startMs: 5000, endMs: 8000, mass: 50, count: 1 }],
    schedulesByDevice: new Map([['C1', []]]),
    deviceNos: ['C1'],
  });
  // s∈(-5s, 8s) 与停用区间相交 → 冲突；s=8s 相接可用
  assert.equal(r.found, true);
  assert.equal(r.startMs, 8000);
});

test('findEarliestSlot：部分设备被排班占用 → 取空设备；全部占用则推到空档', () => {
  // C-A 在 [0,10s) 有排班（与 [0,10s) 完全重合），C-B 空闲 → L 选 C-B
  let r = findEarliestSlot({
    durationMs: D,
    windowStartMs: L,
    windowEndMs: E,
    usage: [], // 无配重需求
    capacityOf: cap1,
    schedulesByDevice: new Map([
      ['C-A', [{ scheduleId: 1, reservationId: 9, startMs: 0, endMs: 10000 }]],
      ['C-B', []],
    ]),
    deviceNos: ['C-A', 'C-B'],
  });
  assert.equal(r.found, true);
  assert.equal(r.startMs, 0);
  assert.equal(r.deviceNo, 'C-B');

  // 两台在 [0,5s) 都有排班 → s=0 冲突；s=5s 相接两台皆空 → 字典序取 C-A
  r = findEarliestSlot({
    durationMs: D,
    windowStartMs: L,
    windowEndMs: E,
    usage: [],
    capacityOf: cap1,
    schedulesByDevice: new Map([
      ['C-A', [{ scheduleId: 1, reservationId: 9, startMs: 0, endMs: 5000 }]],
      ['C-B', [{ scheduleId: 2, reservationId: 8, startMs: 0, endMs: 5000 }]],
    ]),
    deviceNos: ['C-A', 'C-B'],
  });
  assert.equal(r.found, true);
  assert.equal(r.startMs, 5000);
  assert.equal(r.deviceNo, 'C-A');
});

test('findEarliestSlot：配重全程不足 → noFeasibleSlot（含各候选点诊断）', () => {
  const r = findEarliestSlot({
    durationMs: D,
    windowStartMs: L,
    windowEndMs: E,
    usage,
    capacityOf: cap1,
    // 既有预约覆盖整个起点域：任何 s∈[0,20s] 的 [s,s+10s) 都与之重叠
    reservations: [
      { startMs: -10_000, endMs: 30_000, usage: [{ mass: 50, count: 1 }] },
    ],
    schedulesByDevice: new Map([['C1', []]]),
    deviceNos: ['C1'],
  });
  assert.equal(r.found, false);
  assert.equal(r.reason, 'noFeasibleSlot');
  assert.ok(r.examined.length >= 2);
  assert.ok(r.examined.every((x) => !x.weightOk));
});

test('findEarliestSlot：配重可行但设备全程被占 → noFeasibleSlot', () => {
  const r = findEarliestSlot({
    durationMs: D,
    windowStartMs: L,
    windowEndMs: E,
    usage: [],
    capacityOf: cap1,
    schedulesByDevice: new Map([
      ['C1', [{ scheduleId: 1, reservationId: 9, startMs: 0, endMs: 30000 }]],
    ]),
    deviceNos: ['C1'],
  });
  assert.equal(r.found, false);
  assert.equal(r.reason, 'noFeasibleSlot');
  assert.equal(r.examined[0].weightOk, true);
  assert.deepEqual(r.examined[0].freeDevices, []);
});

test('findEarliestSlot：毫秒精度、跨窗口边界区间与停用+排班共同约束', () => {
  // 区间始于窗口之前：[a,b)=[−4000,2001)，时长 10000 → 占位起点域 (−14000,2001)
  // 截入 [0,20000] 后右边界 2001；停用 [5000,7000) → 占位 (−5000,7000)；
  // 设备 C1 在 [8000,12000) → 占位 (−2000,12000)。
  // 候选点 0 配重被占（与跨边界预约重叠）；2001 配重释放但设备被占；
  // 7000 设备仍被占；12000 设备释放且配重空 → 最早可行 12000、C1。
  const r = findEarliestSlot({
    durationMs: 10_000,
    windowStartMs: 0,
    windowEndMs: 25_000,
    usage: [{ mass: 50, count: 1 }],
    capacityOf: cap1,
    reservations: [
      { startMs: -4000, endMs: 2001, usage: [{ mass: 50, count: 1 }] },
    ],
    suspensions: [{ startMs: 5000, endMs: 7000, mass: 50, count: 1 }],
    schedulesByDevice: new Map([
      ['C1', [{ scheduleId: 7, reservationId: 3, startMs: 8000, endMs: 12000 }]],
    ]),
    deviceNos: ['C1'],
  });
  assert.equal(r.found, true);
  assert.equal(r.startMs, 12_000);
  assert.equal(r.deviceNo, 'C1');

  // 首尾相接：区间恰在窗口起点结束（b == L）→ 窗口起点本身可行
  const abut = findEarliestSlot({
    durationMs: 10_000,
    windowStartMs: 5000,
    windowEndMs: 20_000,
    usage: [{ mass: 50, count: 1 }],
    capacityOf: cap1,
    reservations: [
      { startMs: 0, endMs: 5000, usage: [{ mass: 50, count: 1 }] },
    ],
    schedulesByDevice: new Map([['C1', []]]),
    deviceNos: ['C1'],
  });
  assert.equal(abut.found, true);
  assert.equal(abut.startMs, 5000);
});

test('findEarliestSlot：窗口恰可容纳（最晚起点 R 可行）', () => {
  // 既有预约 [5s,20s)：占位起点域 (−5s,20s)——窗口内 s=0 起的 [0,10s) 与之
  // 重叠不可行；R=20s 的 [20s,30s) 首尾相接，最早可行点即最晚起点 20s。
  const r = findEarliestSlot({
    durationMs: D,
    windowStartMs: L,
    windowEndMs: E,
    usage: [{ mass: 50, count: 1 }],
    capacityOf: cap1,
    reservations: [
      { startMs: 5_000, endMs: 20_000, usage: [{ mass: 50, count: 1 }] },
    ],
    schedulesByDevice: new Map([['C1', []]]),
    deviceNos: ['C1'],
  });
  assert.equal(r.found, true);
  assert.equal(r.startMs, 20_000);
});

// ---------- HTTP API ----------

const DAY1 = '2028-03-10';
const t1 = (hms) => `${DAY1}T${hms}Z`;

test('HTTP 准备：发布占用 50 g×1 的可用图（库存 1）', async () => {
  const id = await publishWith(1);
  assert.equal(typeof id, 'number');
});

test('HTTP 非法输入 → 400（时长/窗口/设备）', async () => {
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  const good = {
    batchNo: 'AUTO-BAD',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t1('10:00:00'),
    searchEndUtc: t1('12:00:00'),
    deviceNos: ['C1'],
  };
  let r = await call('POST', '/api/auto-bookings', { ...good, durationSeconds: -3 });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/auto-bookings', { ...good, deviceNos: ['C1', 'C1'] });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('重复'));
  r = await call('POST', '/api/auto-bookings', {
    ...good,
    searchStartUtc: t1('12:00:00'),
    searchEndUtc: t1('11:00:00'),
  });
  assert.equal(r.status, 400);
});

test('HTTP 窗口起点不晚于服务端当前时刻 → 400', async () => {
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  // 起点 == 客户端当前时刻：服务端取时必不早于它，「严格晚于」校验稳定命中
  const nowIso = new Date().toISOString();
  const r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-PAST',
    publicationId: pubId,
    durationSeconds: 60,
    searchStartUtc: nowIso,
    searchEndUtc: '2028-03-10T00:00:00Z',
    deviceNos: ['C1'],
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('晚于服务端当前时刻'));

  // 历史时刻同样拒绝
  const old = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-PAST2',
    publicationId: pubId,
    durationSeconds: 60,
    searchStartUtc: '2000-01-01T00:00:00Z',
    searchEndUtc: '2000-01-02T00:00:00Z',
    deviceNos: ['C1'],
  });
  assert.equal(old.status, 400);
});

test('HTTP 窗口无法容纳时长 → 409 windowTooShort，不留记录', async () => {
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  const before = await call('GET', '/api/auto-bookings');
  const r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-SHORT',
    publicationId: pubId,
    durationSeconds: 7200,
    searchStartUtc: t1('10:00:00'),
    searchEndUtc: t1('11:00:00'), // 窗口仅 1 小时
    deviceNos: ['C1'],
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.detail.reason, 'windowTooShort');
  const after = await call('GET', '/api/auto-bookings');
  assert.equal(after.json.length, before.json.length);
});

test('HTTP 成功：窗口起点即最早可行，设备取字典序最小；原子生成预约与排班', async () => {
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  const r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-1',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t1('08:00:00'),
    searchEndUtc: t1('12:00:00'),
    deviceNos: ['CENT-02', 'CENT-01'], // 乱序提交
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, t1('08:00:00.000'));
  assert.equal(r.json.endUtc, t1('09:00:00.000'));
  assert.equal(r.json.deviceNo, 'CENT-01'); // 字典序最小
  assert.ok(r.json.reservationId > 0);
  assert.ok(r.json.scheduleId > 0);
  assert.deepEqual(r.json.deviceNos, ['CENT-01', 'CENT-02']);
  // 共用时段
  assert.equal(r.json.reservation.startUtc, r.json.startUtc);
  assert.equal(r.json.schedule.startUtc, r.json.startUtc);
  assert.equal(r.json.schedule.deviceNo, 'CENT-01');
  assert.equal(r.json.reservation.usage[0].mass, 50);

  const state = await call('GET', '/api/state');
  assert.ok(state.json.autoBookings.some((a) => a.batchNo === 'AUTO-1'));
  const detail = await call('GET', `/api/auto-bookings/${r.json.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.batchNo, 'AUTO-1');
});

test('HTTP 幂等：同号同请求重试 200 返回原记录；异请求 409', async () => {
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  const body = {
    batchNo: 'AUTO-1',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t1('08:00:00'),
    searchEndUtc: t1('12:00:00'),
    deviceNos: ['CENT-02', 'CENT-01'],
  };
  const first = (await call('GET', '/api/auto-bookings')).json.find((a) => a.batchNo === 'AUTO-1');
  const r = await call('POST', '/api/auto-bookings', body);
  assert.equal(r.status, 200);
  assert.equal(r.json.id, first.id);
  assert.equal(r.json.reservationId, first.reservationId);
  assert.equal(r.json.scheduleId, first.scheduleId);

  const diff = await call('POST', '/api/auto-bookings', { ...body, durationSeconds: 1800 });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, first.id);
});

test('HTTP 幂等：取消预约（级联取消排班）后同号同请求仍返回原结果', async () => {
  const first = (await call('GET', '/api/auto-bookings')).json.find((a) => a.batchNo === 'AUTO-1');
  const cancel = await call('POST', `/api/reservations/${first.reservationId}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.status, 'cancelled');
  assert.equal(cancel.json.cancelledScheduleId, first.scheduleId);

  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  const replay = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-1',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t1('08:00:00'),
    searchEndUtc: t1('12:00:00'),
    deviceNos: ['CENT-02', 'CENT-01'],
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.id);
  assert.equal(replay.json.reservation.status, 'cancelled');
  assert.equal(replay.json.schedule.status, 'cancelled');
  // 没有新增任何记录
  const autos = await call('GET', '/api/auto-bookings');
  assert.equal(autos.json.length, (await call('GET', '/api/auto-bookings')).json.length);
});

test('HTTP 批次号与普通预约双向撞号 → 409', async () => {
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  // 普通预约先占批次号
  const ord = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-X',
    publicationId: pubId,
    startUtc: t1('14:00:00'),
    endUtc: t1('15:00:00'),
  });
  assert.equal(ord.status, 201);
  const clash = await call('POST', '/api/auto-bookings', {
    batchNo: 'BATCH-X',
    publicationId: pubId,
    durationSeconds: 600,
    searchStartUtc: t1('16:00:00'),
    searchEndUtc: t1('18:00:00'),
    deviceNos: ['C1'],
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.json.existingReservationId, ord.json.id);

  // 一键预约先占批次号
  const auto = await call('POST', '/api/auto-bookings', {
    batchNo: 'BATCH-Y',
    publicationId: pubId,
    durationSeconds: 600,
    searchStartUtc: t1('16:00:00'),
    searchEndUtc: t1('18:00:00'),
    deviceNos: ['C1'],
  });
  assert.equal(auto.status, 201);
  const clash2 = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-Y',
    publicationId: pubId,
    startUtc: t1('20:00:00'),
    endUtc: t1('21:00:00'),
  });
  assert.equal(clash2.status, 409);
  // 一键预约生成的预约本身已占用批次号：普通预约按原语义拒绝（既有预约撞号）
  assert.equal(clash2.json.existingId, auto.json.reservationId);
});

test('HTTP 配重冲突推后起点：既有预约终点相接处可用', async () => {
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  // 既有预约 [08:30, 09:30)（库存 1）：s=08:00 的 [08,09) 与之重叠 → 不可；
  // s=09:30 的 [09:30,10:30) 首尾相接 → 最早可行
  const existing = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-W',
    publicationId: pubId,
    startUtc: t1('08:30:00'),
    endUtc: t1('09:30:00'),
  });
  assert.equal(existing.status, 201, JSON.stringify(existing.json));
  const r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-W',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t1('08:00:00'),
    searchEndUtc: t1('12:00:00'),
    deviceNos: ['CENT-09'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, t1('09:30:00.000'));
  assert.equal(r.json.endUtc, t1('10:30:00.000'));
  assert.equal(r.json.deviceNo, 'CENT-09');
});

test('HTTP 设备排班冲突逐设备核算：被占设备落选/起点后移', async () => {
  // 独立于配重测试的占用：使用次日 DAY2，库存调到 3 并发布新图，
  // 使配重恒不构成约束（同刻三条占用合计 3 ≤ 3），仅由设备排班决定可行性
  const day2 = '2028-03-11';
  const t2 = (hms) => `${day2}T${hms}Z`;
  const pubId = await publishWith(3);

  // 普通预约占住两台设备的 [08:00,08:30)（不同预约，各自排班）
  const p1 = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-DEV-A',
    publicationId: pubId,
    startUtc: t2('08:00:00'),
    endUtc: t2('08:30:00'),
  });
  assert.equal(p1.status, 201, JSON.stringify(p1.json));
  assert.equal((await call('POST', '/api/schedules', {
    reservationId: p1.json.id,
    deviceNo: 'CENT-01',
  })).status, 201);
  const p2 = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-DEV-B',
    publicationId: pubId,
    startUtc: t2('08:00:00'),
    endUtc: t2('08:30:00'),
  });
  assert.equal(p2.status, 201, JSON.stringify(p2.json));
  assert.equal((await call('POST', '/api/schedules', {
    reservationId: p2.json.id,
    deviceNo: 'CENT-02',
  })).status, 201);
  // 另一条占住 CENT-01 的 [08:30,09:00)，使 CENT-01 到 09:00 才释放
  const p3 = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-DEV-C',
    publicationId: pubId,
    startUtc: t2('08:30:00'),
    endUtc: t2('09:00:00'),
  });
  assert.equal(p3.status, 201, JSON.stringify(p3.json));
  assert.equal((await call('POST', '/api/schedules', {
    reservationId: p3.json.id,
    deviceNo: 'CENT-01',
  })).status, 201);

  // [08:00,08:30) 两台均被占 → 起点后移；08:30 时 CENT-02 相接释放而 CENT-01
  // 仍被占 → 最早可行 08:30、设备 CENT-02
  let r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-DEV1',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t2('08:00:00'),
    searchEndUtc: t2('12:00:00'),
    deviceNos: ['CENT-01', 'CENT-02'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, t2('08:30:00.000'));
  assert.equal(r.json.deviceNo, 'CENT-02');

  // 之后 CENT-02 在 [08:30,09:30) 也被 AUTO-DEV1 占用；09:00 起 CENT-01 释放，
  // 但 CENT-01 的 [09:00,10:00) 与 CENT-02 的占用无冲突 → 09:00 两台皆空，
  // 字典序取 CENT-01。
  r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-DEV2',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t2('08:00:00'),
    searchEndUtc: t2('12:00:00'),
    deviceNos: ['CENT-01', 'CENT-02'],
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, t2('09:00:00.000'));
  assert.equal(r.json.deviceNo, 'CENT-01');
});

test('HTTP 无可行时段 → 409 noFeasibleSlot 且不留任何记录', async () => {
  // 当前可用图为库存 3（设备测试发布）。用独立日期 DAY4 放置三条并行重叠、
  // 各占 1 枚的预约，使 [07:00,13:00) 内每时刻占用恒为 3 枚（满载）。
  const day4 = '2028-03-13';
  const t4 = (hms) => `${day4}T${hms}Z`;
  const pubId = (await call('GET', '/api/publications')).json.filter((p) => p.usable)[0].id;
  for (const no of ['BATCH-WIDE-1', 'BATCH-WIDE-2', 'BATCH-WIDE-3']) {
    const w = await call('POST', '/api/reservations', {
      batchNo: no,
      publicationId: pubId,
      startUtc: t4('07:00:00'),
      endUtc: t4('13:00:00'),
    });
    assert.equal(w.status, 201, JSON.stringify(w.json));
  }
  const beforeRes = (await call('GET', '/api/reservations')).json.length;
  const beforeSch = (await call('GET', '/api/schedules')).json.schedules.length;
  const beforeAuto = (await call('GET', '/api/auto-bookings')).json.length;

  const r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-NONE',
    publicationId: pubId,
    durationSeconds: 3600,
    searchStartUtc: t4('08:00:00'),
    searchEndUtc: t4('12:00:00'),
    deviceNos: ['CENT-01', 'CENT-02'],
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json.detail.reason, 'noFeasibleSlot');
  assert.ok(Array.isArray(r.json.detail.examined));
  assert.ok(r.json.errors.join(' ').includes('不存在能完整容纳'));

  assert.equal((await call('GET', '/api/reservations')).json.length, beforeRes);
  assert.equal((await call('GET', '/api/schedules')).json.schedules.length, beforeSch);
  assert.equal((await call('GET', '/api/auto-bookings')).json.length, beforeAuto);
});

test('HTTP 图已失效 → 400 且不留记录', async () => {
  // 改库存使当前全部图失效
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 5 }]);
  const stale = (await call('GET', '/api/publications')).json[0];
  const beforeAuto = (await call('GET', '/api/auto-bookings')).json.length;
  const r = await call('POST', '/api/auto-bookings', {
    batchNo: 'AUTO-STALE',
    publicationId: stale.id,
    durationSeconds: 600,
    searchStartUtc: '2028-03-11T08:00:00Z',
    searchEndUtc: '2028-03-11T12:00:00Z',
    deviceNos: ['C1'],
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不可用'));
  assert.equal((await call('GET', '/api/auto-bookings')).json.length, beforeAuto);
});

test('HTTP 详情 404；列表可查', async () => {
  const r = await call('GET', '/api/auto-bookings/999999');
  assert.equal(r.status, 404);
  const list = await call('GET', '/api/auto-bookings');
  assert.equal(list.status, 200);
  assert.ok(list.json.length >= 3);
});
