// 预约排班（预约 → 具体离心设备）：输入规整、左闭右开时段重叠判定与设备占用
// 扫描线（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 排班沿用预约冻结的 UTC 左闭右开时段 [start, end)：首尾相接允许（end == start
//     不算冲突），真正相交（a.start < b.end 且 b.start < a.end）才冲突；
//   - 同设备同一时刻至多一条生效排班：由本模块判定、并由数据库部分唯一索引/触发器兜底；
//   - 取消排班只置 status/cancelled_at，历史保留，占用随即释放；改派将旧排班置为
//     reassigned，原子释放旧设备时段并占用新设备时段，冲突则整事务回滚保留原排班；
//   - 每个预约至多一条生效排班（active 部分唯一索引兜底）。

// 排班提交请求规整：{ reservationId, deviceNo }
// 返回 { errors, clean }；errors 非空时调用方按 400 拒绝。
export function normalizeScheduleInput(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : null;
  if (!b) {
    return { errors: ['请求体必须是对象'], clean: null };
  }
  const reservationId = Number(b.reservationId);
  if (!Number.isInteger(reservationId) || reservationId <= 0) {
    errors.push('reservationId 必须是预约编号（正整数）');
  }
  const deviceNo = typeof b.deviceNo === 'string' ? b.deviceNo.trim() : '';
  if (!deviceNo) errors.push('设备编号不能为空');
  else if (deviceNo.length > 100) errors.push('设备编号过长（最多 100 字符）');
  if (errors.length) return { errors, clean: null };
  return { errors, clean: { reservationId, deviceNo } };
}

// 左闭右开两时段是否重叠：相接（a.end == b.start 或 b.end == a.start）不算重叠。
export function intervalsOverlap(aStartMs, aEndMs, bStartMs, bEndMs) {
  return aStartMs < bEndMs && bStartMs < aEndMs;
}

// ---------- 设备占用扫描线 ----------
// 多条生效排班在查询窗口 [fromMs, toMs) 内的分段占用。
//   items: [{ scheduleId, reservationId, startMs, endMs }]（调用前不要求裁剪）
// 返回 [{ startMs, endMs, schedules:[{scheduleId,reservationId}] }]：
//   窗口内被一条或多条排班占用的连续时段；同一条排班在裁剪后保持单段（即使有
//   其他排班在其内部起止，该条排班仍连续占据整段——故同一条 id 的相邻段合并）。
//   首尾相接的不同排班各自成段（左闭右开：同时刻先结束后开始）。
export function deviceOccupancySegments(items, fromMs, toMs) {
  const events = [];
  for (const it of items || []) {
    const a = Math.max(it.startMs, fromMs);
    const b = Math.min(it.endMs, toMs);
    if (a < b) {
      events.push({ t: a, start: true, id: it.scheduleId, reservationId: it.reservationId });
      events.push({ t: b, start: false, id: it.scheduleId, reservationId: it.reservationId });
    }
  }
  // 同一时刻先处理离场（end）再处理入场（start）——左闭右开
  events.sort((x, y) => x.t - y.t || Number(x.start) - Number(y.start));

  const active = new Map(); // scheduleId -> { scheduleId, reservationId }
  const segments = [];
  let prev = fromMs;
  const flush = (t) => {
    if (t <= prev || active.size === 0) return;
    const last = segments[segments.length - 1];
    const snapshot = [...active.values()];
    // 与前段时段相接且占用集合相同（典型：同一条排班内部有别的排班起止）则合并
    if (last && last.endMs === prev && sameSet(last.schedules, snapshot)) {
      last.endMs = t;
    } else {
      segments.push({ startMs: prev, endMs: t, schedules: snapshot });
    }
  };
  for (const ev of events) {
    flush(ev.t);
    if (ev.start) active.set(ev.id, { scheduleId: ev.id, reservationId: ev.reservationId });
    else active.delete(ev.id);
    prev = ev.t;
  }
  flush(toMs);
  return segments;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((s) => s.scheduleId));
  return b.every((s) => ids.has(s.scheduleId));
}

// 时段占用明细输出（毫秒 → ISO）
export function isoOccupancySegments(segments) {
  return segments.map((seg) => ({
    start: new Date(seg.startMs).toISOString(),
    end: new Date(seg.endMs).toISOString(),
    schedules: seg.schedules.map((s) => ({
      scheduleId: s.scheduleId,
      reservationId: s.reservationId,
    })),
  }));
}

// 探测 [startMs,endMs) 与候选时段是否冲突；candidates 为生效排班
// [{scheduleId, reservationId, startMs, endMs}]（excludeScheduleId 指定的排班
// 视为不存在——改派时排除旧排班本身）。
// 返回 { available, conflicts }，conflicts 元素附裁剪后的重叠时段 overlapMs。
export function findDeviceConflicts(candidates, startMs, endMs, excludeScheduleId = null) {
  const conflicts = [];
  for (const c of candidates || []) {
    if (excludeScheduleId != null && c.scheduleId === excludeScheduleId) continue;
    if (!intervalsOverlap(startMs, endMs, c.startMs, c.endMs)) continue;
    const a = Math.max(startMs, c.startMs);
    const b = Math.min(endMs, c.endMs);
    conflicts.push({
      scheduleId: c.scheduleId,
      reservationId: c.reservationId,
      start: new Date(c.startMs).toISOString(),
      end: new Date(c.endMs).toISOString(),
      overlapStart: new Date(a).toISOString(),
      overlapEnd: new Date(b).toISOString(),
    });
  }
  return { available: conflicts.length === 0, conflicts };
}
