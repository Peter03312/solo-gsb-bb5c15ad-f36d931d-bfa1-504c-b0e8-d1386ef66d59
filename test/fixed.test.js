import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { solve, verify, computeHash } from '../src/solver.js';

// ---------- 求解器：固定孔位（纯函数） ----------

const base = (over = {}) => ({
  holes: 4,
  tolerance: 0.5,
  holeMaxMass: [100, 100, 100, 100],
  tubes: [],
  weights: [],
  exclusionPairs: [],
  fixedSlots: [],
  ...over,
});
const allHoles = (n) => Array.from({ length: n }, (_, i) => i);
const holeOf = (r, id) =>
  r.arrangement.findIndex((s) => s && s.kind === 'tube' && s.ref === id);

test('固定孔位：指定管被放入指定孔位，且不得出现在其他孔位', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
    fixedSlots: [{ tube: 'B', hole: 1 }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(holeOf(r, 'B'), 1);
  // B 固定在孔 1 → 其所在对径对 (1,3) 的另一侧只能放 A（差 0）
  assert.equal(holeOf(r, 'A'), 3);
  assert.equal(r.weightCount, 0);
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('固定孔位不改变优化顺序：配重数最少、差和最小优先', () => {
  // A=50、B=50.9，容差 1：0 枚配重可行（差和 0.9）；固定 A 在孔 2 后仍应选 0 枚配重。
  const data = base({
    tolerance: 1,
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50.9, usableHoles: allHoles(4) },
    ],
    weights: [{ mass: 1, quantity: 2 }],
    fixedSlots: [{ tube: 'A', hole: 2 }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(r.weightCount, 0);
  assert.ok(Math.abs(r.diffSum - 0.9) < 1e-9);
  assert.equal(holeOf(r, 'A'), 2);
});

test('固定孔位下同分方案仍按物件编号序列字典序取小', () => {
  // C 固定在孔 1；其余孔位按字典序：小编号管占据低编号孔位。
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
      { id: 'C', mass: 50, usableHoles: allHoles(4) },
    ],
    weights: [{ mass: 50, quantity: 1 }],
    fixedSlots: [{ tube: 'C', hole: 1 }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(holeOf(r, 'C'), 1);
  assert.equal(holeOf(r, 'A'), 0);
  assert.equal(holeOf(r, 'B'), 2);
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('固定孔位与承重/对径差冲突时无解并说明（忽略固定孔位则可行）', () => {
  // A、B 分别固定在相邻孔 0、1：两对对径孔都只剩一个空位，
  // 仅有 1 枚 50 g 配重无法同时补齐 → 无解；忽略固定孔位后 A、B 对径即可行。
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
    weights: [{ mass: 50, quantity: 1 }],
    fixedSlots: [
      { tube: 'A', hole: 0 },
      { tube: 'B', hole: 1 },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
  assert.ok(
    r.reasons.some((x) => x.includes('固定孔位') && x.includes('「A」→ 孔 0')),
    r.reasons.join('\n'),
  );
  assert.ok(
    r.reasons.some((x) => x.includes('忽略固定孔位')),
    r.reasons.join('\n'),
  );
  const relaxed = solve({ ...data, fixedSlots: [] });
  assert.equal(relaxed.feasible, true);
});

test('固定管质量超过固定孔承重时直接无解并说明', () => {
  const data = base({
    holeMaxMass: [100, 100, 100, 60],
    tubes: [{ id: 'A', mass: 80, usableHoles: allHoles(4) }],
    fixedSlots: [{ tube: 'A', hole: 3 }],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
  assert.ok(
    r.reasons.some((x) => x.includes('固定在孔 3') && x.includes('超过该孔最大承重')),
    r.reasons.join('\n'),
  );
});

test('固定孔位与避邻规则共同冲突时说明两类规则（同时忽略则可行）', () => {
  // C 只能用孔 0/1，而固定孔位把 0/1 占给 A、B → 仅固定即无解；
  // 避邻 (A,B)、(A,C) 星形结构本身也无解；同时忽略两类规则后可行。
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
      { id: 'C', mass: 50, usableHoles: [0, 1] },
    ],
    weights: [{ mass: 50, quantity: 1 }],
    exclusionPairs: [
      { a: 'A', b: 'B' },
      { a: 'A', b: 'C' },
    ],
    fixedSlots: [
      { tube: 'A', hole: 0 },
      { tube: 'B', hole: 1 },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
  assert.ok(
    r.reasons.some((x) => x.includes('固定孔位与避邻规则')),
    r.reasons.join('\n'),
  );
  const relaxed = solve({ ...data, exclusionPairs: [], fixedSlots: [] });
  assert.equal(relaxed.feasible, true);
});

test('固定孔位与录入不一致（重复绑定）时防御性无解', () => {
  const data = base({
    tubes: [{ id: 'A', mass: 50, usableHoles: allHoles(4) }],
    fixedSlots: [
      { tube: 'A', hole: 0 },
      { tube: 'A', hole: 1 },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
  assert.ok(r.reasons.join('\n').includes('重复绑定'), r.reasons.join('\n'));
});

test('verify 复核识别违反固定孔位的装载图', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
    fixedSlots: [{ tube: 'A', hole: 0 }],
  });
  // 手工构造：A 在孔 1 而非固定孔位 0
  const bad = [
    { kind: 'tube', ref: 'B', mass: 50 },
    { kind: 'tube', ref: 'A', mass: 50 },
    null,
    null,
  ];
  const v = verify(data, bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((x) => x.includes('固定孔位 0')), v.errors.join(';'));
});

test('数据指纹：未固定时与历史哈希一致；绑定后指纹变化', () => {
  const data = base({
    tubes: [{ id: 'A', mass: 50, usableHoles: allHoles(4) }],
  });
  const legacy = { ...data };
  delete legacy.fixedSlots; // 历史数据没有该字段
  assert.equal(computeHash(data), computeHash(legacy));
  const withFixed = { ...data, fixedSlots: [{ tube: 'A', hole: 0 }] };
  assert.notEqual(computeHash(withFixed), computeHash(data));
});

// ---------- HTTP API：固定孔位维护 + 求解/发布流程 ----------

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
// D 仅可用孔 0/1：用于「绑定不在可用孔位内」与「固定孔位冲突无解」场景
const tubes4 = [
  { id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] },
  { id: 'B', mass: 50, usableHoles: [0, 1, 2, 3] },
  { id: 'C', mass: 50, usableHoles: [0, 1, 2, 3] },
  { id: 'D', mass: 50, usableHoles: [0, 1] },
];

test('准备：配置转子、离心管、配重块', async () => {
  assert.equal((await call('PUT', 'api/config', cfg)).status, 200);
  assert.equal((await call('PUT', 'api/tubes', tubes4)).status, 200);
  assert.equal((await call('PUT', 'api/weights', [{ mass: 50, quantity: 1 }])).status, 200);
});

test('维护固定孔位：整组保存并查看（按孔位规范化排序）', async () => {
  const r = await call('PUT', 'api/fixed-slots', [
    { tube: 'B', hole: 3 },
    { tube: 'A', hole: 1 },
  ]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const g = await call('GET', 'api/fixed-slots');
  assert.deepEqual(g.json, [
    { tube: 'A', hole: 1 },
    { tube: 'B', hole: 3 },
  ]);
  // 状态接口同步返回当前绑定
  const s = await call('GET', 'api/state');
  assert.deepEqual(s.json.data.fixedSlots, [
    { tube: 'A', hole: 1 },
    { tube: 'B', hole: 3 },
  ]);
});

test('未知管、重复管或孔、越界孔、不可用孔位内的绑定整组拒绝', async () => {
  // 未知管
  let r = await call('PUT', 'api/fixed-slots', [{ tube: 'ZZZ', hole: 0 }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('未知编号'));
  // 重复管
  r = await call('PUT', 'api/fixed-slots', [
    { tube: 'A', hole: 0 },
    { tube: 'A', hole: 1 },
  ]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('重复绑定'));
  // 重复孔
  r = await call('PUT', 'api/fixed-slots', [
    { tube: 'A', hole: 0 },
    { tube: 'B', hole: 0 },
  ]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('重复绑定'));
  // 越界孔
  r = await call('PUT', 'api/fixed-slots', [{ tube: 'A', hole: 9 }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('越界'));
  // 不在该管可用孔位内（D 仅可用 0/1）
  r = await call('PUT', 'api/fixed-slots', [{ tube: 'D', hole: 2 }]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('可用孔位'));
  // 整组拒绝：原绑定保留
  const g = await call('GET', 'api/fixed-slots');
  assert.deepEqual(g.json, [
    { tube: 'A', hole: 1 },
    { tube: 'B', hole: 3 },
  ]);
});

test('替换离心管使固定孔位失效（删管或收窄可用孔位）时整次拒绝', async () => {
  // 当前绑定 A→1、B→3：删除 B 会使绑定失效 → 拒绝
  let r = await call('PUT', 'api/tubes', [tubes4[0], tubes4[2], tubes4[3]]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('固定孔位'));
  // 收窄 B 的可用孔位（不再含孔 3）→ 拒绝
  r = await call('PUT', 'api/tubes', [
    tubes4[0],
    { id: 'B', mass: 50, usableHoles: [0, 1] },
    tubes4[2],
    tubes4[3],
  ]);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('固定孔位'));
  // 原数据保留
  const s = await call('GET', 'api/state');
  assert.deepEqual(s.json.data.tubes.map((t) => t.id), ['A', 'B', 'C', 'D']);
  assert.deepEqual(s.json.data.fixedSlots, [
    { tube: 'A', hole: 1 },
    { tube: 'B', hole: 3 },
  ]);
});

test('清空固定孔位后允许上述离心管替换', async () => {
  assert.equal((await call('PUT', 'api/fixed-slots', [])).status, 200);
  const r = await call('PUT', 'api/tubes', [
    tubes4[0],
    { id: 'B', mass: 50, usableHoles: [0, 1] },
    tubes4[2],
    tubes4[3],
  ]);
  assert.equal(r.status, 200);
  // 还原离心管，供后续用例使用
  assert.equal((await call('PUT', 'api/tubes', tubes4)).status, 200);
});

test('缩小转子孔数使固定孔位越界时整次拒绝', async () => {
  // 扩到 6 孔并允许 A 使用孔 5，绑定 A→5
  const cfg6 = { holes: 6, tolerance: 0.5, holeMaxMass: Array(6).fill(100) };
  assert.equal((await call('PUT', 'api/config', cfg6)).status, 200);
  const tubes6 = [
    { id: 'A', mass: 50, usableHoles: [0, 1, 2, 3, 4, 5] },
    { id: 'B', mass: 50, usableHoles: [0, 1, 2, 3] },
    { id: 'C', mass: 50, usableHoles: [0, 1, 2, 3] },
    { id: 'D', mass: 50, usableHoles: [0, 1] },
  ];
  assert.equal((await call('PUT', 'api/tubes', tubes6)).status, 200);
  assert.equal((await call('PUT', 'api/fixed-slots', [{ tube: 'A', hole: 5 }])).status, 200);
  // 缩回 4 孔：固定孔位 5 越界 → 拒绝，配置保持 6 孔
  const r = await call('PUT', 'api/config', cfg);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(';').includes('固定孔位 5'));
  let s = await call('GET', 'api/state');
  assert.equal(s.json.data.holes, 6);
  // 清空绑定并还原数据
  assert.equal((await call('PUT', 'api/fixed-slots', [])).status, 200);
  assert.equal((await call('PUT', 'api/tubes', tubes4)).status, 200);
  assert.equal((await call('PUT', 'api/config', cfg)).status, 200);
  s = await call('GET', 'api/state');
  assert.equal(s.json.data.holes, 4);
});

test('草稿遵守固定孔位；发布冻结绑定并跟踪当前可用性', async () => {
  assert.equal((await call('PUT', 'api/fixed-slots', [{ tube: 'B', hole: 2 }])).status, 200);
  const solveR = await call('POST', 'api/solve');
  assert.equal(solveR.status, 200);
  assert.equal(solveR.json.feasible, true);
  const arr = solveR.json.result.arrangement;
  assert.equal(arr[2] && arr[2].ref, 'B');

  const pub = await call('POST', 'api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const pubId = pub.json.id;
  // 冻结快照含固定孔位
  assert.deepEqual(pub.json.config.fixedSlots, [{ tube: 'B', hole: 2 }]);
  let p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, true);

  // 绑定变化 → 旧图不可用于当前装载（历史图不改写）
  await call('PUT', 'api/fixed-slots', [{ tube: 'B', hole: 3 }]);
  p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, false);
  assert.deepEqual(p.json.config.fixedSlots, [{ tube: 'B', hole: 2 }]);

  // 绑定改回 → 恢复可用
  await call('PUT', 'api/fixed-slots', [{ tube: 'B', hole: 2 }]);
  p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, true);

  // 清空绑定 → 指纹变化，旧图不可用
  await call('PUT', 'api/fixed-slots', []);
  p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, false);
});

test('固定孔位导致冲突时草稿说明无解且不得发布', async () => {
  // A→0、B→1 后，D（仅可用 0/1）无处可放；忽略固定孔位则可行
  await call('PUT', 'api/fixed-slots', [
    { tube: 'A', hole: 0 },
    { tube: 'B', hole: 1 },
  ]);
  const r = await call('POST', 'api/solve');
  assert.equal(r.status, 200);
  assert.equal(r.json.feasible, false);
  assert.ok(r.json.reasons.join(';').includes('固定孔位'));
  const pub = await call('POST', 'api/publish');
  assert.equal(pub.status, 400);
  assert.ok(pub.json.errors.join(';').includes('固定孔位'));
  // 清理
  assert.equal((await call('PUT', 'api/fixed-slots', [])).status, 200);
});

test('清空固定孔位后流程与无绑定一致（发布/可用性判定不变）', async () => {
  // 当前无绑定：发布新图
  const pub = await call('POST', 'api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const pubId = pub.json.id;
  assert.deepEqual(pub.json.config.fixedSlots, []);
  let p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, true);

  // 无绑定下预约流程照常
  const res = await call('POST', 'api/reservations', {
    batchNo: 'BATCH-NOFIXED',
    publicationId: pubId,
    startUtc: '2027-02-01T08:00:00Z',
    endUtc: '2027-02-01T12:00:00Z',
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));

  // 无绑定下核验流程照常：建草稿 → 暂存 → 完成
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

  // 曾绑定固定孔位发布的旧图仍按冻结绑定判定：当前无绑定 → 不可用
  const pubs = await call('GET', 'api/publications');
  const withFixed = pubs.json.find((x) => x.id !== pubId && x.usable === false);
  assert.ok(withFixed, '存在因绑定清空而不可用的旧发布记录');
  // 新图（无绑定）仍可用
  p = await call('GET', `api/publications/${pubId}`);
  assert.equal(p.json.usable, true);
});
