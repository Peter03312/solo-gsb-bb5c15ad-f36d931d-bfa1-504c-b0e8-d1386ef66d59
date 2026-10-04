// SQLite 数据访问层。
// 所有“多记录集合”的写入都在单个事务内整体替换：
// 任何校验错误都会 ROLLBACK，不会留下部分数据。

import Database from 'better-sqlite3';
import { computeHash } from './solver.js';

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureRunCalibrationColumns(db);
  return db;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hole_count INTEGER NOT NULL,
  tolerance REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hole_max (
  hole INTEGER PRIMARY KEY,
  max_mass REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tubes (
  id TEXT PRIMARY KEY,
  mass REAL NOT NULL,
  ord INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tube_holes (
  tube_id TEXT NOT NULL REFERENCES tubes(id) ON DELETE CASCADE,
  hole INTEGER NOT NULL,
  PRIMARY KEY (tube_id, hole)
);

CREATE TABLE IF NOT EXISTS weights (
  mass REAL PRIMARY KEY,
  quantity INTEGER NOT NULL
);

-- 离心管避邻对：同对两管不得占据环形相邻孔位（i 与 (i+1)%N 相邻）。
-- 整体替换维护；对内按编号字典序规范化（tube_a < tube_b），整体按 (tube_a, tube_b)
-- 排序存储，使规则作为无序集合拥有稳定的数据指纹。
CREATE TABLE IF NOT EXISTS exclusion_pairs (
  tube_a TEXT NOT NULL,
  tube_b TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (tube_a, tube_b)
);

-- 固定孔位：实验人员预先摆好的离心管（管编号 → 孔位）。
-- 整体替换维护；每管最多一个固定孔位、每孔最多一支固定管（主键/唯一约束兜底），
-- 按孔位升序存取，使绑定作为无序集合拥有稳定的数据指纹。
CREATE TABLE IF NOT EXISTS fixed_slots (
  tube_id TEXT NOT NULL PRIMARY KEY,
  hole INTEGER NOT NULL UNIQUE,
  ord INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  reasons TEXT,
  result_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  basis_hash TEXT NOT NULL,
  feasible INTEGER NOT NULL,
  weight_count INTEGER,
  diff_sum REAL,
  config_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  reasons TEXT
);

-- 配重块时段预约：batch_no 为幂等键（同批次号重复提交返回原记录、内容不同拒绝），
-- 取消仅置 status/cancelled_at，历史保留且批次号仍被占用（同号重试不重新占用）。
-- usage_json 为按冻结装载图统计的各质量规格占用量 [{mass, count}]，冻结不变。
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,
  publication_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  FOREIGN KEY (publication_id) REFERENCES publications(id)
);

-- 配重块临时停用：按质量规格记录停用数量、原因与 UTC 起止时间（左闭右开）。
-- 登记时已核对「任一时刻同规格重叠停用量 + 本数量不超过当时登记数量」，
-- 之后录入数量变化不改写既有停用；撤销仅置 status/revoked_at，历史保留。
-- mass 不设外键（规格允许从录入中删除，历史停用与历史预约一样保留）。
CREATE TABLE IF NOT EXISTS suspensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mass REAL NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- 现场装载核验：一条发布记录至多一份（草稿或完成），UNIQUE 约束兜底。
-- version 为乐观锁：每次暂存自增，更新须携带旧版本以防覆盖他人修改。
-- 完成后 completed_at 置位、result_json 冻结，之后草稿与完成结果均不可改写。
CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  entries_json TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT,
  checks_json TEXT,
  diff_sum REAL,
  mass_sum REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (publication_id) REFERENCES publications(id)
);

