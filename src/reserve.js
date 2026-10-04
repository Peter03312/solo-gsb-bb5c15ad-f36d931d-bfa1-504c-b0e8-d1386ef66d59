// 配重块时段预约 / 临时停用（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 时段一律按左闭右开 [start, end) 计算：终点与起点相接的两个时段互不重叠；
//   - 每条预约按其所依据的冻结装载图统计各质量规格的占用量；
//   - 停用登记按质量规格记录临时停用数量，同规格重叠时段的停用量累加；
//   - 任一时刻、任一质量规格，全部生效中（未取消/未撤销）预约的占用总量
//     加上同时段停用量不得超过当前录入的可选数量；
//   - 判定一律使用「当前录入数量」与「当前图可用性」；既有预约/停用均不因数量
//     减少或图失效而被改写；日程中「占用超库存」与「占用加停用超库存」分开展示。

// ISO 8601 形状（允许日期型、空格分隔、省略秒、省略时区——省略时区按 UTC 处理）
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:\s*(?:Z|z|[+-]\d{2}:?\d{2}))?)?$/;

// 解析 UTC 时间字符串 → 毫秒时间戳；非法返回 null。
export function parseUtcMs(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!ISO_RE.test(v)) return null;
  let norm = v.replace(' ', 'T');
  if (!/[T]/.test(norm)) norm += 'T00:00:00';
  if (!/(?:Z|z|[+-]\d{2}:?\d{2})$/.test(norm)) norm += 'Z';
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

