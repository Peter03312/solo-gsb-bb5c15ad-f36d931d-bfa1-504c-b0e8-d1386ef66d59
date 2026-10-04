import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  normalizeItemInput,
  normalizeCheckoutInput,
  normalizeReturnInput,
  countByMass,
  matchUsage,
  findInventoryShortfalls,
  isOverdue,
} from '../src/checkout.js';

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
  const json = await res.json().catch(() => ({ error: 'not-json' }));
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });

async function makeReservation(batchNo, pubId, startMs, endMs, expectStatus = 201) {
  const r = await call('POST', '/api/reservations', {
    batchNo,
    publicationId: pubId,
    startUtc: iso(startMs),
    endUtc: iso(endMs),
  });
  assert.equal(r.status, expectStatus, `${batchNo}: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function checkout(reservationId, itemNos, expectStatus = 201) {
  const r = await call('POST', '/api/checkouts', { reservationId, itemNos });
  assert.equal(r.status, expectStatus, JSON.stringify(r.json));
  return r;
}

// ---------- 纯函数 ----------

test('纯函数：实物登记输入规整', () => {
  const ok = normalizeItemInput({ itemNo: ' W50-001 ', mass: 50 });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, { itemNo: 'W50-001', mass: 50 });

  for (const body of [
    null,
    {},
    { itemNo: ' ', mass: 50 },
    { itemNo: 'A', mass: 0 },
    { itemNo: 'A', mass: -1 },
    { itemNo: 'A', mass: '50' },
    { itemNo: 'A', mass: NaN },
    { itemNo: 'A' },
    { mass: 50 },
  ]) {
    assert.ok(normalizeItemInput(body).errors.length > 0, JSON.stringify(body));
  }
});

test('纯函数：领用输入规整（编号去重排序、重复非法）', () => {
  const ok = normalizeCheckoutInput({ reservationId: 2, itemNos: ['B', ' A '] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean, { reservationId: 2, itemNos: ['A', 'B'] });

  assert.ok(normalizeCheckoutInput({ reservationId: 1, itemNos: ['A', 'A'] }).errors.length > 0);
  assert.ok(normalizeCheckoutInput({ reservationId: 1, itemNos: ['A', ' A '] }).errors.length > 0);
  assert.ok(normalizeCheckoutInput({ reservationId: 1, itemNos: 'A' }).errors.length > 0);
  assert.ok(normalizeCheckoutInput({ reservationId: 0, itemNos: [] }).errors.length > 0);
  assert.ok(normalizeCheckoutInput({ itemNos: [] }).errors.length > 0);
  assert.ok(normalizeCheckoutInput(null).errors.length > 0);
  // 空数组合法（可否领用由占用量精确匹配决定）
  assert.deepEqual(normalizeCheckoutInput({ reservationId: 1, itemNos: [] }).clean.itemNos, []);
});

test('纯函数：归还输入规整', () => {
  const ok = normalizeReturnInput({
    returns: [
      { itemNo: ' A ', condition: 'intact' },
      { itemNo: 'B', condition: 'damaged' },
    ],
  });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.clean.returns, [
    { itemNo: 'A', condition: 'intact' },
    { itemNo: 'B', condition: 'damaged' },
  ]);

  for (const body of [
    null,
    {},
    { returns: [] },
    { returns: 'A' },
    { returns: [{ itemNo: 'A' }] },
    { returns: [{ itemNo: 'A', condition: 'ok' }] },
    { returns: [{ itemNo: '', condition: 'intact' }] },
    { returns: [{ itemNo: 'A', condition: 'intact' }, { itemNo: 'A', condition: 'damaged' }] },
  ]) {
    assert.ok(normalizeReturnInput(body).errors.length > 0, JSON.stringify(body));
  }
});

test('纯函数：按规格统计与精确匹配', () => {
  assert.deepEqual(countByMass([100, 50, 50]), [
    { mass: 50, count: 2 },
    { mass: 100, count: 1 },
  ]);
  assert.deepEqual(countByMass([]), []);

  const usage = [
    { mass: 50, count: 2 },
    { mass: 100, count: 1 },
  ];
  assert.equal(matchUsage(countByMass([50, 50, 100]), usage).ok, true);
  const lack = matchUsage(countByMass([50, 100]), usage);
  assert.equal(lack.ok, false);
  assert.deepEqual(lack.mismatches, [{ mass: 50, required: 2, selected: 1 }]);
  const extra = matchUsage(countByMass([50, 50, 100, 200]), usage);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.mismatches, [{ mass: 200, required: 0, selected: 1 }]);
  assert.equal(matchUsage([], []).ok, true);
});

test('纯函数：库存缩减核对与逾期判定', () => {
  const active = [
    { mass: 50, count: 3 },
    { mass: 100, count: 1 },
  ];
  assert.deepEqual(findInventoryShortfalls(active, [{ mass: 50, quantity: 3 }, { mass: 100, quantity: 2 }]), []);
  assert.deepEqual(
    findInventoryShortfalls(active, [{ mass: 50, quantity: 2 }]),
    [
      { mass: 50, active: 3, quantity: 2 },
      { mass: 100, active: 1, quantity: 0 },
    ],
  );
  assert.equal(isOverdue(1, 1000, 1001), true);
  assert.equal(isOverdue(1, 1000, 1000), false); // 恰在终点不算逾期
  assert.equal(isOverdue(0, 1000, 2000), false); // 无未还件不逾期
});

// ---------- HTTP 流程 ----------

let pubId;
const H = 3600_000;

test('准备：配置 + 离心管 + 配重（50g×5）→ 发布图（冻结占用 50g×1）', async () => {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 50), tube('C', 50)]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 5 }]);
  const p = await call('POST', '/api/publish');
  assert.equal(p.status, 201, JSON.stringify(p.json));
  pubId = p.json.id;
  const detail = await call('GET', `/api/publications/${pubId}`);
  const weights = detail.json.result.arrangement.filter((s) => s && s.kind === 'weight');
  assert.equal(weights.length, 1);
  assert.equal(weights[0].mass, 50);
});

test('实物登记：非法输入与未知规格 400，超库存 409，幂等重放 200 / 异内容 409', async () => {
  assert.equal((await call('POST', '/api/items', { itemNo: '', mass: 50 })).status, 400);
  assert.equal((await call('POST', '/api/items', { itemNo: 'W-BAD', mass: -1 })).status, 400);
  const unknown = await call('POST', '/api/items', { itemNo: 'W-BAD', mass: 999 });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.errors[0], /未知质量规格 999 g/);

  for (const no of ['W50-001', 'W50-002', 'W50-003', 'W50-004', 'W50-005']) {
    const r = await call('POST', '/api/items', { itemNo: no, mass: 50 });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.status, 'available');
  }
  // 第 6 枚超过当前库存 5 → 409
  const over = await call('POST', '/api/items', { itemNo: 'W50-006', mass: 50 });
  assert.equal(over.status, 409);
  assert.deepEqual(over.json.detail, { mass: 50, capacity: 5, active: 5 });

  // 幂等：同号同内容 → 200 原记录；同号异内容 → 409
  const replay = await call('POST', '/api/items', { itemNo: 'W50-001', mass: 50 });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.itemNo, 'W50-001');
  const diff = await call('POST', '/api/items', { itemNo: 'W50-001', mass: 100 });
  assert.equal(diff.status, 409);
  assert.ok(diff.json.existingId != null);

  // 列表与过滤
  const list = await call('GET', '/api/items');
  assert.equal(list.json.length, 5);
  const filtered = await call('GET', '/api/items?mass=50');
  assert.equal(filtered.json.length, 5);
  assert.equal((await call('GET', '/api/items?mass=abc')).status, 400);
  assert.equal((await call('GET', '/api/items/9999')).status, 404);
});

test('库存缩减低于有效实物数 → 整次拒绝并保留原数据', async () => {
  const r = await call('PUT', '/api/weights', [{ mass: 50, quantity: 4 }]);
  assert.equal(r.status, 400);
  assert.match(r.json.errors.join('\n'), /规格 50 g：有效实物 5 枚，调整后库存 4 枚/);
  // 原数据保留
  const state = await call('GET', '/api/state');
  assert.deepEqual(state.json.data.weights, [{ mass: 50, quantity: 5 }]);
});

let res1, res2, res3, res4, res6;

test('准备预约：窗口内 4 条 + 未来 1 条（占用 50g×1，容量 5）', async () => {
  const now = Date.now();
  res1 = (await makeReservation('CO-R1', pubId, now - H, now + H)).id;
  res2 = (await makeReservation('CO-R2', pubId, now - H, now + H)).id;
  res4 = (await makeReservation('CO-R4', pubId, now - H, now + H)).id;
  res6 = (await makeReservation('CO-R6', pubId, now - H, now + H)).id;
  res3 = (await makeReservation('CO-R3', pubId, now + 2 * H, now + 3 * H)).id;
});

test('领用校验：未知预约 400、未到时段 409、已取消 409、未知实物 400、规格不匹配 409', async () => {
  assert.equal((await call('POST', '/api/checkouts', { reservationId: 9999, itemNos: [] })).status, 400);
  assert.equal((await call('POST', '/api/checkouts', { reservationId: res1 })).status, 400);
  assert.equal((await call('POST', '/api/checkouts', { reservationId: res1, itemNos: ['A', 'A'] })).status, 400);

  // 未到领用时段
  const early = await call('POST', '/api/checkouts', { reservationId: res3, itemNos: ['W50-001'] });
  assert.equal(early.status, 409);
  assert.match(early.json.errors[0], /尚未到领用时段/);

  // 取消后不可领用
  const cancel = await call('POST', `/api/reservations/${res3}/cancel`);
  assert.equal(cancel.status, 200);
  const cancelled = await call('POST', '/api/checkouts', { reservationId: res3, itemNos: ['W50-001'] });
  assert.equal(cancelled.status, 409);
  assert.match(cancelled.json.errors[0], /已取消/);

  // 未知实物编号
  const unknown = await call('POST', '/api/checkouts', { reservationId: res1, itemNos: ['W50-999'] });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.errors[0], /实物编号未登记：W50-999/);

  // 规格/数量不精确匹配（需 50g×1）
  for (const itemNos of [[], ['W50-001', 'W50-002']]) {
    const mis = await call('POST', '/api/checkouts', { reservationId: res1, itemNos });
    assert.equal(mis.status, 409, JSON.stringify(itemNos));
    assert.match(mis.json.errors.join('\n'), /规格 50 g：预约需 1 枚/);
    assert.ok(mis.json.detail.mismatches.length > 0);
  }
  // 冲突不留记录：res1 仍无领用单
  const list = await call('GET', '/api/checkouts');
  assert.equal(list.json.length, 0);
});

let co1, co2;

test('领用成功：冻结预约时段与占用量；同内容重试 200、异内容 409；占用冲突 409', async () => {
  const r1 = await checkout(res1, ['W50-001']);
  co1 = r1.json.id;
  assert.equal(r1.json.status, 'out');
  assert.deepEqual(r1.json.usage, [{ mass: 50, count: 1 }]);
  assert.deepEqual(r1.json.unreturned, ['W50-001']);
  assert.equal(r1.json.overdue, false);
  assert.equal(r1.json.items[0].condition, null);

  // 实物状态联动
  const item = await call('GET', `/api/items/${r1.json.items[0].itemId}`);
  assert.equal(item.json.status, 'checked_out');
  assert.equal(item.json.currentCheckoutId, co1);

  // 同一预约：同内容重试 → 200 原单；异内容 → 409
  const replay = await checkout(res1, ['W50-001'], 200);
  assert.equal(replay.json.id, co1);
  const diff = await call('POST', '/api/checkouts', { reservationId: res1, itemNos: ['W50-002'] });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, co1);

  // 已被其他未归还领用占用 → 409（附占用领用单）
  const busy = await call('POST', '/api/checkouts', { reservationId: res2, itemNos: ['W50-001'] });
  assert.equal(busy.status, 409);
  assert.match(busy.json.errors.join('\n'), /W50-001.*领用单 #/);
  assert.equal(busy.json.detail.items[0].status, 'checked_out');
  assert.equal(busy.json.detail.items[0].checkoutId, co1);

  const r2 = await checkout(res2, ['W50-002']);
  co2 = r2.json.id;
});

test('注销：已领出 409；在库可注销且幂等；已注销实物不能领用', async () => {
  const outItem = (await call('GET', '/api/items?mass=50')).json.find((i) => i.itemNo === 'W50-001');
  const denied = await call('POST', `/api/items/${outItem.id}/deregister`);
  assert.equal(denied.status, 409);
  assert.equal(denied.json.detail.checkoutId, co1);

  const idle = (await call('GET', '/api/items?mass=50')).json.find((i) => i.itemNo === 'W50-003');
  const first = await call('POST', `/api/items/${idle.id}/deregister`);
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'deregistered');
  assert.ok(first.json.deregisteredAt);
  const again = await call('POST', `/api/items/${idle.id}/deregister`);
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'deregistered');

  const use = await call('POST', '/api/checkouts', { reservationId: res4, itemNos: ['W50-003'] });
  assert.equal(use.status, 409);
  assert.match(use.json.errors.join('\n'), /已注销/);
  assert.equal((await call('POST', '/api/items/9999/deregister')).status, 404);

  await checkout(res4, ['W50-004']);
});

test('归还：非本单实物整次拒绝不留记录；逐件标记；重复归还 409；损坏件不得再领', async () => {
  // 非本单实物（W50-002 属于 co2）→ 整次拒绝，co1 不留部分记录
  const notMine = await call('POST', `/api/checkouts/${co1}/returns`, {
    returns: [{ itemNo: 'W50-002', condition: 'intact' }],
  });
  assert.equal(notMine.status, 409);
  assert.match(notMine.json.errors.join('\n'), /不属于本领用单：W50-002/);
  const after1 = await call('GET', `/api/checkouts/${co1}`);
  assert.equal(after1.json.status, 'out');
  assert.deepEqual(after1.json.unreturned, ['W50-001']);

  // 非法归还输入
  assert.equal(
    (await call('POST', `/api/checkouts/${co1}/returns`, { returns: [{ itemNo: 'W50-001', condition: 'ok' }] })).status,
    400,
  );
  assert.equal((await call('POST', '/api/checkouts/9999/returns', { returns: [{ itemNo: 'W50-001', condition: 'intact' }] })).status, 404);

  // 标记损坏 → 201，实物状态 damaged
  const damaged = await call('POST', `/api/checkouts/${co1}/returns`, {
    returns: [{ itemNo: 'W50-001', condition: 'damaged' }],
  });
  assert.equal(damaged.status, 201);
  assert.equal(damaged.json.status, 'returned');
  assert.equal(damaged.json.items[0].condition, 'damaged');
  assert.ok(damaged.json.items[0].returnedAt);

  // 重复归还 → 409 整次拒绝
  const dup = await call('POST', `/api/checkouts/${co1}/returns`, {
    returns: [{ itemNo: 'W50-001', condition: 'intact' }],
  });
  assert.equal(dup.status, 409);
  assert.match(dup.json.errors.join('\n'), /重复归还/);

  // 损坏件不得再次领用
  const reuse = await call('POST', '/api/checkouts', { reservationId: res6, itemNos: ['W50-001'] });
  assert.equal(reuse.status, 409);
  assert.match(reuse.json.errors.join('\n'), /W50-001.*已损坏/);

  // 完好归还 → 回到在库，可再次领用
  const ok = await call('POST', `/api/checkouts/${co2}/returns`, {
    returns: [{ itemNo: 'W50-002', condition: 'intact' }],
  });
  assert.equal(ok.status, 201);
  const item = (await call('GET', '/api/items?mass=50')).json.find((i) => i.itemNo === 'W50-002');
  assert.equal(item.status, 'available');
  assert.equal(item.currentCheckoutId, null);
  const re = await checkout(res6, ['W50-002']);
  assert.equal(re.json.status, 'out');
});

test('逾期：预约结束后未还显示逾期；结束后仍可归还', async () => {
  const now = Date.now();
  const res7 = (await makeReservation('CO-R7', pubId, now - 60_000, now + 500)).id;
  const co = await checkout(res7, ['W50-005']);
  assert.equal(co.json.overdue, false);

  await sleep(700); // 越过预约终点
  const during = await call('GET', `/api/checkouts/${co.json.id}`);
  assert.equal(during.json.overdue, true);
  assert.deepEqual(during.json.unreturned, ['W50-005']);
  assert.equal(during.json.status, 'out');

  // 预约结束后仍可归还
  const ret = await call('POST', `/api/checkouts/${co.json.id}/returns`, {
    returns: [{ itemNo: 'W50-005', condition: 'intact' }],
  });
  assert.equal(ret.status, 201);
  assert.equal(ret.json.overdue, false);
  assert.equal(ret.json.status, 'returned');
});

test('历史不改写：库存调整与预约取消不改写领还历史；状态汇总', async () => {
  // 有效实物 4 枚（W50-003 已注销）：缩减到 4 允许，缩减到 3 整次拒绝
  const shrink = await call('PUT', '/api/weights', [{ mass: 50, quantity: 4 }]);
  assert.equal(shrink.status, 200);
  const deny = await call('PUT', '/api/weights', [{ mass: 50, quantity: 3 }]);
  assert.equal(deny.status, 400);

  // 发布图已失效，但领用单冻结内容不变
  const pub = await call('GET', `/api/publications/${pubId}`);
  assert.equal(pub.json.usable, false);
  const co = await call('GET', `/api/checkouts/${co1}`);
  assert.deepEqual(co.json.usage, [{ mass: 50, count: 1 }]);
  assert.equal(co.json.items[0].condition, 'damaged');
  assert.ok(co.json.startUtc && co.json.endUtc);

  // 列表与状态汇总包含实物与领还
  const state = await call('GET', '/api/state');
  assert.equal(state.json.items.length, 5);
  assert.equal(state.json.checkouts.length, 5);
  const list = await call('GET', '/api/checkouts');
  assert.equal(list.json.filter((c) => c.status === 'returned').length, 3);
  assert.equal(list.json.filter((c) => c.status === 'out').length, 2);
  assert.equal((await call('GET', '/api/checkouts/9999')).status, 404);
});