-- 离心运行：以唯一运行编号开始；开始/结束时间由服务端记录。
-- 开始事务内确认核验通过、核验与预约同指一张发布图、发布图当前可用、
-- 当前时刻位于预约左闭右开时段、预约未被其他运行占用、同设备无进行中运行，
-- 通过后冻结发布图编号/数据指纹、核验编号与结论、预约编号与时段。
-- 完结仅置 outcome/ended_at/timed_out；不改写预约、不回填任何冻结列。
-- reservation_id 全局唯一：一个预约至多被一条运行使用；
-- 同设备「进行中（ended_at IS NULL）」至多一条由部分唯一索引兜底。
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_no TEXT NOT NULL UNIQUE,
  device_no TEXT NOT NULL,
  verification_id INTEGER NOT NULL,
  reservation_id INTEGER NOT NULL,
  publication_id INTEGER NOT NULL,
  start_utc TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed', 'aborted')),
  timed_out INTEGER NOT NULL DEFAULT 0,
  -- 冻结依据（开始时写入，之后永不改写）
  frozen_basis_hash TEXT NOT NULL,
  frozen_pub_feasible INTEGER NOT NULL,
  frozen_pub_config_json TEXT NOT NULL,
  frozen_pub_result_json TEXT NOT NULL,
  frozen_verification_passed INTEGER NOT NULL,
  frozen_verification_diff_sum REAL,
  frozen_verification_mass_sum REAL,
  frozen_verification_checks_json TEXT,
  frozen_reservation_start_utc TEXT NOT NULL,
  frozen_reservation_end_utc TEXT NOT NULL,
  frozen_reservation_usage_json TEXT NOT NULL,
  -- 冻结的校准依据（开始时写入，之后永不改写）；
  -- NULL 表示开始时该设备无校准记录（无记录设备沿用原开始规则）。
  frozen_calibration_id INTEGER,
  frozen_calibration_no TEXT,
  frozen_calibration_passed INTEGER,
  frozen_calibration_calibrated_at TEXT,
  frozen_calibration_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (verification_id) REFERENCES verifications(id),
  FOREIGN KEY (reservation_id) REFERENCES reservations(id),
  FOREIGN KEY (publication_id) REFERENCES publications(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_reservation
  ON runs (reservation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_device_active
  ON runs (device_no) WHERE ended_at IS NULL;

-- 设备保养上限：按设备编号设置正整数秒数上限。
-- 仅影响后续开始运行的判定；不改写运行及保养历史；未设置上限的设备沿用原行为。
CREATE TABLE IF NOT EXISTS device_limits (
  device_no TEXT PRIMARY KEY,
  limit_seconds INTEGER NOT NULL CHECK (limit_seconds > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 设备保养登记：maint_no 为幂等键（同号同内容重复提交返回原记录，异内容拒绝）。
-- 登记时刻（created_at，服务端记录，毫秒精度 ISO）开启新的累计周期：
-- 之后统计「自最近一次保养后已完结运行的累计时长」以该时刻为周期起点。
-- 登记时要求设备空闲（无进行中运行）；登记后历史保留，不因上限调整而改写。
CREATE TABLE IF NOT EXISTS maintenances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  maint_no TEXT NOT NULL UNIQUE,
  device_no TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 设备校准记录：calib_no 为幂等键（同号同内容重复提交返回原记录，异内容拒绝）。
-- 记录只追加（无修改/删除接口）；按设备「最新一条」判定运行能否放行。
-- 登记时已在单事务内核对：
--   * 校准时间早于到期时间、校准时间不晚于服务端当前时刻（规整/事务内校验）；
--   * 同设备校准时间严格晚于上一条（最新一条）校准记录。
-- 通过后结论与有效期随开始运行冻结（runs.frozen_calibration_*），之后新增记录、
-- 运行超时或完结都不改写已冻结的校准依据。
CREATE TABLE IF NOT EXISTS calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  calib_no TEXT NOT NULL UNIQUE,
  device_no TEXT NOT NULL,
  calibrated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calibrations_device
  ON calibrations (device_no, calibrated_at, id);

-- 配重块实物：按现有质量规格登记唯一实物编号（item_no 全局唯一，为幂等键：
-- 同号同内容重复登记返回原记录，异内容拒绝；已注销编号仍被占用）。
-- status：available（在库可领）/ checked_out（领出未还）/ damaged（归还报损，
-- 不得再次领用）/ deregistered（已注销）。有效实物 = 未注销（含领出与损坏）；
-- 同规格有效实物数不得超过当前库存（登记时与库存缩减时均核对）。
CREATE TABLE IF NOT EXISTS weight_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_no TEXT NOT NULL UNIQUE,
  mass REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'checked_out', 'damaged', 'deregistered')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deregistered_at TEXT
);

-- 配重块领用单：凭生效预约在其左闭右开时段内领用；一个预约至多领用一次
-- （reservation_id UNIQUE 兜底；同内容重试返回原单，异内容拒绝）。
-- 冻结预约时段与占用量快照：之后预约取消、库存调整或运行状态变化均不改写
-- 领还历史；逾期判定按冻结终点计算。
CREATE TABLE IF NOT EXISTS checkouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL UNIQUE,
  usage_json TEXT NOT NULL,
  reservation_start_utc TEXT NOT NULL,
  reservation_end_utc TEXT NOT NULL,
  checked_out_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (reservation_id) REFERENCES reservations(id)
);

-- 领用明细：每件实物一行（实物编号与规格随单冻结）；归还时逐件标记
-- 完好（intact）/损坏（damaged）。同一实物至多处于一张未归还领用单
-- （部分唯一索引兜底）；归还整单原子完成，冲突不留部分记录。
CREATE TABLE IF NOT EXISTS checkout_items (
  checkout_id INTEGER NOT NULL REFERENCES checkouts(id),
  item_id INTEGER NOT NULL REFERENCES weight_items(id),
  item_no TEXT NOT NULL,
  mass REAL NOT NULL,
  returned_at TEXT,
  condition TEXT CHECK (condition IS NULL OR condition IN ('intact', 'damaged')),
  PRIMARY KEY (checkout_id, item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_items_active_item
  ON checkout_items (item_id) WHERE returned_at IS NULL;

-- 预约设备排班：把生效预约安排到具体离心设备，时段沿用预约冻结的 UTC
-- 左闭右开 [start_utc, end_utc)（start/end 冗余自预约，改派/取消均不改写预约）。
--   active     生效排班，占用该设备时段；
--   cancelled  未开始且未用于运行时取消（历史保留，释放占用）；
--   reassigned 改派到其他设备后旧排班（历史保留，释放旧设备时段），
--              replaced_by_id 指向新生效排班。
-- 一个预约至多一条生效排班（部分唯一索引兜底；改派在单事务内先置旧排班为
-- reassigned 再插入新排班）；同设备生效排班不得重叠（左闭右开，首尾相接允许）
-- 由应用事务判定，并由下面两个触发器兜底。
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  device_no TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'reassigned')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  replaced_by_id INTEGER,
  FOREIGN KEY (reservation_id) REFERENCES reservations(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_active_reservation
  ON schedules (reservation_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_schedules_active_device
  ON schedules (device_no, start_utc, end_utc) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_schedules_reservation
  ON schedules (reservation_id, id);

-- 同设备生效排班左闭右开不得重叠：r.start < new.end AND new.start < r.end
-- （相接 r.end == new.start 或 new.end == r.start 均不触发）。INSERT/UPDATE 均兜底。
CREATE TRIGGER IF NOT EXISTS trg_schedules_no_overlap_insert
BEFORE INSERT ON schedules
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM schedules
   WHERE status = 'active'
     AND device_no = NEW.device_no
     AND start_utc < NEW.end_utc
     AND NEW.start_utc < end_utc
)
BEGIN
  SELECT RAISE(ABORT, '设备排班时段冲突（同设备生效排班不得重叠，首尾相接允许）');
END;

CREATE TRIGGER IF NOT EXISTS trg_schedules_no_overlap_update
BEFORE UPDATE OF device_no, start_utc, end_utc, status ON schedules
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM schedules
   WHERE status = 'active'
     AND id != NEW.id
     AND device_no = NEW.device_no
     AND start_utc < NEW.end_utc
     AND NEW.start_utc < end_utc
)
BEGIN
  SELECT RAISE(ABORT, '设备排班时段冲突（同设备生效排班不得重叠，首尾相接允许）');
END;

-- 找时段预约：提交批次号、发布图、正整数秒时长、UTC 搜索窗口与候选设备编号，
-- 系统在窗口内找能完整容纳该时长的最早起点（并列取设备编号字典序最小），
-- 并在同一事务内原子生成共用时段的预约与设备排班。
-- batch_no 为整次操作的幂等键：同号同请求重试返回本表冻结的原结果（即使
-- 预约之后被取消或资源变化），异请求拒绝；本操作生成的预约占用同一
-- batch_no 命名空间（与既有普通预约撞号同样拒绝）。
-- 请求与结果均随记录冻结：device_nos_json 为规范化（字典序排序）后的候选
-- 设备编号，device_no/start_utc/end_utc/usage_json 为当选结果快照。
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,
  publication_id INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
  window_start_utc TEXT NOT NULL,
  window_end_utc TEXT NOT NULL,
  device_nos_json TEXT NOT NULL,
  device_no TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  reservation_id INTEGER NOT NULL,
  schedule_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (reservation_id) REFERENCES reservations(id),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id)
);
`;

// 既有库平滑升级：runs 增加开始时冻结的校准依据列（老库无此列时补齐；
// 历史运行该列为 NULL——冻结时设备无校准记录，与「无记录沿用原规则」一致）。
const RUN_FROZEN_CALIBRATION_COLUMNS = [
  'frozen_calibration_id INTEGER',
  'frozen_calibration_no TEXT',
  'frozen_calibration_passed INTEGER',
  'frozen_calibration_calibrated_at TEXT',
  'frozen_calibration_expires_at TEXT',
];

// 幂等补列（SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，先查 PRAGMA）。
function ensureRunCalibrationColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name));
  for (const ddl of RUN_FROZEN_CALIBRATION_COLUMNS) {
    const name = ddl.split(' ')[0];
    if (!existing.has(name)) {
      db.prepare(`ALTER TABLE runs ADD COLUMN ${ddl}`).run();
    }
  }
}

// ---------- 读取 ----------

export function loadData(db) {
  const cfg = db.prepare('SELECT hole_count, tolerance FROM config WHERE id = 1').get();
  if (!cfg) return null;
  const N = cfg.hole_count;
  const hmRows = db.prepare('SELECT hole, max_mass FROM hole_max').all();
  const holeMaxMass = new Array(N).fill(null);
  for (const r of hmRows) {
    if (r.hole >= 0 && r.hole < N) holeMaxMass[r.hole] = r.max_mass;
  }
  const tubes = db
    .prepare('SELECT id, mass, ord FROM tubes ORDER BY ord, rowid')
    .all()
    .map((t) => ({
      id: t.id,
      mass: t.mass,
      usableHoles: db
        .prepare('SELECT hole FROM tube_holes WHERE tube_id = ? ORDER BY hole')
        .pluck()
        .all(t.id),
    }));
  const weights = db
    .prepare('SELECT mass, quantity FROM weights ORDER BY mass')
    .all()
    .map((w) => ({ mass: w.mass, quantity: w.quantity }));
  const exclusionPairs = db
    .prepare('SELECT tube_a, tube_b FROM exclusion_pairs ORDER BY tube_a, tube_b')
    .all()
    .map((r) => ({ a: r.tube_a, b: r.tube_b }));
  const fixedSlots = db
    .prepare('SELECT tube_id, hole FROM fixed_slots ORDER BY hole, tube_id')
    .all()
    .map((r) => ({ tube: r.tube_id, hole: r.hole }));
  return {
    holes: N,
    tolerance: cfg.tolerance,
    holeMaxMass,
    tubes,
    weights,
    exclusionPairs,
    fixedSlots,
  };
}

export function currentHash(db) {
  const data = loadData(db);
  return data ? computeHash(data) : null;
}

export function getDraft(db) {
  const row = db.prepare('SELECT * FROM drafts WHERE id = 1').get();
  if (!row) return null;
  return {
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    result: JSON.parse(row.result_json),
    computedAt: row.computed_at,
    stale: false, // 由调用方结合当前哈希填写
  };
}

export function listPublications(db) {
  return db
    .prepare(
      `SELECT id, created_at, basis_hash, feasible, weight_count, diff_sum, reasons
       FROM publications ORDER BY id DESC`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      basisHash: r.basis_hash,
      feasible: !!r.feasible,
      weightCount: r.weight_count,
      diffSum: r.diff_sum,
      reasons: r.reasons ? JSON.parse(r.reasons) : [],
    }));
}

export function getPublication(db, id) {
  const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    basisHash: row.basis_hash,
    feasible: !!row.feasible,
    weightCount: row.weight_count,
    diffSum: row.diff_sum,
    reasons: row.reasons ? JSON.parse(row.reasons) : [],
    config: JSON.parse(row.config_json),
    result: JSON.parse(row.result_json),
  };
}

// ---------- 草稿 ----------

export function saveDraft(db, { basisHash, feasible, reasons, result }) {
  db.prepare(
    `INSERT INTO drafts (id, basis_hash, feasible, reasons, result_json)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       basis_hash = excluded.basis_hash,
       feasible = excluded.feasible,
       reasons = excluded.reasons,
       result_json = excluded.result_json,
       computed_at = datetime('now')`,
  ).run(basisHash, feasible ? 1 : 0, JSON.stringify(reasons ?? []), JSON.stringify(result));
}

// ---------- 发布（由 server 在单事务内调用） ----------

export function insertPublication(
  db,
  { basisHash, feasible, weightCount, diffSum, config, result, reasons },
) {
  const info = db
    .prepare(
      `INSERT INTO publications
         (basis_hash, feasible, weight_count, diff_sum, config_json, result_json, reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      basisHash,
      feasible ? 1 : 0,
      weightCount ?? null,
      diffSum ?? null,
      JSON.stringify(config),
      JSON.stringify(result),
      JSON.stringify(reasons ?? []),
    );
  return info.lastInsertRowid;
}

