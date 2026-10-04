// 输入校验。任何一条不合法即抛出 ValidationError（HTTP 400），
// 调用方据此整体回滚，绝不写入部分数据。

export class ValidationError extends Error {
  constructor(errors, detail = null) {
    super(Array.isArray(errors) ? errors.join('；') : errors);
    this.errors = Array.isArray(errors) ? errors : [errors];
    this.status = 400;
    this.detail = detail;
  }
}

// 409：状态冲突（核验草稿已存在 / 版本过期 / 记录已冻结等）
export class ConflictError extends Error {
  constructor(errors, extra = {}) {
    super(Array.isArray(errors) ? errors.join('；') : errors);
    this.errors = Array.isArray(errors) ? errors : [errors];
    this.status = 409;
    Object.assign(this, extra);
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

const WEIGHT_REF_RE = /^配重#\d+-\d+$/;

function assert(cond, errors, msg) {
  if (!cond) errors.push(msg);
}

export function validateConfig(input, currentData) {
  const errors = [];
  assert(input !== null && typeof input === 'object', errors, '请求体必须是对象');
  if (errors.length) throw new ValidationError(errors);

  const { holes, tolerance, holeMaxMass } = input;

  assert(
    isInt(holes) && holes >= 4 && holes <= 12 && holes % 2 === 0,
    errors,
    '孔位数必须是 4 至 12 之间的偶数',
  );

  assert(isNum(tolerance) && tolerance >= 0, errors, '允许对径差必须是非负数');

  assert(Array.isArray(holeMaxMass), errors, '各孔最大质量必须是数组');
  if (Array.isArray(holeMaxMass)) {
    if (isInt(holes) && holes >= 4 && holes <= 12) {
      assert(
        holeMaxMass.length === holes,
        errors,
        `各孔最大质量数组长度必须为 ${holes}`,
      );
    }
    holeMaxMass.forEach((m, i) => {
      assert(isNum(m) && m > 0, errors, `孔 ${i} 的最大质量必须为正数（当前：${m}）`);
    });
  }

  // 缩小孔位范围前，现有离心管的可用孔位不得越界
  if (errors.length === 0 && currentData) {
    for (const t of currentData.tubes) {
      const bad = t.usableHoles.filter((h) => h >= holes);
      if (bad.length > 0) {
        errors.push(
          `缩小孔位至 ${holes} 会使离心管「${t.id}」的可用孔位 ${bad.join(', ')} 越界，请先修改该离心管`,
        );
      }
    }
    // 缩小孔位范围前，现有固定孔位不得越界（否则绑定失效）
    for (const f of currentData.fixedSlots || []) {
      if (f.hole >= holes) {
        errors.push(
          `缩小孔位至 ${holes} 会使固定孔位 ${f.hole}（离心管「${f.tube}」）越界，请先解除该固定孔位`,
        );
      }
    }
  }

  if (errors.length) throw new ValidationError(errors);
  return { holes, tolerance, holeMaxMass: holeMaxMass.map(Number) };
}

export function validateTubes(input, N) {
  const errors = [];
  assert(Array.isArray(input), errors, '离心管列表必须是数组');
  if (!Array.isArray(input)) throw new ValidationError(errors);
  if (N === null) throw new ValidationError(['请先配置转子孔位数']);

  const seen = new Set();
  const normalized = input.map((row, i) => {
    const where = `第 ${i + 1} 行离心管`;
    assert(row !== null && typeof row === 'object', errors, `${where}格式不正确`);
    if (!row || typeof row !== 'object') return null;

    const id = typeof row.id === 'string' ? row.id.trim() : '';
    assert(id.length > 0, errors, `${where}编号不能为空`);
    assert(!WEIGHT_REF_RE.test(id), errors, `${where}编号「${id}」为系统保留格式（配重#x-y）`);
    if (id) {
      assert(!seen.has(id), errors, `离心管编号「${id}」重复`);
      seen.add(id);
    }

    assert(isNum(row.mass) && row.mass > 0, errors, `${where}「${id || i}」质量必须为正数（当前：${row.mass}）`);

    assert(Array.isArray(row.usableHoles), errors, `${where}「${id || i}」的可用孔位必须是数组`);
    let usable = [];
    if (Array.isArray(row.usableHoles)) {
      const hset = new Set();
      for (const h of row.usableHoles) {
        assert(isInt(h) && h >= 0 && h < N, errors, `${where}「${id || i}」存在越界孔位 ${h}（允许 0..${N - 1}）`);
        if (isInt(h) && h >= 0 && h < N) {
          assert(!hset.has(h), errors, `${where}「${id}」的可用孔位 ${h} 重复`);
          hset.add(h);
        }
      }
      usable = [...hset].sort((a, b) => a - b);
      assert(usable.length > 0, errors, `${where}「${id || i}」至少要有一个可用孔位`);
    }

    return { id, mass: isNum(row.mass) ? row.mass : NaN, usableHoles: usable };
  });

  if (errors.length) throw new ValidationError(errors);
  return normalized;
}

export function validateWeights(input, N) {
  const errors = [];
  assert(Array.isArray(input), errors, '配重块列表必须是数组');
  if (!Array.isArray(input)) throw new ValidationError(errors);
  if (N === null) throw new ValidationError(['请先配置转子孔位数']);

  const seenMass = new Set();
  const normalized = input.map((row, i) => {
    const where = `第 ${i + 1} 行配重块`;
    assert(row !== null && typeof row === 'object', errors, `${where}格式不正确`);
    if (!row || typeof row !== 'object') return null;

    assert(isNum(row.mass) && row.mass > 0, errors, `${where}质量必须为正数（当前：${row.mass}）`);
    if (isNum(row.mass) && row.mass > 0) {
      const key = row.mass;
      assert(!seenMass.has(key), errors, `配重块质量 ${row.mass} 重复`);
      seenMass.add(key);
    }
    assert(
      isInt(row.quantity) && row.quantity >= 1,
      errors,
      `${where}数量必须为正整数（当前：${row.quantity}）`,
    );

    return { mass: row.mass, quantity: row.quantity };
  });

  if (errors.length) throw new ValidationError(errors);
  return normalized;
}

// 固定孔位（整体替换）：未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定，
// 任一出现即整组拒绝（调用方回滚，原绑定保留）。
// 绑定为无序集合：按孔位升序规范化存储，保证数据指纹稳定。
export function validateFixedSlots(input, currentData) {
  const errors = [];
  assert(Array.isArray(input), errors, '固定孔位列表必须是数组');
  if (!Array.isArray(input)) throw new ValidationError(errors);
  const N = currentData ? currentData.holes : null;
  if (N === null) throw new ValidationError(['请先配置转子孔位数']);

  const tubeMap = new Map((currentData.tubes || []).map((t) => [t.id, t]));
  const seenTubes = new Set();
  const seenHoles = new Set();
  const normalized = [];
  input.forEach((row, i) => {
    const where = `第 ${i + 1} 项固定孔位`;
    assert(row !== null && typeof row === 'object', errors, `${where}格式不正确`);
    if (!row || typeof row !== 'object') return;

    const tube = typeof row.tube === 'string' ? row.tube.trim() : '';
    assert(tube.length > 0, errors, `${where}：离心管编号不能为空`);
    const hole = row.hole;
    assert(
      isInt(hole) && hole >= 0 && hole < N,
      errors,
      `${where}：孔位 ${hole === '' ? '（空）' : hole} 越界或非法（允许 0..${N - 1} 的整数）`,
    );
    if (!tube || !isInt(hole) || hole < 0 || hole >= N) return;

    if (seenTubes.has(tube)) {
      errors.push(`${where}：离心管「${tube}」重复绑定（每管最多一个固定孔位）`);
    }
    seenTubes.add(tube);
    if (seenHoles.has(hole)) {
      errors.push(`${where}：孔位 ${hole} 重复绑定（每孔最多一支固定离心管）`);
    }
    seenHoles.add(hole);

    const t = tubeMap.get(tube);
    if (!t) {
      errors.push(`${where}：离心管编号「${tube}」不存在于当前录入（未知编号）`);
    } else if (!t.usableHoles.includes(hole)) {
      errors.push(
        `${where}：孔位 ${hole} 不在离心管「${tube}」的可用孔位内（可用：${t.usableHoles.join(', ')}）`,
      );
    }
    normalized.push({ tube, hole });
  });

  if (errors.length) throw new ValidationError(errors);
  normalized.sort((x, y) =>
    x.hole - y.hole || (x.tube < y.tube ? -1 : x.tube > y.tube ? 1 : 0),
  );
  return normalized;
}

// 避邻对（整体替换）：未知编号、自配对、重复配对（含颠倒）任一出现即整次拒绝。
// 规则为无序集合：每对内部按编号字典序规范化，整体再排序，保证数据指纹稳定。
export function validateExclusions(input, currentData) {
  const errors = [];
  assert(Array.isArray(input), errors, '避邻对列表必须是数组');
  if (!Array.isArray(input)) throw new ValidationError(errors);

  const tubeIds = new Set(currentData ? currentData.tubes.map((t) => t.id) : []);
  const seen = new Set();
  const normalized = [];
  input.forEach((row, i) => {
    const where = `第 ${i + 1} 对避邻规则`;
    assert(row !== null && typeof row === 'object', errors, `${where}格式不正确`);
    if (!row || typeof row !== 'object') return;

    const a = typeof row.a === 'string' ? row.a.trim() : '';
    const b = typeof row.b === 'string' ? row.b.trim() : '';
    assert(a.length > 0, errors, `${where}：离心管编号不能为空`);
    assert(b.length > 0, errors, `${where}：离心管编号不能为空`);
    if (!a || !b) return;

    if (a === b) {
      errors.push(`${where}：离心管「${a}」不能与自身配对（自配对无效）`);
      return;
    }
    for (const id of [a, b]) {
      if (!tubeIds.has(id)) {
        errors.push(`${where}：离心管编号「${id}」不存在于当前录入（未知编号）`);
      }
    }
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const key = JSON.stringify([lo, hi]);
    if (seen.has(key)) {
      errors.push(`避邻对「${lo} ↔ ${hi}」与第 ${i + 1} 对重复（含颠倒顺序的重复）`);
    }
    seen.add(key);
    normalized.push({ a: lo, b: hi });
  });

  if (errors.length) throw new ValidationError(errors);
  normalized.sort((x, y) =>
    x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0,
  );
  return normalized;
}
