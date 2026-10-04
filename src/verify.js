// 现场装载核验（纯函数 + 录入规整）。
//
// 核验对象是某条已发布、已冻结的装载图（snapshot 取自 publications.config_json /
// result_json）。现场按孔位录入「实际物件编号 + 实测质量」：
//   - 物件所在孔：ref 为物件编号（与冻结图一致），mass 为有限正数；
//   - 空孔：ref 为空且 mass 为 0。
// 核验完成时在同一数据库事务内重读发布快照与当前录入后调用 verifyMeasurements：
//   1) 各孔实际物件编号须与冻结图完全一致（定位到孔位）；
//   2) 实测质量不得超过该孔最大承重（定位到孔位）；
//   3) 各对径孔实测质量差不得超过冻结容差（定位到孔对）；
//   4) 发布记录仍可用于当前装载（basis_hash 与当前数据指纹一致）。

import { EPS } from './solver.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// ---------- 录入规整与结构校验（暂存时使用） ----------
//
// entries 支持两种形态：
//   - 长度为 N 的数组：每项 {ref?: string, mass?: number}，缺省项视为空孔；
//   - 稀疏数组：[{hole, ref, mass}, ...]，未出现的孔位视为空孔。
// 规整结果固定为长度 N 的数组 {hole, ref, mass}（空孔 ref:''、mass:0）。
// 结构问题一律抛出 ValidationError，由调用方回滚，不改动既有草稿。
export function normalizeEntries(input, N) {
  const errors = [];
  if (!Array.isArray(input)) {
    return {
      errors: ['核验录入必须是数组（每项含孔位与实测数据）'],
      entries: null,
    };
  }
  const entries = Array.from({ length: N }, (_, h) => ({ hole: h, ref: '', mass: 0 }));
  const seen = new Set();

  const applyRow = (row, h, where) => {
    if (row === null || typeof row !== 'object') {
      errors.push(`${where}格式不正确（必须是对象）`);
      return;
    }
    if (!isInt(h) || h < 0 || h >= N) {
      errors.push(`${where}孔位 ${h} 越界（允许 0..${N - 1}）`);
      return;
    }
    if (seen.has(h)) {
      errors.push(`孔 ${h} 的核验数据重复`);
      return;
    }
    seen.add(h);

    const rawRef = row.ref;
    const ref = typeof rawRef === 'string' ? rawRef.trim() : rawRef == null ? '' : null;
    if (ref === null) {
      errors.push(`孔 ${h} 的物件编号必须是字符串`);
      return;
    }

    const mass = row.mass;
    const hasMass =
      Object.prototype.hasOwnProperty.call(row, 'mass') &&
      mass !== null &&
      `${mass}`.trim() !== '';
    if (!hasMass) {
      if (ref !== '') {
        errors.push(`孔 ${h} 已录入物件「${ref}」，其实测质量必须是有限正数`);
      }
      // 否则视为空孔：ref 空、质量 0（默认值）
      return;
    }
    if (!isNum(mass)) {
      errors.push(`孔 ${h} 的实测质量必须是数字（当前：${mass}）`);
      return;
    }
    if (ref === '') {
      if (mass !== 0) {
        errors.push(`孔 ${h} 为空孔时不得填写质量（空孔质量必须为 0）`);
      }
      return;
    }
    if (!(mass > 0)) {
      errors.push(`孔 ${h} 物件「${ref}」的实测质量必须为有限正数（当前：${mass}）`);
      return;
    }
    entries[h] = { hole: h, ref, mass };
  };

  // 全为“无 hole 字段”的对象时按稠密数组（下标即孔位）处理；否则按稀疏录入处理
  const dense =
    input.length > 0 &&
    input.every(
      (r) =>
        r === null ||
        typeof r !== 'object' ||
        !Object.prototype.hasOwnProperty.call(r, 'hole'),
    );
  if (dense) {
    if (input.length !== N) {
      errors.push(`核验录入数组长度必须为 ${N}（与孔位数一致）`);
    }
    input.forEach((row, i) => {
      if (i < N) applyRow(row ?? {}, i, `孔 ${i}：`);
    });
  } else {
    input.forEach((row, i) => applyRow(row, row && row.hole, `第 ${i + 1} 条录入：`));
  }

  return { errors, entries: errors.length ? null : entries };
}

