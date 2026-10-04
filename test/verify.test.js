import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { normalizeEntries, verifyMeasurements } from '../src/verify.js';

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

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

// 冻结图：A=50 在孔 0，B=50 在孔 2（对径），孔 1、3 为空
async function setupPublished() {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  await call('POST', '/api/solve');
  const pub = await call('POST', '/api/publish');
  return pub.json.id;
}

const emptyEntries = () => [
  { hole: 0, ref: '', mass: 0 },
  { hole: 1, ref: '', mass: 0 },
  { hole: 2, ref: '', mass: 0 },
  { hole: 3, ref: '', mass: 0 },
];
const goodEntries = () => [
  { hole: 0, ref: 'A', mass: 50 },
  { hole: 1, ref: '', mass: 0 },
  { hole: 2, ref: 'B', mass: 50 },
  { hole: 3, ref: '', mass: 0 },
];

test('建立核验草稿：空孔初始化、进度为 0/N', async () => {
  const pubId = await setupPublished();
  const r = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.publicationId, pubId);
  assert.equal(r.json.version, 1);
  assert.equal(r.json.completed, false);
  assert.deepEqual(r.json.entries, emptyEntries());
  assert.deepEqual(r.json.progress, { filled: 0, total: 2 });
  assert.equal(r.json.usable, true);
});

test('同一发布记录只保留一份未完成核验（409 + existingId）', async () => {
  const pubs = await call('GET', '/api/publications');
  const pubId = pubs.json[0].id;
  const r = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(r.status, 409);
  assert.ok(r.json.existingId > 0);
  assert.equal(r.json.completed, false);
});

test('不可用发布记录不能发起核验', async () => {
  // 新发布一张可用图，再改动数据使旧图失效
  const pubId = await setupPublished();
  await call('PUT', '/api/weights', [{ mass: 1, quantity: 1 }]);
  const r = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不可用'));
});

test('暂存合法录入并恢复：版本自增、进度更新', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  // 先把数据改回与发布一致（恢复可用）
  await call('PUT', '/api/weights', []);
  const partial = [
    { hole: 0, ref: 'A', mass: 50 },
    { hole: 1, ref: '', mass: 0 },
    { hole: 2, ref: '', mass: 0 },
    { hole: 3, ref: '', mass: 0 },
  ];
  let r = await call('PUT', `/api/verifications/${id}`, { version: 1, entries: partial });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.version, 2);
  assert.deepEqual(r.json.progress, { filled: 1, total: 2 });
  // 恢复：GET 得到暂存内容
  r = await call('GET', `/api/verifications/${id}`);
  assert.equal(r.json.entries[0].ref, 'A');
  assert.equal(r.json.entries[0].mass, 50);
});

test('乐观锁：携带过期版本更新被 409 拒绝且不覆盖', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  const r = await call('PUT', `/api/verifications/${id}`, {
    version: 1,
    entries: goodEntries(),
  });
  assert.equal(r.status, 409);
  assert.ok(r.json.currentVersion >= 2);
  const fresh = await call('GET', `/api/verifications/${id}`);
  assert.equal(fresh.json.entries[0].ref, 'A');
  assert.equal(fresh.json.entries[2].ref, ''); // 未被覆盖
});

