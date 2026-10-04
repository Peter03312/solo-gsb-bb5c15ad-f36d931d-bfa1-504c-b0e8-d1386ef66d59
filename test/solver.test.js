import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve, verify, computeHash } from '../src/solver.js';

const base = (over = {}) => ({
  holes: 4,
  tolerance: 1,
  holeMaxMass: [100, 100, 100, 100],
  tubes: [],
  weights: [],
  ...over,
});
const allHoles = (n) => Array.from({ length: n }, (_, i) => i);

test('两支等重管直接对径放置，无需配重', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(r.weightCount, 0);
  assert.equal(r.diffSum, 0);
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('管间差超容差时各对径配重，配重每枚只用一次', () => {
  // A=50、B=60 不能同对（差 10 > 容差 2），各自对径一枚同质量配重。
  const data = base({
    tolerance: 2,
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 60, usableHoles: allHoles(4) },
    ],
    weights: [
      { mass: 50, quantity: 1 },
      { mass: 60, quantity: 1 },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(r.weightCount, 2);
  assert.ok(r.pairs.every((p) => p.withinTolerance));
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('配重数量优先最小：即便多加配重可减小差和也不使用', () => {
  // A=50, B=50.9，容差 1：不配重差 0.9 已合格（0 枚配重）；
  // 一枚 1g 配重可把差降到 0.1，但配重数优先，应选 0 枚。
  const data = base({
    tolerance: 1,
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50.9, usableHoles: allHoles(4) },
    ],
    weights: [{ mass: 1, quantity: 2 }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  assert.equal(r.weightCount, 0);
  assert.ok(Math.abs(r.diffSum - 0.9) < 1e-9);
});

test('同分时小编号物件占据小编号孔位', () => {
  const data = base({
    tubes: [
      { id: 'T2', mass: 40, usableHoles: allHoles(4) },
      { id: 'T1', mass: 40, usableHoles: allHoles(4) },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  const holeOf = (id) => r.arrangement.findIndex((s) => s && s.ref === id);
  assert.ok(holeOf('T1') < holeOf('T2'));
});

test('可用孔位受限导致无解时给出明确原因', () => {
  const data = base({
    tolerance: 0.5,
    tubes: [
      { id: 'A', mass: 50, usableHoles: [0] },
      { id: 'B', mass: 80, usableHoles: [2] },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
  assert.ok(r.reasons.length > 0);
});

test('超过孔最大承重不可装', () => {
  const data = base({
    holeMaxMass: [100, 100, 100, 60],
    tubes: [{ id: 'A', mass: 80, usableHoles: [3] }],
  });
  const r = solve(data);
  assert.equal(r.feasible, false);
});

test('管数超过孔位数直接无解', () => {
  const tubes = Array.from({ length: 5 }, (_, i) => ({
    id: `T${i}`,
    mass: 10,
    usableHoles: allHoles(4),
  }));
  const r = solve(base({ tubes }));
  assert.equal(r.feasible, false);
});

test('verify 能识别被篡改的装载图（重复使用管）', () => {
  const data = base({
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 50, usableHoles: allHoles(4) },
    ],
  });
  const tampered = [
    { kind: 'tube', ref: 'A', mass: 50 },
    null,
    { kind: 'tube', ref: 'A', mass: 50 },
    null,
  ];
  const v = verify(data, tampered);
  assert.equal(v.ok, false);
});

test('verify 能识别重复使用同一枚配重', () => {
  const data = base({
    tolerance: 1,
    tubes: [],
    weights: [{ mass: 50, quantity: 2 }],
  });
  const dup = [
    { kind: 'weight', ref: '配重#1-1', mass: 50 },
    null,
    { kind: 'weight', ref: '配重#1-1', mass: 50 },
    null,
  ];
  const v = verify(data, dup);
  assert.equal(v.ok, false);
  assert.ok(v.errors.join(' ').includes('重复使用'));
});

test('求解器输出的配重编号彼此唯一且可通过复核', () => {
  const data = base({
    tolerance: 2,
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 60, usableHoles: allHoles(4) },
    ],
    weights: [
      { mass: 50, quantity: 1 },
      { mass: 60, quantity: 1 },
    ],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  const refs = r.arrangement.filter((s) => s && s.kind === 'weight').map((s) => s.ref);
  assert.equal(new Set(refs).size, refs.length);
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});

test('verify 能识别超容差装载图', () => {
  const data = base({
    tolerance: 0.1,
    tubes: [
      { id: 'A', mass: 50, usableHoles: allHoles(4) },
      { id: 'B', mass: 60, usableHoles: allHoles(4) },
    ],
  });
  const bad = [
    { kind: 'tube', ref: 'A', mass: 50 },
    null,
    { kind: 'tube', ref: 'B', mass: 60 },
    null,
  ];
  const v = verify(data, bad);
  assert.equal(v.ok, false);
});

test('相同数据哈希一致；数据变化哈希变化', () => {
  const d1 = base({ tubes: [{ id: 'A', mass: 1, usableHoles: [0] }] });
  const d2 = base({ tubes: [{ id: 'A', mass: 1, usableHoles: [0] }] });
  const d3 = base({ tubes: [{ id: 'A', mass: 2, usableHoles: [0] }] });
  assert.equal(computeHash(d1), computeHash(d2));
  assert.notEqual(computeHash(d1), computeHash(d3));
});

test('空转子可行（无管无配重）', () => {
  const r = solve(base());
  assert.equal(r.feasible, true);
  assert.equal(r.weightCount, 0);
  assert.equal(r.diffSum, 0);
});

test('12 孔满载规模可完成求解', () => {
  const tubes = Array.from({ length: 12 }, (_, i) => ({
    id: `T${String(i + 1).padStart(2, '0')}`,
    mass: 30 + (i % 2) * 0.3,
    usableHoles: allHoles(12),
  }));
  const data = base({
    holes: 12,
    tolerance: 0.5,
    holeMaxMass: Array(12).fill(100),
    tubes,
    weights: [{ mass: 0.3, quantity: 6 }],
  });
  const r = solve(data);
  assert.equal(r.feasible, true);
  const used = r.arrangement.filter(Boolean).length;
  assert.equal(used, 12);
  const v = verify(data, r.arrangement);
  assert.equal(v.ok, true, v.errors.join(';'));
});
