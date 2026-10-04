// 离心转子配平求解器（纯函数，无数据库依赖，便于测试与发布前独立复核）
//
// 模型：
//   孔位编号 0..N-1（N 为 4..12 的偶数），孔 i 与孔 i+N/2 对径。
//   每孔最多放置一件物件（一支离心管或一枚配重块），也可留空（质量按 0 计）。
//   全部离心管必须装入；每个配重质量组有若干枚，每枚最多使用一次。
//   任一孔内物件质量不得超过该孔最大承重；每对对径孔质量差不得超过容差。
//   避邻规则：环形孔位中孔 i 与孔 (i+1)%N 相邻；data.exclusionPairs 中同对的
//   两支离心管不得占据相邻孔位（未配置规则时等价于无此约束）。
//   固定孔位：data.fixedSlots 中指定的离心管必须占据指定孔位（未配置时等价于
//   无此约束）；固定管不得出现在其他孔位，固定孔位不得放置其他物件。
//
// 优化目标（字典序）：
//   1) 使用配重块数量最少
//   2) 各对径孔质量差之和最小
//   3) 按孔位编号排列的物件编号序列字典序最小；
//      物件次序约定：离心管（编号字符串）< 配重块（质量组序号, 组内序号）< 空孔，
//      即同分方案优先让小编号离心管占据低编号孔位。
//
// 算法：按对径对逐对做动态规划。状态 = 已用离心管位图 + 各配重组已用数量；
// 有避邻规则时再附加「上一对/第一对放置的避邻相关管身份」（用于相邻与环绕判定）；
// 同一状态只保留目标三元组 (配重数, 差和, 孔位物件序列前缀) 最优的路径。

import crypto from 'node:crypto';

export const EPS = 1e-7;

const EMPTY = Object.freeze({ t: 2 });

// ---------- 基础工具 ----------

export function leqDiff(a, b, tol) {
  return Math.abs(a - b) <= tol + EPS;
}

export function canonicalData(data) {
  const canon = (x) => {
    if (Array.isArray(x)) return x.map(canon);
    if (x !== null && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x).sort().map((k) => [k, canon(x[k])]),
      );
    }
    return x;
  };
  return canon(data);
}

// 数据指纹：未配置避邻规则（exclusionPairs 为空或缺失）或固定孔位（fixedSlots 为空或
// 缺失）时，哈希与不含对应字段的历史数据完全一致——旧发布图仍按原规则判定可用；
// 一旦配置了规则/绑定，其内容即纳入指纹，变化会使旧发布图不可用于当前装载
// （历史图本身不改写）；清空后指纹回到与无规则/无绑定一致。
export function computeHash(data) {
  const payload = { ...data };
  if (!Array.isArray(payload.exclusionPairs) || payload.exclusionPairs.length === 0) {
    delete payload.exclusionPairs;
  }
  if (!Array.isArray(payload.fixedSlots) || payload.fixedSlots.length === 0) {
    delete payload.fixedSlots;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalData(payload)))
    .digest('hex');
}

// 孔位序列中单个槽位的比较
function cmpSlot(a, b) {
  if (a.t !== b.t) return a.t - b.t;
  if (a.t === 1) {
    if (a.g !== b.g) return a.g - b.g;
    return a.k - b.k;
  }
  if (a.t === 0) {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }
  return 0;
}

// 槽位序列字典序比较
function cmpKey(ka, kb) {
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i += 1) {
    const c = cmpSlot(ka[i], kb[i]);
    if (c !== 0) return c;
  }
  return ka.length - kb.length;
}

// 目标三元组：<0 表示 a 更优
function cmpObjective(a, b) {
  if (a.wc !== b.wc) return a.wc - b.wc;
  const dd = a.diff - b.diff;
  if (Math.abs(dd) > EPS) return dd;
  return cmpKey(a.key, b.key);
}

// ---------- 求解 ----------