test('非法录入被拒绝：空孔填质量、非正数质量、编号非字符串', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  const ver = await call('GET', `/api/verifications/${id}`);
  const v = ver.json.version;
  let r = await call('PUT', `/api/verifications/${id}`, {
    version: v,
    entries: [
      { hole: 0, ref: 'A', mass: 50 },
      { hole: 1, ref: '', mass: 3 }, // 空孔质量非 0
      { hole: 2, ref: '', mass: 0 },
      { hole: 3, ref: '', mass: 0 },
    ],
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('空孔'));

  r = await call('PUT', `/api/verifications/${id}`, {
    version: v,
    entries: [
      { hole: 0, ref: 'A', mass: 0 }, // 有编号但质量非正
      { hole: 1, ref: '', mass: 0 },
      { hole: 2, ref: '', mass: 0 },
      { hole: 3, ref: '', mass: 0 },
    ],
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('有限正数'));

  r = await call('PUT', `/api/verifications/${id}`, {
    version: v,
    entries: [
      { hole: 0, ref: 7, mass: 50 }, // 编号非字符串
      { hole: 1, ref: '', mass: 0 },
      { hole: 2, ref: '', mass: 0 },
      { hole: 3, ref: '', mass: 0 },
    ],
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('编号必须是字符串'));
});

test('核验不通过-物件不一致：错误定位到孔位，草稿保留、无完成记录', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  let ver = await call('GET', `/api/verifications/${id}`);
  const wrong = [
    { hole: 0, ref: 'B', mass: 50 }, // 孔 0 应为 A
    { hole: 1, ref: '', mass: 0 },
    { hole: 2, ref: 'A', mass: 50 },
    { hole: 3, ref: '', mass: 0 },
  ];
  const saved = await call('PUT', `/api/verifications/${id}`, {
    version: ver.json.version,
    entries: wrong,
  });
  assert.equal(saved.status, 200);
  const r = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(r.status, 400, JSON.stringify(r.json));
  const msg = r.json.errors.join(' ');
  assert.ok(msg.includes('孔 0'));
  assert.ok(msg.includes('不一致'));
  assert.ok(r.json.detail.checks.holes[0].objectMatch === false);
  // 草稿保留：未完成
  ver = await call('GET', `/api/verifications/${id}`);
  assert.equal(ver.json.completed, false);
});

test('核验不通过-实测超重：错误定位到孔位，草稿保留', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  const ver = await call('GET', `/api/verifications/${id}`);
  const entries = [
    { hole: 0, ref: 'A', mass: 50 },
    { hole: 1, ref: '', mass: 0 },
    { hole: 2, ref: 'B', mass: 120 }, // 超过孔 2 承重 100
    { hole: 3, ref: '', mass: 0 },
  ];
  await call('PUT', `/api/verifications/${id}`, {
    version: ver.json.version,
    entries,
  });
  const r = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(r.status, 400);
  const msg = r.json.errors.join(' ');
  assert.ok(msg.includes('孔 2'));
  assert.ok(msg.includes('承重'));
  const fresh = await call('GET', `/api/verifications/${id}`);
  assert.equal(fresh.json.completed, false);
});

test('核验不通过-对径差超冻结容差：错误定位到孔对，草稿保留', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  const ver = await call('GET', `/api/verifications/${id}`);
  // 孔 0↔2 为一对：50 与 51.5，差 1.5 > 容差 1
  const entries = [
    { hole: 0, ref: 'A', mass: 50 },
    { hole: 1, ref: '', mass: 0 },
    { hole: 2, ref: 'B', mass: 51.5 },
    { hole: 3, ref: '', mass: 0 },
  ];
  await call('PUT', `/api/verifications/${id}`, {
    version: ver.json.version,
    entries,
  });
  const r = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(r.status, 400);
  const msg = r.json.errors.join(' ');
  assert.ok(msg.includes('0 ↔ 2'));
  assert.ok(msg.includes('容差'));
  const fresh = await call('GET', `/api/verifications/${id}`);
  assert.equal(fresh.json.completed, false);
});

test('完成期间发布记录变为不可用则拒绝完成（草稿保留）', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  const ver = await call('GET', `/api/verifications/${id}`);
  await call('PUT', `/api/verifications/${id}`, {
    version: ver.json.version,
    entries: goodEntries(),
  });
  // 录入数据变化 → 发布不再可用
  await call('PUT', '/api/weights', [{ mass: 2, quantity: 2 }]);
  const r = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不可用于当前装载'));
  const fresh = await call('GET', `/api/verifications/${id}`);
  assert.equal(fresh.json.completed, false);
  // 恢复数据，供后续用例完成
  await call('PUT', '/api/weights', []);
});

