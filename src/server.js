// Express 服务：REST API + 静态前端。
// 启动时自动建表；所有集合替换/发布均在 SQLite 事务中完成。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  loadData,
  currentHash,
  getDraft,
  saveDraft,
  listPublications,
  getPublication,
  insertPublication,
  getVerificationRow,
  getVerificationRowByPublication,
  createVerification,
  updateVerificationEntries,
  completeVerification,
  listVerificationRows,
  listReservationRows,
  getReservationRow,
  getReservationRowByBatch,
  listOverlappingActiveReservations,
  listActiveReservations,
  insertReservation,
  cancelReservation,
  listSuspensionRows,
  getSuspensionRow,
  listOverlappingActiveSuspensions,
  listActiveSuspensions,
  insertSuspension,
  revokeSuspension,
  listRunRows,
  getRunRow,
  getRunRowByRunNo,
  getRunRowByReservation,
  getActiveRunRowByDevice,
  insertRun,
  completeRun,
  listRunRowsByDevice,
  getDeviceLimitRow,
  listDeviceLimitRows,
  upsertDeviceLimit,
  deleteDeviceLimit,
  getMaintenanceRow,
  getMaintenanceRowByNo,
  listMaintenanceRows,
  getLatestMaintenanceRow,
  insertMaintenance,
  getCalibrationRow,
  getCalibrationRowByNo,
  listCalibrationRows,
  listCalibrationRowsByDevice,
  getLatestCalibrationRow,
  insertCalibration,
  getItemRow,
  getItemRowByNo,
  listItemRows,
  insertItem,
  deregisterItem,
  setItemStatus,
  countActiveItemsByMass,
  getCheckoutRow,
  getCheckoutRowByReservation,
  listCheckoutRows,
  insertCheckout,
  listCheckoutItemRows,
  insertCheckoutItem,
  getActiveCheckoutItemRow,
  markCheckoutItemReturned,
  getScheduleRow,
  getActiveScheduleRowByReservation,
  listScheduleRowsByReservation,
  listScheduleRows,
  listOverlappingActiveSchedulesByDevice,
  listActiveScheduleRows,
  insertSchedule,
  cancelSchedule,
  markScheduleReassigned,
  cancelActiveScheduleByReservation,
} from './db.js';
import { solve, verify, computeHash } from './solver.js';
import { normalizeEntries, measureProgress, verifyMeasurements } from './verify.js';
import {
  normalizeItemInput,
  normalizeCheckoutInput,
  normalizeReturnInput,
  countByMass,
  matchUsage,
  findInventoryShortfalls,
  isOverdue,
} from './checkout.js';
import {
  parseUtcMs,
  toIso,
  planUsage,
  checkCapacity,
  checkSuspension,
  buildSchedule,
} from './reserve.js';
import {
  normalizeStartInput,
  normalizeCompleteInput,
  isWithinReservation,
  isOverrun,
} from './run.js';
import {
  normalizeScheduleInput,
  intervalsOverlap,
  deviceOccupancySegments,
  isoOccupancySegments,
  findDeviceConflicts,
} from './schedule.js';
import {
  normalizeLimitInput,
  normalizeDeviceNo,
  normalizeMaintenanceInput,
  summarizeDevice,
} from './maintenance.js';
import {
  normalizeCalibrationInput,
  isCalibrationInPast,
  isLaterThanPrevious,
  checkCalibrationForRun,
} from './calibration.js';
import {
  ValidationError,
  ConflictError,
  validateConfig,
  validateTubes,
  validateWeights,
  validateExclusions,
  validateFixedSlots,
} from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---------- 状态 ----------

  app.get('/api/state', (req, res) => {
    const data = loadData(db);
    const hash = data ? computeHash(data) : null;
    const rawDraft = getDraft(db);
    let draft = null;
    if (rawDraft) {
      draft = {
        ...rawDraft,
        stale: hash === null || rawDraft.basisHash !== hash,
      };
    }
    const publications = listPublications(db).map((p) => ({
      ...p,
      usable: hash !== null && p.feasible && p.basisHash === hash,
    }));
    res.json({
      data,
      currentHash: hash,
      draft,
      publications,
      verifications: serializeVerifications(db, hash),
      reservations: listReservationRows(db).map((r) =>
        reservationView(r, hash, Date.now()),
      ),
      suspensions: listSuspensionRows(db).map((r) => suspensionView(r, Date.now())),
      runs: listRunRows(db).map((r) => runView(r, hash, Date.now())),
      devices: listDeviceViews(db),
      maintenances: listMaintenanceRows(db).map(maintenanceView),
      calibrations: listCalibrationRows(db).map((r) => calibrationView(r, Date.now())),
      items: listItemRows(db).map(itemView),
      checkouts: listCheckoutRows(db).map((r) => checkoutView(r, Date.now())),
      schedules: listScheduleRows(db).map((r) => scheduleView(r, Date.now())),
    });
  });

  // ---------- 转子配置（整体替换，事务） ----------

  app.put('/api/config', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateConfig(body, current);
        db.prepare('DELETE FROM hole_max').run();
        db.prepare('DELETE FROM config').run();
        db.prepare('INSERT INTO config (id, hole_count, tolerance) VALUES (1, ?, ?)').run(
          clean.holes,
          clean.tolerance,
        );
        const ins = db.prepare('INSERT INTO hole_max (hole, max_mass) VALUES (?, ?)');
        clean.holeMaxMass.forEach((m, h) => ins.run(h, m));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 离心管（整表替换，事务） ----------

  app.put('/api/tubes', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateTubes(body, N);
        // 替换离心管不得留下失效避邻对（对中管不再存在）：整次拒绝并保留原数据
        const ids = new Set(clean.map((t) => t.id));
        const dangling = (current ? current.exclusionPairs : []).filter(
          (p) => !ids.has(p.a) || !ids.has(p.b),
        );
        if (dangling.length > 0) {
          throw new ValidationError([
            '本次离心管替换会使现有避邻对失效（对中离心管不再存在），已拒绝并保留原数据：',
            ...dangling.map((p) => `避邻对「${p.a} ↔ ${p.b}」`),
            '请先解除相关避邻对，或保留对应离心管编号',
          ]);
        }
        // 替换离心管不得使现有固定孔位失效（管不再存在或孔位不再可用）：整次拒绝并保留原数据
        const newTubeMap = new Map(clean.map((t) => [t.id, t]));
        const brokenFixed = (current ? current.fixedSlots : []).filter((f) => {
          const t = newTubeMap.get(f.tube);
          return !t || !t.usableHoles.includes(f.hole);
        });
        if (brokenFixed.length > 0) {
          throw new ValidationError([
            '本次离心管替换会使现有固定孔位失效（管不再存在或孔位不再可用），已拒绝并保留原数据：',
            ...brokenFixed.map((f) => `固定孔位 ${f.hole}：离心管「${f.tube}」`),
            '请先解除相关固定孔位，或保留对应离心管编号与可用孔位',
          ]);
        }
        db.prepare('DELETE FROM tube_holes').run();
        db.prepare('DELETE FROM tubes').run();
        const insTube = db.prepare('INSERT INTO tubes (id, mass, ord) VALUES (?, ?, ?)');
        const insHole = db.prepare('INSERT INTO tube_holes (tube_id, hole) VALUES (?, ?)');
        clean.forEach((t, i) => {
          insTube.run(t.id, t.mass, i);
          for (const h of t.usableHoles) insHole.run(t.id, h);
        });
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 避邻对（整体替换，事务） ----------
  // 环形孔位中孔 i 与 (i+1) % N 相邻，同对两管不得相邻。
  // 未知编号、自配对、重复配对（含颠倒）任一出现即整次拒绝，不留下部分数据。

  app.get('/api/exclusions', (req, res) => {
    const data = loadData(db);
    res.json(data ? data.exclusionPairs : []);
  });

  app.put('/api/exclusions', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateExclusions(body, current);
        db.prepare('DELETE FROM exclusion_pairs').run();
        const ins = db.prepare(
          'INSERT INTO exclusion_pairs (tube_a, tube_b, ord) VALUES (?, ?, ?)',
        );
        clean.forEach((p, i) => ins.run(p.a, p.b, i));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 固定孔位（整体替换，事务） ----------
  // 实验人员预先摆好的离心管：按「管编号 + 孔位」整组保存/修改/清空。
  // 未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定，任一出现即整组拒绝，
  // 不留下部分数据（原绑定保留）。

  app.get('/api/fixed-slots', (req, res) => {
    const data = loadData(db);
    res.json(data ? data.fixedSlots : []);
  });

  app.put('/api/fixed-slots', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateFixedSlots(body, current);
        db.prepare('DELETE FROM fixed_slots').run();
        const ins = db.prepare(
          'INSERT INTO fixed_slots (tube_id, hole, ord) VALUES (?, ?, ?)',
        );
        clean.forEach((f, i) => ins.run(f.tube, f.hole, i));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块（整表替换，事务） ----------
  // 库存缩减若使某规格数量低于该规格有效实物数（已登记未注销，含领出与损坏），
  // 整次拒绝并保留原数据；既有领还历史不因库存调整而改写。

  app.put('/api/weights', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateWeights(body, N);
        // 库存缩减不得使有效实物数超过调整后库存：整次拒绝并保留原数据
        const shortfalls = findInventoryShortfalls(countActiveItemsByMass(db), clean);
        if (shortfalls.length > 0) {
          throw new ValidationError([
            '本次配重块录入调整会使有效实物数超过调整后库存，已拒绝并保留原数据：',
            ...shortfalls.map(
              (s) => `规格 ${s.mass} g：有效实物 ${s.active} 枚，调整后库存 ${s.quantity} 枚`,
            ),
            '请先注销多余的实物登记，或保留足够的库存数量',
          ]);
        }
        db.prepare('DELETE FROM weights').run();
        const ins = db.prepare('INSERT INTO weights (mass, quantity) VALUES (?, ?)');
        clean.forEach((w) => ins.run(w.mass, w.quantity));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 重算草稿 ----------

  app.post('/api/solve', (req, res, next) => {
    try {
      const data = loadData(db);
      if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
      const hash = computeHash(data);
      const result = solve(data);
      saveDraft(db, {
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
      res.json({
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 发布：事务内重读当前数据 → 求解 → 独立复核 → 冻结 ----------

  app.post('/api/publish', (req, res, next) => {
    try {
      let pubId;
      const tx = db.transaction(() => {
        const data = loadData(db);
        if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
        const hash = computeHash(data);
        const result = solve(data);
        if (!result.feasible) {
          throw new ValidationError([
            '当前数据不存在可行装载图，无法发布：',
            ...result.reasons,
          ]);
        }
        // 独立复核：不信任求解器输出本身
        const check = verify(data, result.arrangement);
        if (!check.ok) {
          throw new Error(`发布前独立复核失败：${check.errors.join('；')}`);
        }
        pubId = insertPublication(db, {
          basisHash: hash,
          feasible: true,
          weightCount: check.weightCount,
          diffSum: check.diffSum,
          config: data,
          result,
          reasons: [],
        });
      });
      tx();
      res.status(201).json(getPublication(db, pubId));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/publications', (req, res) => {
    const hash = currentHash(db);
    res.json(
      listPublications(db).map((p) => ({
        ...p,
        usable: hash !== null && p.feasible && p.basisHash === hash,
      })),
    );
  });

  app.get('/api/publications/:id', (req, res, next) => {
    const pub = getPublication(db, Number(req.params.id));
    if (!pub) return res.status(404).json({ error: '发布记录不存在' });
    const hash = currentHash(db);
    res.json({ ...pub, usable: pub.feasible && pub.basisHash === hash });
  });

  // ---------- 配重块时段预约 ----------
  //
  // 时段按左闭右开 [start, end) 计算；占用量按冻结装载图统计（各质量规格）。
  // 创建在单个事务内原子完成：重读冻结图、当前可选数量与重叠的生效中预约，
  // 任一时刻同规格预约总量不得超过当前录入数量；不足时返回冲突规格与时段，
  // 不产生任何部分占用。批次号为幂等键：同号同内容返回原记录（含已取消记录，
  // 不重新占用），同号不同内容拒绝。仅未开始的预约可取消，取消后历史保留。

  // 列表/详情视图：状态、阶段（相对当前时刻）、依据图当前可用性
  function reservationView(row, hash, nowMs) {
    const startMs = Date.parse(row.start_utc);
    const endMs = Date.parse(row.end_utc);
    const phase =
      row.status === 'cancelled'
        ? 'cancelled'
        : nowMs < startMs
          ? 'notStarted'
          : nowMs < endMs
            ? 'ongoing'
            : 'ended';
    return {
      id: row.id,
      batchNo: row.batch_no,
      publicationId: row.publication_id,
      startUtc: row.start_utc,
      endUtc: row.end_utc,
      usage: JSON.parse(row.usage_json),
      status: row.status,
      phase,
      cancellable: row.status === 'active' && nowMs < startMs,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      publicationUsable:
        hash !== null &&
        !!row.pub_basis_hash &&
        row.pub_basis_hash === hash &&
        !!row.pub_feasible,
    };
  }

  app.post('/api/reservations', (req, res, next) => {
    try {
      const body = req.body || {};
      const errors = [];
      const batchNo = typeof body.batchNo === 'string' ? body.batchNo.trim() : '';
      if (!batchNo) errors.push('批次号不能为空');
      else if (batchNo.length > 100) errors.push('批次号过长（最多 100 字符）');
      const publicationId = Number(body.publicationId);
      if (!Number.isInteger(publicationId) || publicationId <= 0) {
        errors.push('publicationId 必须是发布记录编号（正整数）');
      }
      const startMs = parseUtcMs(body.startUtc);
      const endMs = parseUtcMs(body.endUtc);
      if (startMs === null) errors.push('开始时间不是合法的 UTC 时间（ISO 8601）');
      if (endMs === null) errors.push('结束时间不是合法的 UTC 时间（ISO 8601）');
      if (startMs !== null && endMs !== null && !(startMs < endMs)) {
        errors.push('开始时间必须早于结束时间（时段按左闭右开 [start, end) 计算）');
      }
      if (errors.length) throw new ValidationError(errors);

      const startUtc = toIso(startMs);
      const endUtc = toIso(endMs);

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：同批次号重复提交——内容一致返回原记录（含已取消记录，不重新占用），
        // 内容不同拒绝。
        const existing = getReservationRowByBatch(db, batchNo);
        if (existing) {
          const same =
            existing.publication_id === publicationId &&
            existing.start_utc === startUtc &&
            existing.end_utc === endUtc;
          if (!same) {
            throw new ConflictError(
              [`批次号「${batchNo}」已被使用且预约内容不同，拒绝重复提交`],
              { existingId: existing.id },
            );
          }
          view = reservationView(existing, currentHash(db), Date.now());
          status = 200;
          return;
        }

        // 原子重读：冻结图、当前数量、重叠预约
        const pub = getPublication(db, publicationId);
        if (!pub) {
          throw new ValidationError([`发布记录 #${publicationId} 不存在（未知装载图）`]);
        }
        if (!pub.feasible) {
          throw new ValidationError([
            `发布记录 #${publicationId} 不含可行装载图，不能用于预约`,
          ]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），请选择仍可用的发布记录`,
          ]);
        }
        const data = loadData(db);
        const capacityOf = (mass) => {
          const w = data.weights.find((x) => x.mass === mass);
          return w ? w.quantity : 0;
        };
        const usage = planUsage(pub);
        const overlapping = listOverlappingActiveReservations(db, startUtc, endUtc).map(
          (r) => ({
            startMs: Date.parse(r.start_utc),
            endMs: Date.parse(r.end_utc),
            usage: JSON.parse(r.usage_json),
          }),
        );
        // 同时核对当前库存、重叠的生效停用：占用 + 停用任一时刻不得超过当前数量。
        // 停用允许与既有预约重叠，既有预约不因此改写。
        const suspOverlap = listOverlappingActiveSuspensions(db, startUtc, endUtc).map(
          (sp) => ({
            startMs: Date.parse(sp.start_utc),
            endMs: Date.parse(sp.end_utc),
            mass: sp.mass,
            count: sp.quantity,
          }),
        );
        const check = checkCapacity({
          usage,
          capacityOf,
          overlapping,
          suspensions: suspOverlap,
          startMs,
          endMs,
        });
        if (!check.ok) {
          const errs = ['当前可用数量不足（预约占用 + 生效停用超出当前库存），预约未产生任何占用：'];
          for (const c of check.conflicts) {
            for (const w of c.windows) {
              errs.push(
                `规格 ${c.mass} g：${w.start} 至 ${w.end} 已预约占用 ${w.used} 枚、` +
                  `临时停用 ${w.suspended} 枚，本次需 ${c.required} 枚，` +
                  `合计超出当前库存 ${c.capacity} 枚`,
              );
            }
          }
          throw new ConflictError(errs, { detail: { conflicts: check.conflicts } });
        }
        const row = insertReservation(db, {
          batchNo,
          publicationId,
          startUtc,
          endUtc,
          usage,
        });
        view = reservationView(row, hash, Date.now());
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/reservations', (req, res) => {
    const hash = currentHash(db);
    const nowMs = Date.now();
    res.json(listReservationRows(db).map((r) => reservationView(r, hash, nowMs)));
  });

  app.get('/api/reservations/:id', (req, res, next) => {
    const row = getReservationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '预约记录不存在' });
    res.json(reservationView(row, currentHash(db), Date.now()));
  });

  // 取消：仅未开始的预约可取消；已取消的预约幂等返回原记录（历史保留）
  app.post('/api/reservations/:id/cancel', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getReservationRow(db, id);
      if (!existed) return res.status(404).json({ error: '预约记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getReservationRow(db, id);
        if (row.status === 'cancelled') {
          view = reservationView(row, currentHash(db), Date.now());
          return;
        }
        const nowMs = Date.now();
        if (nowMs >= Date.parse(row.start_utc)) {
          throw new ConflictError([
            `预约 #${id} 已开始（${row.start_utc}），仅未开始的预约可取消`,
          ]);
        }
        const updated = cancelReservation(db, id, toIso(nowMs));
        if (!updated) throw new ConflictError([`预约 #${id} 状态已变化，请刷新后重试`]);
        // 同步取消其生效排班（预约未开始，排班必然也未开始；占用随级联释放，历史保留）
        const cancelledSchedule = cancelActiveScheduleByReservation(db, id, toIso(nowMs));
        view = reservationView(updated, currentHash(db), nowMs);
        if (cancelledSchedule) view.cancelledScheduleId = cancelledSchedule.id;
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // 预约日程：各质量规格在 [from, to) 内的分段占用/停用与「不足」区段。
  // segments.shortage 仅表示预约占用超过当前录入数量（字段含义不变）；
  // 另展示停用量（suspendedSegments）与「占用+停用」合计不足区段（combinedSegments）。
  // 既有预约/停用不因数量减少或图失效被改写。
  app.get('/api/schedule', (req, res, next) => {
    try {
      const active = listActiveReservations(db).map((r) => ({
        startMs: Date.parse(r.start_utc),
        endMs: Date.parse(r.end_utc),
        usage: JSON.parse(r.usage_json),
      }));
      const suspensions = listActiveSuspensions(db).map((sp) => ({
        startMs: Date.parse(sp.start_utc),
        endMs: Date.parse(sp.end_utc),
        mass: sp.mass,
        count: sp.quantity,
      }));
      const fromMs = parseUtcMs(req.query.from);
      const toMs = parseUtcMs(req.query.to);
      if (req.query.from !== undefined && fromMs === null) {
        throw new ValidationError(['from 不是合法的 UTC 时间（ISO 8601）']);
      }
      if (req.query.to !== undefined && toMs === null) {
        throw new ValidationError(['to 不是合法的 UTC 时间（ISO 8601）']);
      }
      const horizon = [
        ...active.map((r) => [r.startMs, r.endMs]),
        ...suspensions.map((sp) => [sp.startMs, sp.endMs]),
      ];
      const from =
        fromMs !== null
          ? fromMs
          : horizon.length
            ? Math.min(...horizon.map(([a]) => a))
            : Date.now();
      const to =
        toMs !== null
          ? toMs
          : horizon.length
            ? Math.max(...horizon.map(([, b]) => b))
            : from;
      if (!(from < to)) {
        if (from === to && horizon.length === 0) {
          return res.json({ from: toIso(from), to: toIso(to), specs: [] });
        }
        throw new ValidationError(['from 必须早于 to（时段按左闭右开 [from, to) 计算）']);
      }
      const data = loadData(db);
      const capacityOf = (mass) => {
        const w = data && data.weights.find((x) => x.mass === mass);
        return w ? w.quantity : 0;
      };
      const massSet = new Set();
      if (data) for (const w of data.weights) massSet.add(w.mass);
      for (const r of active) for (const u of r.usage) massSet.add(u.mass);
      for (const sp of suspensions) massSet.add(sp.mass);
      const specs = buildSchedule({
        reservations: active,
        suspensions,
        masses: [...massSet].sort((a, b) => a - b),
        capacityOf,
        fromMs: from,
        toMs: to,
      });
      res.json({ from: toIso(from), to: toIso(to), specs });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 预约设备排班 ----------
  //
  // 把生效预约安排到具体离心设备；时段沿用预约冻结的 UTC 左闭右开 [start, end)，
  // 不由调用方提供。每个预约至多一条生效排班：同预约同设备重复提交幂等返回原记录；
  // 同预约提交另一台设备为改派——仅允许在预约开始前且预约尚未用于运行时进行，
  // 在单事务内原子释放旧设备时段、占用新设备时段，新设备时段冲突则整事务回滚、
  // 保留原排班。已取消 / 已开始 / 已用于运行的预约不得改派或新排班。
  // 未开始且未运行的生效排班可取消（历史保留、释放占用）；预约取消时同步取消排班。
  // 运行开始时若预约有生效排班，提交的设备编号必须与其一致。

  function scheduleView(row, nowMs) {
    const startMs = Date.parse(row.start_utc);
    const endMs = Date.parse(row.end_utc);
    const phase =
      row.status !== 'active'
        ? row.status
        : nowMs < startMs
          ? 'notStarted'
          : nowMs < endMs
            ? 'ongoing'
            : 'ended';
    // 已用于运行（任意状态的运行；开始后该预约即被锁定）
    const usedByRun = !!getRunRowByReservation(db, row.reservation_id);
    const started = nowMs >= startMs;
    const active = row.status === 'active';
    return {
      id: row.id,
      reservationId: row.reservation_id,
      deviceNo: row.device_no,
      startUtc: row.start_utc,
      endUtc: row.end_utc,
      status: row.status,
      phase,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      replacedById: row.replaced_by_id,
      usedByRun,
      // 仅生效、未开始且预约未用于运行的排班可取消/改派
      cancellable: active && !started && !usedByRun,
      reassignable: active && !started && !usedByRun,
    };
  }

  // 把排班行转为占用扫描线输入
  function scheduleOverlapItems(rows) {
    return rows.map((r) => ({
      scheduleId: r.id,
      reservationId: r.reservation_id,
      startMs: Date.parse(r.start_utc),
      endMs: Date.parse(r.end_utc),
    }));
  }

  // 提交排班（新排班 / 幂等重放 / 改派同一入口）。
  // 201 新排班（含改派成功后产生的新记录）；200 同预约同设备幂等返回原记录；
  // 400 非法输入或未知预约；409 预约已取消/已开始/已用于运行，或新设备时段冲突。
  app.post('/api/schedules', (req, res, next) => {
    try {
      const { errors, clean } = normalizeScheduleInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { reservationId, deviceNo } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        const resRow = getReservationRow(db, reservationId);
        if (!resRow) {
          throw new ValidationError([`预约记录 #${reservationId} 不存在（未知预约编号）`]);
        }
        if (resRow.status !== 'active') {
          throw new ConflictError([
            `预约 #${reservationId} 已取消，不能安排设备排班（历史预约保留）`,
          ]);
        }
        const nowMs = Date.now();
        const startMs = Date.parse(resRow.start_utc);
        const runRow = getRunRowByReservation(db, reservationId);
        if (runRow) {
          throw new ConflictError([
            `预约 #${reservationId} 已用于运行 #${runRow.id}（运行编号「${runRow.run_no}」），` +
              '不能新排班或改派',
          ], { existingRunId: runRow.id });
        }
        if (nowMs >= startMs) {
          throw new ConflictError([
            `预约 #${reservationId} 已开始（${resRow.start_utc}），` +
              '已开始的预约不能新排班或改派',
          ]);
        }

        const existing = getActiveScheduleRowByReservation(db, reservationId);
        if (existing) {
          // 同预约同设备：幂等返回原排班（不重新核对占用，与其它幂等接口一致）
          if (existing.device_no === deviceNo) {
            view = scheduleView(existing, nowMs);
            status = 200;
            return;
          }
          // 改派：先探测新设备时段（冲突直接拒绝，旧排班不动）
          const overlap = listOverlappingActiveSchedulesByDevice(
            db,
            deviceNo,
            resRow.start_utc,
            resRow.end_utc,
          );
          if (overlap.length) {
            const probe = findDeviceConflicts(
              scheduleOverlapItems(overlap),
              startMs,
              Date.parse(resRow.end_utc),
            );
            throw new ConflictError(
              [
                `设备「${deviceNo}」在 ${resRow.start_utc} 至 ${resRow.end_utc} 已有生效排班占用` +
                  `（如排班 #${overlap[0].id}，预约 #${overlap[0].reservation_id}），` +
                  '时段冲突，改派未执行，原排班保留',
              ],
              {
                detail: {
                  deviceNo,
                  conflicts: probe.conflicts,
                },
              },
            );
          }
          // 原子改派（整事务回滚保证冲突时原排班保留）：
          //   1) 旧生效排班置为 reassigned，释放「每预约一条生效排班」唯一索引与旧设备；
          //   2) 插入新生效排班，触发器兜底新设备非重叠。
          const old = markScheduleReassigned(db, existing.id, null);
          if (!old) throw new ConflictError(['原排班状态已变化，请刷新后重试']);
          let row;
          try {
            row = insertSchedule(db, {
              reservationId,
              deviceNo,
              startUtc: resRow.start_utc,
              endUtc: resRow.end_utc,
            });
          } catch (dbErr) {
            throw new ConflictError(
              [
                `设备「${deviceNo}」时段冲突，改派未执行，原排班保留：${dbErr && dbErr.message}`,
              ],
              { detail: { deviceNo } },
            );
          }
          // 回填新排班指针（历史可追溯改派去向）
          db.prepare(
            `UPDATE schedules SET replaced_by_id = ? WHERE id = ? AND status = 'reassigned'`,
          ).run(row.id, existing.id);
          view = {
            ...scheduleView(row, nowMs),
            reassignedFrom: {
              scheduleId: existing.id,
              deviceNo: existing.device_no,
            },
          };
          status = 201;
          return;
        }

        // 新排班：核对设备时段（首尾相接允许）
        const overlap = listOverlappingActiveSchedulesByDevice(
          db,
          deviceNo,
          resRow.start_utc,
          resRow.end_utc,
        );
        if (overlap.length) {
          const probe = findDeviceConflicts(
            scheduleOverlapItems(overlap),
            startMs,
            Date.parse(resRow.end_utc),
          );
          throw new ConflictError(
            [
              `设备「${deviceNo}」在 ${resRow.start_utc} 至 ${resRow.end_utc} 已有生效排班占用` +
                `（如排班 #${overlap[0].id}，预约 #${overlap[0].reservation_id}），` +
                '同设备生效排班不能重叠（首尾相接允许），排班未产生',
            ],
            {
              detail: {
                deviceNo,
                conflicts: probe.conflicts,
              },
            },
          );
        }
        let row;
        try {
          row = insertSchedule(db, {
            reservationId,
            deviceNo,
            startUtc: resRow.start_utc,
            endUtc: resRow.end_utc,
          });
        } catch (dbErr) {
          throw new ConflictError(
            [`设备「${deviceNo}」时段冲突，排班未产生：${dbErr && dbErr.message}`],
            { detail: { deviceNo } },
          );
        }
        view = scheduleView(row, nowMs);
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  // 排班列表：默认仅生效排班；?status=active|cancelled|reassigned 指定状态，
  // ?all=1 返回全部（含历史）；?deviceNo= 按设备过滤（生效与历史均支持）；
  // ?reservationId= 按预约过滤（非法 id 400）。
  app.get('/api/schedules', (req, res, next) => {
    try {
      const nowMs = Date.now();
      let statusFilter = 'active';
      if (req.query.all !== undefined) statusFilter = null;
      if (req.query.status !== undefined) {
        if (!['active', 'cancelled', 'reassigned'].includes(req.query.status)) {
          throw new ValidationError([
            'status 仅支持 active / cancelled / reassigned（或用 all=1 查询全部）',
          ]);
        }
        statusFilter = req.query.status;
      }
      let deviceNo = null;
      if (req.query.deviceNo !== undefined) {
        const dev = normalizeDeviceNo(req.query.deviceNo);
        if (dev.errors.length) throw new ValidationError(dev.errors);
        deviceNo = dev.clean.deviceNo;
      }
      let reservationId = null;
      if (req.query.reservationId !== undefined) {
        reservationId = Number(req.query.reservationId);
        if (!Number.isInteger(reservationId) || reservationId <= 0) {
          throw new ValidationError(['reservationId 必须是预约编号（正整数）']);
        }
      }

      // 时间窗口参数（占用/冲突查询）
      const fromMs = parseUtcMs(req.query.from);
      const toMs = parseUtcMs(req.query.to);
      if (req.query.from !== undefined && fromMs === null) {
        throw new ValidationError(['from 不是合法的 UTC 时间（ISO 8601）']);
      }
      if (req.query.to !== undefined && toMs === null) {
        throw new ValidationError(['to 不是合法的 UTC 时间（ISO 8601）']);
      }
      if ((req.query.from === undefined) !== (req.query.to === undefined)) {
        throw new ValidationError(['from 与 to 必须同时提供（时段按左闭右开 [from, to) 计算）']);
      }

      let rows;
      if (reservationId !== null) {
        rows = listScheduleRowsByReservation(db, reservationId);
        if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
        if (deviceNo !== null) rows = rows.filter((r) => r.device_no === deviceNo);
      } else {
        rows = listScheduleRows(db, statusFilter);
        if (deviceNo !== null) rows = rows.filter((r) => r.device_no === deviceNo);
      }

      // 占用与冲突：按设备/预约过滤条件取生效排班（不受 status 过滤影响）
      const activeRows = listActiveScheduleRows(db, deviceNo).filter(
        (r) => reservationId === null || r.reservation_id === reservationId,
      );
      const activeItems = scheduleOverlapItems(activeRows);

      // 窗口缺省：覆盖过滤后的全部生效排班；无排班则为零长窗口（当前时刻）
      let from = fromMs;
      let to = toMs;
      if (from === null || to === null) {
        if (activeItems.length) {
          from = from !== null ? from : Math.min(...activeItems.map((i) => i.startMs));
          to = to !== null ? to : Math.max(...activeItems.map((i) => i.endMs));
        } else {
          from = to = nowMs;
        }
      }
      if (from > to) {
        throw new ValidationError(['from 不能晚于 to（时段按左闭右开 [from, to) 计算）']);
      }

      const clipped = activeItems
        .filter((i) => intervalsOverlap(i.startMs, i.endMs, from, to))
        .map((i) => ({ ...i }));

      // 按设备分组的占用分段
      const byDevice = new Map();
      for (const it of clipped) {
        const devRow = activeRows.find((r) => r.id === it.scheduleId);
        const key = devRow ? devRow.device_no : '';
        if (!byDevice.has(key)) byDevice.set(key, []);
        byDevice.get(key).push(it);
      }
      const devices = [...byDevice.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map((dev) => ({
          deviceNo: dev[0],
          segments: isoOccupancySegments(
            deviceOccupancySegments(dev[1], from, to),
          ),
        }));

      const payload = {
        from: toIso(from),
        to: toIso(to),
        devices,
        schedules: rows.map((r) => scheduleView(r, nowMs)),
      };

      // 探测：deviceNo + from + to 齐全时，给出该设备在窗口内是否可排与冲突明细
      if (
        deviceNo !== null &&
        req.query.from !== undefined &&
        req.query.to !== undefined &&
        from < to
      ) {
        const probeCandidates = listOverlappingActiveSchedulesByDevice(
          db,
          deviceNo,
          toIso(from),
          toIso(to),
        );
        const probe = findDeviceConflicts(
          scheduleOverlapItems(probeCandidates),
          from,
          to,
        );
        payload.probe = {
          deviceNo,
          available: probe.available,
          conflicts: probe.conflicts,
        };
      }

      res.json(payload);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/schedules/:id', (req, res, next) => {
    const row = getScheduleRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '排班记录不存在' });
    res.json(scheduleView(row, Date.now()));
  });

  // 取消排班：仅生效、未开始且预约尚未用于运行的排班可取消；
  // 已取消/已改派重复调用幂等返回原记录（历史保留）。
  app.post('/api/schedules/:id/cancel', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getScheduleRow(db, id);
      if (!existed) return res.status(404).json({ error: '排班记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getScheduleRow(db, id);
        if (row.status !== 'active') {
          view = scheduleView(row, Date.now());
          return;
        }
        const nowMs = Date.now();
        const runRow = getRunRowByReservation(db, row.reservation_id);
        if (runRow) {
          throw new ConflictError([
            `排班 #${id} 的预约 #${row.reservation_id} 已用于运行 #${runRow.id}` +
              `（运行编号「${runRow.run_no}」），不能取消`,
          ], { existingRunId: runRow.id });
        }
        if (nowMs >= Date.parse(row.start_utc)) {
          throw new ConflictError([
            `排班 #${id} 对应预约已开始（${row.start_utc}），不能取消`,
          ]);
        }
        const updated = cancelSchedule(db, id, toIso(nowMs));
        if (!updated) throw new ConflictError([`排班 #${id} 状态已变化，请刷新后重试`]);
        view = scheduleView(updated, nowMs);
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块临时停用 ----------
  //
  // 按质量规格登记停用数量、原因与 UTC 起止时间（左闭右开 [start, end)）。
  // 同规格重叠停用量累加；登记在单个事务内重读当前库存与重叠的生效停用，
  // 任一时刻停用量不得超过登记时该规格当前数量（停用可与既有预约重叠，
  // 既有预约不改写）。登记后即影响新预约：预约事务同时核对库存、停用与已有预约。
  // 仅未开始的停用可撤销，撤销留历史且释放后续容量。

  function suspensionView(row, nowMs) {
    const startMs = Date.parse(row.start_utc);
    const endMs = Date.parse(row.end_utc);
    const phase =
      row.status === 'revoked'
        ? 'revoked'
        : nowMs < startMs
          ? 'notStarted'
          : nowMs < endMs
            ? 'ongoing'
            : 'ended';
    return {
      id: row.id,
      mass: row.mass,
      quantity: row.quantity,
      reason: row.reason,
      startUtc: row.start_utc,
      endUtc: row.end_utc,
      status: row.status,
      phase,
      revocable: row.status === 'active' && nowMs < startMs,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  // 登记停用：非法时间/数量/未知规格 → 400；超量停用 → 409（附冲突规格与时段），
  // 任何失败均在事务内回滚，不留下记录。
  app.post('/api/suspensions', (req, res, next) => {
    try {
      const body = req.body || {};
      const errors = [];

      const mass = body.mass;
      if (typeof mass !== 'number' || !Number.isFinite(mass) || mass <= 0) {
        errors.push('mass 必须是有限正数（配重块质量规格，单位 g）');
      }
      const quantity = body.quantity;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push('停用数量必须是正整数');
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) errors.push('停用原因不能为空');
      else if (reason.length > 200) errors.push('停用原因过长（最多 200 字符）');

      const startMs = parseUtcMs(body.startUtc);
      const endMs = parseUtcMs(body.endUtc);
      if (startMs === null) errors.push('开始时间不是合法的 UTC 时间（ISO 8601）');
      if (endMs === null) errors.push('结束时间不是合法的 UTC 时间（ISO 8601）');
      if (startMs !== null && endMs !== null && !(startMs < endMs)) {
        errors.push('开始时间必须早于结束时间（时段按左闭右开 [start, end) 计算）');
      }
      if (errors.length) throw new ValidationError(errors);

      const startUtc = toIso(startMs);
      const endUtc = toIso(endMs);

      let view;
      const tx = db.transaction(() => {
        // 原子重读：当前库存（未知规格按当前录入判定）与重叠的生效停用
        const data = loadData(db);
        const spec = data && data.weights.find((w) => w.mass === mass);
        if (!spec) {
          throw new ValidationError([
            `未知质量规格 ${mass} g：当前配重块录入中不存在该规格，不能登记停用`,
          ]);
        }
        const overlapping = listOverlappingActiveSuspensions(db, startUtc, endUtc).map(
          (sp) => ({
            startMs: Date.parse(sp.start_utc),
            endMs: Date.parse(sp.end_utc),
            mass: sp.mass,
            count: sp.quantity,
          }),
        );
        const result = checkSuspension({
          mass,
          quantity,
          capacity: spec.quantity,
          overlapping,
          startMs,
          endMs,
        });
        if (!result.ok) {
          const c = result.conflict;
          const errs = ['停用量超出该规格当前数量，停用未登记：'];
          for (const w of c.windows) {
            errs.push(
              `规格 ${c.mass} g：${w.start} 至 ${w.end} 已停用 ${w.suspended} 枚，` +
                `本次再停用 ${c.required} 枚，超出当前库存 ${c.capacity} 枚`,
            );
          }
          throw new ConflictError(errs, { detail: { conflicts: [c] } });
        }
        const row = insertSuspension(db, {
          mass,
          quantity,
          reason,
          startUtc,
          endUtc,
        });
        view = suspensionView(row, Date.now());
      });
      tx();
      res.status(201).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/suspensions', (req, res) => {
    const nowMs = Date.now();
    res.json(listSuspensionRows(db).map((r) => suspensionView(r, nowMs)));
  });

  app.get('/api/suspensions/:id', (req, res) => {
    const row = getSuspensionRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '停用记录不存在' });
    res.json(suspensionView(row, Date.now()));
  });

  // 撤销：仅未开始的生效停用可撤销；已撤销幂等返回原记录（历史保留）；
  // 已开始/已结束 409。撤销立即释放后续容量（新预约可见）。
  app.post('/api/suspensions/:id/revoke', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getSuspensionRow(db, id);
      if (!existed) return res.status(404).json({ error: '停用记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getSuspensionRow(db, id);
        if (row.status === 'revoked') {
          view = suspensionView(row, Date.now());
          return;
        }
        const nowMs = Date.now();
        if (nowMs >= Date.parse(row.start_utc)) {
          throw new ConflictError([
            `停用 #${id} 已开始（${row.start_utc}），仅未开始的停用可撤销`,
          ]);
        }
        const updated = revokeSuspension(db, id, toIso(nowMs));
        if (!updated) throw new ConflictError([`停用 #${id} 状态已变化，请刷新后重试`]);
        view = suspensionView(updated, nowMs);
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 现场装载核验 ----------
  //
  // 流程：POST 选择可用发布记录建立草稿（同一发布记录只保留一份）→
  //       PUT 按孔位暂存实际物件编号/实测质量（携带 version 乐观锁，可反复暂存恢复）→
  //       POST .../complete 在单事务内重读发布快照与当前数据做最终判定。
  // 完成后结果冻结：重复完成不产生第二份结果，后续 PUT 被拒绝。

  // 列表项：进度 + 完成状态 + 发布记录当前可用性
  function verificationSummary(row, hash) {
    const pub = getPublication(db, row.publication_id);
    const entries = JSON.parse(row.entries_json);
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const completed = !!row.completed_at;
    return {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && !!row.pub_basis_hash && row.pub_basis_hash === hash,
      ...(completed
        ? { diffSum: row.diff_sum, massSum: row.mass_sum }
        : {}),
    };
  }

  function serializeVerifications(dbArg, hash) {
    return listVerificationRows(dbArg).map((row) => verificationSummary(row, hash));
  }

  // 详情（草稿或完成均返回；完成时附冻结的判定明细与冻结实测值）
  function verificationDetail(row) {
    const pub = getPublication(db, row.publication_id);
    const hash = currentHash(db);
    const entries = JSON.parse(row.entries_json);
    const completed = !!row.completed_at;
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const detail = {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && pub.feasible && pub.basisHash === hash,
      publication: {
        id: pub.id,
        createdAt: pub.createdAt,
        basisHash: pub.basisHash,
        config: pub.config,
        result: pub.result,
      },
      // 草稿阶段为当前暂存录入；完成后即为冻结实测值
      entries,
    };
    if (completed) {
      detail.diffSum = row.diff_sum;
      detail.massSum = row.mass_sum;
      detail.checks = JSON.parse(row.checks_json);
      detail.frozenEntries = JSON.parse(row.result_json);
    }
    return detail;
  }

  // 建立核验草稿：仅允许针对「当前仍可用」的可行发布记录
  app.post('/api/verifications', (req, res, next) => {
    try {
      const publicationId = Number(req.body && req.body.publicationId);
      if (!Number.isInteger(publicationId)) {
        throw new ValidationError(['publicationId 必须是发布记录编号（整数）']);
      }
      let detail;
      const tx = db.transaction(() => {
        const pub = getPublication(db, publicationId);
        if (!pub) throw new ValidationError(['发布记录不存在']);
        if (!pub.feasible) {
          throw new ValidationError([`发布记录 #${publicationId} 不含可行装载图，无法核验`]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），请选择仍可用的发布记录`,
          ]);
        }
        const existing = getVerificationRowByPublication(db, publicationId);
        if (existing) {
          throw new ConflictError(
            [
              existing.completed_at
                ? `发布记录 #${publicationId} 的核验已完成（结果已冻结），不能再建草稿`
                : `发布记录 #${publicationId} 已存在未完成核验，请直接恢复该草稿`,
            ],
            { existingId: existing.id, completed: !!existing.completed_at },
          );
        }
        const N = pub.config.holes;
        const emptyEntries = Array.from({ length: N }, (_, h) => ({
          hole: h,
          ref: '',
          mass: 0,
        }));
        const row = createVerification(db, publicationId, emptyEntries);
        detail = verificationDetail(row);
      });
      tx();
      res.status(201).json(detail);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/verifications', (req, res) => {
    res.json(serializeVerifications(db, currentHash(db)));
  });

  app.get('/api/verifications/:id', (req, res, next) => {
    const row = getVerificationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '核验记录不存在' });
    res.json(verificationDetail(row));
  });

  // 暂存：整表替换孔位录入；version 不匹配（他人已改）→ 409，拒绝覆盖
  app.put('/api/verifications/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const row0 = getVerificationRow(db, id);
      if (!row0) return res.status(404).json({ error: '核验记录不存在' });
      if (row0.completed_at) {
        throw new ConflictError(['核验已完成，实测值与判定结果已冻结，不能再修改']);
      }
      const expectedVersion = req.body && req.body.version;
      if (!Number.isInteger(expectedVersion)) {
        throw new ValidationError(['更新核验必须携带整数 version（用于防止覆盖他人修改）']);
      }
      if (expectedVersion !== row0.version) {
        throw new ConflictError(
          [`核验数据已被他人更新（当前版本 ${row0.version}），请先恢复最新草稿再提交`],
          { currentVersion: row0.version },
        );
      }
      const pub = getPublication(db, row0.publication_id);
      const { errors, entries } = normalizeEntries(req.body && req.body.entries, pub.config.holes);
      if (errors.length) throw new ValidationError(errors);

      const row = updateVerificationEntries(db, id, expectedVersion, entries);
      if (!row) {
        // 并发情况下版本/状态已被其他事务抢先改变
        const fresh = getVerificationRow(db, id);
        throw new ConflictError(
          [fresh && fresh.completed_at ? '核验刚被完成并冻结' : '核验版本已变化，请恢复最新草稿后再提交'],
          { currentVersion: fresh ? fresh.version : null },
        );
      }
      res.json(verificationDetail(row));
    } catch (e) {
      next(e);
    }
  });

  // 完成核验：同一事务内重读发布快照与当前数据并独立判定
  app.post('/api/verifications/:id/complete', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getVerificationRow(db, id);
      if (!existed) return res.status(404).json({ error: '核验记录不存在' });

      let status = 200;
      let detail;
      const tx = db.transaction(() => {
        const row = getVerificationRow(db, id);

        // 幂等：重复完成不产生第二份结果，直接返回冻结结果
        if (row.completed_at) {
          detail = verificationDetail(row);
          status = 200;
          return;
        }

        const pub = getPublication(db, row.publication_id);
        if (!pub || !pub.feasible) {
          throw new ValidationError([
            `发布记录 #${row.publication_id} 不含可行冻结装载图，无法完成核验`,
          ]);
        }
        // 发布记录仍可用于当前装载？
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${pub.id} 已不可用于当前装载（录入数据已变化），核验不能完成；草稿已保留`,
          ]);
        }

        // 重读当前暂存录入并做结构规整（不合法也保留草稿）
        const entries = JSON.parse(row.entries_json);
        const N = pub.config.holes;
        if (!Array.isArray(entries) || entries.length !== N) {
          throw new ValidationError(['暂存的核验录入与冻结图孔位数不符，草稿已保留']);
        }
        for (const e of entries) {
          const m = e && e.mass;
          const hasRef = e && typeof e.ref === 'string' && e.ref !== '';
          if (
            !e ||
            typeof m !== 'number' ||
            !Number.isFinite(m) ||
            (hasRef ? !(m > 0) : m !== 0)
          ) {
            throw new ValidationError([
              `孔 ${e ? e.hole : '?'} 录入不完整或质量非法：有物件时质量须为有限正数，空孔质量须为 0`,
            ]);
          }
        }

        // 独立判定：物件一致性、孔承重、对径容差（全部定位到孔位/孔对）
        const verdict = verifyMeasurements(
          { config: pub.config, result: pub.result },
          entries,
        );
        if (!verdict.ok) {
          throw new ValidationError(
            ['核验不通过，草稿已保留、未生成完成记录：', ...verdict.errors],
            { checks: verdict.checks, version: row.version },
          );
        }

        const updated = completeVerification(db, id, {
          checks: verdict.checks,
          diffSum: verdict.diffSum,
          massSum: verdict.massSum,
        });
        if (!updated) throw new Error('核验完成写入失败');
        detail = verificationDetail(updated);
        status = 201;
      });
      tx();
      res.status(status).json(detail);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 离心运行 ----------
  //
  // 实验人员以「唯一运行编号 + 非空设备编号 + 已完成核验编号 + 预约编号」开始一次
  // 离心运行；开始/结束时间由服务端记录。开始在单个事务内确认：
  //   1. 核验存在且已完成（核验结论已冻结）；
  //   2. 核验与生效预约指向同一张发布图；
  //   3. 发布图当前可用（数据指纹与当前录入一致、图可行）；
  //   4. 当前时刻处于预约左闭右开时段 [start, end)；
  //   5. 该预约未被其他运行使用（一个预约至多一次运行）；
  //   6. 同设备无进行中运行；
  //   7. 设备保养额度：设置了上限的设备，本累计周期已完结运行累计时长达到
  //      上限即拒绝（未设置上限的设备不核对，沿用原行为）；
  //   8. 设备校准：已有校准记录的设备，其最新一条结论须合格且到期时间不早于
  //      本次预约终点（到期恰等于终点视为足够）；无校准记录的设备沿用原规则。
  // 任一冲突即 409 回滚，不留记录。开始后冻结发布图（编号/指纹/快照）、核验结论、
  // 预约时段与校准依据。完结填写 completed/aborted，结束时间须晚于开始；超过预约
  // 终点仍如实完结并标记 timedOut，随即释放设备（部分唯一索引）；不改写预约。
  // 相同运行编号同开始内容重复提交返回原记录（200），异内容拒绝（409）；
  // 完结同状态重复提交返回原结果（200），异状态拒绝（409）。
  // 后续配置、库存或预约状态变化（含取消）均不改写已冻结的运行历史。

  function runView(row, hash, nowMs) {
    const ended = !!row.ended_at;
    const reservationEndMs = Date.parse(row.frozen_reservation_end_utc);
    const reservationStartMs = Date.parse(row.frozen_reservation_start_utc);
    const view = {
      id: row.id,
      runNo: row.run_no,
      deviceNo: row.device_no,
      verificationId: row.verification_id,
      reservationId: row.reservation_id,
      publicationId: row.publication_id,
      status: ended ? row.outcome : 'running',
      outcome: ended ? row.outcome : null,
      timedOut: !!row.timed_out,
      startUtc: row.start_utc,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      phase: ended
        ? 'ended'
        : nowMs >= reservationEndMs
          ? 'overrunning'
          : 'running',
      // 冻结依据（开始时写入，之后永不改写）
      frozenBasis: {
        publication: {
          id: row.publication_id,
          basisHash: row.frozen_basis_hash,
          feasible: !!row.frozen_pub_feasible,
          // 当前是否仍可用于装载（仅展示用，不影响冻结历史）
          currentlyUsable:
            hash !== null &&
            !!row.frozen_pub_feasible &&
            row.frozen_basis_hash === hash,
          config: JSON.parse(row.frozen_pub_config_json),
          result: JSON.parse(row.frozen_pub_result_json),
        },
        verification: {
          id: row.verification_id,
          passed: !!row.frozen_verification_passed,
          diffSum: row.frozen_verification_diff_sum,
          massSum: row.frozen_verification_mass_sum,
          checks: row.frozen_verification_checks_json
            ? JSON.parse(row.frozen_verification_checks_json)
            : null,
        },
        reservation: {
          id: row.reservation_id,
          startUtc: row.frozen_reservation_start_utc,
          endUtc: row.frozen_reservation_end_utc,
          usage: JSON.parse(row.frozen_reservation_usage_json),
        },
        // 冻结的校准依据（开始时该设备最新一条校准记录；null 表示当时无记录，
        // 无记录设备沿用原开始规则）。开始后新增校准记录不改写此处。
        calibration:
          row.frozen_calibration_id == null
            ? null
            : {
                id: row.frozen_calibration_id,
                calibNo: row.frozen_calibration_no,
                passed: !!row.frozen_calibration_passed,
                calibratedAt: row.frozen_calibration_calibrated_at,
                expiresAt: row.frozen_calibration_expires_at,
              },
        // 展示用：预约当前状态快照（active/cancelled）；预约被取消不改写运行历史
        reservationCurrentStatus: null,
      },
    };
    const resRow = getReservationRow(db, row.reservation_id);
    if (resRow) view.frozenBasis.reservationCurrentStatus = resRow.status;
    // 运行中：now 相对冻结预约窗口的标记（已结束以 timedOut 为准）
    if (!ended) {
      view.withinReservationWindow = isWithinReservation(
        reservationStartMs,
        reservationEndMs,
        nowMs,
      );
    }
    return view;
  }

  // 开始运行：非法输入 400；核验/预约不存在等引用错误 400；状态/冲突类 409。
  app.post('/api/runs', (req, res, next) => {
    try {
      const { errors, clean } = normalizeStartInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { runNo, deviceNo, verificationId, reservationId } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：相同运行编号——开始内容一致返回原记录，不一致拒绝
        const existing = getRunRowByRunNo(db, runNo);
        if (existing) {
          const same =
            existing.device_no === deviceNo &&
            existing.verification_id === verificationId &&
            existing.reservation_id === reservationId;
          if (!same) {
            throw new ConflictError(
              [`运行编号「${runNo}」已被使用且开始内容不同，拒绝重复提交`],
              { existingId: existing.id },
            );
          }
          view = runView(existing, currentHash(db), Date.now());
          status = 200;
          return;
        }

        // 1. 核验存在且已完成（核验结论已冻结）
        const verRow = getVerificationRow(db, verificationId);
        if (!verRow) {
          throw new ValidationError([`核验记录 #${verificationId} 不存在（未知核验编号）`]);
        }
        if (!verRow.completed_at) {
          throw new ConflictError([
            `核验 #${verificationId} 尚未完成（核验结论未冻结），不能开始运行；请先完成现场装载核验`,
          ]);
        }

        // 2. 预约存在且生效中；核验与预约指向同一张发布图
        const resRow = getReservationRow(db, reservationId);
        if (!resRow) {
          throw new ValidationError([`预约记录 #${reservationId} 不存在（未知预约编号）`]);
        }
        if (resRow.status !== 'active') {
          throw new ConflictError([
            `预约 #${reservationId} 已取消，不能用于开始离心运行（历史预约保留）`,
          ]);
        }
        if (resRow.publication_id !== verRow.publication_id) {
          throw new ConflictError([
            `核验 #${verificationId} 依据发布图 #${verRow.publication_id}，` +
              `而预约 #${reservationId} 依据发布图 #${resRow.publication_id}，` +
              '二者必须指向同一张发布图',
          ]);
        }

        // 2b. 预约有生效排班时，运行提交的设备编号必须与排班设备一致；
        //     无生效排班沿用原放行规则（不强制设备来源）。
        const scheduleRow = getActiveScheduleRowByReservation(db, reservationId);
        if (scheduleRow && scheduleRow.device_no !== deviceNo) {
          throw new ConflictError([
            `预约 #${reservationId} 已排班到设备「${scheduleRow.device_no}」（排班 #${scheduleRow.id}），` +
              `运行提交的设备「${deviceNo}」与排班不一致；运行必须在排班设备上开始`,
          ], { detail: { scheduleId: scheduleRow.id, scheduledDeviceNo: scheduleRow.device_no } });
        }

        // 3. 发布图存在、可行且当前可用（数据指纹与当前录入一致）
        const pub = getPublication(db, verRow.publication_id);
        if (!pub) {
          throw new ValidationError([
            `发布记录 #${verRow.publication_id} 不存在（核验/预约的依据图缺失）`,
          ]);
        }
        if (!pub.feasible) {
          throw new ConflictError([
            `发布记录 #${pub.id} 不含可行装载图，不能用于开始运行`,
          ]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ConflictError([
            `发布记录 #${pub.id} 当前不可用于装载（录入数据已变化），不能开始运行；` +
              '既有核验与预约保留不变',
          ]);
        }

        // 4. 当前时刻处于预约左闭右开时段
        const nowMs = Date.now();
        const startMs = Date.parse(resRow.start_utc);
        const endMs = Date.parse(resRow.end_utc);
        if (!isWithinReservation(startMs, endMs, nowMs)) {
          throw new ConflictError([
            nowMs < startMs
              ? `当前时刻早于预约开始时间 ${resRow.start_utc}，运行尚未到开始时段`
              : `当前时刻已到/超过预约终点 ${resRow.end_utc}（时段左闭右开），不能开始运行`,
          ]);
        }

        // 5. 预约未被其他运行使用（UNIQUE 索引兜底，此处给出可读冲突）
        const usedBy = getRunRowByReservation(db, reservationId);
        if (usedBy) {
          throw new ConflictError([
            `预约 #${reservationId} 已用于运行 #${usedBy.id}（运行编号「${usedBy.run_no}」），` +
              '一个预约至多开始一次运行',
          ], { existingRunId: usedBy.id });
        }

        // 6. 同设备无进行中运行（部分唯一索引兜底，此处给出可读冲突）
        const activeOnDevice = getActiveRunRowByDevice(db, deviceNo);
        if (activeOnDevice) {
          throw new ConflictError([
            `设备「${deviceNo}」存在进行中的运行 #${activeOnDevice.id}` +
              `（运行编号「${activeOnDevice.run_no}」），请先完结该运行再开始新运行`,
          ], { existingRunId: activeOnDevice.id });
        }

        // 7. 设备保养额度：设置了上限的设备，自最近一次保养后已完结运行累计时长
        //    达到上限即拒绝（须先登记保养开启新累计周期）；未设置上限的设备不核对，
        //    沿用原行为。进行中的运行不提前计入；既有运行编号的幂等重放在上方
        //    已先行返回，不受额度变化影响。
        const limitRow = getDeviceLimitRow(db, deviceNo);
        if (limitRow) {
          const dev = deviceView(db, deviceNo);
          if (dev.maintenanceDue) {
            throw new ConflictError(
              [
                `设备「${deviceNo}」自最近一次保养后已完结运行累计 ${dev.usedSeconds} 秒，` +
                  `已达到保养上限 ${dev.limitSeconds} 秒（剩余额度 ${Math.max(0, dev.remainingSeconds)} 秒），` +
                  '设备待保养：须先登记保养开启新累计周期，再开始新的运行',
              ],
              { detail: { device: dev } },
            );
          }
        }

        // 8. 设备校准：按该设备最新一条校准记录判定——结论须合格，且到期时间不早于
        //    本次预约终点（到期恰等于终点视为有效期足够）；无校准记录的设备沿用原
        //    开始规则。通过后校准依据随运行冻结；既有运行编号的幂等重放在上方已先行
        //    返回，不受之后新增/失效校准记录影响。
        const latestCalib = getLatestCalibrationRow(db, deviceNo);
        if (latestCalib) {
          const verdict = checkCalibrationForRun(
            { passed: !!latestCalib.passed, expiresUtc: latestCalib.expires_at },
            endMs,
          );
          const calibDetail = {
            id: latestCalib.id,
            calibNo: latestCalib.calib_no,
            calibratedAt: latestCalib.calibrated_at,
            expiresAt: latestCalib.expires_at,
            passed: !!latestCalib.passed,
          };
          if (verdict.reason === 'failed') {
            throw new ConflictError(
              [
                `设备「${deviceNo}」最新校准记录 #${latestCalib.id}（校准单号「${latestCalib.calib_no}」）` +
                  '结论为不合格，不能放行运行；请重新校准合格后再开始',
              ],
              { detail: { calibration: calibDetail, reason: 'failed' } },
            );
          }
          if (verdict.reason === 'expired') {
            throw new ConflictError(
              [
                `设备「${deviceNo}」最新校准记录 #${latestCalib.id}（校准单号「${latestCalib.calib_no}」）` +
                  `有效期至 ${latestCalib.expires_at}，早于本次预约终点 ${resRow.end_utc}，` +
                  '校准有效期不足，不能放行运行；请重新校准使其覆盖预约终点后再开始',
              ],
              { detail: { calibration: calibDetail, reason: 'expired' } },
            );
          }
        }

        const row = insertRun(db, {
          runNo,
          deviceNo,
          verificationId,
          reservationId,
          publicationId: pub.id,
          startUtc: toIso(nowMs),
          basisHash: pub.basisHash,
          pubFeasible: pub.feasible,
          pubConfig: pub.config,
          pubResult: pub.result,
          verificationPassed: true, // 完成核验方可到达此处；结论随运行冻结
          verificationDiffSum: verRow.diff_sum,
          verificationMassSum: verRow.mass_sum,
          verificationChecks: verRow.checks_json ? JSON.parse(verRow.checks_json) : null,
          reservationStartUtc: resRow.start_utc,
          reservationEndUtc: resRow.end_utc,
          reservationUsage: JSON.parse(resRow.usage_json),
          calibrationId: latestCalib ? latestCalib.id : null,
          calibrationNo: latestCalib ? latestCalib.calib_no : null,
          calibrationPassed: latestCalib ? !!latestCalib.passed : null,
          calibrationCalibratedAt: latestCalib ? latestCalib.calibrated_at : null,
          calibrationExpiresAt: latestCalib ? latestCalib.expires_at : null,
        });
        view = runView(row, hash, nowMs);
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/runs', (req, res) => {
    const hash = currentHash(db);
    const nowMs = Date.now();
    res.json(listRunRows(db).map((r) => runView(r, hash, nowMs)));
  });

  app.get('/api/runs/:id', (req, res, next) => {
    const row = getRunRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '运行记录不存在' });
    res.json(runView(row, currentHash(db), Date.now()));
  });

  // 完结运行：body.outcome = completed | aborted；结束时间由服务端记录且须晚于开始。
  // 超过预约终点仍如实完结并标记 timedOut；随即释放设备，不改写预约。
  // 重复提交：相同 outcome 返回原结果（200）；不同 outcome 拒绝（409）。
  app.post('/api/runs/:id/complete', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getRunRow(db, id);
      if (!existed) return res.status(404).json({ error: '运行记录不存在' });
      const { errors, clean } = normalizeCompleteInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { outcome } = clean;

      let status = 200;
      let view;
      const tx = db.transaction(() => {
        const row = getRunRow(db, id);
        if (row.ended_at) {
          // 幂等：同完结状态返回原结果；异状态拒绝
          if (row.outcome !== outcome) {
            throw new ConflictError([
              `运行 #${id} 已完结为「${row.outcome === 'completed' ? '完成' : '中止'}」，` +
                `不能改报为「${outcome === 'completed' ? '完成' : '中止'}」（完结状态已冻结）`,
            ], { existingOutcome: row.outcome });
          }
          view = runView(row, currentHash(db), Date.now());
          status = 200;
          return;
        }

        const endMs = Date.now();
        const startMs = Date.parse(row.start_utc);
        if (!(endMs > startMs)) {
          // 服务端时钟异常或与开始落在同一毫秒：拒绝并保持运行进行中
          throw new ConflictError([
            '结束时间未晚于开始时间（服务端时钟与开始时刻相同），请稍后重试完结',
          ]);
        }
        const timedOut = isOverrun(Date.parse(row.frozen_reservation_end_utc), endMs);
        const updated = completeRun(db, id, {
          outcome,
          endUtc: toIso(endMs),
          timedOut,
        });
        if (!updated) {
          // 并发：刚被其他请求完结
          const fresh = getRunRow(db, id);
          throw new ConflictError(
            [fresh ? `运行 #${id} 已被完结为「${fresh.outcome}」` : `运行 #${id} 状态已变化`],
            fresh ? { existingOutcome: fresh.outcome } : {},
          );
        }
        view = runView(updated, currentHash(db), endMs);
        status = 201;
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 设备保养 ----------
  //
  // 实验室按设备累计运行时长安排保养：
  //   - 可按设备编号设置正整数秒数上限（PUT .../limit 设置/调整，DELETE 清除）；
  //     调整仅影响后续开始判定，不改写运行及保养历史；未设置上限的设备沿用原行为；
  //   - 设备状态：自最近一次保养后已完结运行的累计时长、剩余额度与待保养状态
  //     （尚无保养记录时计入全部已完结运行；完成/中止均按服务端起止时间计入，
  //     进行中的运行不提前计入；越过上限如实呈现，剩余额度可为 0 或负数）；
  //   - 设备空闲时可凭「唯一保养单号 + 设备编号 + 原因」登记保养，登记时刻
  //     （服务端记录）开启新累计周期；同号同内容重试返回原记录（200），
  //     异内容或设备运行中拒绝（409）。

  // 单台设备保养状态视图（供状态查询与开始运行前的事务内核对共用）
  function deviceView(dbArg, deviceNo) {
    const limitRow = getDeviceLimitRow(dbArg, deviceNo);
    const lastMaint = getLatestMaintenanceRow(dbArg, deviceNo);
    const runs = listRunRowsByDevice(dbArg, deviceNo);
    const active = runs.find((r) => r.ended_at === null) || null;
    const summary = summarizeDevice({
      deviceNo,
      limitSeconds: limitRow ? limitRow.limit_seconds : null,
      runs: runs.map((r) => ({ startUtc: r.start_utc, endedAt: r.ended_at })),
      lastMaintenanceAt: lastMaint ? lastMaint.created_at : null,
    });
    const latestCalibRow = getLatestCalibrationRow(dbArg, deviceNo);
    const nowMs = Date.now();
    const latestCalibration = latestCalibRow
      ? calibrationView(latestCalibRow, nowMs)
      : null;
    return {
      ...summary,
      running: !!active,
      activeRunId: active ? active.id : null,
      activeRunNo: active ? active.run_no : null,
      maintenanceCount: dbArg
        .prepare('SELECT COUNT(*) AS c FROM maintenances WHERE device_no = ?')
        .get(deviceNo).c,
      lastMaintenanceAt: lastMaint ? lastMaint.created_at : null,
      // 该设备最新一条校准记录（无记录为 null）；calibrationValidNow 仅展示用，
      // 开始运行时按「到期不早于预约终点」在事务内重新判定。
      latestCalibration,
      calibrationCount: dbArg
        .prepare('SELECT COUNT(*) AS c FROM calibrations WHERE device_no = ?')
        .get(deviceNo).c,
    };
  }

  // 已知设备 = 出现过运行、设置过上限、登记过保养或有校准记录的设备编号并集
  function listDeviceViews(dbArg) {
    const deviceNos = new Set();
    for (const r of dbArg.prepare('SELECT DISTINCT device_no FROM runs').all()) {
      deviceNos.add(r.device_no);
    }
    for (const r of listDeviceLimitRows(dbArg)) deviceNos.add(r.device_no);
    for (const m of listMaintenanceRows(dbArg)) deviceNos.add(m.device_no);
    for (const c of listCalibrationRows(dbArg)) deviceNos.add(c.device_no);
    return [...deviceNos].sort().map((d) => deviceView(dbArg, d));
  }

  function deviceKnown(dbArg, deviceNo) {
    if (getDeviceLimitRow(dbArg, deviceNo)) return true;
    if (getLatestMaintenanceRow(dbArg, deviceNo)) return true;
    if (getLatestCalibrationRow(dbArg, deviceNo)) return true;
    return !!dbArg
      .prepare('SELECT 1 FROM runs WHERE device_no = ? LIMIT 1')
      .get(deviceNo);
  }

  function maintenanceView(row) {
    return {
      id: row.id,
      maintNo: row.maint_no,
      deviceNo: row.device_no,
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

  app.get('/api/devices', (req, res) => {
    res.json(listDeviceViews(db));
  });

  app.get('/api/devices/:deviceNo', (req, res) => {
    const deviceNo = String(req.params.deviceNo || '').trim();
    if (!deviceKnown(db, deviceNo)) {
      return res.status(404).json({ error: '设备不存在（无运行、上限、保养或校准记录）' });
    }
    res.json(deviceView(db, deviceNo));
  });

  // 设置/调整保养上限（正整数秒）：仅影响后续开始判定，不改写历史。
  app.put('/api/devices/:deviceNo/limit', (req, res, next) => {
    try {
      const dev = normalizeDeviceNo(req.params.deviceNo);
      if (dev.errors.length) throw new ValidationError(dev.errors);
      const { errors, clean } = normalizeLimitInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      upsertDeviceLimit(db, dev.clean.deviceNo, clean.limitSeconds);
      res.json(deviceView(db, dev.clean.deviceNo));
    } catch (e) {
      next(e);
    }
  });

  // 清除保养上限：设备回到「未设置上限」的原行为（幂等）。
  app.delete('/api/devices/:deviceNo/limit', (req, res, next) => {
    try {
      const dev = normalizeDeviceNo(req.params.deviceNo);
      if (dev.errors.length) throw new ValidationError(dev.errors);
      deleteDeviceLimit(db, dev.clean.deviceNo);
      res.json(deviceView(db, dev.clean.deviceNo));
    } catch (e) {
      next(e);
    }
  });

  // 登记保养：设备空闲时凭唯一保养单号开启新累计周期。
  // 同号同内容重试返回原记录（200）；异内容或设备运行中拒绝（409）。
  app.post('/api/maintenances', (req, res, next) => {
    try {
      const { errors, clean } = normalizeMaintenanceInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { maintNo, deviceNo, reason } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：同保养单号——内容一致返回原记录，不一致拒绝
        const existing = getMaintenanceRowByNo(db, maintNo);
        if (existing) {
          const same = existing.device_no === deviceNo && existing.reason === reason;
          if (!same) {
            throw new ConflictError(
              [`保养单号「${maintNo}」已被使用且登记内容不同，拒绝重复提交`],
              { existingId: existing.id },
            );
          }
          view = maintenanceView(existing);
          status = 200;
          return;
        }
        // 设备须空闲（无进行中运行）方可登记保养
        const active = getActiveRunRowByDevice(db, deviceNo);
        if (active) {
          throw new ConflictError(
            [
              `设备「${deviceNo}」存在进行中的运行 #${active.id}` +
                `（运行编号「${active.run_no}」），须待运行完结、设备空闲后方可登记保养`,
            ],
            { existingRunId: active.id },
          );
        }
        const row = insertMaintenance(db, {
          maintNo,
          deviceNo,
          reason,
          createdAt: toIso(Date.now()),
        });
        view = maintenanceView(row);
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/maintenances', (req, res) => {
    res.json(listMaintenanceRows(db).map(maintenanceView));
  });

  app.get('/api/maintenances/:id', (req, res) => {
    const row = getMaintenanceRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '保养记录不存在' });
    res.json(maintenanceView(row));
  });

  // ---------- 设备校准 ----------
  //
  // 实验室按设备校准记录决定运行能否放行：
  //   - 登记（只追加）：唯一校准单号 + 设备编号 + 校准时间 + 到期时间 + 合格/不合格；
  //     时间为 UTC，校准时间须早于到期时间且不得晚于服务端当前时刻，同设备校准时间
  //     须晚于上一条；
  //   - 同号同内容重复提交返回原记录（200），同号异内容拒绝（409）；
  //   - 无效输入不留校准记录（400）；同设备校准时间不晚于上一条为 409（不留记录）；
  //   - 开始运行时按设备最新一条校准记录在原事务内判定：结论合格且到期不早于本次
  //     预约终点方可放行；无校准记录的设备沿用原开始规则；
  //   - 开始成功即冻结校准依据；之后新增记录、运行超时或完结不改写历史。

  function calibrationView(row, nowMs) {
    const expiresMs = Date.parse(row.expires_at);
    return {
      id: row.id,
      calibNo: row.calib_no,
      deviceNo: row.device_no,
      calibratedAt: row.calibrated_at,
      expiresAt: row.expires_at,
      passed: !!row.passed,
      createdAt: row.created_at,
      // 展示用阶段：合格且到期时间晚于当前时刻为 valid；
      // 不合格为 failed；已到期（到期不晚于当前时刻）为 expired
      phase: !row.passed ? 'failed' : nowMs < expiresMs ? 'valid' : 'expired',
    };
  }

  // 登记校准：非法输入（空单号/设备、非法时间、校准不早于到期、结论非布尔、
  // 校准时间晚于当前时刻）→ 400；同设备校准时间不晚于上一条 → 409；
  // 同号异内容 → 409。任何失败均回滚，不留校准记录。
  app.post('/api/calibrations', (req, res, next) => {
    try {
      const { errors, clean } = normalizeCalibrationInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { calibNo, deviceNo, calibratedAt, expiresAt, calibratedAtMs, passed } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：同校准单号——内容一致返回原记录，不一致拒绝
        const existing = getCalibrationRowByNo(db, calibNo);
        if (existing) {
          const same =
            existing.device_no === deviceNo &&
            existing.calibrated_at === calibratedAt &&
            existing.expires_at === expiresAt &&
            !!existing.passed === passed;
          if (!same) {
            throw new ConflictError(
              [`校准单号「${calibNo}」已被使用且校准内容不同，拒绝重复提交`],
              { existingId: existing.id },
            );
          }
          view = calibrationView(existing, Date.now());
          status = 200;
          return;
        }

        // 校准时间不得晚于服务端当前时刻（事务内取时，避免时钟偏移）
        const nowMs = Date.now();
        if (!isCalibrationInPast(calibratedAtMs, nowMs)) {
          throw new ValidationError([
            `校准时间 ${calibratedAt} 晚于服务端当前时刻 ${toIso(nowMs)}，不能登记未来的校准`,
          ]);
        }

        // 同设备校准时间须晚于上一条（最新一条）校准记录
        const previous = getLatestCalibrationRow(db, deviceNo);
        if (previous && !isLaterThanPrevious(calibratedAtMs, Date.parse(previous.calibrated_at))) {
          throw new ConflictError(
            [
              `设备「${deviceNo}」已有校准记录 #${previous.id}（校准单号「${previous.calib_no}」，` +
                `校准时间 ${previous.calibrated_at}）：同设备新校准时间 ${calibratedAt} ` +
                '必须晚于上一条校准记录的校准时间',
            ],
            { existingId: previous.id },
          );
        }

        const row = insertCalibration(db, {
          calibNo,
          deviceNo,
          calibratedAt,
          expiresAt,
          passed,
        });
        view = calibrationView(row, nowMs);
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/calibrations', (req, res, next) => {
    try {
      const nowMs = Date.now();
      if (req.query.deviceNo !== undefined) {
        const dev = normalizeDeviceNo(req.query.deviceNo);
        if (dev.errors.length) throw new ValidationError(dev.errors);
        return res.json(
          listCalibrationRowsByDevice(db, dev.clean.deviceNo).map((r) =>
            calibrationView(r, nowMs),
          ),
        );
      }
      res.json(listCalibrationRows(db).map((r) => calibrationView(r, nowMs)));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/calibrations/:id', (req, res) => {
    const row = getCalibrationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '校准记录不存在' });
    res.json(calibrationView(row, Date.now()));
  });

  // ---------- 配重块实物领还 ----------
  //
  // 现场按实物编号追踪配重块领还：
  //   - 实物按现有质量规格登记唯一实物编号；同规格有效实物数（未注销，含领出
  //     与损坏）不得超过当前库存；已领出实物不能注销；库存缩减低于有效实物数
  //     时 PUT /api/weights 整次拒绝（见上）；
  //   - 领用凭生效预约在其左闭右开时段 [start, end) 内进行：所选实物按规格
  //     精确匹配预约冻结占用量，且均未被其他未归还领用占用；同一预约只可
  //     领用一次——同内容重试返回原单（200），异内容拒绝（409）；
  //   - 归还逐件标记完好/损坏：非本单实物及重复归还整次拒绝（409，不留部分
  //     记录）；损坏件不得再次领用；预约结束后仍可归还；
  //   - 查询展示未还件与逾期状态（当前时刻超过冻结预约终点且仍有未还件）；
  //   - 预约取消、库存调整及运行状态变化均不改写领还历史（领用单冻结预约
  //     时段与占用量快照，实物编号与规格随单冻结）。

  // 实物视图：状态 + 当前占用它的领用单（领出时）
  function itemView(row) {
    const active =
      row.status === 'checked_out' ? getActiveCheckoutItemRow(db, row.id) : null;
    return {
      id: row.id,
      itemNo: row.item_no,
      mass: row.mass,
      status: row.status,
      createdAt: row.created_at,
      deregisteredAt: row.deregistered_at,
      currentCheckoutId: active ? active.checkout_id : null,
    };
  }

  // 领用单视图：冻结时段/占用量 + 逐件明细 + 未还件与逾期状态
  function checkoutView(row, nowMs) {
    const items = listCheckoutItemRows(db, row.id).map((l) => ({
      itemId: l.item_id,
      itemNo: l.item_no,
      mass: l.mass,
      returned: !!l.returned_at,
      returnedAt: l.returned_at,
      condition: l.condition,
    }));
    const unreturned = items.filter((i) => !i.returned).map((i) => i.itemNo);
    return {
      id: row.id,
      reservationId: row.reservation_id,
      startUtc: row.reservation_start_utc,
      endUtc: row.reservation_end_utc,
      usage: JSON.parse(row.usage_json),
      checkedOutAt: row.checked_out_at,
      createdAt: row.created_at,
      status:
        unreturned.length === 0
          ? 'returned'
          : items.some((i) => i.returned)
            ? 'partial'
            : 'out',
      items,
      unreturned,
      unreturnedCount: unreturned.length,
      overdue: isOverdue(unreturned.length, Date.parse(row.reservation_end_utc), nowMs),
    };
  }

  // 登记实物：规格须为当前录入规格；同规格有效实物数不得超过当前库存。
  // 实物编号为幂等键：同号同内容返回原记录（200，含已注销记录，不重新生效），
  // 同号异内容拒绝（409）。
  app.post('/api/items', (req, res, next) => {
    try {
      const { errors, clean } = normalizeItemInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { itemNo, mass } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        const existing = getItemRowByNo(db, itemNo);
        if (existing) {
          if (existing.mass !== mass) {
            throw new ConflictError(
              [
                `实物编号「${itemNo}」已登记为规格 ${existing.mass} g，` +
                  '登记内容不同，拒绝重复提交',
              ],
              { existingId: existing.id },
            );
          }
          view = itemView(existing);
          status = 200;
          return;
        }
        // 原子重读：当前库存规格与有效实物数
        const data = loadData(db);
        const spec = data && data.weights.find((w) => w.mass === mass);
        if (!spec) {
          throw new ValidationError([
            `未知质量规格 ${mass} g：当前配重块录入中不存在该规格，不能登记实物`,
          ]);
        }
        const activeRow = countActiveItemsByMass(db).find((r) => r.mass === mass);
        const active = activeRow ? activeRow.count : 0;
        if (active + 1 > spec.quantity) {
          throw new ConflictError(
            [
              `规格 ${mass} g 有效实物数 ${active} 枚已达当前库存 ${spec.quantity} 枚，` +
                '不能再登记新实物；请先上调库存或注销闲置实物',
            ],
            { detail: { mass, capacity: spec.quantity, active } },
          );
        }
        view = itemView(insertItem(db, { itemNo, mass }));
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/items', (req, res, next) => {
    try {
      let rows = listItemRows(db);
      if (req.query.mass !== undefined) {
        const mass = Number(req.query.mass);
        if (!Number.isFinite(mass) || mass <= 0) {
          throw new ValidationError(['mass 查询参数必须是有限正数（质量规格，单位 g）']);
        }
        rows = rows.filter((r) => r.mass === mass);
      }
      res.json(rows.map(itemView));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/items/:id', (req, res) => {
    const row = getItemRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '实物记录不存在' });
    res.json(itemView(row));
  });

  // 注销：仅在库/损坏可注销；已领出实物不能注销（409，附占用领用单）；
  // 已注销重复调用幂等返回原记录（历史保留）。
  app.post('/api/items/:id/deregister', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getItemRow(db, id);
      if (!existed) return res.status(404).json({ error: '实物记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getItemRow(db, id);
        if (row.status === 'deregistered') {
          view = itemView(row);
          return;
        }
        if (row.status === 'checked_out') {
          const active = getActiveCheckoutItemRow(db, id);
          throw new ConflictError(
            [
              `实物「${row.item_no}」当前已领出（领用单 #${active ? active.checkout_id : '?'}），` +
                '已领出实物不能注销；请先归还',
            ],
            active ? { detail: { checkoutId: active.checkout_id } } : {},
          );
        }
        const updated = deregisterItem(db, id, toIso(Date.now()));
        if (!updated) throw new ConflictError([`实物 #${id} 状态已变化，请刷新后重试`]);
        view = itemView(updated);
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // 领用：生效预约 + 左闭右开时段内 + 所选实物按规格精确匹配冻结占用量 +
  // 实物均在库可领。同一预约只可领用一次：同内容重试返回原单（200），
  // 异内容拒绝（409）。任何冲突整体回滚，不留部分记录。
  app.post('/api/checkouts', (req, res, next) => {
    try {
      const { errors, clean } = normalizeCheckoutInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { reservationId, itemNos } = clean;

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：同一预约只可领用一次——同内容重试返回原单，异内容拒绝
        const existing = getCheckoutRowByReservation(db, reservationId);
        if (existing) {
          const existingNos = listCheckoutItemRows(db, existing.id)
            .map((l) => l.item_no)
            .sort();
          const same =
            existingNos.length === itemNos.length &&
            existingNos.every((no, i) => no === itemNos[i]);
          if (!same) {
            throw new ConflictError(
              [
                `预约 #${reservationId} 已领用（领用单 #${existing.id}），` +
                  '同一预约只可领用一次，且本次所选实物与原单不同，拒绝重复领用',
              ],
              { existingId: existing.id },
            );
          }
          view = checkoutView(existing, Date.now());
          status = 200;
          return;
        }

        const resRow = getReservationRow(db, reservationId);
        if (!resRow) {
          throw new ValidationError([`预约记录 #${reservationId} 不存在（未知预约编号）`]);
        }
        if (resRow.status !== 'active') {
          throw new ConflictError([
            `预约 #${reservationId} 已取消，不能用于领用配重块（历史预约保留）`,
          ]);
        }
        const nowMs = Date.now();
        const startMs = Date.parse(resRow.start_utc);
        const endMs = Date.parse(resRow.end_utc);
        if (!isWithinReservation(startMs, endMs, nowMs)) {
          throw new ConflictError([
            nowMs < startMs
              ? `当前时刻早于预约开始时间 ${resRow.start_utc}，尚未到领用时段`
              : `当前时刻已到/超过预约终点 ${resRow.end_utc}（时段左闭右开），不能领用`,
          ]);
        }

        // 实物核对：全部已登记（未知编号 400），且均在库可领（409 分类说明）
        const items = [];
        const unknown = [];
        for (const no of itemNos) {
          const row = getItemRowByNo(db, no);
          if (row) items.push(row);
          else unknown.push(no);
        }
        if (unknown.length) {
          throw new ValidationError([`实物编号未登记：${unknown.join('、')}`]);
        }
        const blocked = items.filter((it) => it.status !== 'available');
        if (blocked.length) {
          const detailItems = blocked.map((it) => {
            const active =
              it.status === 'checked_out' ? getActiveCheckoutItemRow(db, it.id) : null;
            return {
              itemNo: it.item_no,
              status: it.status,
              ...(active ? { checkoutId: active.checkout_id } : {}),
            };
          });
          const errs = ['所选实物不在可领用状态，领用未产生任何记录：'];
          for (const d of detailItems) {
            if (d.status === 'checked_out') {
              errs.push(`实物「${d.itemNo}」已被领用单 #${d.checkoutId} 占用（未归还）`);
            } else if (d.status === 'damaged') {
              errs.push(`实物「${d.itemNo}」已损坏（归还时报损），不得再次领用`);
            } else {
              errs.push(`实物「${d.itemNo}」已注销，不能领用`);
            }
          }
          throw new ConflictError(errs, { detail: { items: detailItems } });
        }

        // 所选实物按规格精确匹配预约冻结占用量
        const usage = JSON.parse(resRow.usage_json);
        const selected = countByMass(items.map((it) => it.mass));
        const match = matchUsage(selected, usage);
        if (!match.ok) {
          const errs = ['所选实物与预约冻结占用量不匹配（须按规格精确匹配），领用未产生任何记录：'];
          for (const m of match.mismatches) {
            errs.push(`规格 ${m.mass} g：预约需 ${m.required} 枚，本次选 ${m.selected} 枚`);
          }
          throw new ConflictError(errs, {
            detail: { required: usage, selected, mismatches: match.mismatches },
          });
        }

        const row = insertCheckout(db, {
          reservationId,
          usage,
          reservationStartUtc: resRow.start_utc,
          reservationEndUtc: resRow.end_utc,
          checkedOutAt: toIso(nowMs),
        });
        for (const it of items) {
          insertCheckoutItem(db, {
            checkoutId: row.id,
            itemId: it.id,
            itemNo: it.item_no,
            mass: it.mass,
          });
          setItemStatus(db, it.id, 'checked_out');
        }
        view = checkoutView(getCheckoutRow(db, row.id), nowMs);
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/checkouts', (req, res) => {
    const nowMs = Date.now();
    res.json(listCheckoutRows(db).map((r) => checkoutView(r, nowMs)));
  });

  app.get('/api/checkouts/:id', (req, res) => {
    const row = getCheckoutRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '领用单不存在' });
    res.json(checkoutView(row, Date.now()));
  });

  // 归还：逐件标记完好/损坏；非本单实物及重复归还整次拒绝（409，不留部分
  // 记录）；预约结束后仍可归还。归还后完好件回到在库、损坏件不得再次领用。
  app.post('/api/checkouts/:id/returns', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getCheckoutRow(db, id);
      if (!existed) return res.status(404).json({ error: '领用单不存在' });
      const { errors, clean } = normalizeReturnInput(req.body);
      if (errors.length) throw new ValidationError(errors);
      const { returns } = clean;

      let view;
      const tx = db.transaction(() => {
        const lines = listCheckoutItemRows(db, id);
        const byNo = new Map(lines.map((l) => [l.item_no, l]));
        const notMine = [];
        const already = [];
        for (const r of returns) {
          const line = byNo.get(r.itemNo);
          if (!line) notMine.push(r.itemNo);
          else if (line.returned_at) already.push(r.itemNo);
        }
        if (notMine.length || already.length) {
          const errs = ['归还整次拒绝（不留下部分记录）：'];
          if (notMine.length) errs.push(`实物不属于本领用单：${notMine.join('、')}`);
          if (already.length) errs.push(`实物已归还（重复归还）：${already.join('、')}`);
          throw new ConflictError(errs, {
            detail: { notMine, alreadyReturned: already },
          });
        }
        const nowIso = toIso(Date.now());
        for (const r of returns) {
          const line = byNo.get(r.itemNo);
          const marked = markCheckoutItemReturned(db, id, line.item_id, {
            condition: r.condition,
            returnedAt: nowIso,
          });
          if (!marked) throw new ConflictError([`实物「${r.itemNo}」状态已变化，请刷新后重试`]);
          setItemStatus(db, line.item_id, r.condition === 'damaged' ? 'damaged' : 'available');
        }
        view = checkoutView(getCheckoutRow(db, id), Date.now());
      });
      tx();
      res.status(201).json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 静态前端 ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- 错误处理 ----------

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res
        .status(400)
        .json({ error: err.message, errors: err.errors, ...(err.detail ? { detail: err.detail } : {}) });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({
        error: err.message,
        errors: err.errors,
        ...(err.existingId != null ? { existingId: err.existingId } : {}),
        ...(err.existingRunId != null ? { existingRunId: err.existingRunId } : {}),
        ...(err.existingOutcome != null ? { existingOutcome: err.existingOutcome } : {}),
        ...(err.completed != null ? { completed: err.completed } : {}),
        ...(err.currentVersion != null ? { currentVersion: err.currentVersion } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON', errors: ['请求体不是合法 JSON'] });
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误', errors: [String(err && err.message)] });
  });

  return app;
}

function start() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rotor.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const app = createApp(db);
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`离心转子配平服务已启动: http://localhost:${port}  (数据库: ${dbPath})`);
  });
}

// 仅在直接运行时监听端口（测试中 import 不触发）
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  start();
}