// ---------- 现场核验 ----------

export function getVerificationRow(db, id) {
  return db.prepare('SELECT * FROM verifications WHERE id = ?').get(id);
}

export function getVerificationRowByPublication(db, publicationId) {
  return db
    .prepare('SELECT * FROM verifications WHERE publication_id = ?')
    .get(publicationId);
}

export function createVerification(db, publicationId, entries) {
  const info = db
    .prepare(
      `INSERT INTO verifications (publication_id, version, entries_json)
       VALUES (?, 1, ?)`,
    )
    .run(publicationId, JSON.stringify(entries));
  return getVerificationRow(db, info.lastInsertRowid);
}

// 乐观锁更新：仅当草稿未完成且 version 匹配时写入；返回 null 表示未命中。
export function updateVerificationEntries(db, id, expectedVersion, entries) {
  const info = db
    .prepare(
      `UPDATE verifications
         SET entries_json = ?, version = version + 1, updated_at = datetime('now')
       WHERE id = ? AND version = ? AND completed_at IS NULL`,
    )
    .run(JSON.stringify(entries), id, expectedVersion);
  return info.changes === 1 ? getVerificationRow(db, id) : null;
}

// 完成：冻结判定结果（同一事务内由 server 重读快照并判定后调用）。
export function completeVerification(db, id, { checks, diffSum, massSum }) {
  const info = db
    .prepare(
      `UPDATE verifications
         SET completed_at = datetime('now'),
             result_json = entries_json,
             checks_json = ?,
             diff_sum = ?,
             mass_sum = ?,
             updated_at = datetime('now')
       WHERE id = ? AND completed_at IS NULL`,
    )
    .run(JSON.stringify(checks), diffSum, massSum, id);
  return info.changes === 1 ? getVerificationRow(db, id) : null;
}

