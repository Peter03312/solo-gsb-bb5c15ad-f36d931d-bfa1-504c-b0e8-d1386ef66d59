/* 离心转子配平前端（无框架，原生 JS） */

const $ = (sel) => document.querySelector(sel);
const holesSel = $('#holes');
for (let n = 4; n <= 12; n += 2) {
  const opt = document.createElement('option');
  opt.value = String(n);
  opt.textContent = `${n} 孔`;
  holesSel.appendChild(opt);
}

let state = null; // GET /api/state 的完整响应
// 编辑区本地缓冲
let editorN = null;
let tubeRows = []; // {id, mass, holes:Set}
let weightRows = []; // {mass, quantity}
let exclRows = []; // 避邻对编辑行：{a, b}（管编号）
let fixedRows = []; // 固定孔位编辑行：{tube, hole}（管编号 + 孔位）

// ---------- 通用 ----------

function showAlert(msg, kind = 'err') {
  const el = $('#alert');
  el.textContent = msg;
  el.className = `alert ${kind}`;
  el.scrollIntoView({ block: 'nearest' });
}
function clearAlert() {
  $('#alert').className = 'alert hidden';
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const list = json.errors && json.errors.length ? json.errors.join('\n') : json.error || '请求失败';
    const err = new Error(list);
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
}
const fmt = (x) => (typeof x === 'number' ? String(Math.round(x * 1e6) / 1e6) : x);

// ---------- 数据刷新 ----------

async function refresh(flash) {
  state = await api('GET', '/api/state');
  renderAll();
  if (flash) showAlert(flash, 'ok');
  else clearAlert();
}

function renderAll() {
  const d = state.data;
  $('#hashline').textContent = state.currentHash
    ? `当前数据指纹 sha256:${state.currentHash.slice(0, 16)}…`
    : '尚未配置转子';

  // 首次或孔位数变化时重建本地编辑缓冲
  const N = d ? d.holes : null;
  if (editorN !== N) {
    editorN = N;
    if (d) {
      holesSel.value = String(d.holes);
      $('#tolerance').value = d.tolerance;
      tubeRows = d.tubes.map((t) => ({
        id: t.id,
        mass: t.mass,
        holes: new Set(t.usableHoles),
      }));
      weightRows = d.weights.map((w) => ({ mass: w.mass, quantity: w.quantity }));
      exclRows = (d.exclusionPairs || []).map((p) => ({ a: p.a, b: p.b }));
      fixedRows = (d.fixedSlots || []).map((f) => ({ tube: f.tube, hole: f.hole }));
    } else {
      exclRows = [];
      fixedRows = [];
    }
  }

  renderHoleMax(d);
  renderTubeTable(N);
  renderExclusionTable();
  renderFixedTable();
  renderWeightTable();
  renderDraft();
  renderPublications();
  renderVerifications();
  renderReservations();
  renderSuspensions();
  renderRuns();
  renderDevices();
  renderMaintenances();
  renderCalibrations();
}

function renderHoleMax(d) {
  const N = d ? d.holes : Number(holesSel.value);
  const box = $('#holemax');
  if (box.childElementCount !== N) {
    box.innerHTML = '';
    for (let h = 0; h < N; h += 1) {
      const lab = document.createElement('label');
      lab.innerHTML = `孔 ${h}<input data-hole="${h}" type="number" step="0.0001" min="0">`;
      box.appendChild(lab);
    }
  }
  if (d) {
    box.querySelectorAll('input').forEach((inp) => {
      const h = Number(inp.dataset.hole);
      if (document.activeElement !== inp) inp.value = d.holeMaxMass[h];
    });
  }
}

holesSel.addEventListener('change', () => {
  editorN = Number(holesSel.value);
  renderHoleMax(null);
  renderTubeTable(editorN);
});

// ---------- 离心管表 ----------

function renderTubeTable(N) {
  const tbody = $('#tubes-table tbody');
  tbody.innerHTML = '';
  tubeRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    const idInp = document.createElement('input');
    idInp.type = 'text';
    idInp.value = row.id;
    idInp.placeholder = '如 T01';
    idInp.addEventListener('input', () => { row.id = idInp.value.trim(); });
    tdId.appendChild(idInp);

    const tdMass = document.createElement('td');
    const mInp = document.createElement('input');
    mInp.type = 'number';
    mInp.step = '0.0001';
    mInp.min = '0';
    mInp.value = row.mass;
    mInp.addEventListener('input', () => { row.mass = mInp.value; });
    tdMass.appendChild(mInp);

    const tdHoles = document.createElement('td');
    if (N) {
      const wrap = document.createElement('div');
      wrap.className = 'holes-checks';
      for (let h = 0; h < N; h += 1) {
        const lab = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = row.holes.has(h);
        cb.addEventListener('change', () => {
          if (cb.checked) row.holes.add(h);
          else row.holes.delete(h);
        });
        lab.append(cb, document.createTextNode(h));
        wrap.appendChild(lab);
      }
      tdHoles.appendChild(wrap);
    } else {
      tdHoles.textContent = '—';
      tdHoles.className = 'muted';
    }

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { tubeRows.splice(i, 1); renderTubeTable(N); });
    tdDel.appendChild(del);

    tr.append(tdId, tdMass, tdHoles, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-tube').addEventListener('click', () => {
  if (!editorN) return showAlert('请先保存转子配置（孔位数）。', 'err');
  const holes = new Set([0]);
  tubeRows.push({ id: '', mass: '', holes });
  renderTubeTable(editorN);
});

// ---------- 避邻对表 ----------

function tubeIdOptions(selected) {
  // 下拉选项来自已保存的离心管（服务端按已保存数据校验）；
  // 当前值不在其中时保留原值并标记（保存时会被服务端拒绝）。
  const ids = state.data ? state.data.tubes.map((t) => t.id) : [];
  const opts = ['<option value="">（选择离心管）</option>'];
  for (const id of ids) {
    opts.push(
      `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(id)}</option>`,
    );
  }
  if (selected && !ids.includes(selected)) {
    opts.push(
      `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}（未知编号）</option>`,
    );
  }
  return opts.join('');
}

function renderExclusionTable() {
  const tbody = $('#exclusions-table tbody');
  tbody.innerHTML = '';
  exclRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdA = document.createElement('td');
    const selA = document.createElement('select');
    selA.innerHTML = tubeIdOptions(row.a);
    selA.addEventListener('change', () => { row.a = selA.value; });
    tdA.appendChild(selA);

    const tdB = document.createElement('td');
    const selB = document.createElement('select');
    selB.innerHTML = tubeIdOptions(row.b);
    selB.addEventListener('change', () => { row.b = selB.value; });
    tdB.appendChild(selB);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { exclRows.splice(i, 1); renderExclusionTable(); });
    tdDel.appendChild(del);

    tr.append(tdA, tdB, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-exclusion').addEventListener('click', () => {
  if (!state.data) return showAlert('请先保存转子配置并录入离心管。', 'err');
  exclRows.push({ a: '', b: '' });
  renderExclusionTable();
});

