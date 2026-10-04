import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  parseUtcMs,
  planUsage,
  occupancySegments,
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

// 4 孔、容差 0.5：管 A=50 在孔 0，对径孔 2 必须放 50 g 配重 → 冻结图占用 50 g × 1
const cfg = { holes: 4, tolerance: 0.5, holeMaxMass: [100, 100, 100, 100] };

async function setupPublished(weightsQty = 1) {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: weightsQty }]);
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  return pub.json.id;
}

let pubId; // 当前可用发布记录
const T = (s) => `2027-01-01T${s}:00.000Z`;

test('准备：发布可行装载图（占用 50 g 配重 1 枚）', async () => {
  pubId = await setupPublished(1);
  const pub = await call('GET', `/api/publications/${pubId}`);
  assert.equal(pub.json.usable, true);
  assert.equal(pub.json.result.weightCount, 1);
});

test('非法时间被拒绝（400）：起点不早于终点、非法字符串、缺字段', async () => {
  let r = await call('POST', '/api/reservations', {
    batchNo: 'B-T1',
    publicationId: pubId,
    startUtc: T('10:00'),
    endUtc: T('10:00'),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('早于'));

  r = await call('POST', '/api/reservations', {
    batchNo: 'B-T1',
    publicationId: pubId,
    startUtc: T('11:00'),
    endUtc: T('10:00'),
  });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/reservations', {
    batchNo: 'B-T1',
    publicationId: pubId,
    startUtc: 'not-a-time',
    endUtc: T('10:00'),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('UTC'));

  r = await call('POST', '/api/reservations', {
    batchNo: '',
    publicationId: pubId,
    startUtc: T('09:00'),
    endUtc: T('10:00'),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('批次号'));
});

test('未知图与不可用图被拒绝（400）', async () => {
  let r = await call('POST', '/api/reservations', {
    batchNo: 'B-T2',
    publicationId: 9999,
    startUtc: T('09:00'),
    endUtc: T('10:00'),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('未知'));

  // 录入数据变化 → 发布记录失效
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
  r = await call('POST', '/api/reservations', {
    batchNo: 'B-T2',
    publicationId: pubId,
    startUtc: T('09:00'),
    endUtc: T('10:00'),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不可用'));
  // 恢复数据使发布记录重新可用
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 1 }]);
});

test('成功预约：201，按冻结图统计各规格占用', async () => {
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-A',
    publicationId: pubId,
    startUtc: T('09:00'),
    endUtc: T('11:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.batchNo, 'BATCH-A');
  assert.equal(r.json.publicationId, pubId);
  assert.deepEqual(r.json.usage, [{ mass: 50, count: 1 }]);
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.phase, 'notStarted');
  assert.equal(r.json.cancellable, true);
  assert.equal(r.json.startUtc, T('09:00'));
});

test('幂等：同批次号同内容重复提交返回原记录（200），不产生新记录', async () => {
  const before = await call('GET', '/api/reservations');
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-A',
    publicationId: pubId,
    startUtc: '2027-01-01T09:00:00Z', // 等价写法（规范化后与 .000Z 相同）
    endUtc: T('11:00'),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, before.json[0].id);
  assert.equal(r.json.status, 'active');
  const after = await call('GET', '/api/reservations');
  assert.equal(after.json.length, before.json.length);
});

test('同批次号不同内容被拒绝（409 + existingId）', async () => {
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-A',
    publicationId: pubId,
    startUtc: T('09:30'),
    endUtc: T('11:00'),
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.existingId > 0);
});

test('重叠预约超量：409 返回冲突规格与时段，不产生部分占用', async () => {
  const before = await call('GET', '/api/reservations');
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-B',
    publicationId: pubId,
    startUtc: T('10:00'),
    endUtc: T('12:00'),
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  const c = r.json.detail.conflicts[0];
  assert.equal(c.mass, 50);
  assert.equal(c.required, 1);
  assert.equal(c.capacity, 1);
  assert.equal(c.windows.length, 1);
  assert.equal(c.windows[0].start, T('10:00'));
  assert.equal(c.windows[0].end, T('11:00'));
  assert.equal(c.windows[0].used, 1);
  // 不产生部分占用：预约列表不变
  const after = await call('GET', '/api/reservations');
  assert.equal(after.json.length, before.json.length);
});

