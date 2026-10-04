// 配重块实物领还（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 实物按现有质量规格登记唯一实物编号；实物状态：available（在库可领）/
//     checked_out（领出未还）/ damaged（归还报损，不得再次领用）/
//     deregistered（已注销，不再计入有效实物数）；
//   - 有效实物 = 已登记且未注销（含在库、领出、损坏）；同规格有效实物数不得
//     超过当前库存：登记实物时核对，库存缩减低于有效实物数时整次拒绝；
//   - 已领出实物不能注销；损坏件不得再次领用；
//   - 领用凭生效预约在其左闭右开时段 [start, end) 内进行；所选实物按规格
//     精确匹配预约冻结占用量，且均未被其他未归还领用占用；同一预约只可
//     领用一次——同内容重试返回原单，异内容拒绝；
//   - 归还逐件标记完好（intact）/损坏（damaged）；非本单实物或重复归还
//     整次拒绝，不留下部分记录；预约结束后仍可归还；
//   - 查询展示未还件与逾期状态（当前时刻超过冻结预约终点且仍有未还件）；
//   - 预约取消、库存调整及运行状态变化均不改写领还历史（领用单冻结预约
//     时段与占用量快照）。

export const ITEM_STATUSES = ['available', 'checked_out', 'damaged', 'deregistered'];
export const RETURN_CONDITIONS = ['intact', 'damaged'];

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// 实物登记请求规整：{ itemNo, mass }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeItemInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const itemNo = typeof b.itemNo === 'string' ? b.itemNo.trim() : '';
  if (!itemNo) errors.push('实物编号不能为空');
  else if (itemNo.length > 100) errors.push('实物编号过长（最多 100 字符）');

  const mass = b.mass;
  if (typeof mass !== 'number' || !Number.isFinite(mass) || mass <= 0) {
    errors.push('mass 必须是有限正数（配重块质量规格，单位 g）');
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { itemNo, mass } };
}

// 领用请求规整：{ reservationId, itemNos: [实物编号...] }
// itemNos 规整为去重后按字典序排序的数组（重复编号为非法输入）。
export function normalizeCheckoutInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const reservationId = Number(b.reservationId);
  if (!isInt(reservationId) || reservationId <= 0) {
    errors.push('reservationId 必须是预约编号（正整数）');
  }

  const raw = b.itemNos;
  let itemNos = [];
  if (!Array.isArray(raw)) {
    errors.push('itemNos 必须是实物编号数组（按预约冻结占用量选取对应规格的实物）');
  } else {
    const seen = new Set();
    raw.forEach((v, i) => {
      const no = typeof v === 'string' ? v.trim() : '';
      if (!no) {
        errors.push(`第 ${i + 1} 项实物编号不能为空`);
        return;
      }
      if (seen.has(no)) {
        errors.push(`实物编号「${no}」重复选择（每件实物至多领用一次）`);
        return;
      }
      seen.add(no);
    });
    itemNos = [...seen].sort();
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { reservationId, itemNos } };
}

// 归还请求规整：{ returns: [{ itemNo, condition }] }
// condition 仅能为 intact（完好）/ damaged（损坏）；同一请求内编号不得重复。
export function normalizeReturnInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const raw = b.returns;
  const returns = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('returns 必须是非空数组（逐件标记完好 intact 或损坏 damaged）');
  }
  if (Array.isArray(raw)) {
    const seen = new Set();
    raw.forEach((entry, i) => {
      const e = entry && typeof entry === 'object' ? entry : {};
      const no = typeof e.itemNo === 'string' ? e.itemNo.trim() : '';
      if (!no) errors.push(`第 ${i + 1} 件归还：实物编号不能为空`);
      else if (seen.has(no)) errors.push(`实物编号「${no}」在本次归还中重复`);
      else seen.add(no);
      if (!RETURN_CONDITIONS.includes(e.condition)) {
        errors.push(
          `第 ${i + 1} 件归还：condition 必须是 ${RETURN_CONDITIONS.join(' / ')} 之一（完好或损坏）`,
        );
      }
      if (no && RETURN_CONDITIONS.includes(e.condition)) {
        returns.push({ itemNo: no, condition: e.condition });
      }
    });
  }
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { returns } };
}

// 按质量规格统计数量：[mass...] → [{mass, count}]（按质量升序）
export function countByMass(masses) {
  const counts = new Map();
  for (const m of masses) counts.set(m, (counts.get(m) || 0) + 1);
  return [...counts.entries()]
    .map(([mass, count]) => ({ mass, count }))
    .sort((a, b) => a.mass - b.mass);
}

// 所选实物是否按规格精确匹配预约冻结占用量。
// selected / usage 均为 [{mass, count}]；返回 { ok, mismatches }，
// mismatches 元素 { mass, required, selected }（按质量升序）。
export function matchUsage(selected, usage) {
  const selOf = new Map((selected || []).map((s) => [s.mass, s.count]));
  const reqOf = new Map((usage || []).map((u) => [u.mass, u.count]));
  const masses = [...new Set([...selOf.keys(), ...reqOf.keys()])].sort((a, b) => a - b);
  const mismatches = [];
  for (const mass of masses) {
    const required = reqOf.get(mass) || 0;
    const sel = selOf.get(mass) || 0;
    if (sel !== required) mismatches.push({ mass, required, selected: sel });
  }
  return { ok: mismatches.length === 0, mismatches };
}

// 库存缩减核对：有效实物数（未注销，含领出/损坏）不得超过调整后库存。
// activeCounts: [{mass, count}]（各规格有效实物数）
// newWeights:   [{mass, quantity}]（调整后的配重录入）
// 返回违例 [{mass, active, quantity}]（按质量升序）；空数组表示可放行。
export function findInventoryShortfalls(activeCounts, newWeights) {
  const qtyOf = new Map((newWeights || []).map((w) => [w.mass, w.quantity]));
  const out = [];
  for (const { mass, count } of activeCounts || []) {
    const quantity = qtyOf.has(mass) ? qtyOf.get(mass) : 0;
    if (quantity < count) out.push({ mass, active: count, quantity });
  }
  return out.sort((a, b) => a.mass - b.mass);
}

// 逾期判定：仍有未还件且当前时刻超过冻结预约终点（恰在终点不算逾期，
// 与运行超时判定 timedOut 的口径一致）。
export function isOverdue(unreturnedCount, reservationEndMs, nowMs) {
  return unreturnedCount > 0 && nowMs > reservationEndMs;
}
