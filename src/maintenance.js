// 设备保养：保养上限输入规整、保养登记输入规整、累计运行时长汇总
// （纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 可按设备编号设置「正整数秒数」的保养上限；未设置上限的设备不核对额度，
//     沿用原行为；
//   - 累计周期自最近一次保养登记时刻开始；尚无保养记录时计入该设备全部已完结运行；
//   - 完成（completed）与中止（aborted）均按服务端记录的起止时间计入累计时长，
//     进行中的运行不提前计入；
//   - 运行即使越过上限也如实完结并释放设备；达到上限（累计时长 ≥ 上限）后，
//     后续开始运行在事务内被拒绝，须先登记保养开启新累计周期；
//   - 调整上限仅影响后续开始判定，不改写运行及保养历史。

// 保养上限设置请求规整：{ limitSeconds }（正整数秒）
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeLimitInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const limitSeconds = Number(b.limitSeconds);
  if (
    typeof b.limitSeconds !== 'number' ||
    !Number.isSafeInteger(limitSeconds) ||
    limitSeconds <= 0
  ) {
    errors.push('保养上限 limitSeconds 必须是正整数（单位：秒）');
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { limitSeconds } };
}

// 设备编号规整（路径参数或请求体共用）：非空、长度上限与运行接口一致。
export function normalizeDeviceNo(value) {
  const deviceNo = typeof value === 'string' ? value.trim() : '';
  if (!deviceNo) return { errors: ['设备编号不能为空'], clean: null };
  if (deviceNo.length > 100) {
    return { errors: ['设备编号过长（最多 100 字符）'], clean: null };
  }
  return { errors: [], clean: { deviceNo } };
}

// 保养登记请求规整：{ maintNo, deviceNo, reason }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeMaintenanceInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const maintNo = typeof b.maintNo === 'string' ? b.maintNo.trim() : '';
  if (!maintNo) errors.push('保养单号不能为空');
  else if (maintNo.length > 100) errors.push('保养单号过长（最多 100 字符）');

  const dev = normalizeDeviceNo(b.deviceNo);
  errors.push(...dev.errors);

  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) errors.push('保养原因不能为空');
  else if (reason.length > 200) errors.push('保养原因过长（最多 200 字符）');

  if (errors.length) return { errors, clean: null };
  return { errors, clean: { maintNo, deviceNo: dev.clean.deviceNo, reason } };
}

// 汇总设备在当前累计周期内的保养状态。
//   deviceNo          设备编号
//   limitSeconds      保养上限（秒）；null 表示未设置（不核对额度）
//   runs              该设备全部运行 [{ startUtc, endedAt }]（endedAt 为 null 表示进行中）
//   lastMaintenanceAt 最近一次保养登记时刻（ISO 字符串）；null 表示尚无保养记录
// 返回：
//   { deviceNo, limitSeconds, cycleStartAt, usedSeconds, countedRuns,
//     remainingSeconds, maintenanceDue }
// 说明：
//   - 周期起点为最近一次保养时刻；无保养记录时计入全部已完结运行；
//   - 仅计入已完结运行（完成/中止均计），进行中的运行不提前计入；
//   - 保养登记要求设备空闲，故周期起点之前开始的运行必然已在起点前完结，
//     按「开始时刻 ≥ 周期起点」判定属于本周期；
//   - 累计时长按服务端记录的起止时间以毫秒精度求和，对外以秒（可含小数）呈现；
//   - 越过上限如实呈现：remainingSeconds 可为 0 或负数；
//   - maintenanceDue：设置了上限且累计时长达到上限（used ≥ limit）。
export function summarizeDevice({ deviceNo, limitSeconds, runs, lastMaintenanceAt }) {
  const cycleStartMs = lastMaintenanceAt ? Date.parse(lastMaintenanceAt) : null;
  let usedMs = 0;
  let countedRuns = 0;
  for (const r of runs || []) {
    if (!r || !r.endedAt) continue; // 进行中不提前计入
    const startMs = Date.parse(r.startUtc);
    const endMs = Date.parse(r.endedAt);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    if (cycleStartMs !== null && !(startMs >= cycleStartMs)) continue;
    usedMs += Math.max(0, endMs - startMs);
    countedRuns += 1;
  }
  const hasLimit = typeof limitSeconds === 'number' && Number.isFinite(limitSeconds);
  const limitMs = hasLimit ? limitSeconds * 1000 : null;
  return {
    deviceNo,
    limitSeconds: hasLimit ? limitSeconds : null,
    cycleStartAt: cycleStartMs !== null ? new Date(cycleStartMs).toISOString() : null,
    usedSeconds: usedMs / 1000,
    countedRuns,
    remainingSeconds: hasLimit ? (limitMs - usedMs) / 1000 : null,
    maintenanceDue: hasLimit && usedMs >= limitMs,
  };
}