test('左闭右开：终点与起点相接的预约互不冲突', async () => {
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-C',
    publicationId: pubId,
    startUtc: T('11:00'), // 与 BATCH-A 的终点相接
    endUtc: T('12:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('取消：仅未开始可取消；取消后保留历史且同号重试不重新占用', async () => {
  const list = await call('GET', '/api/reservations');
  const target = list.json.find((x) => x.batchNo === 'BATCH-C');

  // 未开始 → 可取消
  let r = await call('POST', `/api/reservations/${target.id}/cancel`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'cancelled');
  assert.ok(r.json.cancelledAt);

  // 重复取消幂等返回原记录
  r = await call('POST', `/api/reservations/${target.id}/cancel`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'cancelled');

  // 同批次号同内容重试 → 返回已取消的原记录，不重新占用、不产生新记录
  const before = await call('GET', '/api/reservations');
  r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-C',
    publicationId: pubId,
    startUtc: T('11:00'),
    endUtc: T('12:00'),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, target.id);
  assert.equal(r.json.status, 'cancelled');
  const after = await call('GET', '/api/reservations');
  assert.equal(after.json.length, before.json.length);

  // 取消后时段已释放：其他批次号可在同时段预约
  r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-D',
    publicationId: pubId,
    startUtc: T('11:00'),
    endUtc: T('12:00'),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('已开始的预约不能取消（409）', async () => {
  const now = Date.now();
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-PAST',
    publicationId: pubId,
    startUtc: new Date(now - 3600e3).toISOString(), // 1 小时前已开始
    endUtc: new Date(now + 3600e3).toISOString(),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const c = await call('POST', `/api/reservations/${r.json.id}/cancel`);
  assert.equal(c.status, 409);
  assert.ok(c.json.errors.join(' ').includes('未开始'));
  // 状态仍为 active
  const fresh = await call('GET', `/api/reservations/${r.json.id}`);
  assert.equal(fresh.json.status, 'active');
  assert.equal(fresh.json.phase, 'ongoing');
  assert.equal(fresh.json.cancellable, false);
});

test('数量减少/图失效不改写既有预约；日程展示已有占用及不足', async () => {
  // 当前生效占用（2027-01-01 窗口内）：BATCH-A [09,11) 与 BATCH-D [11,12)，各 50 g × 1
  let sch = await call('GET', '/api/schedule?from=2027-01-01T08:00:00Z&to=2027-01-01T13:00:00Z');
  let spec = sch.json.specs.find((s) => s.mass === 50);
  assert.equal(spec.capacity, 1);
  assert.equal(spec.peak, 1);
  assert.equal(spec.shortage, false);

  // 数量减少为 0：既有预约保持原样
  await call('PUT', '/api/weights', []);
  const list = await call('GET', '/api/reservations');
  const a = list.json.find((x) => x.batchNo === 'BATCH-A');
  assert.equal(a.status, 'active');
  assert.deepEqual(a.usage, [{ mass: 50, count: 1 }]);
  assert.equal(a.publicationUsable, false); // 依据图已失效，但预约不改写

  // 日程：当前数量 0，占用 1 → 不足区段
  sch = await call('GET', '/api/schedule?from=2027-01-01T08:00:00Z&to=2027-01-01T13:00:00Z');
  spec = sch.json.specs.find((s) => s.mass === 50);
  assert.equal(spec.capacity, 0);
  assert.equal(spec.peak, 1);
  assert.equal(spec.shortage, true);
  assert.ok(spec.segments.every((g) => g.shortage));

  // 图已失效：新预约被拒绝
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-E',
    publicationId: pubId,
    startUtc: T('13:00'),
    endUtc: T('14:00'),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不可用'));
});

test('后续预约按当前数量判定：恢复 1 枚后重叠预约仍被冲突拒绝', async () => {
  // 恢复数量为 1（数据指纹复原，旧图重新可用）
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 1 }]);
  // 与 BATCH-A/BATCH-D 重叠的新预约：1+1 > 1 → 409（冲突规格与时段）
  const r = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-F',
    publicationId: pubId,
    startUtc: T('10:30'),
    endUtc: T('11:30'),
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.detail.conflicts[0].mass, 50);
  assert.equal(r.json.detail.conflicts[0].capacity, 1);
  // 与 BATCH-D 终点相接的时段（左闭右开）可预约
  const ok = await call('POST', '/api/reservations', {
    batchNo: 'BATCH-F',
    publicationId: pubId,
    startUtc: T('12:00'),
    endUtc: T('13:00'),
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
});

