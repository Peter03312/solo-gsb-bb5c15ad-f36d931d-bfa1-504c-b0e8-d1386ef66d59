// 一键预约 + 设备排班（纯函数，无数据库依赖，便于测试）。
//
// 实验人员提交：批次号、当前可用发布图、正整数秒时长、起点严格晚于服务端当前
// 时刻的 UTC 搜索窗口 [windowStart, windowEnd)，以及非空且不重复的候选设备编号。
// 系统在窗口内找出能完整容纳该时长的最早起点 s（预约/排班共用 [s, s+D)）：
//   - 配重：按冻结装载图用量、当前库存、重叠的生效预约与生效停用逐时段核算
//     （左闭右开，任一时刻「既有预约占用 + 停用 + 本次需求」不得超过当前库存）；
//   - 设备：候选设备在 [s, s+D) 内不得有重叠生效排班（左闭右开，首尾相接可用）；
//   - 同一最早起点多台设备可用时，取设备编号字典序最小者。
//
// 可行性关于起点 s 只在既有区间端点处变化：某区间 [a,b) 对时长 D 的占位区间
// （起点域上的被排除集合）为开区间 (a-D, b)——s == a-D 与 s == b 均为首尾相接，
// 不算冲突。故最早可行起点必在窗口起点 L 或某占位区间的端点处，枚举这些点
// 逐点判定即可（毫秒精度，左闭右开由判定函数保证）。