// ---------- 核验进度（页面展示用） ----------
// 总孔位 = 冻结图中的非空孔；已录入 = 该孔填了物件编号。
export function measureProgress(frozen, entries) {
  const N = frozen.config.holes;
  let total = 0;
  let filled = 0;
  for (let h = 0; h < N; h += 1) {
    if (frozen.result.arrangement[h]) total += 1;
    if (entries[h] && entries[h].ref !== '') filled += 1;
  }
  return { filled, total };
}

// ---------- 完成核验：事务内独立判定（不信任前端、不信任草稿） ----------
//
// snapshot: { config, result } 发布冻结内容；entries: 规整后的 N 项录入。
// 返回：
//   { ok:true, checks:{ holes:[...], pairs:[...] }, diffSum, massSum }
//   { ok:false, errors:[...], checks:{...} }  错误均定位到孔位/孔对。
export function verifyMeasurements(snapshot, entries) {
  const { config, result } = snapshot;
  const N = config.holes;
  const tol = config.tolerance;
  const arrangement = result.arrangement;
  const errors = [];

  if (!Array.isArray(entries) || entries.length !== N) {
    return {
      ok: false,
      errors: ['核验录入与冻结图孔位数不符'],
      checks: { holes: [], pairs: [] },
    };
  }

  const holes = [];
  for (let h = 0; h < N; h += 1) {
    const slot = arrangement[h];
    const e = entries[h];
    const expectedRef = slot ? slot.ref : '';
    const actualRef = e && typeof e.ref === 'string' ? e.ref : '';
    const mass = e && isNum(e.mass) ? e.mass : NaN;
    const item = {
      hole: h,
      expectedRef,
      actualRef,
      measuredMass: Number.isNaN(mass) ? 0 : mass,
      objectMatch: actualRef === expectedRef,
      withinCapacity: false,
    };

    // 1) 物件一致性（含“空孔须为空”）
    if (actualRef !== expectedRef) {
      item.objectMatch = false;
      if (expectedRef === '') {
        errors.push(`孔 ${h} 应为空孔，但实测录入了物件「${actualRef}」（空孔须保持为空、质量为 0）`);
      } else if (actualRef === '') {
        errors.push(`孔 ${h} 应为物件「${expectedRef}」，但现场留空`);
      } else {
        errors.push(`孔 ${h} 物件不一致：冻结图为「${expectedRef}」，现场录入为「${actualRef}」`);
      }
    }

    // 2) 实测质量合法性与孔承重
    const cap = config.holeMaxMass[h];
    if (expectedRef === '') {
      // 空孔质量必须为 0
      item.withinCapacity = isNum(mass) && mass === 0;
      if (!item.withinCapacity) {
        errors.push(`孔 ${h} 为空孔，实测质量必须为 0（当前：${e ? e.mass : '缺失'}）`);
      }
    } else {
      item.withinCapacity = isNum(mass) && mass > 0 && mass <= cap + EPS;
      if (!isNum(mass) || mass <= 0) {
        errors.push(`孔 ${h} 物件「${expectedRef}」实测质量必须为有限正数（当前：${e ? e.mass : '缺失'}）`);
      } else if (mass > cap + EPS) {
        errors.push(`孔 ${h} 物件「${expectedRef}」实测质量 ${mass} 超过该孔最大承重 ${cap}`);
      }
    }
    holes.push(item);
  }

  // 3) 对径孔实测质量差（冻结容差）
  const m = N / 2;
  const pairs = [];
  let diffSum = 0;
  let massSum = 0;
  for (let i = 0; i < m; i += 1) {
    const a = i;
    const b = i + m;
    const ma = holes[a].measuredMass;
    const mb = holes[b].measuredMass;
    const diff = Math.abs(ma - mb);
    diffSum += diff;
    massSum += ma + mb;
    const withinTolerance = diff <= tol + EPS;
    if (!withinTolerance) {
      errors.push(
        `对径孔对（${a} ↔ ${b}）实测质量差 ${Math.round(diff * 1e6) / 1e6} 超过冻结容差 ${tol}`,
      );
    }
    pairs.push({ a, b, massA: ma, massB: mb, diff, withinTolerance });
  }

  return {
    ok: errors.length === 0,
    errors,
    checks: { holes, pairs },
    diffSum,
    massSum,
  };
}