// 核验列表（连发布表取冻结依据与发布编号）
export function listReservationRows(db) {
  return db
    .prepare(
      `SELECT r.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM reservations r
         JOIN publications p ON p.id = r.publication_id
        ORDER BY r.start_utc, r.id`,
    )
    .all();
}

export function getReservationRow(db, id) {
  return db
    .prepare(
      `SELECT r.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM reservations r
         JOIN publications p ON p.id = r.publication_id
        WHERE r.id = ?`,
    )
    .get(id);
}

export function getReservationRowByBatch(db, batchNo) {
  return db
    .prepare(
      `SELECT r.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM reservations r
         JOIN publications p ON p.id = r.publication_id
        WHERE r.batch_no = ?`,
    )
    .get(batchNo);
}

// 与 [startIso, endIso) 重叠的生效中预约（左闭右开：r.start < end 且 start < r.end）
export function listOverlappingActiveReservations(db, startIso, endIso) {
  return db
    .prepare(
      `SELECT * FROM reservations
        WHERE status = 'active' AND start_utc < ? AND ? < end_utc`,
    )
    .all(endIso, startIso);
}

export function listActiveReservations(db) {
  return db.prepare(`SELECT * FROM reservations WHERE status = 'active'`).all();
}

export function insertReservation(db, { batchNo, publicationId, startUtc, endUtc, usage }) {
  const info = db
    .prepare(
      `INSERT INTO reservations (batch_no, publication_id, start_utc, end_utc, usage_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(batchNo, publicationId, startUtc, endUtc, JSON.stringify(usage));
  return getReservationRow(db, info.lastInsertRowid);
}

// 取消：仅生效中且未开始的预约可取消（条件更新，未命中返回 null）。
export function cancelReservation(db, id, nowIso) {
  const info = db
    .prepare(
      `UPDATE reservations
          SET status = 'cancelled', cancelled_at = ?
        WHERE id = ? AND status = 'active' AND start_utc > ?`,
    )
    .run(nowIso, id, nowIso);
  return info.changes === 1 ? getReservationRow(db, id) : null;
}

// ---------- 配重块临时停用（由 server 在单事务内调用） ----------

export function listSuspensionRows(db) {
  return db
    .prepare(`SELECT * FROM suspensions ORDER BY start_utc, id`)
    .all();
}

export function getSuspensionRow(db, id) {
  return db.prepare('SELECT * FROM suspensions WHERE id = ?').get(id);
}

// 与 [startIso, endIso) 重叠的生效中停用（左闭右开：start < end 且自身 start < endIso）
export function listOverlappingActiveSuspensions(db, startIso, endIso) {
  return db
    .prepare(
      `SELECT * FROM suspensions
        WHERE status = 'active' AND start_utc < ? AND ? < end_utc`,
    )
    .all(endIso, startIso);
}

export function listActiveSuspensions(db) {
  return db.prepare(`SELECT * FROM suspensions WHERE status = 'active'`).all();
}

export function insertSuspension(db, { mass, quantity, reason, startUtc, endUtc }) {
  const info = db
    .prepare(
      `INSERT INTO suspensions (mass, quantity, reason, start_utc, end_utc)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(mass, quantity, reason, startUtc, endUtc);
  return getSuspensionRow(db, info.lastInsertRowid);
}

// 撤销：仅生效中且未开始的停用可撤销（条件更新，未命中返回 null）。
export function revokeSuspension(db, id, nowIso) {
  const info = db
    .prepare(
      `UPDATE suspensions
          SET status = 'revoked', revoked_at = ?
        WHERE id = ? AND status = 'active' AND start_utc > ?`,
    )
    .run(nowIso, id, nowIso);
  return info.changes === 1 ? getSuspensionRow(db, id) : null;
}

// 核验列表（连发布表取冻结依据与发布编号）
export function listVerificationRows(db) {
  return db
    .prepare(
      `SELECT v.*, p.basis_hash AS pub_basis_hash, p.feasible AS pub_feasible
         FROM verifications v
         JOIN publications p ON p.id = v.publication_id
        ORDER BY v.id DESC`,
    )
    .all();
}

// ---------- 离心运行（由 server 在单事务内调用） ----------

export function getRunRow(db, id) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

export function getRunRowByRunNo(db, runNo) {
  return db.prepare('SELECT * FROM runs WHERE run_no = ?').get(runNo);
}

export function getRunRowByReservation(db, reservationId) {
  return db.prepare('SELECT * FROM runs WHERE reservation_id = ?').get(reservationId);
}

export function getActiveRunRowByDevice(db, deviceNo) {
  return db
    .prepare('SELECT * FROM runs WHERE device_no = ? AND ended_at IS NULL')
    .get(deviceNo);
}

export function listRunRows(db) {
  return db.prepare('SELECT * FROM runs ORDER BY start_utc DESC, id DESC').all();
}

// 开始运行：冻结依据快照在同一事务内写入（basis 字段由 server 收集）。
export function insertRun(db, b) {
  const info = db
    .prepare(
      `INSERT INTO runs (
         run_no, device_no, verification_id, reservation_id, publication_id,
         start_utc,
         frozen_basis_hash, frozen_pub_feasible,
         frozen_pub_config_json, frozen_pub_result_json,
         frozen_verification_passed, frozen_verification_diff_sum,
         frozen_verification_mass_sum, frozen_verification_checks_json,
         frozen_reservation_start_utc, frozen_reservation_end_utc,
         frozen_reservation_usage_json,
         frozen_calibration_id, frozen_calibration_no, frozen_calibration_passed,
         frozen_calibration_calibrated_at, frozen_calibration_expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.runNo,
      b.deviceNo,
      b.verificationId,
      b.reservationId,
      b.publicationId,
      b.startUtc,
      b.basisHash,
      b.pubFeasible ? 1 : 0,
      JSON.stringify(b.pubConfig),
      JSON.stringify(b.pubResult),
      b.verificationPassed ? 1 : 0,
      b.verificationDiffSum ?? null,
      b.verificationMassSum ?? null,
      b.verificationChecks === undefined
        ? null
        : JSON.stringify(b.verificationChecks ?? null),
      b.reservationStartUtc,
      b.reservationEndUtc,
      JSON.stringify(b.reservationUsage ?? []),
      b.calibrationId ?? null,
      b.calibrationNo ?? null,
      b.calibrationPassed === undefined || b.calibrationPassed === null
        ? null
        : b.calibrationPassed
          ? 1
          : 0,
      b.calibrationCalibratedAt ?? null,
      b.calibrationExpiresAt ?? null,
    );
  return getRunRow(db, info.lastInsertRowid);
}

// 完结：条件更新保证幂等与状态约束（仅进行中可完结）。
export function completeRun(db, id, { outcome, endUtc, timedOut }) {
  const info = db
    .prepare(
      `UPDATE runs
          SET outcome = ?, ended_at = ?, timed_out = ?
        WHERE id = ? AND ended_at IS NULL AND outcome IS NULL`,
    )
    .run(outcome, endUtc, timedOut ? 1 : 0, id);
  return info.changes === 1 ? getRunRow(db, id) : null;
}

// 指定设备的全部运行（开始/完结时间用于保养累计统计）。
export function listRunRowsByDevice(db, deviceNo) {
  return db
    .prepare('SELECT * FROM runs WHERE device_no = ? ORDER BY start_utc, id')
    .all(deviceNo);
}

// ---------- 设备保养上限与保养登记（由 server 在单事务内调用） ----------

export function getDeviceLimitRow(db, deviceNo) {
  return db
    .prepare('SELECT * FROM device_limits WHERE device_no = ?')
    .get(deviceNo);
}

export function listDeviceLimitRows(db) {
  return db.prepare('SELECT * FROM device_limits ORDER BY device_no').all();
}

// 设置/调整上限：仅影响后续开始判定，不改写运行及保养历史。
export function upsertDeviceLimit(db, deviceNo, limitSeconds) {
  db.prepare(
    `INSERT INTO device_limits (device_no, limit_seconds, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(device_no) DO UPDATE SET
       limit_seconds = excluded.limit_seconds,
       updated_at = datetime('now')`,
  ).run(deviceNo, limitSeconds);
  return getDeviceLimitRow(db, deviceNo);
}

// 清除上限：设备回到「未设置上限」的原行为（幂等，未设置时亦为成功）。
export function deleteDeviceLimit(db, deviceNo) {
  db.prepare('DELETE FROM device_limits WHERE device_no = ?').run(deviceNo);
}

export function getMaintenanceRow(db, id) {
  return db.prepare('SELECT * FROM maintenances WHERE id = ?').get(id);
}

export function getMaintenanceRowByNo(db, maintNo) {
  return db.prepare('SELECT * FROM maintenances WHERE maint_no = ?').get(maintNo);
}

export function listMaintenanceRows(db) {
  return db.prepare('SELECT * FROM maintenances ORDER BY created_at DESC, id DESC').all();
}

export function listMaintenanceRowsByDevice(db, deviceNo) {
  return db
    .prepare('SELECT * FROM maintenances WHERE device_no = ? ORDER BY created_at, id')
    .all(deviceNo);
}

// 最近一次保养（当前累计周期的起点）；无保养记录时返回 undefined。
export function getLatestMaintenanceRow(db, deviceNo) {
  return db
    .prepare(
      `SELECT * FROM maintenances
        WHERE device_no = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(deviceNo);
}

// 登记保养：createdAt 由服务端以毫秒精度 ISO 写入（新累计周期起点）。
export function insertMaintenance(db, { maintNo, deviceNo, reason, createdAt }) {
  const info = db
    .prepare(
      `INSERT INTO maintenances (maint_no, device_no, reason, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(maintNo, deviceNo, reason, createdAt);
  return getMaintenanceRow(db, info.lastInsertRowid);
}

// ---------- 设备校准（只追加；由 server 在单事务内调用） ----------

export function getCalibrationRow(db, id) {
  return db.prepare('SELECT * FROM calibrations WHERE id = ?').get(id);
}

export function getCalibrationRowByNo(db, calibNo) {
  return db.prepare('SELECT * FROM calibrations WHERE calib_no = ?').get(calibNo);
}

// 全部校准记录（列表：最新在前）
export function listCalibrationRows(db) {
  return db
    .prepare('SELECT * FROM calibrations ORDER BY calibrated_at DESC, id DESC')
    .all();
}

// 指定设备的校准记录（最新在前）；deviceNo 省略时取全部设备。
export function listCalibrationRowsByDevice(db, deviceNo) {
  return db
    .prepare(
      `SELECT * FROM calibrations
        WHERE device_no = ?
        ORDER BY calibrated_at DESC, id DESC`,
    )
    .all(deviceNo);
}

// 指定设备最新一条校准记录（按校准时间，再以 id 决胜）；无记录返回 undefined。
export function getLatestCalibrationRow(db, deviceNo) {
  return db
    .prepare(
      `SELECT * FROM calibrations
        WHERE device_no = ?
        ORDER BY calibrated_at DESC, id DESC LIMIT 1`,
    )
    .get(deviceNo);
}

// 追加校准记录（登记校验由 server 在同事务内完成）。
export function insertCalibration(db, { calibNo, deviceNo, calibratedAt, expiresAt, passed }) {
  const info = db
    .prepare(
      `INSERT INTO calibrations (calib_no, device_no, calibrated_at, expires_at, passed)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(calibNo, deviceNo, calibratedAt, expiresAt, passed ? 1 : 0);
  return getCalibrationRow(db, info.lastInsertRowid);
}

// ---------- 配重块实物与领还（由 server 在单事务内调用） ----------

export function getItemRow(db, id) {
  return db.prepare('SELECT * FROM weight_items WHERE id = ?').get(id);
}

export function getItemRowByNo(db, itemNo) {
  return db.prepare('SELECT * FROM weight_items WHERE item_no = ?').get(itemNo);
}

export function listItemRows(db) {
  return db.prepare('SELECT * FROM weight_items ORDER BY mass, item_no, id').all();
}

// 登记实物：规格存在性与「有效实物数 ≤ 当前库存」由 server 在同事务内核验。
export function insertItem(db, { itemNo, mass }) {
  const info = db
    .prepare('INSERT INTO weight_items (item_no, mass) VALUES (?, ?)')
    .run(itemNo, mass);
  return getItemRow(db, info.lastInsertRowid);
}

// 注销：仅在库 / 损坏状态可注销（已领出实物不能注销；条件更新，未命中返回 null）。
export function deregisterItem(db, id, nowIso) {
  const info = db
    .prepare(
      `UPDATE weight_items
          SET status = 'deregistered', deregistered_at = ?
        WHERE id = ? AND status IN ('available', 'damaged')`,
    )
    .run(nowIso, id);
  return info.changes === 1 ? getItemRow(db, id) : null;
}

// 状态流转（领出 / 归还完好 / 归还报损），由 server 在同事务内调用。
export function setItemStatus(db, id, status) {
  db.prepare('UPDATE weight_items SET status = ? WHERE id = ?').run(status, id);
}

// 各规格有效实物数（未注销：含在库、领出、损坏）——库存缩减核对用。
export function countActiveItemsByMass(db) {
  return db
    .prepare(
      `SELECT mass, COUNT(*) AS count FROM weight_items
        WHERE status != 'deregistered' GROUP BY mass ORDER BY mass`,
    )
    .all();
}

export function getCheckoutRow(db, id) {
  return db.prepare('SELECT * FROM checkouts WHERE id = ?').get(id);
}

export function getCheckoutRowByReservation(db, reservationId) {
  return db.prepare('SELECT * FROM checkouts WHERE reservation_id = ?').get(reservationId);
}

export function listCheckoutRows(db) {
  return db.prepare('SELECT * FROM checkouts ORDER BY checked_out_at DESC, id DESC').all();
}

// 领用：冻结预约时段与占用量快照（server 同事务内完成全部核验后调用）。
export function insertCheckout(
  db,
  { reservationId, usage, reservationStartUtc, reservationEndUtc, checkedOutAt },
) {
  const info = db
    .prepare(
      `INSERT INTO checkouts
         (reservation_id, usage_json, reservation_start_utc, reservation_end_utc, checked_out_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      reservationId,
      JSON.stringify(usage ?? []),
      reservationStartUtc,
      reservationEndUtc,
      checkedOutAt,
    );
  return getCheckoutRow(db, info.lastInsertRowid);
}

export function listCheckoutItemRows(db, checkoutId) {
  return db
    .prepare('SELECT * FROM checkout_items WHERE checkout_id = ? ORDER BY mass, item_no')
    .all(checkoutId);
}

export function insertCheckoutItem(db, { checkoutId, itemId, itemNo, mass }) {
  db.prepare(
    `INSERT INTO checkout_items (checkout_id, item_id, item_no, mass)
     VALUES (?, ?, ?, ?)`,
  ).run(checkoutId, itemId, itemNo, mass);
}

// 实物当前所在的未归还领用明细（含领用单号）；无则 undefined。
export function getActiveCheckoutItemRow(db, itemId) {
  return db
    .prepare(
      `SELECT ci.*, c.reservation_id
         FROM checkout_items ci
         JOIN checkouts c ON c.id = ci.checkout_id
        WHERE ci.item_id = ? AND ci.returned_at IS NULL`,
    )
    .get(itemId);
}

// 归还：仅未归还的明细可标记（条件更新，未命中返回 null）。
export function markCheckoutItemReturned(db, checkoutId, itemId, { condition, returnedAt }) {
  const info = db
    .prepare(
      `UPDATE checkout_items
          SET returned_at = ?, condition = ?
        WHERE checkout_id = ? AND item_id = ? AND returned_at IS NULL`,
    )
    .run(returnedAt, condition, checkoutId, itemId);
  return info.changes === 1;
}

// ---------- 预约设备排班（由 server 在单事务内调用） ----------

export function getScheduleRow(db, id) {
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
}

// 预约的生效排班（每个预约至多一条；无则 undefined）。
export function getActiveScheduleRowByReservation(db, reservationId) {
  return db
    .prepare(`SELECT * FROM schedules WHERE reservation_id = ? AND status = 'active'`)
    .get(reservationId);
}

// 预约的全部排班历史（含取消与改派旧记录），按 id 升序。
export function listScheduleRowsByReservation(db, reservationId) {
  return db
    .prepare('SELECT * FROM schedules WHERE reservation_id = ? ORDER BY id')
    .all(reservationId);
}

export function listScheduleRows(db, status) {
  if (status) {
    return db
      .prepare('SELECT * FROM schedules WHERE status = ? ORDER BY start_utc, id')
      .all(status);
  }
  return db.prepare('SELECT * FROM schedules ORDER BY start_utc, id').all();
}

// 指定设备与 [startIso, endIso) 重叠的生效排班（左闭右开）；可排除某条排班（改派探测）。
export function listOverlappingActiveSchedulesByDevice(
  db,
  deviceNo,
  startIso,
  endIso,
  excludeScheduleId = null,
) {
  const sql = `
    SELECT * FROM schedules
     WHERE status = 'active'
       AND device_no = ?
       AND start_utc < ?
       AND ? < end_utc
       AND (? IS NULL OR id != ?)
     ORDER BY start_utc, id`;
  return db
    .prepare(sql)
    .all(deviceNo, endIso, startIso, excludeScheduleId, excludeScheduleId);
}

// 全部生效排班（占用查询用；可按设备过滤）。
export function listActiveScheduleRows(db, deviceNo = null) {
  if (deviceNo !== null) {
    return db
      .prepare(
        `SELECT * FROM schedules WHERE status = 'active' AND device_no = ?
          ORDER BY start_utc, id`,
      )
      .all(deviceNo);
  }
  return db
    .prepare(`SELECT * FROM schedules WHERE status = 'active' ORDER BY start_utc, id`)
    .all();
}

export function insertSchedule(db, { reservationId, deviceNo, startUtc, endUtc }) {
  const info = db
    .prepare(
      `INSERT INTO schedules (reservation_id, device_no, start_utc, end_utc)
       VALUES (?, ?, ?, ?)`,
    )
    .run(reservationId, deviceNo, startUtc, endUtc);
  return getScheduleRow(db, info.lastInsertRowid);
}

// 取消排班（条件更新：仅生效排班可取消；未命中返回 null）。
export function cancelSchedule(db, id, nowIso) {
  const info = db
    .prepare(
      `UPDATE schedules
          SET status = 'cancelled', cancelled_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(nowIso, id);
  return info.changes === 1 ? getScheduleRow(db, id) : null;
}

// 改派：原子释放旧排班并占用新排班（由 server 在单事务内先后调用）：
//   1) markScheduleReassigned 先把旧生效排班置为 reassigned（释放「每预约一条
//      生效排班」的部分唯一索引与旧设备时段）；
//   2) insertSchedule 再插入新生效排班（触发器对新设备做非重叠兜底）。
// 任一步失败均随外层事务整体回滚，旧排班保持 active。
export function markScheduleReassigned(db, oldId, newId) {
  const info = db
    .prepare(
      `UPDATE schedules
          SET status = 'reassigned', replaced_by_id = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(newId, oldId);
  return info.changes === 1 ? getScheduleRow(db, oldId) : null;
}

// 预约取消级联：其生效排班同步取消（条件更新，未命中返回 null）。
// 调用方已在同事务内确认预约未开始，故此处不再校验时刻。
export function cancelActiveScheduleByReservation(db, reservationId, nowIso) {
  const active = getActiveScheduleRowByReservation(db, reservationId);
  if (!active) return null;
  const info = db
    .prepare(
      `UPDATE schedules
          SET status = 'cancelled', cancelled_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(nowIso, active.id);
  return info.changes === 1 ? getScheduleRow(db, active.id) : null;
}

// ---------- 找时段预约（预约 + 排班整次操作；由 server 在单事务内调用） ----------

export function getBookingRow(db, id) {
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
}

export function getBookingRowByBatch(db, batchNo) {
  return db.prepare('SELECT * FROM bookings WHERE batch_no = ?').get(batchNo);
}

export function listBookingRows(db) {
  return db.prepare('SELECT * FROM bookings ORDER BY id DESC').all();
}

// 写入整次操作的冻结记录（请求与当选结果快照；预约与排班已在同事务内生成）。
export function insertBooking(db, b) {
  const info = db
    .prepare(
      `INSERT INTO bookings
         (batch_no, publication_id, duration_seconds, window_start_utc, window_end_utc,
          device_nos_json, device_no, start_utc, end_utc, usage_json,
          reservation_id, schedule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.batchNo,
      b.publicationId,
      b.durationSeconds,
      b.windowStartUtc,
      b.windowEndUtc,
      JSON.stringify(b.deviceNos),
      b.deviceNo,
      b.startUtc,
      b.endUtc,
      JSON.stringify(b.usage ?? []),
      b.reservationId,
      b.scheduleId,
    );
  return getBookingRow(db, info.lastInsertRowid);
}
