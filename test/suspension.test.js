import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  availabilitySegments,
  checkSuspension,
  checkCapacity,
  buildSchedule,
} from '../src/reserve.js';

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
const T = (s) => `2027-03-01T${s}:00.000Z`;

let pubId; // 冻结图占用 50 g × 1

test('准备：库存 50 g × 2，发布冻结图（占用 50 g × 1）', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  pubId = pub.json.id;
});

// ---------- 登记校验 ----------

test('非法时间/数量/原因被拒绝（400）且不留记录', async () => {
  const before = (await call('GET', '/api/suspensions')).json.length;
  const base = {
    mass: 50,
    quantity: 1,
    reason: '检定',
    startUtc: T('10:00'),
    endUtc: T('11:00'),
  };
  let r = await call('POST', '/api/suspensions', { ...base, startUtc: T('11:00') });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('早于'));

  r = await call('POST', '/api/suspensions', { ...base, startUtc: 'nope' });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/suspensions', { ...base, quantity: 0 });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/suspensions', { ...base, quantity: 1.5 });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/suspensions', { ...base, quantity: '2' });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/suspensions', { ...base, mass: -1 });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/suspensions', { ...base, mass: '50' });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/suspensions', { ...base, reason: '   ' });
  assert.equal(r.status, 400);

  const afterN = (await call('GET', '/api/suspensions')).json.length;
  assert.equal(afterN, before);
});

test('未知规格被拒绝（400）且不留记录', async () => {
  const before = (await call('GET', '/api/suspensions')).json.length;
  const r = await call('POST', '/api/suspensions', {
    mass: 999,
    quantity: 1,
    reason: '未知规格',
    startUtc: T('10:00'),
    endUtc: T('11:00'),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('未知'));
  const afterN = (await call('GET', '/api/suspensions')).json.length;
  assert.equal(afterN, before);
});

test('超量停用（单条即超当前数量）→ 409，附冲突规格与时段，不留记录', async () => {
  const before = (await call('GET', '/api/suspensions')).json.length;
  const r = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 3, // 库存仅 2
    reason: '一次性超量',
    startUtc: T('08:00'),
    endUtc: T('09:00'),
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  const c = r.json.detail.conflicts[0];
  assert.equal(c.mass, 50);
  assert.equal(c.required, 3);
  assert.equal(c.capacity, 2);
  assert.equal(c.peak, 0);
  assert.equal(c.windows[0].start, T('08:00'));
  assert.equal(c.windows[0].end, T('09:00'));
  assert.equal(c.windows[0].suspended, 0);
  const afterN = (await call('GET', '/api/suspensions')).json.length;
  assert.equal(afterN, before);
});

// ---------- 重叠累加与左闭右开 ----------

test('成功登记：201，视图含 phase/revocable', async () => {
  const r = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '送检校准',
    startUtc: T('10:00'),
    endUtc: T('12:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.mass, 50);
  assert.equal(r.json.quantity, 1);
  assert.equal(r.json.reason, '送检校准');
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.phase, 'notStarted');
  assert.equal(r.json.revocable, true);
  assert.equal(r.json.startUtc, T('10:00'));
  assert.equal(r.json.endUtc, T('12:00'));
});

test('同规格重叠停用量累加：重叠峰值 ≤ 库存可登记', async () => {
  // [10,12) 已停 1；再停 1 [11,13)，重叠 [11,12) 峰值 2 = 库存 2 → 通过
  const r = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '损坏待修',
    startUtc: T('11:00'),
    endUtc: T('13:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('重叠停用超量 → 409 且指出规格与冲突时段，不留记录', async () => {
  const before = (await call('GET', '/api/suspensions')).json.length;
  // [11:30,12:00) 已有停用 2，再停 1 → 3 > 2
  const r = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '再停一枚',
    startUtc: T('11:30'),
    endUtc: T('12:30'),
  });
  assert.equal(r.status, 409);
  const c = r.json.detail.conflicts[0];
  assert.equal(c.mass, 50);
  assert.equal(c.capacity, 2);
  assert.equal(c.windows.length, 1);
  assert.equal(c.windows[0].start, T('11:30'));
  assert.equal(c.windows[0].end, T('12:00'));
  assert.equal(c.windows[0].suspended, 2);
  const afterN = (await call('GET', '/api/suspensions')).json.length;
  assert.equal(afterN, before);
});