test('核验成功：冻结实测值、判定明细与发布编号', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json[0].id;
  const ver = await call('GET', `/api/verifications/${id}`);
  await call('PUT', `/api/verifications/${id}`, {
    version: ver.json.version,
    entries: goodEntries(),
  });
  const r = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.completed, true);
  assert.ok(r.json.completedAt);
  assert.deepEqual(r.json.frozenEntries, goodEntries());
  assert.equal(r.json.publicationId, ver.json.publicationId);
  assert.equal(r.json.diffSum, 0);
  assert.equal(r.json.checks.pairs.length, 2);
  assert.ok(r.json.checks.holes.every((h) => h.objectMatch && h.withinCapacity));
});

test('重复完成不生成第二份结果（幂等返回 200）', async () => {
  const listBefore = await call('GET', '/api/verifications');
  const countBefore = listBefore.json.length;
  const id = listBefore.json.find((v) => v.completed).id;
  const r1 = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(r1.status, 200);
  const r2 = await call('POST', `/api/verifications/${id}/complete`);
  assert.equal(r2.status, 200);
  const listAfter = await call('GET', '/api/verifications');
  assert.equal(listAfter.json.length, countBefore);
});

test('完成后修改录入被拒绝，已冻结结果不变', async () => {
  const list = await call('GET', '/api/verifications');
  const id = list.json.find((v) => v.completed).id;
  const before = await call('GET', `/api/verifications/${id}`);
  const r = await call('PUT', `/api/verifications/${id}`, {
    version: before.json.version,
    entries: goodEntries(),
  });
  assert.equal(r.status, 409);
  const after = await call('GET', `/api/verifications/${id}`);
  assert.deepEqual(after.json.frozenEntries, before.json.frozenEntries);
  assert.equal(after.json.version, before.json.version);
});

test('已完成核验不能再就同一发布新建草稿', async () => {
  const list = await call('GET', '/api/verifications');
  const done = list.json.find((v) => v.completed);
  const r = await call('POST', '/api/verifications', { publicationId: done.publicationId });
  assert.equal(r.status, 409);
  assert.equal(r.json.completed, true);
  assert.equal(r.json.existingId, done.id);
});

test('normalizeEntries：稠密数组与稀疏数组等价', () => {
  const N = 4;
  const dense = [
    { ref: 'A', mass: 50 },
    null,
    { ref: '', mass: 0 },
    { ref: 'B', mass: 60 },
  ];
  const sparse = [
    { hole: 3, ref: 'B', mass: 60 },
    { hole: 0, ref: 'A', mass: 50 },
  ];
  const a = normalizeEntries(dense, N);
  const b = normalizeEntries(sparse, N);
  assert.equal(a.errors.length, 0);
  assert.equal(b.errors.length, 0);
  assert.deepEqual(a.entries, b.entries);
  assert.deepEqual(a.entries[1], { hole: 1, ref: '', mass: 0 });
});

test('verifyMeasurements 单元判定：物件/承重/容差三类问题分别定位', () => {
  const snapshot = {
    config: { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] },
    result: {
      arrangement: [
        { kind: 'tube', ref: 'A', mass: 50 },
        null,
        { kind: 'tube', ref: 'B', mass: 50 },
        null,
      ],
    },
  };
  const ok = verifyMeasurements(snapshot, goodEntries());
  assert.equal(ok.ok, true, ok.errors.join(';'));

  const badMass = verifyMeasurements(snapshot, [
    { hole: 0, ref: 'A', mass: 150 },
    { hole: 1, ref: '', mass: 0 },
    { hole: 2, ref: 'B', mass: 50 },
    { hole: 3, ref: '', mass: 0 },
  ]);
  assert.equal(badMass.ok, false);
  assert.ok(badMass.errors[0].includes('孔 0'));

  const badPair = verifyMeasurements(snapshot, [
    { hole: 0, ref: 'A', mass: 50 },
    { hole: 1, ref: '', mass: 0 },
    { hole: 2, ref: 'B', mass: 60 },
    { hole: 3, ref: '', mass: 0 },
  ]);
  assert.equal(badPair.ok, false);
  assert.ok(badPair.errors.some((e) => e.includes('0 ↔ 2')));
});
