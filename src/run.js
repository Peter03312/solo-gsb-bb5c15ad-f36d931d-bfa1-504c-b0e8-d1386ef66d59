// 离心运行：开始输入规整与时段判定（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 开始与结束时间一律由服务端记录（调用方不传时间）；
//   - 预约时段按左闭右开 [start, end)：开始时刻满足 start <= now < end；
//   - 超过预约终点才完结时如实完结并标记超时（结束时刻 == 预约终点不算超时）；
//   - 开始后冻结发布图（编号/数据指纹/快照）、核验结论与预约时段，之后任何
//     配置、库存或预约状态变化都不改写这些冻结依据。

export const RUN_OUTCOMES = ['completed', 'aborted'];

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// 开始运行请求规整：
//   { runNo, deviceNo, verificationId, reservationId }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeStartInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const runNo = typeof b.runNo === 'string' ? b.runNo.trim() : '';
  if (!runNo) errors.push('运行编号不能为空');
  else if (runNo.length > 100) errors.push('运行编号过长（最多 100 字符）');

  const deviceNo = typeof b.deviceNo === 'string' ? b.deviceNo.trim() : '';
  if (!deviceNo) errors.push('设备编号不能为空');
  else if (deviceNo.length > 100) errors.push('设备编号过长（最多 100 字符）');

  const verificationId = Number(b.verificationId);
  if (!isInt(verificationId) || verificationId <= 0) {
    errors.push('verificationId 必须是核验编号（正整数）');
  }
  const reservationId = Number(b.reservationId);
  if (!isInt(reservationId) || reservationId <= 0) {
    errors.push('reservationId 必须是预约编号（正整数）');
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { runNo, deviceNo, verificationId, reservationId } };
}

// 完结请求规整：outcome 必填且仅能为 completed / aborted。
export function normalizeCompleteInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const outcome = b.outcome;
  if (typeof outcome !== 'string' || !RUN_OUTCOMES.includes(outcome)) {
    errors.push(`outcome 必须是 ${RUN_OUTCOMES.join(' / ')} 之一（完成或中止）`);
  }
  return { errors, clean: errors.length ? null : { outcome } };
}

// 当前时刻是否处于预约左闭右开时段 [start, end)
export function isWithinReservation(startMs, endMs, nowMs) {
  return startMs <= nowMs && nowMs < endMs;
}

// 完结时刻是否超过预约终点（左闭右开：恰在终点完结不算超时）
export function isOverrun(reservationEndMs, endMs) {
  return endMs > reservationEndMs;
}
