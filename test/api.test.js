import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';

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

test('未配置时求解返回 400', async () => {
  const r = await call('POST', '/api/solve');
  assert.equal(r.status, 400);
});

test('保存合法转子配置', async () => {
  const r = await call('PUT', '/api/config', cfg);
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('非法孔位数被拒绝', async () => {
  const r = await call('PUT', '/api/config', { ...cfg, holes: 5 });
  assert.equal(r.status, 400);
});

test('非法质量被拒绝', async () => {
  const r = await call('PUT', '/api/config', { ...cfg, holeMaxMass: [100, -5, 100, 100] });
  assert.equal(r.status, 400);
});

test('重复编号被拒绝且不留下部分数据', async () => {
  const before = await call('GET', '/api/state');
  const r = await call('PUT', '/api/tubes', [
    tube('X', 50),
    tube('X', 60),
  ]);
  assert.equal(r.status, 400);
  const after = await call('GET', '/api/state');
  assert.deepEqual(after.json.data.tubes, before.json.data.tubes);
});

test('孔位越界被拒绝', async () => {
  const r = await call('PUT', '/api/tubes', [{ id: 'X', mass: 50, usableHoles: [7] }]);
  assert.equal(r.status, 400);
});

test('保留编号格式被拒绝', async () => {
  const r = await call('PUT', '/api/tubes', [{ id: '配重#1-1', mass: 50, usableHoles: [0] }]);
  assert.equal(r.status, 400);
});

test('保存离心管并求解、发布；发布后哈希标记为可用', async () => {
  let r = await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50)]);
  assert.equal(r.status, 200);
  r = await call('POST', '/api/solve');
  assert.equal(r.status, 200);
  assert.equal(r.json.feasible, true);
  r = await call('POST', '/api/publish');
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const pubId = r.json.id;
  const s = await call('GET', '/api/state');
  const found = s.json.publications.find((p) => p.id === pubId);
  assert.equal(found.usable, true);
});

test('数据变化后旧发布标记为不可用，旧图内容不变', async () => {
  const list0 = await call('GET', '/api/publications');
  const oldPub = list0.json[0];
  const oldDetail = await call('GET', `/api/publications/${oldPub.id}`);

  const r = await call('PUT', '/api/weights', [{ mass: 1, quantity: 2 }]);
  assert.equal(r.status, 200);

  const list1 = await call('GET', '/api/publications');
  const stale = list1.json.find((p) => p.id === oldPub.id);
  assert.equal(stale.usable, false);

  const newDetail = await call('GET', `/api/publications/${oldPub.id}`);
  assert.equal(newDetail.json.usable, false);
  assert.deepEqual(newDetail.json.result, oldDetail.json.result);
});

test('草稿随数据变化标记为 stale', async () => {
  await call('POST', '/api/solve');
  let s = await call('GET', '/api/state');
  assert.equal(s.json.draft.stale, false);
  await call('PUT', '/api/weights', [{ mass: 1, quantity: 3 }]);
  s = await call('GET', '/api/state');
  assert.equal(s.json.draft.stale, true);
});

test('无解时不能发布', async () => {
  await call('PUT', '/api/tubes', [
    { id: 'A', mass: 50, usableHoles: [0] },
    { id: 'B', mass: 90, usableHoles: [2] },
  ]);
  const r = await call('POST', '/api/publish');
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不存在可行装载图'));
});

test('缩小孔位范围会因现有管可用孔越界被拒绝；调整管后允许', async () => {
  const cfg6 = { holes: 6, tolerance: 1, holeMaxMass: Array(6).fill(100) };
  const cfg4 = { holes: 4, tolerance: 1, holeMaxMass: Array(4).fill(100) };
  let r = await call('PUT', '/api/config', cfg6);
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/tubes', [{ id: 'A', mass: 10, usableHoles: [5] }]);
  assert.equal(r.status, 200);
  // 缩回 4 孔会使孔 5 越界 → 拒绝
  r = await call('PUT', '/api/config', cfg4);
  assert.equal(r.status, 400);
  // 数据未被部分修改：仍为 6 孔
  let s = await call('GET', '/api/state');
  assert.equal(s.json.data.holes, 6);
  // 调整管后允许缩孔
  r = await call('PUT', '/api/tubes', [{ id: 'A', mass: 10, usableHoles: [0] }]);
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/config', cfg4);
  assert.equal(r.status, 200);
  s = await call('GET', '/api/state');
  assert.equal(s.json.data.holes, 4);
});
