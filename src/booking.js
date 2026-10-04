// 找时段预约（批次号幂等的「预约 + 设备排班」整次操作）：输入规整、
// 区间代数与最早可行起点搜索（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 实验人员提交批次号、当前可用的发布图、正整数秒时长、起点晚于服务端
//     当前时刻的 UTC 搜索窗口，以及非空且不重复的候选设备编号；
//   - 系统在窗口内寻找能完整容纳该时长的最早起点；同一最早起点多台设备
//     可行时，取设备编号字典序最小者；
//   - 配重按冻结装载图用量、当前库存、重叠的生效预约与生效停用逐时段核算
//     （任一时刻「既有占用 + 停用 + 本次需求 ≤ 当前库存」）；设备按生效排班
//     核算（同设备时段不得重叠）；均采用左闭右开 [start, end) 时段，
//     首尾相接可用；
//   - 提交时在同一事务内重读依据，原子生成共用时段的预约与设备排班；
//     无可行时段、图已失效或输入非法时不留任何记录并说明原因；
//   - 批次号为整次操作的幂等键：同号同请求重试返回冻结的原结果（即使预约
//     之后被取消或资源变化），异请求或与既有普通预约撞号拒绝。

import { parseUtcMs, availabilitySegments } from './reserve.js';

// 找时段预约请求规整：
//   { batchNo, publicationId, durationSeconds, windowStartUtc, windowEndUtc, deviceNos }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
// clean 中窗口已解析为毫秒（windowStartMs / windowEndMs），设备编号已去空白。
export function normalizeBookingInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }

  const batchNo = typeof b.batchNo === 'string' ? b.batchNo.trim() : '';
  if (!batchNo) errors.push('批次号不能为空');
  else if (batchNo.length > 100) errors.push('批次号过长（最多 100 字符）');

  const publicationId = Number(b.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    errors.push('publicationId 必须是发布记录编号（正整数）');
  }

  const durationSeconds = b.durationSeconds;
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds <= 0
  ) {
    errors.push('时长 durationSeconds 必须是正整数（单位：秒）');
  } else if (!Number.isSafeInteger(durationSeconds * 1000)) {
    errors.push('时长 durationSeconds 过大（超出可表示范围）');
  }

  const windowStartMs = parseUtcMs(b.windowStartUtc);
  const windowEndMs = parseUtcMs(b.windowEndUtc);
  if (windowStartMs === null) errors.push('搜索窗口起点不是合法的 UTC 时间（ISO 8601）');
  if (windowEndMs === null) errors.push('搜索窗口终点不是合法的 UTC 时间（ISO 8601）');
  if (windowStartMs !== null && windowEndMs !== null && !(windowStartMs < windowEndMs)) {
    errors.push('搜索窗口起点必须早于终点（时段按左闭右开 [start, end) 计算）');
  }

  let deviceNos = null;
  if (!Array.isArray(b.deviceNos) || b.deviceNos.length === 0) {
    errors.push('候选设备编号列表 deviceNos 必须是非空数组');
  } else {
    deviceNos = [];
    const seen = new Set();
    b.deviceNos.forEach((raw, i) => {
      if (typeof raw !== 'string' || raw.trim() === '') {
        errors.push(`第 ${i + 1} 个候选设备编号必须是非空字符串`);
        return;
      }
      const no = raw.trim();
      if (no.length > 100) {
        errors.push(`候选设备编号「${no}」过长（最多 100 字符）`);
        return;
      }
      if (seen.has(no)) {
        errors.push(`候选设备编号「${no}」重复（候选设备编号不得重复）`);
        return;
      }
      seen.add(no);
      deviceNos.push(no);
    });
  }

  if (errors.length) return { errors, clean: null };
  return {
    errors,
    clean: { batchNo, publicationId, durationSeconds, windowStartMs, windowEndMs, deviceNos },
  };
}

// ---------- 区间代数（左闭右开 [start, end)，毫秒） ----------

