import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { solve, verify, computeHash } from '../src/solver.js';

// ---------- 求解器：避邻规则（纯函数） ----------

const base = (over = {}) => ({
  holes: 4,
  tolerance: 0.5,
  holeMaxMass: [100, 100, 100, 100],
  tubes: [],
  weights: [],
  exclusionPairs: [],
  ...over,
});
const holeOf = (r, id) =>
  r.arrangement.findIndex((s) => s && s.kind === 'tube' && s.ref === id);

test('避邻对不得占据相邻孔位（同分下被推开到对径孔）', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] },
      { id: 'B', mass: 50, usableHoles: [0, 1, 2, 3] },
    ],
    exclusionPairs: [{ a: 'A', b: 'B' }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  const ha = holeOf(r, 'A');
  const hb = holeOf(r, 'B');
  assert.notEqual(ha, -1);
  assert.notEqual(hb, -1);
  const d = (ha - hb + 4) % 4;
  assert.ok(d !== 1 && d !== 3, `holes ${ha} and ${hb} are adjacent`);
  // 同分（0 枚配重、差和 0）下字典序最小：A 在孔 0，B 在孔 2（对径）
  assert.equal(ha, 0);
  assert.equal(hb, 2);
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('避邻规则不改变优化顺序：配重数优先、差和其次', () => {
  // A/B 差 0.9g，容差 1：不避邻时 0 枚配重可行（差和 0.9）。
  // 加避邻对后，A 与 B 对径放置仍 0 枚配重、差和 0.9。
  const data = base({
    tolerance: 1,
    tubes: [
      { id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] },
      { id: 'B', mass: 50.9, usableHoles: [0, 1, 2, 3] },
    ],
    weights: [{ mass: 1, quantity: 2 }],
    exclusionPairs: [{ a: 'A', b: 'B' }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(r.weightCount, 0);
  assert.ok(Math.abs(r.diffSum - 0.9) < 1e-9);
  const ha = holeOf(r, 'A');
  const hb = holeOf(r, 'B');
  const d = (ha - hb + 4) % 4;
  assert.ok(d !== 1 && d !== 3);
});

test('避邻冲突无解时说明冲突（忽略规则则可行）', () => {
  // A 与 B、C 均避邻：A 的两个邻居孔都不能放 B/C，B 和 C 只能挤在 A 的对径孔，
  // 放不下两支管 → 无解；忽略避邻时（50g 配重平衡空孔）可行。
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] },
      { id: 'B', mass: 50, usableHoles: [0, 1, 2, 3] },
      { id: 'C', mass: 50, usableHoles: [0, 1, 2, 3] },
    ],
    weights: [{ mass: 50, quantity: 1 }],
    exclusionPairs: [
      { a: 'A', b: 'B' },
      { a: 'A', b: 'C' },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
  assert.ok(
    r.reasons.some((x) => x.includes('避邻规则') && x.includes('A ↔ B')),
    r.reasons.join('\n'),
  );
  // 对照：忽略避邻规则后可行
  const relaxed = solve({ ...data, exclusionPairs: [] });
  assert.equal(relaxed.feasible, true);
});

test('环形相邻：孔 N-1 与孔 0 相邻（环绕边）', () => {
  // 4 孔：A 与 B 避邻。A 只能放孔 0（usableHoles [0]），B 只能放孔 1（[1]）→
  // 环绕边 (3,0) 与 (0,1) 均相邻，无解。
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: [0] },
      { id: 'B', mass: 50, usableHoles: [1] },
    ],
    exclusionPairs: [{ a: 'A', b: 'B' }],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
});

test('verify 复核识别违反避邻规则的装载图', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] },
      { id: 'B', mass: 50, usableHoles: [0, 1, 2, 3] },
    ],
    exclusionPairs: [{ a: 'A', b: 'B' }],
  });
  // 手工构造：A 在孔 0、B 在孔 1（相邻）——违反避邻
  const bad = [
    { kind: 'tube', ref: 'A', mass: 50 },
    { kind: 'tube', ref: 'B', mass: 50 },
    null,
    null,
  ];
  const v = verify(data, bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((x) => x.includes('避邻规则')), v.errors.join(';'));
});

test('数据指纹：未配置规则时与历史哈希一致；配置规则后指纹变化', () => {
  const data = base({
    tubes: [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }],
  });
  const legacy = { ...data };
  delete legacy.exclusionPairs; // 历史数据没有该字段
  assert.equal(computeHash(data), computeHash(legacy));
  const withPairs = { ...data, exclusionPairs: [{ a: 'A', b: 'B' }] };
  assert.notEqual(computeHash(withPairs), computeHash(data));
});

