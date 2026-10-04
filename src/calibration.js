// 设备校准：校准登记输入规整、登记时序判定与开始运行放行判定
// （纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 校准记录只追加；登记时填写唯一校准单号、设备编号、校准时间、到期时间
//     与合格/不合格结论（passed）；
//   - 所有时间为 UTC；校准时间必须早于到期时间，且校准时间不得晚于服务端当前时刻；
//     同一设备的校准时间必须晚于该设备上一条（最新一条）校准记录的校准时间；
//   - 记录只追加，按设备「最新一条」校准记录判定能否放行运行；
//   - 已有校准记录的设备开始运行时，须确认最新结论合格，且到期时间不早于
//     本次预约终点（到期时间恰等于预约终点视为有效期足够）；无校准记录的设备
//     沿用原有开始规则（不核对校准）；
//   - 开始成功后冻结校准依据；之后新增校准记录、运行超时或完结均不改写历史。

import { parseUtcMs, toIso } from './reserve.js';

// 校准登记请求规整：
//   { calibNo, deviceNo, calibratedAt(UTC), expiresAt(UTC), passed(布尔) }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝（不留校准记录）。
export function normalizeCalibrationInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const calibNo = typeof b.calibNo === 'string' ? b.calibNo.trim() : '';
  if (!calibNo) errors.push('校准单号不能为空');
  else if (calibNo.length > 100) errors.push('校准单号过长（最多 100 字符）');

  const deviceNo = typeof b.deviceNo === 'string' ? b.deviceNo.trim() : '';
  if (!deviceNo) errors.push('设备编号不能为空');
  else if (deviceNo.length > 100) errors.push('设备编号过长（最多 100 字符）');

  const startMs = parseUtcMs(b.calibratedAt);
  const endMs = parseUtcMs(b.expiresAt);
  if (startMs === null) errors.push('校准时间不是合法的 UTC 时间（ISO 8601）');
  if (endMs === null) errors.push('到期时间不是合法的 UTC 时间（ISO 8601）');
  if (startMs !== null && endMs !== null && !(startMs < endMs)) {
    errors.push('校准时间必须早于到期时间');
  }

  if (typeof b.passed !== 'boolean') {
    errors.push('校准结论 passed 必须是布尔值（true=合格，false=不合格）');
  }

  if (errors.length) return { errors, clean: null };
  return {
    errors,
    clean: {
      calibNo,
      deviceNo,
      calibratedAtMs: startMs,
      expiresAtMs: endMs,
      calibratedAt: toIso(startMs),
      expiresAt: toIso(endMs),
      passed: b.passed,
    },
  };
}

// 校准时间不得晚于服务端当前时刻（calibratedAt == now 视为允许：不晚于）。
export function isCalibrationInPast(calibratedAtMs, nowMs) {
  return calibratedAtMs <= nowMs;
}

// 同设备新记录的校准时间必须严格晚于上一条（最新一条）记录的校准时间。
export function isLaterThanPrevious(calibratedAtMs, previousCalibratedAtMs) {
  return calibratedAtMs > previousCalibratedAtMs;
}

// 开始运行放行判定：按设备最新一条校准记录判定。
//   latest: 该设备最新校准记录 { passed, expiresUtc }，null 表示该设备无校准记录
//   reservationEndMs: 本次预约终点（毫秒）
// 返回 { ok, reason }：
//   - 无校准记录：ok=true, reason='none'（沿用原开始规则）；
//   - 最新结论不合格：ok=false, reason='failed'；
//   - 到期时间早于预约终点（有效期不足）：ok=false, reason='expired'；
//   - 合格且到期时间不早于预约终点：ok=true, reason='valid'。
// 到期时间恰等于预约终点视为有效期足够（不早于）。
export function checkCalibrationForRun(latest, reservationEndMs) {
  if (!latest) return { ok: true, reason: 'none' };
  if (!latest.passed) return { ok: false, reason: 'failed' };
  const expiresMs = Date.parse(latest.expiresUtc);
  if (Number.isNaN(expiresMs)) return { ok: false, reason: 'expired' };
  if (expiresMs < reservationEndMs) return { ok: false, reason: 'expired' };
  return { ok: true, reason: 'valid' };
}