// 两组已排序、各自不重叠的区间列表求交。
export function intersectIntervals(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].startMs, b[j].startMs);
    const t = Math.min(a[i].endMs, b[j].endMs);
    if (s < t) out.push({ startMs: s, endMs: t });
    if (a[i].endMs < b[j].endMs) i += 1;
    else j += 1;
  }
  return out;
}

// 窗口 [s, e) 减去占用区间后的空闲区间（占用先裁剪到窗口；左闭右开，
// 占用终点与空闲起点相接）。
export function freeIntervals(busy, s, e) {
  const sorted = [...(busy || [])]
    .map((it) => ({ startMs: Math.max(it.startMs, s), endMs: Math.min(it.endMs, e) }))
    .filter((it) => it.startMs < it.endMs)
    .sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const free = [];
  let cur = s;
  for (const b of sorted) {
    if (b.startMs > cur) free.push({ startMs: cur, endMs: b.startMs });
    if (b.endMs > cur) cur = b.endMs;
  }
  if (cur < e) free.push({ startMs: cur, endMs: e });
  return free;
}

// ---------- 配重可行区间 ----------
// specs: [{ required, capacity, usedIntervals, suspendedIntervals }]
//   required          本次需求（按冻结装载图统计的该规格占用量）
//   capacity          当前库存（当前录入数量）
//   usedIntervals     窗口内重叠的生效预约占用 [{startMs, endMs, count}]
//   suspendedIntervals 窗口内重叠的生效停用 [{startMs, endMs, count}]
// 返回窗口 [s, e) 内「任一时刻 既有占用 + 停用 ≤ 当前库存 − 本次需求」
// 对所有规格同时成立的区间（已合并相邻段、按起点升序）。
export function weightFeasibleIntervals(specs, s, e) {
  let ok = [{ startMs: s, endMs: e }];
  for (const spec of specs || []) {
    const segments = availabilitySegments(
      spec.usedIntervals || [],
      spec.suspendedIntervals || [],
      s,
      e,
    );
    const limit = spec.capacity - spec.required;
    const specOk = [];
    for (const seg of segments) {
      if (seg.used + seg.suspended > limit) continue;
      const last = specOk[specOk.length - 1];
      if (last && last.endMs === seg.startMs) last.endMs = seg.endMs;
      else specOk.push({ startMs: seg.startMs, endMs: seg.endMs });
    }
    ok = intersectIntervals(ok, specOk);
    if (ok.length === 0) break;
  }
  return ok;
}

// ---------- 最早可行起点搜索 ----------
// windowStartMs/windowEndMs: 搜索窗口（左闭右开）
// durationMs:  需要完整容纳的时长（毫秒）
// weightOk:    配重可行区间（weightFeasibleIntervals 的输出）
// devices:     [{ deviceNo, busy: [{startMs, endMs}] }]（busy 为该设备窗口内生效排班）
// 返回 { startMs, endMs, deviceNo }：窗口内能完整容纳时长的最早起点；
// 同一最早起点多台设备可行时取设备编号字典序最小者；无可行时段返回 null。
export function findEarliestSlot({ windowStartMs, windowEndMs, durationMs, weightOk, devices }) {
  let best = null;
  for (const dev of devices || []) {
    const free = freeIntervals(dev.busy, windowStartMs, windowEndMs);
    const combined = intersectIntervals(weightOk, free);
    for (const iv of combined) {
      if (iv.endMs - iv.startMs >= durationMs) {
        const startMs = iv.startMs;
        if (
          best === null ||
          startMs < best.startMs ||
          (startMs === best.startMs && dev.deviceNo < best.deviceNo)
        ) {
          best = { startMs, endMs: startMs + durationMs, deviceNo: dev.deviceNo };
        }
        break; // 区间按起点升序，首个能容纳的区间起点即该设备最早可行起点
      }
    }
  }
  return best;
}