test('左闭右开：终点相接不累加，可登记', async () => {
  // 与第一条 [10,12) 终点相接：[12,13) 已有第二条 1 枚，库存 2，足够
  const r = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '相接时段',
    startUtc: T('12:00'),
    endUtc: T('12:30'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('停用可与既有预约重叠：登记停用不核对预约占用', async () => {
  // 预约 [09,11) 占用 1（其 [10,11) 已与「送检校准」停用 1 枚共存，合计恰为库存 2）
  const res = await call('POST', '/api/reservations', {
    batchNo: 'S-RES-1',
    publicationId: pubId,
    startUtc: T('09:00'),
    endUtc: T('11:00'),
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  // 同时段再登记停用 1 枚（[09,10) 内无其他停用）——登记不核对预约占用，允许
  const sus = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '与预约重叠的停用',
    startUtc: T('09:00'),
    endUtc: T('10:00'),
  });
  assert.equal(sus.status, 201, JSON.stringify(sus.json));
});

// ---------- 停用对新预约的影响 ----------

test('新预约事务同时核对库存/停用/已有预约：占用+停用超库存 → 整单拒绝', async () => {
  const before = (await call('GET', '/api/reservations')).json.length;
  // [10:30,11:30)：
  //   [10:30,11) S-RES-1 占用 1 + 送检停用 1；[11,11:30) 送检+损坏停用 2
  // 新预约需 1 → 两段均超（库存 2），合并冲突窗 [10:30,11:30)
  const r = await call('POST', '/api/reservations', {
    batchNo: 'S-RES-2',
    publicationId: pubId,
    startUtc: T('10:30'),
    endUtc: T('11:30'),
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  const c = r.json.detail.conflicts[0];
  assert.equal(c.mass, 50);
  assert.equal(c.capacity, 2);
  assert.equal(c.required, 1);
  assert.equal(c.windows.length, 1);
  assert.equal(c.windows[0].start, T('10:30'));
  assert.equal(c.windows[0].end, T('11:30'));
  assert.equal(c.windows[0].used, 1);
  assert.equal(c.windows[0].suspended, 2);
  // 整单拒绝：不产生任何记录
  const afterN = (await call('GET', '/api/reservations')).json.length;
  assert.equal(afterN, before);
});

test('停用终点相接（左闭右开）不占容量，新预约通过', async () => {
  // [13,14)：所有停用均已结束（损坏停用 13:00 终点相接），库存 2 ≥ 需求 1
  const r = await call('POST', '/api/reservations', {
    batchNo: 'S-RES-3',
    publicationId: pubId,
    startUtc: T('13:00'),
    endUtc: T('14:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

// ---------- 撤销 ----------

test('仅未开始的停用可撤销；已撤销幂等；撤销留历史并释放容量', async () => {
  const list = await call('GET', '/api/suspensions');
  const target = list.json.find(
    (x) => x.reason === '送检校准' && x.startUtc === T('10:00'),
  );
  assert.ok(target);

  // 撤销前：送检停用 [10,12) 仍生效，[10:30,11) 已停 1 枚，再停 1 → 峰值 2，
  // 但 [11,11:30) 与损坏叠加为 2……直接用送检覆盖的 [10,11) 验证：停 1 + 再停 2 超量
  const blocked = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 2,
    reason: '撤销前应当被拒',
    startUtc: T('10:00'),
    endUtc: T('11:00'),
  });
  assert.equal(blocked.status, 409);

  let r = await call('POST', `/api/suspensions/${target.id}/revoke`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'revoked');
  assert.equal(r.json.phase, 'revoked');
  assert.equal(r.json.revocable, false);
  assert.ok(r.json.revokedAt);

  // 历史保留：详情仍可查到撤销记录
  const again = await call('GET', `/api/suspensions/${target.id}`);
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'revoked');

  // 幂等：重复撤销返回原记录
  r = await call('POST', `/api/suspensions/${target.id}/revoke`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'revoked');

  // 释放后续容量：送检撤销后 [10,11) 已无任何停用，再停 2 枚 = 库存 2，允许
  const freed = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 2,
    reason: '撤销释放后登记',
    startUtc: T('10:00'),
    endUtc: T('11:00'),
  });
  assert.equal(freed.status, 201, JSON.stringify(freed.json));
});

test('已开始的停用不能撤销（409）', async () => {
  const now = Date.now();
  const created = await call('POST', '/api/suspensions', {
    mass: 50,
    quantity: 1,
    reason: '进行中的停用',
    startUtc: new Date(now - 3600e3).toISOString(),
    endUtc: new Date(now + 3600e3).toISOString(),
  });
  // 登记时段与既有未来停用不重叠（当前 2026，未来停用在 2027），容量 2 足够
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.phase, 'ongoing');
  assert.equal(created.json.revocable, false);

  const r = await call('POST', `/api/suspensions/${created.json.id}/revoke`);
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('未开始'));
  const fresh = await call('GET', `/api/suspensions/${created.json.id}`);
  assert.equal(fresh.json.status, 'active');
});

test('撤销不存在的停用 → 404', async () => {
  const r = await call('POST', '/api/suspensions/9999/revoke');
  assert.equal(r.status, 404);
});

// ---------- 日程展示 ----------

test('日程展示停用量与占用加停用不足区段；占用不足字段含义不变', async () => {
  // 2027-03-01 [09,13) 窗口内（当前库存 2 枚）：
  // 预约：S-RES-1 [09,11) 用 1；S-RES-3 [13,14) 用 1（不在窗口）
  // 生效停用：与预约重叠 [09,10) ×1；撤销释放后补登 [10,11) ×2；
  //           损坏 [11,13) ×1；相接 [12,12:30) ×1；撤销释放 [11:30,12:30) ×1；
  //           送检校准 [10,12) 已撤销（不出现在任何分段）
  const sch = await call(
    'GET',
    '/api/schedule?from=2027-03-01T09:00:00Z&to=2027-03-01T13:00:00Z',
  );
  assert.equal(sch.status, 200, JSON.stringify(sch.json));
  const spec = sch.json.specs.find((s) => s.mass === 50);
  assert.equal(spec.capacity, 2);

  // 占用口径：峰值 1，从不超过库存 2 → shortage=false（字段含义保持不变）
  assert.equal(spec.peak, 1);
  assert.equal(spec.shortage, false);
  assert.ok(spec.segments.every((g) => g.shortage === false));

  // 停用分段：suspended>0，补登的 [10,11) 为 2
  const susSegs = spec.suspendedSegments;
  assert.ok(susSegs.some((g) => g.start === T('09:00') && g.suspended === 1));
  assert.ok(susSegs.some((g) => g.start === T('10:00') && g.suspended === 2));

  // 合计口径：[10,11) 占用 1 + 停用 2 = 3 > 2 → 合计不足（停用登记时不核对预约）
  assert.equal(spec.peakCombined, 3);
  assert.equal(spec.combinedShortage, true);
  const bad = spec.combinedSegments.filter((g) => g.shortage);
  assert.deepEqual(
    bad.map((g) => [g.start, g.end, g.used, g.suspended]),
    [[T('10:00'), T('11:00'), 1, 2]],
  );

  // 已撤销停用不出现：[11,11:30) 停用量只来自损坏 1；[12,12:30) 为相接 1 + 撤销释放 1 = 2
  const seg1111 = spec.combinedSegments.find((g) => g.start === T('11:00'));
  assert.equal(seg1111.suspended, 1);
  const seg1200 = spec.combinedSegments.find((g) => g.start === T('12:00'));
  assert.equal(seg1200.suspended, 2);
});

test('库存减少不改写既有停用与预约；占用不足与合计不足分别体现', async () => {
  await call('PUT', '/api/weights', []);
  // [10,11)：S-RES-1 占用 1、补登停用 2，库存降为 0 → 两种口径都不足
  const sch = await call(
    'GET',
    '/api/schedule?from=2027-03-01T10:00:00Z&to=2027-03-01T11:00:00Z',
  );
  const spec = sch.json.specs.find((s) => s.mass === 50);
  assert.equal(spec.capacity, 0);
  // 既有停用仍在
  assert.ok(spec.suspendedSegments.some((g) => g.suspended >= 1));
  // 占用 1 > 0：占用口径不足
  assert.equal(spec.shortage, true);
  // 合计同样不足
  assert.equal(spec.combinedShortage, true);
  // 既有预约/停用均未被改写
  const res = await call('GET', '/api/reservations');
  assert.ok(res.json.some((x) => x.batchNo === 'S-RES-1' && x.status === 'active'));
  // 恢复库存
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
});

test('/api/state 含 suspensions 列表', async () => {
  const s = await call('GET', '/api/state');
  assert.ok(Array.isArray(s.json.suspensions));
  assert.ok(s.json.suspensions.length >= 3);
  const sample = s.json.suspensions[0];
  assert.ok(['active', 'revoked'].includes(sample.status));
  assert.ok('phase' in sample && 'revocable' in sample);
});

// ---------- 纯函数测试 ----------

test('availabilitySegments：双层扫描线，左闭右开', () => {
  const segs = availabilitySegments(
    [{ startMs: 0, endMs: 10, count: 1 }],
    [{ startMs: 5, endMs: 15, count: 2 }],
    0,
    20,
  );
  assert.deepEqual(
    segs.map((g) => [g.startMs, g.endMs, g.used, g.suspended]),
    [
      [0, 5, 1, 0],
      [5, 10, 1, 2],
      [10, 15, 0, 2],
      [15, 20, 0, 0],
    ],
  );
  // 相接区间不叠加
  const touch = availabilitySegments(
    [],
    [
      { startMs: 0, endMs: 10, count: 1 },
      { startMs: 10, endMs: 20, count: 1 },
    ],
    0,
    20,
  );
  assert.deepEqual(
    touch.map((g) => [g.startMs, g.endMs, g.suspended]),
    [
      [0, 10, 1],
      [10, 20, 1],
    ],
  );
});

test('checkSuspension：重叠累加超量时返回合并时段', () => {
  // 峰值 2 + 本次 1 = 3 ≤ 容量 3 → 通过
  const ok = checkSuspension({
    mass: 50,
    quantity: 1,
    capacity: 3,
    overlapping: [
      { startMs: 0, endMs: 10, mass: 50, count: 1 },
      { startMs: 5, endMs: 15, mass: 50, count: 1 },
    ],
    startMs: 0,
    endMs: 20,
  });
  assert.equal(ok.ok, true);

  // 容量 2：[0,10) 已停 2，再停 1 → 超量
  const bad = checkSuspension({
    mass: 50,
    quantity: 1,
    capacity: 2,
    overlapping: [{ startMs: 0, endMs: 10, mass: 50, count: 2 }],
    startMs: 0,
    endMs: 20,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.conflict.mass, 50);
  assert.equal(bad.conflict.peak, 2);
  assert.equal(bad.conflict.windows.length, 1);
  assert.equal(bad.conflict.windows[0].suspended, 2);

  // 其他规格的停用不参与
  const other = checkSuspension({
    mass: 50,
    quantity: 2,
    capacity: 2,
    overlapping: [{ startMs: 0, endMs: 10, mass: 10, count: 9 }],
    startMs: 0,
    endMs: 10,
  });
  assert.equal(other.ok, true);
});

test('checkCapacity：占用 + 停用 + 本次需求 > 库存时冲突', () => {
  // 库存 3：[5,10) 占用1+停用1+需求1=3 ≤ 3 → 通过；[10,15) 0+1+1=2 ≤ 3
  const ok = checkCapacity({
    usage: [{ mass: 50, count: 1 }],
    capacityOf: () => 3,
    overlapping: [{ startMs: 0, endMs: 10, usage: [{ mass: 50, count: 1 }] }],
    suspensions: [{ startMs: 5, endMs: 15, mass: 50, count: 1 }],
    startMs: 0,
    endMs: 20,
  });
  assert.equal(ok.ok, true);

  // 库存 2：[5,10) 1+1+1=3 > 2 → 冲突，时段恰好 [5,10)
  const r2 = checkCapacity({
    usage: [{ mass: 50, count: 1 }],
    capacityOf: () => 2,
    overlapping: [{ startMs: 0, endMs: 10, usage: [{ mass: 50, count: 1 }] }],
    suspensions: [{ startMs: 5, endMs: 15, mass: 50, count: 1 }],
    startMs: 0,
    endMs: 20,
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.conflicts[0].windows.length, 1);
  assert.equal(r2.conflicts[0].windows[0].start, new Date(5).toISOString());
  assert.equal(r2.conflicts[0].windows[0].end, new Date(10).toISOString());
  assert.equal(r2.conflicts[0].windows[0].used, 1);
  assert.equal(r2.conflicts[0].windows[0].suspended, 1);
});

test('buildSchedule：停用量、占用不足与合计不足分段', () => {
  const specs = buildSchedule({
    reservations: [{ startMs: 0, endMs: 10, usage: [{ mass: 50, count: 1 }] }],
    suspensions: [{ startMs: 5, endMs: 15, mass: 50, count: 2 }],
    masses: [50],
    capacityOf: () => 2,
    fromMs: 0,
    toMs: 20,
  });
  const s = specs[0];
  // 占用峰值 1 ≤ 2
  assert.equal(s.peak, 1);
  assert.equal(s.shortage, false);
  // 停用峰值 2
  assert.equal(s.peakSuspended, 2);
  // 合计峰值 3 > 2
  assert.equal(s.peakCombined, 3);
  assert.equal(s.combinedShortage, true);
  const bad = s.combinedSegments.filter((g) => g.shortage);
  assert.deepEqual(
    bad.map((g) => [g.start, g.end, g.used, g.suspended]),
    [[new Date(5).toISOString(), new Date(10).toISOString(), 1, 2]],
  );
});