$('#save-exclusions').addEventListener('click', async () => {
  try {
    await api('PUT', '/api/exclusions', exclRows.map((r) => ({ a: r.a, b: r.b })));
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('避邻对已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('避邻对已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 固定孔位表 ----------

function holeOptions(selected) {
  // 下拉选项为当前孔位 0..N-1；当前值越界时保留原值并标记（保存时会被服务端拒绝）
  const N = state.data ? state.data.holes : editorN;
  const opts = ['<option value="">（选择孔位）</option>'];
  for (let h = 0; h < N; h += 1) {
    opts.push(`<option value="${h}"${h === selected ? ' selected' : ''}>${h}</option>`);
  }
  if (selected !== '' && selected != null && !(selected >= 0 && selected < N)) {
    opts.push(`<option value="${selected}" selected>${selected}（越界）</option>`);
  }
  return opts.join('');
}

function renderFixedTable() {
  const tbody = $('#fixed-table tbody');
  tbody.innerHTML = '';
  fixedRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdTube = document.createElement('td');
    const selTube = document.createElement('select');
    selTube.innerHTML = tubeIdOptions(row.tube);
    selTube.addEventListener('change', () => { row.tube = selTube.value; });
    tdTube.appendChild(selTube);

    const tdHole = document.createElement('td');
    const selHole = document.createElement('select');
    selHole.innerHTML = holeOptions(row.hole);
    selHole.addEventListener('change', () => {
      row.hole = selHole.value === '' ? '' : Number(selHole.value);
    });
    tdHole.appendChild(selHole);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { fixedRows.splice(i, 1); renderFixedTable(); });
    tdDel.appendChild(del);

    tr.append(tdTube, tdHole, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-fixed').addEventListener('click', () => {
  if (!state.data) return showAlert('请先保存转子配置并录入离心管。', 'err');
  fixedRows.push({ tube: '', hole: '' });
  renderFixedTable();
});

$('#save-fixed').addEventListener('click', async () => {
  try {
    await api(
      'PUT',
      '/api/fixed-slots',
      fixedRows.map((r) => ({ tube: r.tube, hole: r.hole === '' ? '' : Number(r.hole) })),
    );
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('固定孔位已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('固定孔位已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 配重表 ----------

function renderWeightTable() {
  const tbody = $('#weights-table tbody');
  tbody.innerHTML = '';
  weightRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdMass = document.createElement('td');
    const mInp = document.createElement('input');
    mInp.type = 'number';
    mInp.step = '0.0001';
    mInp.min = '0';
    mInp.value = row.mass;
    mInp.addEventListener('input', () => { row.mass = mInp.value; });
    tdMass.appendChild(mInp);

    const tdQ = document.createElement('td');
    const qInp = document.createElement('input');
    qInp.type = 'number';
    qInp.step = '1';
    qInp.min = '1';
    qInp.value = row.quantity;
    qInp.addEventListener('input', () => { row.quantity = qInp.value; });
    tdQ.appendChild(qInp);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { weightRows.splice(i, 1); renderWeightTable(); });
    tdDel.appendChild(del);

    tr.append(tdMass, tdQ, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-weight').addEventListener('click', () => {
  if (!editorN) return showAlert('请先保存转子配置（孔位数）。', 'err');
  weightRows.push({ mass: '', quantity: 1 });
  renderWeightTable();
});

// ---------- 保存动作 ----------

$('#save-config').addEventListener('click', async () => {
  const holes = Number(holesSel.value);
  const tolerance = Number($('#tolerance').value);
  const holeMaxMass = [...$('#holemax').querySelectorAll('input')].map((i) => Number(i.value));
  try {
    await api('PUT', '/api/config', { holes, tolerance, holeMaxMass });
    await refresh('转子配置已保存。');
  } catch (e) { showAlert(e.message, 'err'); }
});

async function saveTubes() {
  if (!editorN) throw new Error('请先配置转子孔位数。');
  const body = tubeRows.map((r) => ({
    id: r.id,
    mass: Number(r.mass),
    usableHoles: [...r.holes].sort((a, b) => a - b),
  }));
  await api('PUT', '/api/tubes', body);
}

async function saveWeights() {
  if (!editorN) throw new Error('请先配置转子孔位数。');
  const body = weightRows.map((r) => ({ mass: Number(r.mass), quantity: Number(r.quantity) }));
  await api('PUT', '/api/weights', body);
}

$('#save-tubes').addEventListener('click', async () => {
  try {
    await saveTubes();
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('离心管已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('离心管已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

$('#save-weights').addEventListener('click', async () => {
  try {
    await saveWeights();
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('配重块已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('配重块已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 草稿展示 ----------

function slotHtml(h, slot) {
  if (!slot) {
    return `<div class="slot empty"><span class="hole-no">孔 ${h}</span>
      <span class="ref">空</span><span class="mass">0 g</span></div>`;
  }
  const cls = slot.kind === 'tube' ? 'tube' : 'weight';
  const tag = slot.kind === 'tube' ? '离心管' : '配重块';
  return `<div class="slot ${cls}"><span class="hole-no">孔 ${h}</span>
    <span class="ref">${escapeHtml(slot.ref)}</span>
    <span class="mass">${tag} · ${fmt(slot.mass)} g</span></div>`;
}

function arrangementHtml(result) {
  return `<div class="rotor-layout">${result.arrangement
    .map((s, h) => slotHtml(h, s))
    .join('')}</div>
  <table class="pair-list">
    <thead><tr><th>对径孔对</th><th>A 侧质量</th><th>B 侧质量</th><th>差值</th><th>容差判定</th></tr></thead>
    <tbody>${result.pairs
      .map(
        (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
        <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
        <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
          p.withinTolerance ? '✓ 合格' : '✗ 超限'
        }</td></tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function renderDraft() {
  const draft = state.draft;
  const staleBox = $('#draft-stale');
  const noneBox = $('#draft-none');
  const body = $('#draft-body');
  const pubBtn = $('#publish');

  if (!draft) {
    staleBox.classList.add('hidden');
    noneBox.classList.remove('hidden');
    body.classList.add('hidden');
    pubBtn.disabled = true;
    return;
  }
  noneBox.classList.add('hidden');
  staleBox.classList.toggle('hidden', !draft.stale);
  body.classList.remove('hidden');

  if (!draft.feasible) {
    body.innerHTML = `<div class="banner bad"><b>不存在可行装载图。</b><ul>${draft.reasons
      .map((r) => `<li>${escapeHtml(r)}</li>`)
      .join('')}</ul></div>`;
    pubBtn.disabled = true;
    return;
  }
  const r = draft.result;
  const excl = state.data && state.data.exclusionPairs ? state.data.exclusionPairs : [];
  const fixed = state.data && state.data.fixedSlots ? state.data.fixedSlots : [];
  body.innerHTML = `
    <div class="metrics">
      <div>使用配重块：<b>${r.weightCount}</b> 枚（已最小化）</div>
      <div>各对径差之和：<b>${fmt(r.diffSum)}</b> g（同配重数下已最小化）</div>
      <div>避邻规则：<b>${excl.length}</b> 对（已纳入求解）</div>
      <div>固定孔位：<b>${fixed.length}</b> 项（已纳入求解）</div>
    </div>
    ${arrangementHtml(r)}`;
  pubBtn.disabled = draft.stale;
}

$('#recompute').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('已按当前数据重算。', 'ok');
    else showAlert('不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

$('#publish').addEventListener('click', async () => {
  try {
    const pub = await api('POST', '/api/publish');
    await refresh(`已发布并冻结装载图 #${pub.id}（发布时基于当前数据复核通过）。`);
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 发布历史 ----------

function renderPublications() {
  const box = $('#pub-list');
  if (state.publications.length === 0) {
    box.innerHTML = '<div class="muted">暂无发布记录。</div>';
    return;
  }
  box.innerHTML = state.publications
    .map(
      (p) => `<div class="pub-row">
        <div>
          <button data-pub="${p.id}" class="pub-view">#${p.id}</button>
          <span class="muted">${p.createdAt}</span>
          ${p.feasible
            ? `<span class="muted">· 配重 ${p.weightCount} 枚 · 对径差和 ${fmt(p.diffSum)} g</span>`
            : '<span class="muted">· 不可行记录</span>'}
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${
            p.feasible && p.usable
              ? `<button data-pub-verify="${p.id}" class="primary">现场核验此图</button>`
              : ''
          }
          <span class="badge ${p.usable ? 'ok' : 'stale'}">${
            p.usable ? '✓ 可用于当前装载' : '✗ 不可用于当前装载（数据已变化，旧图冻结不变）'
          }</span>
        </div>
      </div>`,
    )
    .join('');
  box.querySelectorAll('.pub-view').forEach((b) =>
    b.addEventListener('click', () => openPublication(Number(b.dataset.pub))),
  );
  box.querySelectorAll('[data-pub-verify]').forEach((b) =>
    b.addEventListener('click', () => startVerification(Number(b.dataset.pubVerify))),
  );
}

async function openPublication(id) {
  const p = await api('GET', `/api/publications/${id}`);
  $('#pub-title').textContent = `已冻结装载图 #${p.id}`;
  const badge = p.usable
    ? '<span class="badge ok">✓ 可用于当前装载</span>'
    : '<span class="badge stale">✗ 不可用于当前装载</span>';
  const excl = p.config && Array.isArray(p.config.exclusionPairs) ? p.config.exclusionPairs : [];
  const exclText = excl.length
    ? `${excl.length} 对：${excl.map((x) => `${x.a} ↔ ${x.b}`).join('，')}`
        : '未配置（按无规则装载）';
  const fixed = p.config && Array.isArray(p.config.fixedSlots) ? p.config.fixedSlots : [];
  const fixedText = fixed.length
    ? `${fixed.length} 项：${fixed.map((x) => `「${x.tube}」→ 孔 ${x.hole}`).join('，')}`
        : '未固定（自由装载）';
  $('#pub-detail').innerHTML = `
    <div class="actions" style="margin-top:0">${badge}
      <span class="muted">发布时间 ${p.createdAt}</span></div>
    <p class="muted" style="font-family:ui-monospace,monospace;font-size:12px">
      数据依据 sha256:${p.basisHash}</p>
    <p class="muted">冻结的避邻规则：${escapeHtml(exclText)}</p>
    <p class="muted">冻结的固定孔位：${escapeHtml(fixedText)}</p>
    ${p.feasible
      ? `<div class="metrics">
          <div>配重块：<b>${p.weightCount}</b> 枚</div>
          <div>对径差之和：<b>${fmt(p.diffSum)}</b> g</div>
        </div>${arrangementHtml(p.result)}`
      : `<div class="banner bad">${p.reasons.map(escapeHtml).join('<br>')}</div>`}
    <details class="snapshot-block">
      <summary>发布时冻结的录入数据（依据快照）</summary>
      <pre>${escapeHtml(JSON.stringify(p.config, null, 2))}</pre>
    </details>`;
  $('#pub-dialog').showModal();
}
$('#pub-close').addEventListener('click', () => $('#pub-dialog').close());

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- 现场装载核验 ----------

let verDetail = null; // GET /api/verifications/:id 的完整响应（编辑器数据源）

function renderVerifications() {
  const box = $('#verify-list');
  const list = state.verifications || [];
  if (list.length === 0) {
    box.innerHTML =
      '<div class="muted">尚无核验记录。在第 7 节对可用于当前装载的发布记录点「现场核验此图」即可开始。</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (v) => `<div class="pub-row">
        <div>
          <button data-ver="${v.id}" class="pub-view">核验 #${v.id}</button>
          <span class="muted">发布记录 #${v.publicationId} · 更新于 ${v.updatedAt}</span>
          <span class="muted">· 进度 ${v.progress.filled}/${v.progress.total} 孔</span>
          ${v.completed ? `<span class="muted">· 实测对径差和 ${fmt(v.diffSum)} g</span>` : ''}
        </div>
        <span class="badge ${v.completed ? 'ok' : v.usable ? 'stale' : 'bad'}">${
          v.completed
            ? `✓ 已完成核验（${v.completedAt}）`
            : v.usable
              ? '⏳ 核验进行中（草稿可恢复）'
              : '✗ 依据发布已不可用于当前装载'
        }</span>
      </div>`,
    )
    .join('');
  box.querySelectorAll('[data-ver]').forEach((b) =>
    b.addEventListener('click', () => openVerification(Number(b.dataset.ver))),
  );
}

async function startVerification(publicationId) {
  try {
    const v = await api('POST', '/api/verifications', { publicationId });
    await refresh();
    await openVerification(v.id);
  } catch (e) {
    // 同一发布记录已有核验（草稿或已完成）→ 直接恢复
    if (e.status === 409 && e.data && e.data.existingId != null) {
      await refresh();
      await openVerification(e.data.existingId);
      showAlert(e.message, 'ok');
    } else {
      showAlert(e.message, 'err');
    }
  }
}

async function openVerification(id) {
  verDetail = await api('GET', `/api/verifications/${id}`);
  verRows = [];
  verFail = null;
  renderVerificationDialog();
  $('#ver-dialog').showModal();
}

// 编辑器本地缓冲：verRows[h] = {ref, mass}
let verRows = [];
// 最近一次“完成核验”失败时服务端返回的判定明细（用于定位孔位/孔对）
let verFail = null;

function renderVerificationDialog() {
  const v = verDetail;
  $('#ver-title').textContent = `现场核验 #${v.id}（发布记录 #${v.publicationId}）`;
  const frozen = v.publication.result.arrangement;
  const N = frozen.length;

  // 首次载入时用服务端数据初始化本地缓冲（避免覆盖正在编辑的内容）
  if (!verRows.length || verRows._verId !== v.id || verRows._version !== v.version) {
    verRows = v.entries.map((e) => ({ ref: e.ref, mass: e.mass === 0 ? '' : e.mass }));
    verRows._verId = v.id;
    verRows._version = v.version;
  }

  const badge = v.completed
    ? '<span class="badge ok">✓ 核验已完成并冻结</span>'
    : v.usable
      ? '<span class="badge ok">✓ 发布记录可用于当前装载</span>'
      : '<span class="badge bad">✗ 发布记录已不可用于当前装载（不能完成核验）</span>';

  let body = `
    <div class="actions" style="margin-top:0">${badge}
      <span class="muted">版本 v${v.version} · 进度 ${v.progress.filled}/${v.progress.total} 孔</span>
    </div>
    <p class="muted" style="font-family:ui-monospace,monospace;font-size:12px">
      依据发布 sha256:${v.publication.basisHash} · 冻结容差 ${v.publication.config.tolerance} g</p>
    <div id="ver-msg"></div>`;

  const holeChecks = new Map();
  if (v.completed && v.checks) {
    for (const h of v.checks.holes) holeChecks.set(h.hole, h);
  } else if (verFail && verFail.checks) {
    for (const h of verFail.checks.holes) holeChecks.set(h.hole, h);
  }
  const pairChecks = v.completed
    ? v.checks.pairs
    : verFail && verFail.checks
      ? verFail.checks.pairs
      : null;

  body += `<div class="table-wrap"><table class="ver-table">
    <thead><tr>
      <th>孔位</th><th>冻结图应放物件</th><th>孔承重 (g)</th>
      <th>现场实际物件编号</th><th>实测质量 (g)</th>${v.completed ? '<th>判定</th>' : ''}
    </tr></thead><tbody>`;

  for (let h = 0; h < N; h += 1) {
    const slot = frozen[h];
    const expected = slot ? slot.ref : '空';
    const isEmpty = !slot;
    const row = verRows[h];
    const chk = holeChecks.get(h);
    const holeBad = chk && !(chk.objectMatch && chk.withinCapacity);
    let verdict = '';
    if (v.completed) {
      const ok = chk && chk.objectMatch && chk.withinCapacity;
      verdict = `<td class="${ok ? 'tag-ok' : 'tag-bad'}">${ok ? '✓' : '✗'}</td>`;
    }
    body += `<tr${holeBad ? ' class="row-bad"' : ''}>
      <td>孔 ${h}</td>
      <td>${escapeHtml(expected)}</td>
      <td>${fmt(v.publication.config.holeMaxMass[h])}</td>
      <td>${
        v.completed
          ? escapeHtml(row.ref || '（空）')
          : isEmpty
            ? '<span class="muted">空孔（保持为空）</span>'
            : `<input type="text" data-ver-ref="${h}" value="${escapeHtml(row.ref)}" placeholder="${escapeHtml(expected)}" class="${chk && !chk.objectMatch ? 'inp-bad' : ''}">`
      }</td>
      <td>${
        v.completed
          ? fmt(row.mass || 0)
          : isEmpty
            ? '<span class="muted">0</span>'
            : `<input type="number" step="0.0001" min="0" data-ver-mass="${h}" value="${row.mass === '' || row.mass == null ? '' : Number(row.mass)}" class="${chk && !chk.withinCapacity ? 'inp-bad' : ''}">`
      }</td>
      ${verdict}
    </tr>`;
  }
  body += '</tbody></table></div>';

  if (!v.completed) {
    if (verFail) {
      body += `<div class="banner bad" id="ver-fail-banner">
        <b>核验不通过（草稿已保留，未生成完成记录）：</b>
        <ul>${(verFail.errors || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      </div>`;
    }
    if (pairChecks) {
      body += `<table class="pair-list">
        <thead><tr><th>对径孔对</th><th>A 侧实测</th><th>B 侧实测</th><th>差值</th><th>冻结容差判定</th></tr></thead>
        <tbody>${pairChecks
          .map(
            (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
            <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
            <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
              p.withinTolerance ? '✓ 合格' : '✗ 超限'
            }</td></tr>`,
          )
          .join('')}</tbody></table>`;
    }
    body += `<div class="actions">
      <button id="ver-save">暂存录入</button>
      <button id="ver-complete" class="primary" ${v.usable ? '' : 'disabled'}>
        完成核验（事务内重读快照与当前数据判定）
      </button>
    </div>
    <p class="muted">提示：暂存可随时中断、稍后从本页恢复；完成须全部孔位录入合格（有物件填正数质量，空孔留空）。</p>`;
  } else {
    const allOk =
      v.checks.holes.every((c) => c.objectMatch && c.withinCapacity) &&
      v.checks.pairs.every((p) => p.withinTolerance);
    body += `<div class="banner ${allOk ? 'ok' : 'bad'}">
      <b>${allOk ? '✓ 核验通过' : '✗ 核验不通过（冻结记录保留）'}</b>
      实测各对径差之和：${fmt(v.diffSum)} g · 完成时间：${v.completedAt}
    </div>`;
    body += `<table class="pair-list">
      <thead><tr><th>对径孔对</th><th>A 侧实测</th><th>B 侧实测</th><th>差值</th><th>冻结容差判定</th></tr></thead>
      <tbody>${v.checks.pairs
        .map(
          (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
          <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
          <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
            p.withinTolerance ? '✓ 合格' : '✗ 超限'
          }</td></tr>`,
        )
        .join('')}</tbody></table>`;
  }

  $('#ver-detail').innerHTML = body;

  // 绑定输入
  $('#ver-detail').querySelectorAll('[data-ver-ref]').forEach((inp) => {
    inp.addEventListener('input', () => {
      verRows[Number(inp.dataset.verRef)].ref = inp.value.trim();
      clearVerFail();
    });
  });
  $('#ver-detail').querySelectorAll('[data-ver-mass]').forEach((inp) => {
    inp.addEventListener('input', () => {
      verRows[Number(inp.dataset.verMass)].mass = inp.value;
      clearVerFail();
    });
  });

  const saveBtn = $('#ver-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveVerification(false));
  }
  const completeBtn = $('#ver-complete');
  if (completeBtn) {
    completeBtn.addEventListener('click', () => saveVerification(true));
  }
}

function collectVerEntries() {
  return verRows.map((r, h) => ({
    hole: h,
    ref: r.ref || '',
    mass: r.ref ? Number(r.mass) : 0,
  }));
}

async function saveVerification(andComplete) {
  try {
    const saved = await api('PUT', `/api/verifications/${verDetail.id}`, {
      version: verDetail.version,
      entries: collectVerEntries(),
    });
    verDetail = saved;
    verRows._version = saved.version;
    verFail = null;
    if (!andComplete) {
      renderVerificationDialog();
      verDialogMsg(`核验草稿已暂存（版本 v${saved.version}，进度 ${saved.progress.filled}/${saved.progress.total}）。`, 'ok');
      await refresh();
      return;
    }
    const done = await api('POST', `/api/verifications/${saved.id}/complete`);
    verDetail = done;
    verRows = [];
    verFail = null;
    renderVerificationDialog();
    await refresh();
    verDialogMsg('核验已完成：实测值与判定明细已冻结。', 'ok');
  } catch (e) {
    // 完成失败：草稿仍在；若服务端附带判定明细则缓存以定位孔位/孔对
    verFail = e.data && e.data.detail ? e.data.detail : null;
    try {
      verDetail = await api('GET', `/api/verifications/${verDetail.id}`);
      verRows._version = verDetail.version;
    } catch (_) { /* 忽略二次刷新失败 */ }
    renderVerificationDialog();
    verDialogMsg(e.message, 'err');
  }
}

// 对话框内消息（顶部 alert 在模态框之外、不可见）
function verDialogMsg(msg, kind = 'err') {
  const el = $('#ver-msg');
  if (!el) return;
  el.innerHTML = `<div class="banner ${kind === 'ok' ? 'ok' : 'bad'}" style="margin:0 0 12px">
    ${escapeHtml(msg).replace(/\n/g, '<br>')}</div>`;
  el.scrollIntoView({ block: 'nearest' });
}

// 任一字段改动后清掉上一轮失败高亮，避免误导（不整体重渲染以保留焦点）
function clearVerFail() {
  if (!verFail) return;
  verFail = null;
  $('#ver-detail').querySelectorAll('.inp-bad').forEach((el) => el.classList.remove('inp-bad'));
  $('#ver-detail').querySelectorAll('tr.row-bad').forEach((el) => el.classList.remove('row-bad'));
  const banner = $('#ver-fail-banner');
  if (banner) banner.remove();
}

$('#ver-close').addEventListener('click', () => {
  $('#ver-dialog').close();
  verRows = [];
  refresh().catch(() => {});
});

// ---------- 配重块时段预约 ----------

const PHASE_LABEL = {
  notStarted: '未开始',
  ongoing: '进行中',
  ended: '已结束',
  cancelled: '已取消',
};

function usageText(usage) {
  if (!usage || usage.length === 0) return '（不使用配重块）';
  return usage.map((u) => `${u.mass} g × ${u.count}`).join('，');
}

function renderReservations() {
  // 预约表单：可选发布图（仅当前可用）
  const sel = $('#res-pub');
  const usable = state.publications.filter((p) => p.usable);
  const prev = sel.value;
  sel.innerHTML = usable.length
    ? usable
        .map(
          (p) =>
            `<option value="${p.id}">#${p.id} · ${p.createdAt} · 配重 ${p.weightCount} 枚</option>`,
        )
        .join('')
    : '<option value="">（暂无可用发布图）</option>';
  if (usable.some((p) => String(p.id) === prev)) sel.value = prev;

  // 预约列表
  const box = $('#res-list');
  const list = state.reservations || [];
  if (list.length === 0) {
    box.innerHTML = '<div class="muted">暂无预约记录。</div>';
  } else {
    box.innerHTML = `<div class="table-wrap"><table class="res-table">
      <thead><tr>
        <th>批次号</th><th>依据图</th><th>时段（UTC，左闭右开）</th><th>占用规格</th>
        <th>状态</th><th>依据图当前可用</th><th></th>
      </tr></thead><tbody>${list
        .map(
          (r) => `<tr>
        <td><b>${escapeHtml(r.batchNo)}</b></td>
        <td>#${r.publicationId}</td>
        <td class="mono">${r.startUtc}<br>至 ${r.endUtc}</td>
        <td>${escapeHtml(usageText(r.usage))}</td>
        <td><span class="badge ${
          r.status === 'cancelled' ? 'bad' : r.phase === 'ended' ? 'stale' : 'ok'
        }">${PHASE_LABEL[r.phase]}</span></td>
        <td>${
          r.publicationUsable
            ? '<span class="tag-ok">✓ 可用</span>'
            : '<span class="tag-bad">✗ 已失效</span>'
        }</td>
        <td>${
          r.cancellable
            ? `<button data-res-cancel="${r.id}" class="danger">取消预约</button>`
            : ''
        }</td>
      </tr>`,
        )
        .join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-res-cancel]').forEach((b) =>
      b.addEventListener('click', () => cancelReservation(Number(b.dataset.resCancel))),
    );
  }

  loadSchedule().catch(() => {});
}

async function loadSchedule() {
  const sch = await api('GET', '/api/schedule');
  const box = $('#res-schedule');
  if (!sch.specs || sch.specs.length === 0) {
    box.innerHTML = '<div class="muted">当前无生效中的预约占用或停用。</div>';
    return;
  }
  box.innerHTML = sch.specs
    .map(
      (s) => `<div class="spec-block">
      <div class="spec-head">
        <b>规格 ${s.mass} g</b>
        <span class="muted">当前库存 ${s.capacity} 枚 · 时段内峰值占用 ${s.peak} 枚 ·
          峰值停用 ${s.peakSuspended || 0} 枚 · 占用+停用峰值 ${s.peakCombined || s.peak} 枚</span>
        <span class="badge ${s.shortage ? 'bad' : 'ok'}">${
          s.shortage ? '✗ 占用超库存' : '✓ 占用未超库存'
        }</span>
        <span class="badge ${s.combinedShortage ? 'bad' : 'ok'}">${
          s.combinedShortage ? '✗ 占用+停用存在不足区段' : '✓ 占用+停用充足'
        }</span>
      </div>
      ${
        s.combinedSegments && s.combinedSegments.length
          ? `<table class="pair-list">
        <thead><tr><th>时段（UTC）</th><th>预约占用</th><th>停用</th><th>占用判定</th><th>占用+停用判定</th></tr></thead>
        <tbody>${s.combinedSegments
          .map(
            (g) => `<tr${g.shortage ? ' class="row-bad"' : ''}>
            <td class="mono">${g.start} 至 ${g.end}</td>
            <td>${g.used} 枚</td>
            <td>${g.suspended || 0} 枚</td>
            <td class="${g.used > s.capacity ? 'tag-bad' : 'tag-ok'}">${
              g.used > s.capacity ? '✗ 不足' : '✓'
            }</td>
            <td class="${g.shortage ? 'tag-bad' : 'tag-ok'}">${
              g.shortage ? '✗ 不足' : '✓'
            }</td>
          </tr>`,
          )
          .join('')}</tbody></table>`
          : '<div class="muted">该时段内无占用或停用。</div>'
      }
    </div>`,
    )
    .join('');
}

// datetime-local 值按 UTC 解释（服务端对无时区后缀的 ISO 时间一律按 UTC 处理）
function dtLocalToUtc(v) {
  return v || '';
}

$('#res-submit').addEventListener('click', async () => {
  const batchNo = $('#res-batch').value.trim();
  const publicationId = Number($('#res-pub').value);
  const startUtc = dtLocalToUtc($('#res-start').value);
  const endUtc = dtLocalToUtc($('#res-end').value);
  $('#res-conflict').innerHTML = '';
  try {
    const r = await api('POST', '/api/reservations', {
      batchNo,
      publicationId,
      startUtc,
      endUtc,
    });
    await refresh(
      r.status === 'cancelled'
        ? `批次号「${r.batchNo}」的预约此前已取消，返回原记录（未重新占用）。`
        : `批次号「${r.batchNo}」预约已登记（占用 ${usageText(r.usage)}）。`,
    );
  } catch (e) {
    // 容量不足：展示冲突规格与时段
    const conflicts = e.data && e.data.detail && e.data.detail.conflicts;
    if (e.status === 409 && conflicts) {
      $('#res-conflict').innerHTML = `<div class="banner bad">
        <b>可选数量不足，本次预约未产生任何占用：</b>
        <ul>${conflicts
          .map(
            (c) =>
              `<li>规格 ${c.mass} g：本次需 ${c.required} 枚，当前可选 ${c.capacity} 枚；` +
              `冲突时段：${c.windows
                .map((w) => `${w.start} 至 ${w.end}（已占用 ${w.used} 枚）`)
                .join('；')}</li>`,
          )
          .join('')}</ul>
      </div>`;
      showAlert(e.message, 'err');
    } else {
      showAlert(e.message, 'err');
    }
  }
});

async function cancelReservation(id) {
  try {
    await api('POST', `/api/reservations/${id}/cancel`);
    await refresh(`预约 #${id} 已取消（历史保留，占用已释放）。`);
  } catch (e) {
    showAlert(e.message, 'err');
  }
}

// ---------- 配重块临时停用 ----------

const SUS_PHASE_LABEL = {
  notStarted: '未开始',
  ongoing: '生效中',
  ended: '已结束',
  revoked: '已撤销',
};

function renderSuspensions() {
  // 规格下拉：仅当前录入规格
  const sel = $('#sus-mass');
  const weights = (state.data && state.data.weights) || [];
  const prev = sel.value;
  sel.innerHTML = weights.length
    ? weights
        .map((w) => `<option value="${w.mass}">${fmt(w.mass)} g（库存 ${w.quantity} 枚）</option>`)
        .join('')
    : '<option value="">（请先在第 5 节录入配重规格）</option>';
  if (weights.some((w) => String(w.mass) === prev)) sel.value = prev;

  const box = $('#sus-list');
  const list = state.suspensions || [];
  if (list.length === 0) {
    box.innerHTML = '<div class="muted">暂无停用记录。</div>';
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="res-table">
    <thead><tr>
      <th>规格</th><th>停用数量</th><th>原因</th><th>时段（UTC，左闭右开）</th>
      <th>状态</th><th></th>
    </tr></thead><tbody>${list
      .map(
        (sp) => `<tr${sp.status === 'revoked' ? ' class="row-stale"' : ''}>
      <td><b>${fmt(sp.mass)} g</b></td>
      <td>${sp.quantity} 枚</td>
      <td>${escapeHtml(sp.reason)}</td>
      <td class="mono">${sp.startUtc}<br>至 ${sp.endUtc}</td>
      <td><span class="badge ${
        sp.status === 'revoked' ? 'stale' : sp.phase === 'ongoing' ? 'bad' : 'ok'
      }">${SUS_PHASE_LABEL[sp.phase]}</span></td>
      <td>${
        sp.revocable
          ? `<button data-sus-revoke="${sp.id}" class="danger">撤销停用</button>`
          : ''
      }</td>
    </tr>`,
      )
      .join('')}</tbody></table></div>`;
  box.querySelectorAll('[data-sus-revoke]').forEach((b) =>
    b.addEventListener('click', () => revokeSuspension(Number(b.dataset.susRevoke))),
  );
}

$('#sus-submit').addEventListener('click', async () => {
  const mass = Number($('#sus-mass').value);
  const quantity = Number($('#sus-qty').value);
  const reason = $('#sus-reason').value.trim();
  const startUtc = $('#sus-start').value || '';
  const endUtc = $('#sus-end').value || '';
  $('#sus-conflict').innerHTML = '';
  try {
    const r = await api('POST', '/api/suspensions', {
      mass,
      quantity,
      reason,
      startUtc,
      endUtc,
    });
    $('#sus-qty').value = '';
    $('#sus-reason').value = '';
    await refresh(
      `停用已登记：${fmt(r.mass)} g × ${r.quantity}（${r.startUtc} 至 ${r.endUtc}）。`,
    );
  } catch (e) {
    const conflicts = e.data && e.data.detail && e.data.detail.conflicts;
    if (e.status === 409 && conflicts) {
      $('#sus-conflict').innerHTML = `<div class="banner bad">
        <b>停用量超出当前库存，停用未登记：</b>
        <ul>${conflicts
          .map(
            (c) =>
              `<li>规格 ${c.mass} g：本次停用 ${c.required} 枚，当前库存 ${c.capacity} 枚；` +
              `冲突时段：${c.windows
                .map((w) => `${w.start} 至 ${w.end}（已停用 ${w.suspended} 枚）`)
                .join('；')}</li>`,
          )
          .join('')}</ul>
      </div>`;
    }
    showAlert(e.message, 'err');
  }
});

async function revokeSuspension(id) {
  try {
    await api('POST', `/api/suspensions/${id}/revoke`);
    await refresh(`停用 #${id} 已撤销（历史保留，后续容量已释放）。`);
  } catch (e) {
    showAlert(e.message, 'err');
  }
}

// ---------- 离心运行 ----------

const RUN_STATUS_LABEL = {
  running: '进行中',
  overrunning: '进行中（已超预约终点）',
  completed: '已完成',
  aborted: '已中止',
};

function renderRuns() {
  // 核验下拉：仅展示已完成核验（未完成草稿不能开始运行）
  const verSel = $('#run-ver');
  const verList = (state.verifications || []).filter((v) => v.completed);
  const verPrev = verSel.value;
  verSel.innerHTML = verList.length
    ? verList
        .map(
          (v) =>
            `<option value="${v.id}">核验 #${v.id}（发布图 #${v.publicationId}，已通过）</option>`,
        )
        .join('')
    : '<option value="">（暂无已完成核验）</option>';
  if (verList.some((v) => String(v.id) === verPrev)) verSel.value = verPrev;

  // 预约下拉：仅展示生效中预约（已取消不能开始运行）
  const resSel = $('#run-res');
  const resList = (state.reservations || []).filter((r) => r.status === 'active');
  const resPrev = resSel.value;
  resSel.innerHTML = resList.length
    ? resList
        .map(
          (r) =>
            `<option value="${r.id}">预约 #${r.id}（批次 ${r.batchNo}，图 #${r.publicationId}，${r.startUtc} 至 ${r.endUtc}）</option>`,
        )
        .join('')
    : '<option value="">（暂无生效中预约）</option>';
  if (resList.some((r) => String(r.id) === resPrev)) resSel.value = resPrev;

  const box = $('#run-list');
  const list = state.runs || [];
  if (list.length === 0) {
    box.innerHTML = '<div class="muted">暂无运行记录。</div>';
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="res-table">
    <thead><tr>
      <th>运行编号</th><th>设备</th><th>状态</th><th>超时</th>
      <th>开始 / 结束（UTC，服务端记录）</th><th>核验 / 预约 / 发布图</th>
      <th>依据图当前可用</th><th></th>
    </tr></thead><tbody>${list
      .map(
        (r) => `<tr${r.status === 'aborted' ? ' class="row-stale"' : ''}>
      <td><b>${escapeHtml(r.runNo)}</b></td>
      <td>${escapeHtml(r.deviceNo)}</td>
      <td><span class="badge ${
        r.status === 'running'
          ? r.phase === 'overrunning'
            ? 'bad'
            : 'ok'
          : r.status === 'completed'
            ? 'ok'
            : 'stale'
      }">${RUN_STATUS_LABEL[r.phase === 'overrunning' ? 'overrunning' : r.status]}</span></td>
      <td>${
        r.timedOut
          ? '<span class="badge bad">⏱ 超时完结</span>'
          : r.status === 'running'
            ? '<span class="muted">—</span>'
            : '<span class="tag-ok">按时</span>'
      }</td>
      <td class="mono">${r.startUtc}<br>${r.endedAt ? `至 ${r.endedAt}` : '（进行中）'}</td>
      <td class="mono">核验 #${r.verificationId}<br>预约 #${r.reservationId}
        （${r.frozenBasis.reservationCurrentStatus === 'cancelled' ? '后已取消' : '生效中'}）<br>
        发布图 #${r.publicationId}</td>
      <td>${
        r.frozenBasis.publication.currentlyUsable
          ? '<span class="tag-ok">✓ 可用</span>'
          : '<span class="tag-bad">✗ 已失效（历史冻结不变）</span>'
      }</td>
      <td style="white-space:nowrap">
        <button data-run-view="${r.id}">查看冻结依据</button>
        ${
          r.status === 'running'
            ? `<button data-run-complete="${r.id}" class="primary">完成</button>
               <button data-run-abort="${r.id}" class="danger">中止</button>`
            : ''
        }
      </td>
    </tr>`,
      )
      .join('')}</tbody></table></div>`;
  box.querySelectorAll('[data-run-view]').forEach((b) =>
    b.addEventListener('click', () => openRun(Number(b.dataset.runView))),
  );
  box.querySelectorAll('[data-run-complete]').forEach((b) =>
    b.addEventListener('click', () => completeRun(Number(b.dataset.runComplete), 'completed')),
  );
  box.querySelectorAll('[data-run-abort]').forEach((b) =>
    b.addEventListener('click', () => completeRun(Number(b.dataset.runAbort), 'aborted')),
  );
}

$('#run-start').addEventListener('click', async () => {
  const body = {
    runNo: $('#run-no').value.trim(),
    deviceNo: $('#run-device').value.trim(),
    verificationId: Number($('#run-ver').value),
    reservationId: Number($('#run-res').value),
  };
  $('#run-conflict').innerHTML = '';
  try {
    const r = await api('POST', '/api/runs', body);
    $('#run-no').value = '';
    $('#run-device').value = '';
    await refresh(
      `运行「${r.runNo}」已提交（#${r.id}，状态：${
        r.status === 'running' ? '进行中' : r.status === 'completed' ? '已完成' : '已中止'
      }）：发布图、核验结论与预约时段已冻结。`,
    );
  } catch (e) {
    $('#run-conflict').innerHTML = `<div class="banner bad">
      <b>运行未能开始（事务已回滚，未留记录）：</b>
      <ul>${(e.data && e.data.errors ? e.data.errors : [e.message])
        .map((x) => `<li>${escapeHtml(x)}</li>`)
        .join('')}</ul>
    </div>`;
    showAlert(e.message, 'err');
  }
});

async function completeRun(id, outcome) {
  const label = outcome === 'completed' ? '完成' : '中止';
  try {
    const r = await api('POST', `/api/runs/${id}/complete`, { outcome });
    await refresh(
      `运行「${r.runNo}」已${label}（#${id}）${
        r.timedOut ? '，已标记超时（超过预约终点）' : ''
      }；设备已释放。`,
    );
  } catch (e) {
    showAlert(e.message, 'err');
  }
}

async function openRun(id) {
  const r = await api('GET', `/api/runs/${id}`);
  $('#run-title').textContent = `离心运行 #${r.id}（${r.runNo}）`;
  const fb = r.frozenBasis;
  const resStatus =
    fb.reservationCurrentStatus === 'cancelled'
      ? '<span class="badge stale">预约后已取消（运行历史不改写）</span>'
      : '<span class="badge ok">预约生效中</span>';
  $('#run-detail').innerHTML = `
    <div class="actions" style="margin-top:0">
      <span class="badge ${
        r.status === 'running' ? 'ok' : r.status === 'completed' ? 'ok' : 'stale'
      }">${RUN_STATUS_LABEL[r.phase === 'overrunning' ? 'overrunning' : r.status]}</span>
      ${
        r.timedOut
          ? '<span class="badge bad">⏱ 超过预约终点完结（超时）</span>'
          : r.status === 'running'
            ? ''
            : '<span class="badge ok">未超时</span>'
      }
      ${fb.publication.currentlyUsable ? '' : '<span class="badge bad">依据发布图当前已失效（冻结内容不变）</span>'}
    </div>
    <p class="muted">设备：<b>${escapeHtml(r.deviceNo)}</b></p>
    <p class="muted mono">开始：${r.startUtc}<br>结束：${r.endedAt || '（进行中，服务端记录结束时间）'}</p>
    <h3>冻结的发布图依据</h3>
    <p class="muted mono">发布记录 #${fb.publication.id} · sha256:${fb.publication.basisHash} · 可行：${
      fb.publication.feasible ? '是' : '否'
    }</p>
    ${arrangementHtml(fb.publication.result)}
    <h3>冻结的核验结论</h3>
    <p class="muted">核验 #${fb.verification.id}：${
      fb.verification.passed
        ? '<span class="tag-ok">✓ 核验通过（开始时已完成并冻结）</span>'
        : '<span class="tag-bad">✗ 未通过</span>'
    } · 实测对径差和 ${fmt(fb.verification.diffSum)} g · 实测总质量 ${fmt(
      fb.verification.massSum,
    )} g</p>
    ${
      fb.verification.checks
        ? `<table class="pair-list">
      <thead><tr><th>对径孔对</th><th>A 侧实测</th><th>B 侧实测</th><th>差值</th><th>冻结容差判定</th></tr></thead>
      <tbody>${fb.verification.checks.pairs
        .map(
          (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
          <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
          <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
            p.withinTolerance ? '✓ 合格' : '✗ 超限'
          }</td></tr>`,
        )
        .join('')}</tbody></table>`
        : ''
    }
    <h3>冻结的预约时段</h3>
    <div class="actions" style="margin-top:0">${resStatus}</div>
    <p class="muted mono">预约 #${fb.reservation.id}：[${fb.reservation.startUtc}, ${
      fb.reservation.endUtc})（左闭右开）<br>
      冻结占用规格：${escapeHtml(usageText(fb.reservation.usage))}</p>
    <h3>冻结的校准依据</h3>
    ${
      fb.calibration
        ? `<p class="muted mono">校准记录 #${fb.calibration.id}（${escapeHtml(
            fb.calibration.calibNo,
          )}）：${
            fb.calibration.passed
              ? '<span class="tag-ok">✓ 合格</span>'
              : '<span class="tag-bad">✗ 不合格</span>'
          }<br>
            校准时间 ${fb.calibration.calibratedAt}，到期时间 ${fb.calibration.expiresAt}
            （开始时已确认不早于预约终点；之后新增记录不改写此处）</p>`
        : '<p class="muted">开始时该设备无校准记录（无记录设备沿用原开始规则）。</p>'
    }
    <details class="snapshot-block">
      <summary>冻结的发布图配置快照</summary>
      <pre>${escapeHtml(JSON.stringify(fb.publication.config, null, 2))}</pre>
    </details>
    ${
      r.status === 'running'
        ? `<div class="actions">
             <button id="run-detail-complete" class="primary">完结：完成</button>
             <button id="run-detail-abort" class="danger">完结：中止</button>
           </div>`
        : ''
    }`;
  const c = $('#run-detail-complete');
  if (c) c.addEventListener('click', () => { $('#run-dialog').close(); completeRun(id, 'completed'); });
  const a = $('#run-detail-abort');
  if (a) a.addEventListener('click', () => { $('#run-dialog').close(); completeRun(id, 'aborted'); });
  $('#run-dialog').showModal();
}
$('#run-detail-close').addEventListener('click', () => $('#run-dialog').close());

// ---------- 设备保养 ----------

function renderDevices() {
  const devs = state.devices || [];
  // 已知设备编号下拉提示（供上限设置与保养登记两个表单共用）
  $('#known-devices').innerHTML = devs
    .map((d) => `<option value="${escapeHtml(d.deviceNo)}">`)
    .join('');

  const box = $('#dev-list');
  if (devs.length === 0) {
    box.innerHTML =
      '<div class="muted">暂无设备记录（开始运行、设置上限或登记保养后在此呈现）。</div>';
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="res-table">
    <thead><tr>
      <th>设备编号</th><th>当前状态</th><th>最新校准</th><th>保养上限</th><th>本周期已用（已完结）</th>
      <th>剩余额度</th><th>待保养</th><th>最近保养（UTC）</th>
    </tr></thead><tbody>${devs
      .map(
        (d) => `<tr${d.maintenanceDue ? ' class="row-bad"' : ''}>
      <td><b>${escapeHtml(d.deviceNo)}</b></td>
      <td>${
        d.running
          ? `<span class="badge ok">运行中（#${d.activeRunId} ${escapeHtml(d.activeRunNo)}）</span>`
          : '<span class="muted">空闲</span>'
      }</td>
      <td>${calibrationCell(d.latestCalibration)}</td>
      <td>${d.limitSeconds != null ? `${d.limitSeconds} 秒` : '<span class="muted">未设置</span>'}</td>
      <td>${d.usedSeconds} 秒（${d.countedRuns} 次）</td>
      <td>${
        d.remainingSeconds != null
          ? `<span class="${d.remainingSeconds <= 0 ? 'tag-bad' : ''}">${d.remainingSeconds} 秒</span>`
          : '<span class="muted">—</span>'
      }</td>
      <td>${
        d.limitSeconds == null
          ? '<span class="muted">—（未设上限）</span>'
          : d.maintenanceDue
            ? '<span class="badge bad">⚠ 待保养（达到上限，新运行将被拒绝）</span>'
            : '<span class="tag-ok">✓ 未到期</span>'
      }</td>
      <td class="mono">${d.lastMaintenanceAt || '<span class="muted">从未保养</span>'}</td>
    </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

// 设备表中的最新校准单元格：合格/不合格/已到期/无记录
function calibrationCell(c) {
  if (!c) return '<span class="muted">无校准记录（沿用原开始规则）</span>';
  const label =
    c.phase === 'valid'
      ? '<span class="tag-ok">✓ 合格</span>'
      : c.phase === 'failed'
        ? '<span class="tag-bad">✗ 不合格（拒绝放行）</span>'
        : '<span class="badge bad">已到期（按预约终点复核）</span>';
  return `<div>${label}</div><div class="muted mono" style="font-size:12px">` +
    `${escapeHtml(c.calibNo)}<br>至 ${c.expiresAt}</div>`;
}

function renderMaintenances() {
  const box = $('#maint-list');
  const list = state.maintenances || [];
  if (list.length === 0) {
    box.innerHTML = '<div class="muted">暂无保养记录。</div>';
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="res-table">
    <thead><tr>
      <th>保养单号</th><th>设备编号</th><th>原因</th><th>登记时间（UTC，新周期起点）</th>
    </tr></thead><tbody>${list
      .map(
        (m) => `<tr>
      <td><b>${escapeHtml(m.maintNo)}</b></td>
      <td>${escapeHtml(m.deviceNo)}</td>
      <td>${escapeHtml(m.reason)}</td>
      <td class="mono">${m.createdAt}</td>
    </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

$('#dev-limit-save').addEventListener('click', async () => {
  const deviceNo = $('#dev-limit-device').value.trim();
  const limitSeconds = Number($('#dev-limit-seconds').value);
  try {
    const d = await api('PUT', `/api/devices/${encodeURIComponent(deviceNo)}/limit`, {
      limitSeconds,
    });
    await refresh(
      `设备「${d.deviceNo}」保养上限已设为 ${d.limitSeconds} 秒（仅影响后续开始判定，历史不改写）。`,
    );
  } catch (e) {
    showAlert(e.message, 'err');
  }
});

$('#dev-limit-clear').addEventListener('click', async () => {
  const deviceNo = $('#dev-limit-device').value.trim();
  if (!deviceNo) return showAlert('请先填写要清除上限的设备编号。', 'err');
  try {
    const d = await api('DELETE', `/api/devices/${encodeURIComponent(deviceNo)}/limit`);
    await refresh(`设备「${d.deviceNo}」的保养上限已清除，恢复为不核对额度的原行为。`);
  } catch (e) {
    showAlert(e.message, 'err');
  }
});

$('#maint-submit').addEventListener('click', async () => {
  const body = {
    maintNo: $('#maint-no').value.trim(),
    deviceNo: $('#maint-device').value.trim(),
    reason: $('#maint-reason').value.trim(),
  };
  $('#maint-conflict').innerHTML = '';
  try {
    const m = await api('POST', '/api/maintenances', body);
    $('#maint-no').value = '';
    $('#maint-reason').value = '';
    await refresh(
      `保养「${m.maintNo}」已登记（设备「${m.deviceNo}」自 ${m.createdAt} 起开启新累计周期）。`,
    );
  } catch (e) {
    $('#maint-conflict').innerHTML = `<div class="banner bad">
      <b>保养未能登记（未留记录）：</b>
      <ul>${(e.data && e.data.errors ? e.data.errors : [e.message])
        .map((x) => `<li>${escapeHtml(x)}</li>`)
        .join('')}</ul>
    </div>`;
    showAlert(e.message, 'err');
  }
});

// ---------- 设备校准 ----------

const CALIB_PHASE_LABEL = {
  valid: '<span class="tag-ok">✓ 合格（有效期内）</span>',
  failed: '<span class="tag-bad">✗ 不合格</span>',
  expired: '<span class="badge bad">⏱ 合格但已到期</span>',
};

function renderCalibrations() {
  const box = $('#calib-list');
  const list = state.calibrations || [];
  if (list.length === 0) {
    box.innerHTML = '<div class="muted">暂无校准记录。</div>';
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table class="res-table">
    <thead><tr>
      <th>校准单号</th><th>设备编号</th><th>结论</th><th>校准时间（UTC）</th>
      <th>到期时间（UTC）</th><th>状态</th>
    </tr></thead><tbody>${list
      .map(
        (c) => `<tr>
      <td><b>${escapeHtml(c.calibNo)}</b></td>
      <td>${escapeHtml(c.deviceNo)}</td>
      <td>${c.passed ? '合格' : '<span class="tag-bad">不合格</span>'}</td>
      <td class="mono">${c.calibratedAt}</td>
      <td class="mono">${c.expiresAt}</td>
      <td>${CALIB_PHASE_LABEL[c.phase] || c.phase}</td>
    </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

$('#calib-submit').addEventListener('click', async () => {
  const body = {
    calibNo: $('#calib-no').value.trim(),
    deviceNo: $('#calib-device').value.trim(),
    calibratedAt: dtLocalToUtc($('#calib-at').value),
    expiresAt: dtLocalToUtc($('#calib-expires').value),
    passed: $('#calib-passed').value === 'true',
  };
  $('#calib-conflict').innerHTML = '';
  try {
    const c = await api('POST', '/api/calibrations', body);
    $('#calib-no').value = '';
    await refresh(
      `校准记录「${c.calibNo}」（设备「${c.deviceNo}」）已登记：` +
        `${c.passed ? '合格' : '不合格'}，有效期至 ${c.expiresAt}（UTC）。`,
    );
  } catch (e) {
    $('#calib-conflict').innerHTML = `<div class="banner bad">
      <b>校准未能登记（未留记录）：</b>
      <ul>${(e.data && e.data.errors ? e.data.errors : [e.message])
        .map((x) => `<li>${escapeHtml(x)}</li>`)
        .join('')}</ul>
    </div>`;
    showAlert(e.message, 'err');
  }
});

// ---------- 启动 ----------

refresh().catch((e) => showAlert('初始化失败：' + e.message, 'err'));