test('日程接口参数校验：非法时间与 from >= to 被拒绝', async () => {
  let r = await call('GET', '/api/schedule?from=bad&to=2027-01-01T00:00:00Z');
  assert.equal(r.status, 400);
  r = await call(
    'GET',
    '/api/schedule?from=2027-01-02T00:00:00Z&to=2027-01-01T00:00:00Z',
  );
  assert.equal(r.status, 400);
});

// ---------- 纯函数单元测试 ----------

test('parseUtcMs：ISO 变体与非法输入', () => {
  assert.equal(parseUtcMs('2027-01-01T09:00:00Z'), Date.parse('2027-01-01T09:00:00Z'));
  assert.equal(parseUtcMs('2027-01-01T09:00'), Date.parse('2027-01-01T09:00:00Z'));
  assert.equal(parseUtcMs('2027-01-01'), Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(
    parseUtcMs('2027-01-01T17:00:00+08:00'),
    Date.parse('2027-01-01T09:00:00Z'),
  );
  assert.equal(parseUtcMs('not-a-time'), null);
  assert.equal(parseUtcMs('2027-13-01T00:00:00Z'), null);
  assert.equal(parseUtcMs(''), null);
  assert.equal(parseUtcMs(123), null);
});

test('planUsage：按冻结图统计各质量规格占用', () => {
  const pub = {
    result: {
      arrangement: [
        { kind: 'tube', ref: 'A', mass: 50 },
        { kind: 'weight', ref: '配重#1-1', mass: 10 },
        { kind: 'weight', ref: '配重#1-2', mass: 10 },
        null,
      ],
    },
  };
  assert.deepEqual(planUsage(pub), [{ mass: 10, count: 2 }]);
  assert.deepEqual(planUsage({ result: { arrangement: [null, null] } }), []);
});

test('occupancySegments：左闭右开，相接区间不叠加', () => {
  const segs = occupancySegments(
    [
      { startMs: 0, endMs: 10, count: 1 },
      { startMs: 10, endMs: 20, count: 1 },
    ],
    0,
    20,
  );
  assert.deepEqual(segs, [
    { startMs: 0, endMs: 10, used: 1 },
    { startMs: 10, endMs: 20, used: 1 },
  ]);
  // 重叠区间峰值 2，裁剪到窗口内
  const segs2 = occupancySegments(
    [
      { startMs: 0, endMs: 15, count: 2 },
      { startMs: 5, endMs: 25, count: 3 },
    ],
    10,
    20,
  );
  assert.deepEqual(segs2, [
    { startMs: 10, endMs: 15, used: 5 },
    { startMs: 15, endMs: 20, used: 3 },
  ]);
});

test('checkCapacity：超限时返回冲突规格与合并时段', () => {
  const r = checkCapacity({
    usage: [{ mass: 50, count: 1 }],
    capacityOf: () => 2,
    overlapping: [
      { startMs: 0, endMs: 10, usage: [{ mass: 50, count: 1 }] },
      { startMs: 5, endMs: 15, usage: [{ mass: 50, count: 1 }] },
    ],
    startMs: 0,
    endMs: 20,
  });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].peak, 2);
  // 仅 [5,10) 内 2+1 > 2 超限
  assert.equal(r.conflicts[0].windows.length, 1);
  assert.equal(r.conflicts[0].windows[0].used, 2);
  // 容量足够时通过
  const ok = checkCapacity({
    usage: [{ mass: 50, count: 1 }],
    capacityOf: () => 3,
    overlapping: [
      { startMs: 0, endMs: 10, usage: [{ mass: 50, count: 1 }] },
      { startMs: 5, endMs: 15, usage: [{ mass: 50, count: 1 }] },
    ],
    startMs: 0,
    endMs: 20,
  });
  assert.equal(ok.ok, true);
});

test('buildSchedule：占用分段与不足标记', () => {
  const specs = buildSchedule({
    reservations: [
      { startMs: 0, endMs: 10, usage: [{ mass: 50, count: 2 }] },
      { startMs: 5, endMs: 15, usage: [{ mass: 50, count: 1 }] },
    ],
    masses: [50],
    capacityOf: () => 2,
    fromMs: 0,
    toMs: 20,
  });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].peak, 3);
  assert.equal(specs[0].shortage, true);
  assert.deepEqual(
    specs[0].segments.map((s) => [s.used, s.shortage]),
    [
      [2, false],
      [3, true],
      [1, false],
    ],
  );
});