export function solve(data) {
  const N = data.holes;
  const m = N / 2;
  const tol = data.tolerance;
  const maxMass = data.holeMaxMass;
  const tubes = data.tubes.map((t) => ({ ...t })).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const T = tubes.length;
  const groups = data.weights
    .map((w, g) => ({ g, mass: w.mass, q: Math.min(w.quantity, N) }))
    .sort((a, b) => a.mass - b.mass)
    .map((w, idx) => ({ ...w, g: idx }));
  const G = groups.length;

  // ---------- 避邻规则预处理 ----------
  // 环形相邻：孔 h 与 (h+1)%N。同对两管不得相邻。
  // 只有「参与避邻对的管」的身份需要进入 DP 状态（其余管与任何管相邻均可），
  // 故状态附加维度仅为 (s+1)^4，s 为避邻涉及管数；无规则时 s=0，状态与
  // 原模型完全一致（零额外开销）。
  const exclPairs = Array.isArray(data.exclusionPairs) ? data.exclusionPairs : [];
  const tubeIdx = new Map(tubes.map((t, i) => [t.id, i]));
  const forbidden = new Set(); // lo * T + hi（管索引对，小在前）
  const sMembers = new Set();
  for (const p of exclPairs) {
    if (!p || typeof p !== 'object') continue;
    const ia = tubeIdx.get(p.a);
    const ib = tubeIdx.get(p.b);
    if (ia === undefined || ib === undefined || ia === ib) continue; // 校验层已拦截，防御
    forbidden.add(Math.min(ia, ib) * T + Math.max(ia, ib));
    sMembers.add(ia);
    sMembers.add(ib);
  }
  const sList = [...sMembers].sort((a, b) => a - b); // S 编码 1..s → 管索引
  const sCode = new Array(T).fill(0); // 管索引 → S 编码（0 = 不参与避邻）
  sList.forEach((idx, k) => {
    sCode[idx] = k + 1;
  });
  const S1 = sList.length + 1; // 单侧编码种数（含「非避邻物件」0）
  const pairKeyOf = (x, y) => Math.min(x, y) * T + Math.max(x, y);
  // 判定：S 编码 code（上一对/第一对留下的物件）与当前管 curIdx 是否构成禁对
  const clashes = (code, curIdx) =>
    code > 0 && curIdx >= 0 && forbidden.has(pairKeyOf(sList[code - 1], curIdx));

  // ---------- 固定孔位预处理 ----------
  // 指定管必须占据指定孔位：fixedTubeAtHole（孔 → 管索引）使该孔只接受这一支管；
  // fixedHoleOfTube（管索引 → 孔）使该管不得出现在其他孔位。不增加 DP 状态维度，
  // 仅收缩各孔位的放置选项，优化目标与求解顺序保持不变。
  const fixedList = Array.isArray(data.fixedSlots) ? data.fixedSlots : [];
  const fixedTubeAtHole = new Map(); // 孔 → 管索引
  const fixedHoleOfTube = new Map(); // 管索引 → 孔
  const fixedInvalid = [];
  for (const f of fixedList) {
    if (!f || typeof f !== 'object') continue;
    const idx = tubeIdx.get(f.tube);
    const h = f.hole;
    // 校验层已拦截以下情形，此处为防御性检查
    if (idx === undefined) {
      fixedInvalid.push(`固定孔位绑定的离心管「${f.tube}」不存在于当前录入`);
      continue;
    }
    if (!Number.isInteger(h) || h < 0 || h >= N) {
      fixedInvalid.push(`固定孔位绑定的孔位 ${h} 越界（允许 0..${N - 1}）`);
      continue;
    }
    if (fixedHoleOfTube.has(idx)) {
      fixedInvalid.push(`离心管「${f.tube}」被重复绑定固定孔位`);
      continue;
    }
    if (fixedTubeAtHole.has(h)) {
      fixedInvalid.push(`孔位 ${h} 被重复绑定固定离心管`);
      continue;
    }
    fixedHoleOfTube.set(idx, h);
    fixedTubeAtHole.set(h, idx);
  }

  const reasons = [];
  if (fixedInvalid.length > 0) {
    reasons.push('固定孔位绑定与当前录入数据不一致：', ...fixedInvalid);
  }
  for (const [h, idx] of fixedTubeAtHole) {
    const t = tubes[idx];
    if (!t.usableHoles.includes(h)) {
      reasons.push(`离心管「${t.id}」固定在孔 ${h}，但该孔不在其可用孔位内`);
    }
    if (t.mass > maxMass[h] + EPS) {
      reasons.push(
        `离心管「${t.id}」固定在孔 ${h}，但其质量 ${t.mass} 超过该孔最大承重（${maxMass[h]}）`,
      );
    }
  }
  if (T > N) {
    reasons.push(`离心管数量（${T}）超过转子孔位总数（${N}）`);
  }
  for (const t of tubes) {
    const cap = Math.max(...t.usableHoles.map((h) => maxMass[h]));
    if (t.mass > cap + EPS) {
      reasons.push(
        `离心管「${t.id}」质量 ${t.mass} 超过其全部可用孔位的最大承重（${cap}）`,
      );
    }
  }
  if (reasons.length > 0) return { feasible: false, reasons };

  // 配重组混合基数编码
  const stride = new Array(G);
  let wbase = 1;
  for (let g = 0; g < G; g += 1) {
    stride[g] = wbase;
    wbase *= groups[g].q + 1;
  }

  // 某孔位可放置的物件清单
  const fillsAt = (h) => {
    // 固定孔位：该孔只接受绑定的离心管（不放空、不放配重、不放其他管）
    const fixedIdx = fixedTubeAtHole.get(h);
    if (fixedIdx !== undefined) {
      const t = tubes[fixedIdx];
      if (!t.usableHoles.includes(h) || t.mass > maxMass[h] + EPS) return [];
      return [
        {
          empty: false,
          kind: 'tube',
          idx: fixedIdx,
          ref: t.id,
          mass: t.mass,
          slot: { t: 0, id: t.id },
        },
      ];
    }
    const fills = [{ empty: true, mass: 0, slot: EMPTY }];
    for (let idx = 0; idx < T; idx += 1) {
      if (fixedHoleOfTube.has(idx)) continue; // 固定管只能占据其固定孔位
      const t = tubes[idx];
      if (t.usableHoles.includes(h) && t.mass <= maxMass[h] + EPS) {
        fills.push({
          empty: false,
          kind: 'tube',
          idx,
          ref: t.id,
          mass: t.mass,
          slot: { t: 0, id: t.id },
        });
      }
    }
    for (const grp of groups) {
      if (grp.mass <= maxMass[h] + EPS) {
        for (let k = 0; k < grp.q; k += 1) {
          fills.push({
            empty: false,
            kind: 'weight',
            g: grp.g,
            k,
            ref: weightRef(grp.g, k),
            mass: grp.mass,
            slot: { t: 1, g: grp.g, k },
          });
        }
      }
    }
    return fills;
  };

  const sameInstance = (a, b) => {
    if (a.empty || b.empty) return false;
    if (a.kind === 'tube' && b.kind === 'tube') return a.idx === b.idx;
    if (a.kind === 'weight' && b.kind === 'weight')
      return a.g === b.g && a.k === b.k;
    return false;
  };

  // 每个对径对的合法放置选项
  const pairOptions = [];
  for (let i = 0; i < m; i += 1) {
    const holeA = i;
    const holeB = i + m;
    const opts = [];
    for (const fa of fillsAt(holeA)) {
      for (const fb of fillsAt(holeB)) {
        if (sameInstance(fa, fb)) continue;
        if (!leqDiff(fa.mass, fb.mass, tol)) continue;
        let mask = 0;
        const counts = new Array(G).fill(0);
        const placements = [];
        for (const [hole, f] of [
          [holeA, fa],
          [holeB, fb],
        ]) {
          if (f.empty) continue;
          if (f.kind === 'tube') mask |= 1 << f.idx;
          else counts[f.g] += 1;
          placements.push({
            hole,
            kind: f.kind,
            ref: f.ref,
            mass: f.mass,
            ...(f.kind === 'weight' ? { g: f.g, k: f.k } : {}),
          });
        }
        let wdelta = 0;
        for (let g = 0; g < G; g += 1) wdelta += counts[g] * stride[g];
        opts.push({
          mask,
          counts,
          wdelta,
          wc: placements.filter((p) => p.kind === 'weight').length,
          diff: Math.abs(fa.mass - fb.mass),
          key: [fa.slot, fb.slot],
          placements,
          // 避邻判定用：A/B 侧放置的管索引（非管为 -1）
          ca: fa.kind === 'tube' ? fa.idx : -1,
          cb: fb.kind === 'tube' ? fb.idx : -1,
        });
      }
    }
    if (opts.length === 0) {
      const fixedNote = [holeA, holeB]
        .filter((h) => fixedTubeAtHole.has(h))
        .map((h) => `孔 ${h} 固定放置离心管「${tubes[fixedTubeAtHole.get(h)].id}」`)
        .join('；');
      reasons.push(
        `对径孔对（${holeA} ↔ ${holeB}）不存在满足承重与容差的放置方式` +
          (fixedNote ? `（${fixedNote}）` : ''),
      );
      return { feasible: false, reasons };
    }
    pairOptions.push(opts);
  }

  // DP：stateKey -> 最优路径。
  // 状态附加 prevA/prevB（上一对 A/B 侧物件的 S 编码）与 firstA/firstB
  // （第一对 A/B 侧物件的 S 编码）：处理第 i 对时，孔 i 与孔 i-1、孔 i+m 与
  // 孔 i+m-1 的相邻关系用 prev 判定；最后一对（i = m-1）时，环绕边
  // （孔 m-1 ↔ 孔 m、孔 N-1 ↔ 孔 0）用 first 判定。无避邻规则时 S1 = 1，
  // 编码恒为 0，stateKey 与原模型逐位一致。
  const FF = S1 * S1;
  let states = new Map();
  states.set(0, {
    mask: 0,
    wcode: 0,
    counts: new Array(G).fill(0),
    wc: 0,
    diff: 0,
    key: [],
    placements: [],
    prevA: 0,
    prevB: 0,
    firstA: 0,
    firstB: 0,
  });

  for (let i = 0; i < m; i += 1) {
    const last = i === m - 1;
    const next = new Map();
    for (const st of states.values()) {
      for (const opt of pairOptions[i]) {
        if (st.mask & opt.mask) continue;
        // 避邻：当前对与上一对的相邻边（孔 i-1 ↔ i、孔 i+m-1 ↔ i+m）
        if (S1 > 1) {
          if (clashes(st.prevA, opt.ca) || clashes(st.prevB, opt.cb)) continue;
          // 环绕边（仅最后一对）：孔 m-1 ↔ 孔 m、孔 N-1 ↔ 孔 0
          if (last && (clashes(st.firstB, opt.ca) || clashes(st.firstA, opt.cb))) {
            continue;
          }
        }
        let wcode = st.wcode;
        let counts = st.counts;
        let ok = true;
        for (let g = 0; g < G; g += 1) {
          if (opt.counts[g] > 0) {
            const ng = st.counts[g] + opt.counts[g];
            if (ng > groups[g].q) {
              ok = false;
              break;
            }
            if (counts === st.counts) counts = st.counts.slice();
            counts[g] = ng;
            wcode += opt.counts[g] * stride[g];
          }
        }
        if (!ok) continue;

        const candidate = {
          mask: st.mask | opt.mask,
          wcode,
          counts,
          wc: st.wc + opt.wc,
          diff: st.diff + opt.diff,
          key: st.key.concat(opt.key),
          placements: st.placements.concat(opt.placements),
          prevA: opt.ca >= 0 ? sCode[opt.ca] : 0,
          prevB: opt.cb >= 0 ? sCode[opt.cb] : 0,
          firstA: i === 0 ? (opt.ca >= 0 ? sCode[opt.ca] : 0) : st.firstA,
          firstB: i === 0 ? (opt.cb >= 0 ? sCode[opt.cb] : 0) : st.firstB,
        };
        const stateKey =
          (((candidate.mask * wbase + wcode) * S1 + candidate.prevA) * S1 +
            candidate.prevB) *
            FF +
          candidate.firstA * S1 +
          candidate.firstB;
        const old = next.get(stateKey);
        if (!old || cmpObjective(candidate, old) < 0) next.set(stateKey, candidate);
      }
    }
    states = next;
    if (states.size === 0) break;
  }

  const fullMask = T === 0 ? 0 : (1 << T) - 1;
  let best = null;
  for (const st of states.values()) {
    if (st.mask !== fullMask) continue;
    if (!best || cmpObjective(st, best) < 0) best = st;
  }

  if (!best) {
    // 无解时说明冲突来源：若忽略固定孔位/避邻规则后存在可行图，则冲突来自对应规则
    const hasFixed = fixedTubeAtHole.size > 0;
    const hasExcl = exclPairs.length > 0;
    const fixedDesc = fixedList
      .map((f) => (f && typeof f === 'object' ? `「${f.tube}」→ 孔 ${f.hole}` : ''))
      .filter(Boolean)
      .join('、');
    const fixedConflictReasons = () => [
      `不存在同时满足固定孔位的装载图：当前 ${fixedList.length} 项固定孔位（${fixedDesc}）与装载约束相互冲突`,
      '忽略固定孔位时存在可行装载图；请调整固定孔位或录入数据后重试',
    ];
    const exclConflictReasons = () => [
      `不存在同时满足避邻规则的装载图：当前 ${exclPairs.length} 对避邻规则（${exclPairs
        .map((p) => `${p.a} ↔ ${p.b}`)
        .join('、')}）与装载约束相互冲突`,
      '忽略避邻规则时存在可行装载图；请调整避邻对或录入数据后重试',
    ];
    if (hasFixed || hasExcl) {
      const relaxedAll = solve({ ...data, exclusionPairs: [], fixedSlots: [] });
      if (relaxedAll.feasible) {
        if (hasFixed && hasExcl) {
          // 两类规则同时存在：分别放松以定位冲突来源
          const relaxFixed = solve({ ...data, fixedSlots: [] });
          if (relaxFixed.feasible) {
            return { feasible: false, reasons: fixedConflictReasons() };
          }
          const relaxExcl = solve({ ...data, exclusionPairs: [] });
          if (relaxExcl.feasible) {
            return { feasible: false, reasons: exclConflictReasons() };
          }
          return {
            feasible: false,
            reasons: [
              `不存在同时满足固定孔位与避邻规则的装载图：${fixedList.length} 项固定孔位（${fixedDesc}）` +
                `与 ${exclPairs.length} 对避邻规则（${exclPairs
                  .map((p) => `${p.a} ↔ ${p.b}`)
                  .join('、')}）共同与装载约束相互冲突`,
              '同时忽略固定孔位与避邻规则时存在可行装载图；请调整规则或录入数据后重试',
            ],
          };
        }
        return {
          feasible: false,
          reasons: hasFixed ? fixedConflictReasons() : exclConflictReasons(),
        };
      }
    }
    return {
      feasible: false,
      reasons: ['穷举全部放置组合后，不存在满足全部约束的装载图'],
    };
  }

  const arrangement = new Array(N).fill(null);
  // 配重块同质量物理等价，状态只区分“某组用了几枚”；
  // 输出时按孔位升序对每组实际使用的配重重新编号，保证编号唯一（#组-1..k）。
  const wSeen = groups.map(() => 0);
  const byHole = new Map(best.placements.map((p) => [p.hole, p]));
  for (let h = 0; h < N; h += 1) {
    const p = byHole.get(h);
    if (!p) continue;
    let ref = p.ref;
    if (p.kind === 'weight') {
      ref = weightRef(p.g, wSeen[p.g]);
      wSeen[p.g] += 1;
    }
    arrangement[h] = { kind: p.kind, ref, mass: p.mass };
  }
  const pairs = [];
  for (let i = 0; i < m; i += 1) {
    const massA = arrangement[i] ? arrangement[i].mass : 0;
    const massB = arrangement[i + m] ? arrangement[i + m].mass : 0;
    pairs.push({
      a: i,
      b: i + m,
      massA,
      massB,
      diff: Math.abs(massA - massB),
      withinTolerance: leqDiff(massA, massB, tol),
    });
  }

  return {
    feasible: true,
    arrangement,
    pairs,
    weightCount: best.wc,
    diffSum: pairs.reduce((s, p) => s + p.diff, 0),
  };
}