import { parseUtcMs, checkCapacity } from './reserve.js';
import { findDeviceConflicts } from './schedule.js';

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// 一键预约请求规整：
//   { batchNo, publicationId, durationSeconds, searchStartUtc, searchEndUtc,
//     deviceNos: [string] }
// 返回 { errors, clean }；clean 中时间已转为毫秒、设备编号去空白去重并按字典序
// 排列；errors 非空时调用方按 400 拒绝。
export function normalizeAutoBookInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) return { errors: ['请求体必须是对象'], clean: null };

  const batchNo = typeof b.batchNo === 'string' ? b.batchNo.trim() : '';
  if (!batchNo) errors.push('批次号不能为空');
  else if (batchNo.length > 100) errors.push('批次号过长（最多 100 字符）');

  const publicationId = Number(b.publicationId);
  if (!isInt(publicationId) || publicationId <= 0) {
    errors.push('publicationId 必须是发布记录编号（正整数）');
  }

  const durationSeconds = b.durationSeconds;
  if (!isInt(durationSeconds) || durationSeconds <= 0) {
    errors.push('durationSeconds 必须是正整数秒时长');
  }

  const searchStartMs = parseUtcMs(b.searchStartUtc);
  const searchEndMs = parseUtcMs(b.searchEndUtc);
  if (searchStartMs === null) {
    errors.push('搜索窗口起点不是合法的 UTC 时间（ISO 8601）');
  }
  if (searchEndMs === null) {
    errors.push('搜索窗口终点不是合法的 UTC 时间（ISO 8601）');
  }
  if (searchStartMs !== null && searchEndMs !== null) {
    if (!(searchStartMs < searchEndMs)) {
      errors.push('搜索窗口起点必须早于终点（窗口按左闭右开 [start, end) 计算）');
    } else if (isInt(durationSeconds) && durationSeconds > 0) {
      const endMs = searchStartMs + durationSeconds * 1000;
      if (!Number.isSafeInteger(endMs)) {
        errors.push('时长相对于搜索窗口起点超出可表示的时间范围');
      }
    }
  }

  const deviceNos = [];
  if (!Array.isArray(b.deviceNos)) {
    errors.push('deviceNos 必须是非空数组（候选设备编号，非空且不重复）');
  } else {
    const seen = new Set();
    b.deviceNos.forEach((raw, i) => {
      const no = typeof raw === 'string' ? raw.trim() : '';
      if (!no) {
        errors.push(`第 ${i + 1} 个候选设备编号不能为空`);
        return;
      }
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
    if (deviceNos.length === 0 && !errors.some((e) => e.includes('不能为空'))) {
      errors.push('deviceNos 必须是非空数组（候选设备编号，非空且不重复）');
    }
    deviceNos.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  }

  if (errors.length) return { errors, clean: null };
  return {
    errors,
    clean: {
      batchNo,
      publicationId,
      durationSeconds,
      searchStartMs,
      searchEndMs,
      deviceNos,
    },
  };
}

// ---------- 最早可行起点 ----------
//
// 入参：
//   durationMs        时长（毫秒，正整数）
//   windowStartMs/windowEndMs 搜索窗口（左闭右开）
//   usage             冻结图各规格占用 [{mass,count}]
//   capacityOf        (mass) => 当前库存
//   reservations      与窗口重叠的生效预约 [{startMs,endMs,usage:[{mass,count}]}]
//   suspensions       与窗口重叠的生效停用 [{startMs,endMs,mass,count}]
//   schedulesByDevice Map<deviceNo, [{scheduleId,reservationId,startMs,endMs}]>
//   deviceNos         候选设备（已按字典序升序）
// 返回：
//   { found:true, startMs, deviceNo }
//   { found:false, reason:'windowTooShort' }
//   { found:false, reason:'noFeasibleSlot', examined:[
//       {startMs, weightOk, capacityConflicts, freeDevices,
//        blockedDevices:[{deviceNo, conflicts}]}] }
export function findEarliestSlot({
  durationMs,
  windowStartMs,
  windowEndMs,
  usage,
  capacityOf,
  reservations = [],
  suspensions = [],
  schedulesByDevice = new Map(),
  deviceNos = [],
}) {
  const L = windowStartMs;
  const E = windowEndMs;
  const D = durationMs;
  const R = E - D; // 可容纳完整时长的最晚起点
  if (R < L) return { found: false, reason: 'windowTooShort' };

  // 起点域候选点：L、R 及各区间 [a,b) 的 (a-D) 与 b（裁剪到 [L,R]）。
  const points = new Set([L, R]);
  const addInterval = (a, b) => {
    const l = a - D;
    if (l >= L && l <= R) points.add(l);
    if (b >= L && b <= R) points.add(b);
  };
  for (const r of reservations) addInterval(r.startMs, r.endMs);
  for (const sp of suspensions) addInterval(sp.startMs, sp.endMs);
  for (const d of deviceNos) {
    for (const s of schedulesByDevice.get(d) || []) {
      addInterval(s.startMs, s.endMs);
    }
  }
  const ordered = [...points].sort((a, b) => a - b);

  const examined = [];
  for (const s of ordered) {
    // 配重：逐时段核对 [s, s+D) 内「既有预约占用 + 停用 + 本次需求 ≤ 当前库存」
    const cap = checkCapacity({
      usage,
      capacityOf,
      overlapping: reservations,
      suspensions,
      startMs: s,
      endMs: s + D,
    });
    // 设备：逐台核对生效排班（首尾相接允许）
    const blockedDevices = [];
    for (const deviceNo of deviceNos) {
      const probe = findDeviceConflicts(schedulesByDevice.get(deviceNo) || [], s, s + D);
      if (!probe.available) {
        blockedDevices.push({ deviceNo, conflicts: probe.conflicts });
      }
    }
    const blockedSet = new Set(blockedDevices.map((x) => x.deviceNo));
    const freeDevices = deviceNos.filter((d) => !blockedSet.has(d));

    if (cap.ok && freeDevices.length > 0) {
      // deviceNos 已按字典序升序，第一台即字典序最小
      return { found: true, startMs: s, deviceNo: freeDevices[0] };
    }
    examined.push({
      startMs: s,
      weightOk: cap.ok,
      capacityConflicts: cap.conflicts,
      freeDevices,
      blockedDevices,
    });
  }
  return { found: false, reason: 'noFeasibleSlot', examined };
}