// ---------- HTTP API：避邻对维护 + 发布/预约/核验流程 ----------

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
  const res = await fetch(`${baseUrl}/${p.replace(/^\/+/, '')}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const cfg = { holes: 4, tolerance: 0.5, holeMaxMass: [100, 100, 100, 100] };
const tubes3 = [
  { id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] },
  { id: 'B', mass: 50, usableHoles: [0, 1, 2, 3] },
  { id: 'C', mass: 50, usableHoles: [0, 1, 2, 3] },
];

test('准备：配置转子、离心管、配重块', async () => {
  assert.equal((await call('PUT', 'api/config', cfg)).status, 200);
  assert.equal((await call('PUT', 'api/tubes', tubes3)).status, 200);
  assert.equal((await call('PUT', 'api/weights', [{ mass: 50, quantity: 1 }])).status, 200);
});

test('维护避邻对：保存并查看（规范化排序）', async () => {
  const r = await call('PUT', 'api/exclusions', [{ a: 'B', b: 'A' }]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = await call('GET', 'api/exclusions');
  assert.deepEqual(g.json, [{ a: 'A', b: 'B' }]);
  // 状态接口同步返回当前规则
  const s = await call('GET', 'api/state');
  assert.deepEqual(s.json.data.exclusionPairs, [{ a: 'A', b: 'B' }]);
});

test('未知编号、自配对、重复配对（含颠倒）整次拒绝', async () => {
  // 未知编号
  let r = await call('PUT', 'api/exclusions', [{ a: 'A', b: 'ZZZ' }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('未知编号'));
  // 自配对
  r = await call('PUT', 'api/exclusions', [{ a: 'A', b: 'A' }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('自配对'));
  // 重复（含颠倒）
  r = await call('PUT', 'api/exclusions', [
    { a: 'A', b: 'B' },
    { a: 'B', b: 'A' },
  ]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('重复'));
  // 整次拒绝：规则保持原样
  const g = await call('GET', 'api/exclusions');
  assert.deepEqual(g.json, [{ a: 'A', b: 'B' }]);
});

test('替换离心管会留下失效避邻对时拒绝并保留原数据', async () => {
  // 当前规则 (A,B)：删除 B 管会使该对失效 → 拒绝
  const r = await call('PUT', 'api/tubes', [tubes3[0], tubes3[2]]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('避邻对'));
  // 原数据保留
  const s = await call('GET', 'api/state');
  assert.deepEqual(s.json.data.tubes.map((t) => t.id), ['A', 'B', 'C']);
  assert.deepEqual(s.json.data.exclusionPairs, [{ a: 'A', b: 'B' }]);
});

test('清空避邻对后允许替换离心管', async () => {
  assert.equal((await call('PUT', 'api/exclusions', [])).status, 200);
  const r = await call('PUT', 'api/tubes', tubes3);
  assert.equal(r.status, 200);
});

test('草稿求解满足避邻规则；无解时说明冲突', async () => {
  // 设置 (A,B)、(A,C) 避邻：与求解器测试相同场景 → 无解且说明冲突
  await call('PUT', 'api/exclusions', [
    { a: 'A', b: 'B' },
    { a: 'A', b: 'C' },
  ]);
  let r = await call('POST', 'api/solve');
  assert.equal(r.status, 200);
  assert.equal(r.json.feasible, false);
  assert.ok(r.json.reasons.join(';').includes('避邻规则'));
  // 发布同样被拒绝（事务内重读规则并复核）
  r = await call('POST', 'api/publish');
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('避邻规则'));
});

test('发布冻结规则与装载图；规则变化使旧图不可用、改回后恢复', async () => {
  // 只剩 (A,B) 避邻：可行（A 与 B 对径）
  await call('PUT', 'api/exclusions', [{ a: 'A', b: 'B' }]);
  const solveR = await call('POST', 'api/solve');
  assert.equal(solveR.json.feasible, true);
  const arr = solveR.json.result.arrangement;
  const ha = arr.findIndex((s) => s && s.ref === 'A');
  const hb = arr.findIndex((s) => s && s.ref === 'B');
  const d = (ha - hb + 4) % 4;
  assert.ok(d !== 1 && d !== 3, `holes ${ha} and ${hb} are adjacent`);

  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const pubId = pub.json.id;
  // 冻结快照含避邻规则
  assert.deepEqual(pub.json.config.exclusionPairs, [{ a: 'A', b: 'B' }]);
  let p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, true);

  // 规则变化 → 旧图不可用于当前装载（历史图不改写）
  await call('PUT', 'api/exclusions', [{ a: 'A', b: 'C' }]);
  p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, false);
  assert.deepEqual(p.json.config.exclusionPairs, [{ a: 'A', b: 'B' }]);

  // 规则改回 → 恢复可用
  await call('PUT', 'api/exclusions', [{ a: 'A', b: 'B' }]);
  p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, true);

  // 清空规则 → 指纹变化，旧图不可用
  await call('PUT', 'api/exclusions', []);
  p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, false);
});

test('未配置规则时发布/预约/核验流程照常（旧图按原规则判定）', async () => {
  // 当前无规则：发布新图
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201);
  const pubId = pub.json.id;
  assert.deepEqual(pub.json.config.exclusionPairs, []);
  const p0 = await call('GET', `api/publications/${pubId}`);
  assert.equal(p0.json.usable, true);

  // 无规则下预约照常
  const res = await call('POST', 'api/reservations', {
    batchNo: 'BATCH-NORULE',
    publicationId: pubId,
    startUtc: '2027-01-01T08:00:00Z',
    endUtc: '2027-01-01T12:00:00Z',
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));

  // 无规则下核验流程照常：建草稿 → 暂存 → 完成
  const v = await call('POST', 'api/verifications', { publicationId: pubId });
  assert.equal(v.status, 201, JSON.stringify(v.json));
  const entries = v.json.publication.result.arrangement.map((s, h) => ({
    hole: h,
    ref: s ? s.ref : '',
    mass: s ? s.mass : 0,
  }));
  const put = await call('PUT', `api/verifications/${v.json.id}`, {
    version: v.json.version,
    entries,
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const done = await call('POST', `api/verifications/${v.json.id}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.completed, true);

  // 旧发布图（有规则时发布的 #1）仍按原规则判定：当前无规则 → 不可用
  const p1 = await call('GET', 'api/publications/1');
  assert.equal(p1.json.usable, false);
  // 新图（无规则）仍可用
  const p2 = await call('GET', `api/publications/${pubId}`);
  assert.equal(p2.json.usable, true);
});