// ---------- 冻结图占用统计 ----------
// publication: getPublication 返回的冻结记录（含 result.arrangement）。
// 返回 [{mass, count}]（按质量升序），仅含配重块；纯离心管图为空数组。
export function planUsage(publication) {
  const counts = new Map();
  const arrangement =
    publication && publication.result && Array.isArray(publication.result.arrangement)
      ? publication.result.arrangement
      : [];
  for (const slot of arrangement) {
    if (slot && slot.kind === 'weight' && typeof slot.mass === 'number') {
      counts.set(slot.mass, (counts.get(slot.mass) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([mass, count]) => ({ mass, count }))
    .sort((a, b) => a.mass - b.mass);
}

// ---------- 扫描线：时段内分段常量占用 ----------
// intervals: [{startMs, endMs, count}]（调用前不要求裁剪，函数内裁剪到 [s,e)）。
// 返回 [{startMs, endMs, used}]：在 [s,e) 上占用量分段恒定，相邻段 used 不同；
// 左闭右开语义由「同一时刻先处理结束事件再处理开始事件」保证。
export function occupancySegments(intervals, s, e) {
  const events = [];
  for (const it of intervals) {
    const a = Math.max(it.startMs, s);
    const b = Math.min(it.endMs, e);
    if (a < b && it.count > 0) {
      events.push({ t: a, d: it.count });
      events.push({ t: b, d: -it.count });
    }
  }
  // 同一时刻：结束（负增量）先于开始（正增量）——左闭右开
  events.sort((x, y) => x.t - y.t || x.d - y.d);

  const segments = [];
  let cur = 0;
  let i = 0;
  let prev = s;
  while (i < events.length && events[i].t <= s) {
    cur += events[i].d;
    i += 1;
  }
  while (i < events.length) {
    const t = events[i].t;
    if (t > prev) segments.push({ startMs: prev, endMs: t, used: cur });
    while (i < events.length && events[i].t === t) {
      cur += events[i].d;
      i += 1;
    }
    prev = t;
  }
  if (prev < e) segments.push({ startMs: prev, endMs: e, used: cur });
  return segments;
}

// ---------- 双层扫描线：预约占用 + 停用量 ----------
// usedIntervals / suspendedIntervals: [{startMs, endMs, count}]（函数内裁剪到 [s,e)）。
// 返回 [{startMs, endMs, used, suspended}]：在 [s,e) 上占用量与停用量均分段恒定；
// 任一层发生变化即切段；左闭右开语义由「同一时刻先处理结束事件再处理开始事件」保证。
export function availabilitySegments(usedIntervals, suspendedIntervals, s, e) {
  const events = [];
  for (const it of usedIntervals || []) {
    const a = Math.max(it.startMs, s);
    const b = Math.min(it.endMs, e);
    if (a < b && it.count > 0) {
      events.push({ t: a, du: it.count, ds: 0 });
      events.push({ t: b, du: -it.count, ds: 0 });
    }
  }
  for (const it of suspendedIntervals || []) {
    const a = Math.max(it.startMs, s);
    const b = Math.min(it.endMs, e);
    if (a < b && it.count > 0) {
      events.push({ t: a, du: 0, ds: it.count });
      events.push({ t: b, du: 0, ds: -it.count });
    }
  }
  // 同一时刻：负增量（结束）先于正增量（开始）——左闭右开
  events.sort((x, y) => x.t - y.t || x.du + x.ds - (y.du + y.ds));

  const segments = [];
  let used = 0;
  let suspended = 0;
  let i = 0;
  let prev = s;
  while (i < events.length && events[i].t <= s) {
    used += events[i].du;
    suspended += events[i].ds;
    i += 1;
  }
  const flush = (t) => {
    if (t > prev) segments.push({ startMs: prev, endMs: t, used, suspended });
  };
  while (i < events.length) {
    const t = events[i].t;
    flush(t);
    while (i < events.length && events[i].t === t) {
      used += events[i].du;
      suspended += events[i].ds;
      i += 1;
    }
    prev = t;
  }
  flush(e);
  return segments;
}

// ---------- 容量判定 ----------
// usage:       本次预约各规格占用 [{mass, count}]
// capacityOf:  (mass) => 当前录入可选数量（无该规格返回 0）
// overlapping: 与 [startMs,endMs) 重叠的生效中预约 [{startMs, endMs, usage:[{mass,count}]}]
// suspensions: 与 [startMs,endMs) 重叠的生效中停用（同格式，count 为停用数量，可选）
// 返回 { ok, conflicts }；conflicts 元素：
//   { mass, required, capacity, peak, peakSuspended,
//     windows:[{start,end,used,suspended}] }
//   windows 为「既有占用 + 本次需求 + 停用量 > 当前数量」的合并时段（ISO 字符串）。
export function checkCapacity({
  usage,
  capacityOf,
  overlapping,
  suspensions = [],
  startMs,
  endMs,
}) {
  const conflicts = [];
  for (const u of usage) {
    if (!(u.count > 0)) continue;
    const capacity = capacityOf(u.mass);
    const usedIntervals = [];
    for (const r of overlapping) {
      const ru = (r.usage || []).find((x) => x.mass === u.mass);
      if (ru && ru.count > 0) {
        usedIntervals.push({ startMs: r.startMs, endMs: r.endMs, count: ru.count });
      }
    }
    const suspendedIntervals = [];
    for (const sp of suspensions) {
      if (sp.mass === u.mass && sp.count > 0) {
        suspendedIntervals.push({ startMs: sp.startMs, endMs: sp.endMs, count: sp.count });
      }
    }
    const segments = availabilitySegments(
      usedIntervals,
      suspendedIntervals,
      startMs,
      endMs,
    );
    const peak = segments.reduce((m, seg) => Math.max(m, seg.used), 0);
    const peakSuspended = segments.reduce((m, seg) => Math.max(m, seg.suspended), 0);
    if (peak + u.count + peakSuspended <= capacity) continue;

    // 超限时窗：used + suspended > capacity - required 的连续段（相邻合并，峰值取段内最大）
    const limit = capacity - u.count;
    const windows = [];
    for (const seg of segments) {
      if (seg.used + seg.suspended <= limit) continue;
      const last = windows[windows.length - 1];
      if (last && last.endMs === seg.startMs) {
        last.endMs = seg.endMs;
        last.used = Math.max(last.used, seg.used);
        last.suspended = Math.max(last.suspended, seg.suspended);
      } else {
        windows.push({
          startMs: seg.startMs,
          endMs: seg.endMs,
          used: seg.used,
          suspended: seg.suspended,
        });
      }
    }
    conflicts.push({
      mass: u.mass,
      required: u.count,
      capacity,
      peak,
      peakSuspended,
      windows: windows.map((w) => ({
        start: toIso(w.startMs),
        end: toIso(w.endMs),
        used: w.used,
        suspended: w.suspended,
      })),
    });
  }
  return { ok: conflicts.length === 0, conflicts };
}

// 把 [{startMs,endMs,...}] 段数组转为 ISO 输出（used/suspended 之外键原样保留）
function isoSegments(segments) {
  return segments.map((seg) => {
    const out = { start: toIso(seg.startMs), end: toIso(seg.endMs) };
    for (const [k, v] of Object.entries(seg)) {
      if (k !== 'startMs' && k !== 'endMs') out[k] = v;
    }
    return out;
  });
}

// ---------- 停用登记容量判定 ----------
// mass/quantity: 本次停用的规格与数量
// capacity:      登记时该规格当前录入数量
// overlapping:   与 [startMs,endMs) 重叠的生效中停用 [{startMs,endMs,mass,count}]
// 注意：停用允许与既有预约重叠（既有预约不改写），故此处只核对重叠停用量。
// 返回 { ok, conflict: {mass, required, capacity, peak,
//   windows:[{start,end,suspended}]} | null }
export function checkSuspension({ mass, quantity, capacity, overlapping, startMs, endMs }) {
  const intervals = (overlapping || [])
    .filter((sp) => sp.mass === mass && sp.count > 0)
    .map((sp) => ({ startMs: sp.startMs, endMs: sp.endMs, count: sp.count }));
  const segments = availabilitySegments([], intervals, startMs, endMs);
  const peak = segments.reduce((m, seg) => Math.max(m, seg.suspended), 0);
  if (peak + quantity <= capacity) return { ok: true, conflict: null };

  const limit = capacity - quantity;
  const windows = [];
  for (const seg of segments) {
    if (seg.suspended <= limit) continue;
    const last = windows[windows.length - 1];
    if (last && last.endMs === seg.startMs) {
      last.endMs = seg.endMs;
      last.suspended = Math.max(last.suspended, seg.suspended);
    } else {
      windows.push({ startMs: seg.startMs, endMs: seg.endMs, suspended: seg.suspended });
    }
  }
  return {
    ok: false,
    conflict: {
      mass,
      required: quantity,
      capacity,
      peak,
      windows: isoSegments(windows),
    },
  };
}

// ---------- 日程（展示已有占用、停用及不足） ----------
// reservations: 生效中预约 [{startMs, endMs, usage:[{mass,count}]}]
// suspensions:  生效中停用 [{startMs, endMs, mass, count}]（可选）
// masses:       需要展示的规格集合（当前录入规格 ∪ 预约涉及规格 ∪ 停用涉及规格）
// capacityOf:   (mass) => 当前录入可选数量
// 返回 specs: [{
//   mass, capacity,
//   peak, shortage,                 // 仅预约占用口径（字段含义保持不变）
//   peakSuspended, peakCombined, combinedShortage,
//   segments:        [{start,end,used,shortage}],        // 仅 used>0；占用超库存
//   suspendedSegments:[{start,end,suspended}],           // 仅 suspended>0
//   combinedSegments:[{start,end,used,suspended,shortage}] // 占用+停用超库存
// }]
// shortage（segments/规格级）表示「预约占用超过当前数量」；
// combinedSegments/ shortage 表示「占用加停用超过当前数量」。
export function buildSchedule({
  reservations,
  suspensions = [],
  masses,
  capacityOf,
  fromMs,
  toMs,
}) {
  const specs = [];
  for (const mass of masses) {
    const capacity = capacityOf(mass);
    const usedIntervals = [];
    for (const r of reservations) {
      const ru = (r.usage || []).find((x) => x.mass === mass);
      if (ru && ru.count > 0) {
        usedIntervals.push({ startMs: r.startMs, endMs: r.endMs, count: ru.count });
      }
    }
    const suspendedIntervals = [];
    for (const sp of suspensions) {
      if (sp.mass === mass && sp.count > 0) {
        suspendedIntervals.push({ startMs: sp.startMs, endMs: sp.endMs, count: sp.count });
      }
    }
    const all = availabilitySegments(
      usedIntervals,
      suspendedIntervals,
      fromMs,
      toMs,
    );

    // 占用口径：仅保留 used>0 的分段（与历史行为一致）
    const segments = isoSegments(
      all
        .filter((seg) => seg.used > 0)
        .map((seg) => ({ ...seg, shortage: seg.used > capacity })),
    );
    const peak = all.reduce((m, seg) => Math.max(m, seg.used), 0);

    // 停用口径：仅保留 suspended>0 的分段（相邻同值段已由扫描线按层合并）
    const suspendedSegments = isoSegments(
      all.filter((seg) => seg.suspended > 0).map((seg) => ({ ...seg })),
    );
    const peakSuspended = all.reduce((m, seg) => Math.max(m, seg.suspended), 0);

    // 合计口径：占用或停用任一 >0 的分段
    const combinedSegments = isoSegments(
      all
        .filter((seg) => seg.used > 0 || seg.suspended > 0)
        .map((seg) => ({
          ...seg,
          shortage: seg.used + seg.suspended > capacity,
        })),
    );
    const peakCombined = all.reduce(
      (m, seg) => Math.max(m, seg.used + seg.suspended),
      0,
    );

    specs.push({
      mass,
      capacity,
      peak,
      shortage: peak > capacity,
      peakSuspended,
      peakCombined,
      combinedShortage: peakCombined > capacity,
      segments,
      suspendedSegments,
      combinedSegments,
    });
  }
  return specs;
}