export function weightRef(g, k) {
  return `配重#${g + 1}-${k + 1}`;
}

// ---------- 独立复核（发布时使用，不信任求解器输出） ----------

export function verify(data, arrangement) {
  const errors = [];
  const N = data.holes;
  const tol = data.tolerance;
  const numEq = (x, y) => Math.abs(x - y) <= EPS;

  if (!Array.isArray(arrangement) || arrangement.length !== N) {
    return { ok: false, errors: ['装载图长度与孔位数不符'], weightCount: 0, diffSum: 0 };
  }

  const tubeMap = new Map(data.tubes.map((t) => [t.id, t]));
  const seenTubes = new Set();
  // 配重组按质量升序编号，与求解器一致
  const groups = data.weights
    .map((w) => ({ mass: w.mass, quantity: w.quantity }))
    .sort((a, b) => a.mass - b.mass);
  const usedWeights = groups.map(() => 0);
  const weightInstances = new Set();
  const usedHoles = new Set();
  let weightCount = 0;

  const refRe = /^配重#(\d+)-(\d+)$/;

  arrangement.forEach((slot, h) => {
    if (slot === null) return;
    if (usedHoles.has(h)) errors.push(`孔 ${h} 放置了多件物件`);
    usedHoles.add(h);
    if (
      typeof slot !== 'object' ||
      (slot.kind !== 'tube' && slot.kind !== 'weight')
    ) {
      errors.push(`孔 ${h} 的物件类型无法识别`);
      return;
    }
    if (typeof slot.mass !== 'number' || !Number.isFinite(slot.mass) || slot.mass < 0) {
      errors.push(`孔 ${h} 的物件质量非法`);
      return;
    }
    if (slot.mass > data.holeMaxMass[h] + EPS) {
      errors.push(`孔 ${h} 物件质量 ${slot.mass} 超过最大承重 ${data.holeMaxMass[h]}`);
    }

    if (slot.kind === 'tube') {
      const t = tubeMap.get(slot.ref);
      if (!t) {
        errors.push(`孔 ${h} 使用了不存在的离心管「${slot.ref}」`);
        return;
      }
      if (seenTubes.has(t.id)) errors.push(`离心管「${t.id}」被重复放置`);
      seenTubes.add(t.id);
      if (!numEq(slot.mass, t.mass)) {
        errors.push(`孔 ${h} 离心管「${t.id}」质量与录入数据不一致`);
      }
      if (!t.usableHoles.includes(h)) {
        errors.push(`离心管「${t.id}」被放入其不可用孔位 ${h}`);
      }
    } else {
      const mt = String(slot.ref).match(refRe);
      if (!mt) {
        errors.push(`孔 ${h} 配重编号「${slot.ref}」无法识别`);
        return;
      }
      const g = Number(mt[1]) - 1;
      const k = Number(mt[2]) - 1;
      if (g < 0 || g >= groups.length) {
        errors.push(`孔 ${h} 配重「${slot.ref}」所属质量组不存在`);
        return;
      }
      if (!numEq(slot.mass, groups[g].mass)) {
        errors.push(`孔 ${h} 配重「${slot.ref}」质量与录入数据不一致`);
      }
      if (k < 0 || k >= groups[g].quantity) {
        errors.push(`孔 ${h} 使用了超出库存数量的配重「${slot.ref}」`);
        return;
      }
      const instKey = `${g}:${k}`;
      if (weightInstances.has(instKey)) {
        errors.push(`配重「${slot.ref}」被重复使用（每枚最多用一次）`);
        return;
      }
      weightInstances.add(instKey);
      usedWeights[g] += 1;
      if (usedWeights[g] > groups[g].quantity) {
        errors.push(`质量 ${groups[g].mass} 的配重块使用数量超过库存`);
      }
      weightCount += 1;
    }
  });

  for (const t of data.tubes) {
    if (!seenTubes.has(t.id)) errors.push(`离心管「${t.id}」未被装入转子`);
  }

  let diffSum = 0;
  const m = N / 2;
  for (let i = 0; i < m; i += 1) {
    const ma = arrangement[i] ? arrangement[i].mass : 0;
    const mb = arrangement[i + m] ? arrangement[i + m].mass : 0;
    const d = Math.abs(ma - mb);
    diffSum += d;
    if (d > tol + EPS) {
      errors.push(`对径孔对（${i} ↔ ${i + m}）质量差 ${d} 超过容差 ${tol}`);
    }
  }

  // 避邻复核：同对两管不得占据环形相邻孔位（i 与 (i+1)%N 相邻）
  const exclPairs = Array.isArray(data.exclusionPairs) ? data.exclusionPairs : [];
  if (exclPairs.length > 0) {
    const holeOf = new Map();
    arrangement.forEach((slot, h) => {
      if (slot && slot.kind === 'tube') holeOf.set(slot.ref, h);
    });
    for (const p of exclPairs) {
      if (!p || typeof p !== 'object') continue;
      const ha = holeOf.get(p.a);
      const hb = holeOf.get(p.b);
      if (ha === undefined || hb === undefined) continue; // 未装入/未知管已由上文报告
      const d = (ha - hb + N) % N;
      if (d === 1 || d === N - 1) {
        errors.push(
          `离心管「${p.a}」（孔 ${ha}）与「${p.b}」（孔 ${hb}）占据相邻孔位，违反避邻规则`,
        );
      }
    }
  }

  // 固定孔位复核：指定离心管必须占据指定孔位
  const fixedList = Array.isArray(data.fixedSlots) ? data.fixedSlots : [];
  for (const f of fixedList) {
    if (!f || typeof f !== 'object') continue;
    const h = f.hole;
    if (!Number.isInteger(h) || h < 0 || h >= N) {
      errors.push(`固定孔位 ${h} 越界（允许 0..${N - 1}）`);
      continue;
    }
    const slot = arrangement[h];
    if (!slot || slot.kind !== 'tube' || slot.ref !== f.tube) {
      errors.push(
        `固定孔位 ${h} 应放置离心管「${f.tube}」，实际为「${slot ? slot.ref : '空'}」`,
      );
    }
  }

  return { ok: errors.length === 0, errors, weightCount, diffSum };
}
