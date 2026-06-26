/* ===========================================================================
   Murdoku Studio — a puzzle maker for Murdoku creators.

   Murdoku model (from murdoku.com / murdoku.fans):
   - An R×C crime-scene grid. Every PERSON (suspects + the one victim) sits in a
     cell. Row/Column constraint: at most one person per row and per column.
   - The grid is divided into named, colored REGIONS. OBJECTS (shelf, bed, chair…)
     sit on cells and are referenced by clues.
   - Each suspect carries ONE clue card. The victim's card is the murder condition:
     "alone with the murderer" — the victim shares a region with exactly one
     suspect, and that suspect is the murderer. There may also be GENERAL clues
     that aren't tied to any single suspect.
   - Clues are authored as free text; the tool validates the board (placement,
     row/column rule, murder condition) and derives the murderer.
   =========================================================================== */
'use strict';

/* ----------------------------- constants -------------------------------- */
const REGION_COLORS = [
  '#fbe7c2', '#d8edcb', '#e6dcf0', '#d6f0ea',
  '#f7d9e7', '#cdeeec', '#dfe6ef', '#f3e1c4',
  '#e9e3d4', '#f6ddd0',
];
const TOKEN_COLORS = [
  '#efc85a', '#83b86c', '#9f8bb9', '#4dc3bf',
  '#df86ad', '#5f9fce', '#e7916b', '#7bc6a0',
];
// occupiable = a person can stand on this object's cell (else it's scenery to sit beside)
const DEFAULT_OBJECTS = [
  { type: 'shelf', emoji: '📚', occupiable: false }, { type: 'bed', emoji: '🛏️', occupiable: true },
  { type: 'chair', emoji: '🪑', occupiable: true }, { type: 'TV', emoji: '📺', occupiable: false },
  { type: 'sofa', emoji: '🛋️', occupiable: true }, { type: 'table', emoji: '🍽️', occupiable: true },
  { type: 'plant', emoji: '🪴', occupiable: false }, { type: 'register', emoji: '💰', occupiable: false },
  { type: 'easel', emoji: '🎨', occupiable: false }, { type: 'painting', emoji: '🖼️', occupiable: false },
  { type: 'door', emoji: '🚪', occupiable: false }, { type: 'box', emoji: '📦', occupiable: false },
  { type: 'car', emoji: '🚗', occupiable: false }, { type: 'tree', emoji: '🌳', occupiable: false },
  { type: 'flowers', emoji: '💐', occupiable: false }, { type: 'statue', emoji: '🗿', occupiable: false },
];
const PRON = {
  he: { subj: 'He', verb: 'was' },
  she: { subj: 'She', verb: 'was' },
  they: { subj: 'They', verb: 'were' },
};

/* ----------------------------- state ------------------------------------ */
let S; // current case
let sel = { regionId: null, objType: null, personId: null };
let mode = 'region';

const $ = (id) => document.getElementById(id);
const key = (r, c) => r + ',' + c;
const uid = (() => { let n = 0; return (p) => p + '_' + (Date.now().toString(36)) + (n++); })();

function blankCase() {
  return {
    id: uid('case'), title: 'Untitled Case',
    rows: 6, cols: 6,
    regions: [], cellRegion: {}, objects: [],
    objectTypes: [],
    people: [], generalClues: [],
  };
}

/* ----------------------------- helpers ---------------------------------- */
const inGrid = (r, c) => r >= 0 && r < S.rows && c >= 0 && c < S.cols;
const regionAt = (r, c) => S.cellRegion[key(r, c)] || null;
const regionById = (id) => S.regions.find((x) => x.id === id);
const personById = (id) => S.people.find((p) => p.id === id);
const victim = () => S.people.find((p) => p.isVictim);
const suspects = () => S.people.filter((p) => !p.isVictim);
const placed = (p) => p && p.r != null && p.c != null;
const objTypeMeta = (t) => S.objectTypes.find((o) => o.type === t) || { type: t, emoji: '❓' };
const nameOf = (id) => { const p = personById(id); return p ? p.name : '?'; };
const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const defaultVictimClue = (p) => { const pr = PRON[p.gender] || PRON.they; return `${pr.subj} ${pr.verb} alone with the murderer.`; };

function objectsAt(r, c) { return S.objects.filter((o) => o.r === r && o.c === c).map((o) => o.type); }
function personAt(r, c) { return S.people.find((p) => p.r === r && p.c === c); }
function regionName(id) { const g = regionById(id); return g ? g.name : '(no region)'; }

/* derive the murderer purely from placement. */
function murdererFromPlacement() {
  const v = victim();
  if (!placed(v)) return { state: 'no-victim' };
  const vr = regionAt(v.r, v.c);
  if (!vr) return { state: 'victim-no-region' };
  const inRoom = suspects().filter((p) => placed(p) && regionAt(p.r, p.c) === vr);
  if (inRoom.length === 1) return { state: 'ok', murderer: inRoom[0], region: vr };
  return { state: inRoom.length === 0 ? 'empty' : 'crowded', count: inRoom.length, region: vr };
}

/* ============================== RENDER =================================== */
function render() {
  renderGrid();
  renderRegions();
  renderObjects();
  renderPeople();
  renderGeneralClues();
  renderClues();
  renderValidation();
  $('scene-title').value = S.title;
  $('rows').value = S.rows;
  $('cols').value = S.cols;
  document.querySelectorAll('.tool').forEach((t) =>
    t.setAttribute('aria-pressed', t.dataset.mode === mode));
  const hints = {
    region: sel.regionId ? `Click or drag cells to paint them <b>${regionName(sel.regionId)}</b>.` : 'Add &amp; select a region, then paint cells.',
    object: sel.objType ? `Click cells to drop a <b>${sel.objType}</b>. Click an existing one to remove it.` : 'Select an object above, then click cells.',
    character: sel.personId ? `Click a cell to place <b>${nameOf(sel.personId)}</b>. Click them again to pick them up.` : 'Select a person, then click a cell to place.',
    erase: 'Click a cell to clear its object, person, or region.',
  };
  $('active-tool-hint').innerHTML = hints[mode] || '';
}

function renderGrid() {
  const g = $('grid');
  const cell = Math.max(46, Math.min(94, Math.floor(640 / Math.max(S.rows, S.cols))));
  g.style.setProperty('--cell', cell + 'px');
  g.style.gridTemplateColumns = `26px repeat(${S.cols}, var(--cell))`;
  g.style.gridTemplateRows = `26px repeat(${S.rows}, var(--cell))`;
  g.innerHTML = '';

  const corner = document.createElement('div');
  corner.className = 'cell coord-label'; g.appendChild(corner);
  for (let c = 0; c < S.cols; c++) {
    const h = document.createElement('div');
    h.className = 'cell coord-label'; h.textContent = c + 1; g.appendChild(h);
  }
  for (let r = 0; r < S.rows; r++) {
    const rh = document.createElement('div');
    rh.className = 'cell coord-label'; rh.textContent = r + 1; g.appendChild(rh);
    for (let c = 0; c < S.cols; c++) {
      const d = document.createElement('div');
      d.className = 'cell';
      const reg = regionAt(r, c);
      if (reg && regionById(reg)) d.style.background = regionById(reg).color;
      d.dataset.r = r; d.dataset.c = c;

      const objs = objectsAt(r, c);
      if (objs.length) {
        const o = document.createElement('div'); o.className = 'obj';
        o.textContent = objs.map((t) => objTypeMeta(t).emoji).join('');
        d.appendChild(o);
      }
      const per = personAt(r, c);
      if (per) {
        const t = document.createElement('div');
        t.className = 'token' + (per.isVictim ? ' victim' : '');
        t.style.background = per.color;
        t.textContent = per.isVictim ? '💀' : initials(per.name);
        t.title = per.name;
        d.appendChild(t);
      }
      g.appendChild(d);
    }
  }
}

/* a styled <input type=color> used as the editable swatch */
function colorInput(value, round, onInput, onChange) {
  const inp = document.createElement('input');
  inp.type = 'color'; inp.value = value || '#cccccc';
  inp.className = 'swatch-input' + (round ? ' round' : '');
  inp.onclick = (e) => e.stopPropagation();
  inp.oninput = () => onInput(inp.value);
  inp.onchange = () => onChange && onChange(inp.value);
  return inp;
}

function renderRegions() {
  const host = $('region-list'); host.innerHTML = '';
  if (!S.regions.length) host.innerHTML = '<div class="empty">No regions yet.</div>';
  S.regions.forEach((g) => {
    const row = document.createElement('div');
    row.className = 'row-item' + (sel.regionId === g.id && mode === 'region' ? ' selected' : '');
    row.appendChild(colorInput(g.color, false,
      (v) => { g.color = v; renderGrid(); },
      (v) => { g.color = v; save(); }));
    const nm = document.createElement('div'); nm.className = 'name';
    const inp = document.createElement('input'); inp.value = g.name;
    inp.onchange = () => { g.name = inp.value || 'Region'; save(); renderClues(); renderValidation(); };
    inp.onclick = (e) => e.stopPropagation();
    nm.appendChild(inp); row.appendChild(nm);
    const cnt = Object.values(S.cellRegion).filter((x) => x === g.id).length;
    const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = cnt + ' cells';
    row.appendChild(meta);
    const gi = S.regions.indexOf(g);
    row.appendChild(reorderCtrl(
      gi > 0 ? () => { arrMove(S.regions, gi, gi - 1); save(); render(); } : null,
      gi < S.regions.length - 1 ? () => { arrMove(S.regions, gi, gi + 1); save(); render(); } : null));
    row.appendChild(mkX(() => {
      S.regions = S.regions.filter((x) => x.id !== g.id);
      for (const k in S.cellRegion) if (S.cellRegion[k] === g.id) delete S.cellRegion[k];
      if (sel.regionId === g.id) sel.regionId = null; save(); render();
    }));
    row.onclick = () => { sel.regionId = g.id; mode = 'region'; render(); };
    host.appendChild(row);
  });
}

function renderObjects() {
  renderObjectList('object-list-occ', true);
  renderObjectList('object-list-non', false);
}
function renderObjectList(hostId, occupiable) {
  const host = $(hostId); host.innerHTML = '';
  const cat = S.objectTypes.filter((o) => !!o.occupiable === occupiable);
  if (!cat.length) { host.innerHTML = '<div class="empty">None yet.</div>'; return; }
  cat.forEach((o, ci) => {
    const row = document.createElement('div');
    row.className = 'row-item' + (sel.objType === o.type && mode === 'object' ? ' selected' : '');
    const em = document.createElement('span'); em.className = 'emoji'; em.textContent = o.emoji; row.appendChild(em);
    const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = o.type; row.appendChild(nm);
    const cnt = S.objects.filter((x) => x.type === o.type).length;
    if (cnt) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = cnt + ' placed'; row.appendChild(m); }
    row.appendChild(reorderCtrl(
      ci > 0 ? () => moveObjectType(o, -1) : null,
      ci < cat.length - 1 ? () => moveObjectType(o, 1) : null));
    row.appendChild(mkX(() => {
      S.objectTypes = S.objectTypes.filter((x) => x !== o);
      S.objects = S.objects.filter((x) => x.type !== o.type);
      if (sel.objType === o.type) sel.objType = null;
      save(); render();
    }));
    row.onclick = () => { sel.objType = o.type; mode = 'object'; render(); };
    host.appendChild(row);
  });
}
function moveObjectType(item, dir) {
  const cat = S.objectTypes.filter((o) => !!o.occupiable === !!item.occupiable);
  const target = cat[cat.indexOf(item) + dir]; if (!target) return;
  const ai = S.objectTypes.indexOf(item), bi = S.objectTypes.indexOf(target);
  [S.objectTypes[ai], S.objectTypes[bi]] = [S.objectTypes[bi], S.objectTypes[ai]];
  save(); render();
}

function renderPeople() {
  const host = $('people-list'); host.innerHTML = '';
  if (!S.people.length) host.innerHTML = '<div class="empty">No people yet. Add suspects and mark one victim.</div>';
  S.people.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'row-item' + (sel.personId === p.id && mode === 'character' ? ' selected' : '') + (p.isVictim ? ' victim-row' : '');
    row.appendChild(colorInput(p.color, true,
      (v) => { p.color = v; renderGrid(); },
      (v) => { p.color = v; save(); renderClues(); }));
    const nm = document.createElement('div'); nm.className = 'name';
    const inp = document.createElement('input'); inp.value = p.name;
    inp.onclick = (e) => e.stopPropagation();
    inp.onchange = () => { p.name = inp.value || 'Suspect'; save(); render(); };
    nm.appendChild(inp); row.appendChild(nm);

    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = placed(p) ? `R${p.r + 1}·C${p.c + 1}` : 'unplaced';
    row.appendChild(meta);

    const pi = S.people.indexOf(p);
    row.appendChild(reorderCtrl(
      pi > 0 ? () => { arrMove(S.people, pi, pi - 1); save(); render(); } : null,
      pi < S.people.length - 1 ? () => { arrMove(S.people, pi, pi + 1); save(); render(); } : null));

    const vbtn = document.createElement('button');
    vbtn.className = 'btn ghost sm'; vbtn.title = 'Mark as victim';
    vbtn.textContent = p.isVictim ? '💀' : '🩸';
    vbtn.onclick = (e) => {
      e.stopPropagation();
      S.people.forEach((q) => q.isVictim = false);
      p.isVictim = true;
      save(); render();
    };
    row.appendChild(vbtn);

    row.appendChild(mkX(() => {
      S.people = S.people.filter((x) => x.id !== p.id);
      if (sel.personId === p.id) sel.personId = null; save(); render();
    }));
    row.onclick = () => { sel.personId = p.id; mode = 'character'; render(); };
    host.appendChild(row);
  });
}

function renderGeneralClues() {
  const host = $('general-clue-list'); host.innerHTML = '';
  if (!S.generalClues.length) { host.innerHTML = '<div class="empty">No general clues yet.</div>'; return; }
  S.generalClues.forEach((txt, i) => {
    const row = document.createElement('div'); row.className = 'general-row';
    const idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = (i + 1) + '.'; row.appendChild(idx);
    const inp = document.createElement('input'); inp.type = 'text'; inp.value = txt;
    inp.oninput = () => { S.generalClues[i] = inp.value; saveSoon(); };
    inp.onchange = () => { S.generalClues[i] = inp.value; save(); };
    row.appendChild(inp);
    row.appendChild(reorderCtrl(
      i > 0 ? () => { arrMove(S.generalClues, i, i - 1); save(); renderGeneralClues(); } : null,
      i < S.generalClues.length - 1 ? () => { arrMove(S.generalClues, i, i + 1); save(); renderGeneralClues(); } : null));
    row.appendChild(mkX(() => { S.generalClues.splice(i, 1); save(); renderGeneralClues(); }));
    host.appendChild(row);
  });
}

function renderClues() {
  const host = $('clue-list'); host.innerHTML = '';
  const v = victim();
  if (v) host.appendChild(clueCardEl(v, true));
  const subs = suspects();
  if (!subs.length) { host.insertAdjacentHTML('beforeend', '<div class="empty">Add suspects to write clue cards.</div>'); return; }
  for (const p of subs) host.appendChild(clueCardEl(p, false));
}

function clueCardEl(p, isVictim) {
  const card = document.createElement('div');
  card.className = 'clue-card' + (isVictim ? ' victim' : '');
  const who = document.createElement('div'); who.className = 'who';
  const tok = document.createElement('span'); tok.className = 'token';
  tok.style.background = p.color;
  tok.textContent = isVictim ? '💀' : initials(p.name);
  who.appendChild(tok);
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name; who.appendChild(nm);
  if (isVictim) { const r = document.createElement('span'); r.className = 'role'; r.textContent = 'victim'; who.appendChild(r); }
  card.appendChild(who);

  if (isVictim) {
    // the victim's card is the fixed murder condition — auto-generated, not editable
    const txt = document.createElement('div'); txt.className = 'text';
    txt.textContent = defaultVictimClue(p);
    card.appendChild(txt);
    const note = document.createElement('div'); note.className = 'note'; note.style.marginTop = '6px';
    note.textContent = 'Auto-generated · the murder condition';
    card.appendChild(note);
  } else {
    const ta = document.createElement('textarea');
    ta.value = p.clue || '';
    ta.placeholder = `Write ${p.name}'s clue…`;
    ta.oninput = () => { p.clue = ta.value; saveSoon(); };
    ta.onchange = () => { p.clue = ta.value; save(); renderValidation(); };
    card.appendChild(ta);
  }
  return card;
}

function renderValidation() {
  const checks = $('checks'); checks.innerHTML = '';
  const verdict = $('verdict');
  const add = (cls, badge, label, sub) => {
    const d = document.createElement('div'); d.className = 'check ' + cls;
    d.innerHTML = `<span class="badge">${badge}</span><div>${label}${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
    checks.appendChild(d);
  };

  const subs = suspects(); const v = victim();
  const allPlaced = S.people.length > 0 && S.people.every(placed);

  if (!v) add('err', '✗', 'No victim marked', 'Use the 🩸 button next to a person.');
  else add('ok', '✓', `Victim: ${v.name}`);
  if (subs.length === 0) add('warn', '!', 'No suspects yet');
  else add('ok', '✓', `${subs.length} suspect${subs.length > 1 ? 's' : ''}`);

  const unplaced = S.people.filter((p) => !placed(p));
  if (unplaced.length) add('warn', '!', `${unplaced.length} person(s) not on the board`, unplaced.map((p) => p.name).join(', '));
  else if (S.people.length) add('ok', '✓', 'Everyone placed');

  const rowsUsed = {}, colsUsed = {}; let clash = false;
  for (const p of S.people) if (placed(p)) {
    rowsUsed[p.r] = (rowsUsed[p.r] || 0) + 1; colsUsed[p.c] = (colsUsed[p.c] || 0) + 1;
    if (rowsUsed[p.r] > 1 || colsUsed[p.c] > 1) clash = true;
  }
  if (clash) add('err', '✗', 'Row / column clash', 'Two people share a row or column.');
  else if (S.people.some(placed)) add('ok', '✓', 'Row & column constraint holds');

  const mur = murdererFromPlacement();
  if (mur.state === 'ok') add('ok', '✓', `Murder scene: ${regionName(mur.region)}`, `${mur.murderer.name} is alone with the victim.`);
  else if (mur.state === 'empty') add('err', '✗', 'No suspect with the victim', `Region ${regionName(mur.region)} has no suspect to accuse.`);
  else if (mur.state === 'crowded') add('err', '✗', `${mur.count} suspects with the victim`, 'Exactly one suspect must share the victim’s region.');
  else if (mur.state === 'victim-no-region') add('warn', '!', 'Victim is not in a region', 'Paint a region under the victim.');
  else if (mur.state === 'no-victim') add('warn', '!', 'Place the victim');

  const missing = subs.filter((p) => placed(p) && (!p.clue || !p.clue.trim()));
  if (missing.length) add('warn', '!', `${missing.length} suspect(s) have no clue written`, missing.map((p) => p.name).join(', '));
  else if (subs.length) add('ok', '✓', 'Every suspect has a clue');

  if (S.generalClues.filter((x) => x.trim()).length) add('ok', '✓', `${S.generalClues.filter((x) => x.trim()).length} general clue(s)`);

  // verdict
  let state = 'none', vtext = 'Set up your case';
  if (!v || !subs.length || !allPlaced) { state = 'multi'; vtext = 'Keep building…'; }
  else if (clash) { state = 'none'; vtext = 'Row / column clash'; }
  else if (mur.state === 'ok') { state = 'solved'; vtext = `Valid · ${mur.murderer.name} did it`; }
  else if (mur.state === 'crowded') { state = 'none'; vtext = `${mur.count} suspects with the victim`; }
  else if (mur.state === 'empty') { state = 'none'; vtext = 'No suspect with the victim'; }
  else { state = 'multi'; vtext = 'Victim needs a region'; }
  verdict.className = 'verdict ' + state;
  verdict.textContent = vtext;
}

function mkX(fn) {
  const b = document.createElement('button');
  b.className = 'btn ghost sm x'; b.textContent = '✕'; b.title = 'Remove';
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}

function arrMove(arr, from, to) { const x = arr.splice(from, 1)[0]; arr.splice(to, 0, x); }

/* up/down reorder control; pass null for a direction to disable it */
function reorderCtrl(up, down) {
  const wrap = document.createElement('div'); wrap.className = 'reorder';
  const mk = (txt, fn) => {
    const b = document.createElement('button'); b.className = 'ro'; b.type = 'button'; b.textContent = txt;
    b.disabled = !fn; b.onclick = (e) => { e.stopPropagation(); if (fn) fn(); };
    return b;
  };
  wrap.append(mk('▲', up), mk('▼', down));
  return wrap;
}

/* ============================ INTERACTION =============================== */
let painting = false;
function onCellPaint(r, c) {
  if (!inGrid(r, c)) return;
  if (mode === 'region') {
    if (!sel.regionId) { flash('Select or add a region first.'); return; }
    S.cellRegion[key(r, c)] = sel.regionId;
  } else if (mode === 'object') {
    if (!sel.objType) { flash('Select an object first.'); return; }
    const ex = S.objects.find((o) => o.r === r && o.c === c && o.type === sel.objType);
    if (ex) S.objects = S.objects.filter((o) => o !== ex);
    else S.objects.push({ id: uid('obj'), type: sel.objType, emoji: objTypeMeta(sel.objType).emoji, r, c });
  } else if (mode === 'character') {
    if (!sel.personId) { flash('Select a person first.'); return; }
    const p = personById(sel.personId);
    if (p.r === r && p.c === c) { p.r = p.c = null; }
    else {
      const occ = personAt(r, c);
      if (occ && occ.id !== p.id) { occ.r = occ.c = null; }
      p.r = r; p.c = c;
    }
  } else if (mode === 'erase') {
    S.objects = S.objects.filter((o) => !(o.r === r && o.c === c));
    const occ = personAt(r, c); if (occ) occ.r = occ.c = null;
    delete S.cellRegion[key(r, c)];
  }
  save(); render();
}

function bindGrid() {
  const g = $('grid');
  g.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.cell'); if (!cell || cell.dataset.r == null) return;
    painting = true; onCellPaint(+cell.dataset.r, +cell.dataset.c);
  });
  g.addEventListener('mouseover', (e) => {
    if (!painting || mode !== 'region') return;
    const cell = e.target.closest('.cell'); if (!cell || cell.dataset.r == null) return;
    onCellPaint(+cell.dataset.r, +cell.dataset.c);
  });
  window.addEventListener('mouseup', () => { painting = false; });
}

/* ============================ PERSISTENCE ===============================
   The working case is auto-saved to a single localStorage slot so a refresh
   doesn't lose work. There is no multi-case library. */
const LS_KEY = 'murdoku.case.v2';
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
function save() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...S })); } catch (e) { /* quota / private mode */ }
}
function loadCase(obj) {
  S = Object.assign(blankCase(), obj);
  S.cellRegion = S.cellRegion || {}; S.generalClues = S.generalClues || []; delete S.blocked;
  // migrate any legacy structured clues to free text (clear non-strings)
  S.people.forEach((p) => { if (p.clue && typeof p.clue !== 'string') p.clue = ''; if (!p.gender) p.gender = 'they'; });
  S.objectTypes.forEach((o) => { if (o.occupiable === undefined) o.occupiable = true; });
  sel = { regionId: S.regions[0] ? S.regions[0].id : null, objType: null, personId: null };
  mode = 'region'; render();
}

/* ============================== EXPORT ================================== */
const SVG = (body, sw) => `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw || 2}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  copy: SVG('<rect x="5.5" y="5.5" width="7.8" height="7.8" rx="1.6"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>'),
  download: SVG('<path d="M8 2.5v7M5 6.5 8 9.5l3-3M3 12.5h10"/>'),
  file: SVG('<path d="M4 2.5h4l3.5 3.5v7.5H4z"/><path d="M8 2.5V6h3.5"/>'),
};
function exportJSON() {
  const data = buildExport();
  const text = JSON.stringify(data, null, 2);
  openModal('Export case', `
    <p class="note" style="margin-top:0">Copy this JSON or download it. Re-import it any time.</p>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn primary" id="copy-json">${ICON.copy} Copy</button>
      <button class="btn" id="dl-json">${ICON.download} Download .json</button>
    </div>
    <pre id="export-pre">${escapeHtml(text)}</pre>`);
  $('copy-json').onclick = () => { navigator.clipboard.writeText(text); flash('Copied!'); };
  $('dl-json').onclick = () => download(`${slug(S.title)}.json`, text);
}
function buildExport() {
  const mur = murdererFromPlacement();
  return {
    studio: true, title: S.title, grid: { rows: S.rows, cols: S.cols },
    regions: S.regions.map((g) => ({ name: g.name, color: g.color,
      cells: Object.entries(S.cellRegion).filter(([, v]) => v === g.id).map(([k]) => k.split(',').map(Number)) })),
    objects: S.objects.map((o) => ({ type: o.type, row: o.r + 1, col: o.c + 1 })),
    generalClues: S.generalClues.filter((x) => x.trim()),
    suspects: suspects().map((p) => ({
      name: p.name, gender: p.gender, color: p.color,
      row: placed(p) ? p.r + 1 : null, col: placed(p) ? p.c + 1 : null,
      clue: p.clue || null,
    })),
    victim: victim() ? { name: victim().name, gender: victim().gender, color: victim().color,
      row: placed(victim()) ? victim().r + 1 : null, col: placed(victim()) ? victim().c + 1 : null,
      clue: defaultVictimClue(victim()) } : null,
    solution: { murderer: mur.state === 'ok' ? mur.murderer.name : null, scene: mur.region ? regionName(mur.region) : null },
    _internal: { ...S },
  };
}
function importJSON() {
  openModal('Import case', `
    <p class="note" style="margin-top:0">Load a <b>.json</b> file or paste a Murdoku Studio JSON export.</p>
    <div class="btn-row" style="margin-bottom:12px">
      <button class="btn" id="load-file">${ICON.file} Load from .json</button>
      <input type="file" id="import-file" accept=".json,application/json" hidden />
    </div>
    <textarea id="import-ta" placeholder="…or paste JSON here" style="min-height:180px;font-family:monospace;font-size:12px"></textarea>
    <div class="btn-row" style="margin-top:12px"><button class="btn primary" id="do-import">Import pasted JSON</button></div>`);
  const tryLoad = (raw) => {
    try {
      let obj = JSON.parse(raw);
      if (obj._internal) obj = obj._internal;            // unwrap a published export
      if (obj.cellRegion || obj.objectTypes) {           // internal studio format
        obj.id = uid('case'); loadCase(obj);
      } else if (obj.grid && (obj.people || obj.suspects || obj.regions || obj.objects)) {
        loadCase(buildFromAuthoring(obj));               // friendly authoring format (LLM / hand-written)
      } else { flash('Unrecognized format.'); return; }
      save(); closeModal(); flash('Imported.');
    } catch { flash('Could not parse JSON.'); }
  };
  $('do-import').onclick = () => tryLoad($('import-ta').value);
  $('load-file').onclick = () => $('import-file').click();
  $('import-file').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => tryLoad(String(reader.result));
    reader.readAsText(f);
  };
}

/* convert the friendly authoring schema (see llms-full.txt) into internal state */
function buildFromAuthoring(a) {
  const c = blankCase();
  c.title = a.title || 'Imported Case';
  c.rows = Math.max(3, Math.min(9, (a.grid && a.grid.rows) || 6));
  c.cols = Math.max(3, Math.min(9, (a.grid && a.grid.cols) || 6));

  const typeMap = {};
  (a.objects || []).forEach((o) => {
    if (!o.type) return;
    if (!typeMap[o.type]) typeMap[o.type] = { type: o.type, emoji: o.emoji || '🏠', occupiable: o.occupiable !== false };
  });
  c.objectTypes = Object.values(typeMap);
  c.objects = (a.objects || []).filter((o) => o.type && o.row && o.col)
    .map((o) => ({ id: uid('obj'), type: o.type, emoji: (typeMap[o.type] || {}).emoji || '🏠', r: o.row - 1, c: o.col - 1 }));

  c.regions = (a.regions || []).map((g, i) => ({ id: uid('reg'), name: g.name || ('Region ' + (i + 1)), color: g.color || REGION_COLORS[i % REGION_COLORS.length] }));
  c.cellRegion = {};
  (a.regions || []).forEach((g, i) => {
    const id = c.regions[i].id;
    (g.cells || []).forEach((cell) => { if (Array.isArray(cell)) c.cellRegion[(cell[0] - 1) + ',' + (cell[1] - 1)] = id; });
  });

  let ppl = a.people;
  if (!ppl && a.suspects) { ppl = a.suspects.slice(); if (a.victim) ppl.push(Object.assign({ victim: true }, a.victim)); }
  ppl = ppl || [];
  let pi = 0;
  c.people = ppl.map((p) => ({
    id: uid('p'), name: p.name || ('Suspect ' + (pi + 1)), gender: p.gender || 'they',
    isVictim: !!(p.victim || p.isVictim), color: p.color || TOKEN_COLORS[pi++ % TOKEN_COLORS.length],
    r: (p.row != null ? p.row - 1 : null), c: (p.col != null ? p.col - 1 : null),
    clue: typeof p.clue === 'string' ? p.clue : '',
  }));
  c.generalClues = (a.generalClues || []).filter((x) => typeof x === 'string');
  return c;
}

/* ===================== GENERATE / SOLVE / VALIDATE ===================== */
/* These wire the standalone Murdoku engine (engine.js) into the Studio. The
   engine generates a puzzle that is valid, uniquely + logically solvable (no
   guessing) with the victim solved LAST, then Validate / Solve re-prove it. */

// Build the engine's 1-based `model` from the current Studio state, attaching
// the structured clues captured at generation time (S._murdoku) by name.
function engineModelFromState() {
  const m = S._murdoku || null;
  const regById = {};
  S.regions.forEach((g) => { regById[g.id] = { name: g.name, color: g.color, cells: [] }; });
  for (const [k, id] of Object.entries(S.cellRegion)) {
    const [r, c] = k.split(',').map(Number);
    if (regById[id]) regById[id].cells.push([r + 1, c + 1]);
  }
  const objects = S.objects.map((o) => ({ type: o.type, emoji: objTypeMeta(o.type).emoji, occupiable: !!objTypeMeta(o.type).occupiable, row: o.r + 1, col: o.c + 1 }));
  const susByName = {};
  if (m) (m.suspects || []).forEach((s) => { susByName[s.name] = s; });
  const proseByName = {};
  let missingStructured = false;
  const people = S.people.filter(placed).map((p) => {
    if (!p.isVictim) proseByName[p.name] = p.clue || '';
    let clue = null;
    if (!p.isVictim) {
      if (susByName[p.name]) clue = susByName[p.name].clue;
      else { missingStructured = true; clue = undefined; }
    }
    return { name: p.name, gender: p.gender || 'they', row: p.r + 1, col: p.c + 1, isVictim: !!p.isVictim, clue };
  });
  const v = victim();
  return {
    model: {
      grid: { rows: S.rows, cols: S.cols },
      regions: Object.values(regById),
      objects, people,
      victim: v ? v.name : null,
      murderer: m ? m.murderer : null,
      murderRoom: m ? m.murderRoom : null,
      _proseByName: proseByName,
    },
    hasStructured: !!m,
    missingStructured,
  };
}

function engineReady() {
  if (typeof window.MurdokuEngine === 'undefined') { flash('Engine not loaded.'); return false; }
  return true;
}

// Pre-flight common to Solve & Validate: we need the structured puzzle.
function needGenerated() {
  const { hasStructured, missingStructured } = engineModelFromState();
  if (!hasStructured) {
    openModal('Generate first', `<p class="note" style="margin-top:0">Solve &amp; Validate read the puzzle's structured clues, which only a <b>generated</b> case carries.</p>
      <p class="note">Click <b>✨ Generate</b> in the top bar to create one, then try again.</p>`);
    return false;
  }
  if (missingStructured) flash('Some suspects were added by hand — they have no machine-readable clue and will fail checks.');
  return true;
}

function openGenerateModal() {
  const cur = Math.max(3, Math.min(9, S.rows || 6));
  openModal('Generate a puzzle', `
    <p class="note" style="margin-top:0">Pick a grid size. The generator builds a case with a <b>single, no-guess solution</b> where the victim is deduced <b>last</b>, then validates &amp; solves it to be sure (regenerating on any failure).</p>
    <label class="field">Grid size — ${'N'}×N</label>
    <div class="stepper" style="margin:6px 0 4px">
      <button class="btn step" id="gen-minus">−</button>
      <input type="number" id="gen-size" min="3" max="9" value="${cur}" />
      <button class="btn step" id="gen-plus">＋</button>
    </div>
    <p class="hint" style="margin:6px 0 14px">3–9 each side. One person per row &amp; column. Larger grids make richer clue chains.</p>
    <div class="btn-row">
      <button class="btn primary" id="gen-go">✨ Generate puzzle</button>
    </div>
    <div id="gen-status" class="note" style="margin-top:12px"></div>`);
  const sizeEl = $('gen-size');
  const clamp = () => { sizeEl.value = Math.max(3, Math.min(9, +sizeEl.value || 6)); };
  $('gen-minus').onclick = () => { sizeEl.value = Math.max(3, (+sizeEl.value || 6) - 1); };
  $('gen-plus').onclick = () => { sizeEl.value = Math.min(9, (+sizeEl.value || 6) + 1); };
  sizeEl.onchange = clamp;
  $('gen-go').onclick = () => { clamp(); runGenerate(+sizeEl.value); };
}

function runGenerate(N) {
  if (!engineReady()) return;
  const status = $('gen-status');
  const go = $('gen-go');
  if (go) go.disabled = true;
  if (status) status.innerHTML = `Generating a ${N}×${N} puzzle…`;
  // defer so the "Generating…" paint lands before the (fast) synchronous work
  setTimeout(() => {
    let r;
    try { r = window.MurdokuEngine.generate(N, { maxAttempts: 1000 }); }
    catch (e) { if (status) status.innerHTML = `<span style="color:#b3261e">Error: ${escapeHtml(e.message)}</span>`; if (go) go.disabled = false; return; }
    if (!r || !r.ok) {
      if (status) status.innerHTML = `<span style="color:#b3261e">Couldn't build a valid puzzle after ${r ? r.attempts : 0} attempts. Try again.</span>`;
      if (go) go.disabled = false;
      return;
    }
    const c = buildFromAuthoring(r.authoring);
    c._murdoku = r.authoring._murdoku;   // keep structured clues for Solve/Validate
    loadCase(c);
    save();
    closeModal();
    flash(`Generated a ${N}×${N} puzzle · ${r.solve.murderer} did it.`);
  }, 30);
}

// shared renderer for a check list (Validate) — reuses the .check styles
function checkListHTML(checks) {
  return checks.map((c) => {
    const cls = c.ok ? 'ok' : 'err';
    const badge = c.ok ? '✓' : '✗';
    return `<div class="check ${cls}"><span class="badge">${badge}</span><div>${escapeHtml(c.label)}${c.detail ? `<span class="sub">${escapeHtml(c.detail)}</span>` : ''}</div></div>`;
  }).join('');
}

function runValidate() {
  if (!engineReady() || !needGenerated()) return;
  const { model } = engineModelFromState();
  let v;
  try { v = window.MurdokuEngine.validateModel(model); }
  catch (e) { openModal('Validation error', `<p class="note">${escapeHtml(e.message)}</p>`); return; }
  const head = v.pass
    ? `<div class="verdict solved" style="margin:0 0 12px">All ${v.checks.length} checks passed ✓</div>`
    : `<div class="verdict none" style="margin:0 0 12px">${v.checks.filter((c) => !c.ok).length} check(s) failed ✗</div>`;
  openModal('Validate case', head + checkListHTML(v.checks));
}

function solveGridHTML(N, assign, murderer, victimName) {
  const at = {};
  for (const [name, [r, c]] of Object.entries(assign)) at[key(r, c)] = name;
  let h = `<div class="grid" style="display:grid;grid-template-columns:repeat(${N},minmax(34px,1fr));gap:0;border:3px solid #232229;border-radius:8px;overflow:hidden;margin:10px 0;max-width:420px">`;
  for (let r = 1; r <= N; r++) for (let c = 1; c <= N; c++) {
    const who = at[key(r, c)];
    const isV = who === victimName, isM = who === murderer;
    const bg = isV ? '#fcd4d8' : isM ? '#fff3c4' : '#fff';
    h += `<div style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;border:1px solid rgba(35,34,41,.18);background:${bg};font-weight:800;font-size:11px;text-align:center;line-height:1.05;padding:2px">${who ? escapeHtml(who.slice(0, 6)) + (isV ? ' 💀' : '') : ''}</div>`;
  }
  return h + '</div>';
}

function runSolve() {
  if (!engineReady() || !needGenerated()) return;
  const { model } = engineModelFromState();
  let s;
  try { s = window.MurdokuEngine.solveModel(model); }
  catch (e) { openModal('Solver error', `<p class="note">${escapeHtml(e.message)}</p>`); return; }

  const guarantees = [
    { ok: s.logicOK, label: 'Logic-solvable with NO guessing' },
    { ok: s.unique, label: `Exactly ONE solution (search found ${s.nSol >= 3 ? '3+' : s.nSol})` },
    { ok: !!s.victimLast, label: 'Victim is determined LAST' },
    { ok: !!s.matches, label: 'Logic solution matches the board' },
  ];
  const head = s.pass
    ? `<div class="verdict solved" style="margin:0 0 12px">Valid logic puzzle ✓ · ${escapeHtml(s.murderer || '?')} did it</div>`
    : `<div class="verdict none" style="margin:0 0 12px">Not a clean logic puzzle ✗</div>`;
  const order = s.order && s.order.length
    ? `<p class="note" style="margin:0 0 4px"><b>Deduction order</b> (victim in brackets, last):</p>
       <p class="note" style="margin:0 0 10px">${s.order.map((n) => n === s.victim ? `[<b>${escapeHtml(n)}</b>]` : escapeHtml(n)).join(' → ')}</p>`
    : (s.reason ? `<p class="note" style="margin:0 0 10px;color:#b3261e">Stuck: ${escapeHtml(s.reason)}</p>` : '');
  const grid = (s.logicOK && s.assign) ? solveGridHTML(model.grid.rows, s.assign, s.murderer, s.victim) : '';
  const accuse = s.murderer ? `<p class="note" style="margin:8px 0 0">Victim <b>${escapeHtml(s.victim)}</b> was alone with <b>${escapeHtml(s.murderer)}</b> in the ${escapeHtml(s.sceneRegion || '?')}.</p>` : '';
  openModal('Solve case', head + checkListHTML(guarantees) + '<div style="height:8px"></div>' + order + grid + accuse);
}

/* ============================ EXPORT PNG =============================== */
async function exportPNG() {
  const scale = 2, cell = 84, head = 28, pad = 10, border = 4;
  const blockW = head + S.cols * cell, blockH = head + S.rows * cell;
  const W = pad * 2 + blockW + border * 2, H = pad * 2 + blockH + border * 2;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
  const ctx = cv.getContext('2d'); ctx.scale(scale, scale);
  try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* ignore */ }
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

  ctx.fillStyle = '#f4f2ef'; ctx.fillRect(0, 0, W, H);
  const fx = pad, fy = pad, gx = fx + border, gy = fy + border, cx0 = gx + head, cy0 = gy + head;
  ctx.fillStyle = '#232229'; ctx.fillRect(fx, fy, blockW + border * 2, blockH + border * 2);
  ctx.fillStyle = '#e7e1d8';
  ctx.fillRect(gx, gy, blockW, head);
  ctx.fillRect(gx, gy, head, blockH);

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) {
    const X = cx0 + c * cell, Y = cy0 + r * cell;
    const reg = regionAt(r, c);
    ctx.fillStyle = reg && regionById(reg) ? regionById(reg).color : '#fffdf7';
    ctx.fillRect(X, Y, cell, cell);
    ctx.strokeStyle = 'rgba(35,34,41,.22)'; ctx.lineWidth = 1;
    ctx.strokeRect(X + 0.5, Y + 0.5, cell - 1, cell - 1);
    const objs = objectsAt(r, c);
    if (objs.length) { ctx.font = `${Math.round(cell * 0.32)}px ${EMOJI_FONT}`; ctx.fillStyle = '#232229'; ctx.fillText(objTypeMeta(objs[0]).emoji, X + cell / 2, Y + cell / 2 + 1); }
    const per = personAt(r, c);
    if (per) {
      ctx.beginPath(); ctx.arc(X + cell / 2, Y + cell / 2, cell * 0.34, 0, Math.PI * 2);
      ctx.fillStyle = per.color || '#fff'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#232229'; ctx.stroke();
      if (per.isVictim) { ctx.font = `${Math.round(cell * 0.3)}px ${EMOJI_FONT}`; ctx.fillText('💀', X + cell / 2, Y + cell / 2 + 1); }
      else { ctx.font = `900 ${Math.round(cell * 0.26)}px Nunito, sans-serif`; ctx.fillStyle = '#232229'; ctx.fillText(initials(per.name), X + cell / 2, Y + cell / 2 + 1); }
    }
  }
  ctx.fillStyle = '#66616b'; ctx.font = '800 13px Nunito, sans-serif';
  for (let c = 0; c < S.cols; c++) ctx.fillText(String(c + 1), cx0 + c * cell + cell / 2, gy + head / 2);
  for (let r = 0; r < S.rows; r++) ctx.fillText(String(r + 1), gx + head / 2, cy0 + r * cell + cell / 2);

  cv.toBlob((blob) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${slug(S.title)}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
  flash('PNG exported.');
}

/* ============================ PRINT SHEET =============================== */
/* Build a self-contained "print data" object (everything the standalone play
   sheet needs) and open print.html with it encoded in the URL, so the sheet has
   a real, refreshable address instead of about:blank. */
function buildPrintData() {
  const cellColor = (r, c) => { const id = regionAt(r, c); return id && regionById(id) ? regionById(id).color : '#fff'; };
  const grid = [];
  for (let r = 0; r < S.rows; r++) for (let c = 0; c < S.cols; c++) {
    const objs = objectsAt(r, c);
    grid.push({ r, c, color: cellColor(r, c), emoji: objs.length ? objTypeMeta(objs[0]).emoji : '' });
  }
  const usedTypes = [...new Set(S.objects.map((o) => o.type))].map(objTypeMeta);
  const v = victim();
  return {
    title: S.title, rows: S.rows, cols: S.cols, grid,
    regions: S.regions.map((g) => ({ name: g.name, color: g.color })),
    occ: usedTypes.filter((m) => m.occupiable).map((m) => ({ type: m.type, emoji: m.emoji })),
    non: usedTypes.filter((m) => !m.occupiable).map((m) => ({ type: m.type, emoji: m.emoji })),
    general: S.generalClues.filter((x) => x.trim()),
    cards: [
      ...suspects().map((p) => ({ name: p.name, clue: p.clue && p.clue.trim() ? p.clue : '', victim: false })),
      ...(v ? [{ name: v.name, clue: defaultVictimClue(v), victim: true }] : []),
    ],
    people: S.people.map((p) => ({ name: p.name, color: p.color || '#ffffff', initials: initials(p.name), victim: !!p.isVictim })),
  };
}

// UTF-8 + base64url (handles emoji); mirrored by fromB64() in print.js.
function toB64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function printSheet() {
  let enc;
  try { enc = toB64Url(JSON.stringify(buildPrintData())); }
  catch (e) { flash('Could not prepare the play sheet.'); return; }
  const w = window.open('print.html?d=' + enc, '_blank');
  if (!w) flash('Allow pop-ups to open the play sheet.');
}

/* ============================ EMOJI PICKER ============================= */
const DEFAULT_EMOJI = '🏠';
// one picker config per object add-row (occupiable / scenery)
const EMOJI_PICKERS = [
  { toggle: 'emoji-toggle-occ', pop: 'emoji-pop-occ', el: 'emoji-el-occ', hidden: 'new-object-emoji-occ' },
  { toggle: 'emoji-toggle-non', pop: 'emoji-pop-non', el: 'emoji-el-non', hidden: 'new-object-emoji-non' },
];
function pickEmoji(cfg, e) {
  if (!e) return;
  $(cfg.hidden).value = e; $(cfg.toggle).textContent = e; $(cfg.pop).hidden = true;
}
function resetEmojiPick(cfg) { $(cfg.hidden).value = DEFAULT_EMOJI; $(cfg.toggle).textContent = DEFAULT_EMOJI; }

/* uses the third-party <emoji-picker> web component (emoji-picker-element),
   loaded from a CDN on demand, with a typed-input fallback when offline. */
function setupEmojiPickers() {
  EMOJI_PICKERS.forEach((cfg) => {
    const toggle = $(cfg.toggle); const pop = $(cfg.pop);
    toggle.onclick = (e) => {
      e.stopPropagation();
      EMOJI_PICKERS.forEach((o) => { if (o !== cfg) $(o.pop).hidden = true; });
      pop.hidden = !pop.hidden;
    };
    document.addEventListener('click', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && e.target !== toggle) pop.hidden = true;
    });
  });
  import('https://cdn.jsdelivr.net/npm/emoji-picker-element@1/index.js')
    .then(() => {
      EMOJI_PICKERS.forEach((cfg) => $(cfg.el).addEventListener('emoji-click', (ev) => pickEmoji(cfg, ev.detail && ev.detail.unicode)));
    })
    .catch(() => {
      EMOJI_PICKERS.forEach((cfg) => {
        const pop = $(cfg.pop);
        pop.innerHTML = '<div class="emoji-fallback"><input type="text" placeholder="Paste an emoji" maxlength="2" style="width:130px" /></div>';
        pop.querySelector('input').oninput = (ev) => pickEmoji(cfg, ev.target.value.trim());
      });
    });
}

/* ============================== MODAL ================================== */
function openModal(title, html) { $('modal-title').textContent = title; $('modal-body').innerHTML = html; $('modal').classList.add('show'); }
function closeModal() { $('modal').classList.remove('show'); }

/* ============================== UTIL =================================== */
function flash(msg) { const f = $('flash'); f.textContent = msg; f.classList.add('show'); clearTimeout(f._t); f._t = setTimeout(() => f.classList.remove('show'), 1900); }
function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function slug(s) { return (s || 'case').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'case'; }

/* ============================ SAMPLE CASE ============================== */
function sampleCase() {
  // "Netflix and Kill" — the canonical very-easy 6×6 case.
  const c = blankCase();
  c.id = uid('case'); c.title = 'Netflix and Kill';
  c.rows = 6; c.cols = 6;
  c.objectTypes = DEFAULT_OBJECTS.slice();
  const reg = (name, color, cells) => { const id = uid('reg'); c.regions.push({ id, name, color }); cells.forEach(([r, cc]) => c.cellRegion[key(r, cc)] = id); return id; };
  const living = [], kitchen = [], bedroom = [];
  for (let r = 0; r < 6; r++) for (let cc = 0; cc < 6; cc++) {
    if (cc >= 4) kitchen.push([r, cc]);
    else if (r >= 4) bedroom.push([r, cc]);
    else living.push([r, cc]);
  }
  reg('Living Room', REGION_COLORS[3], living);
  reg('Kitchen', REGION_COLORS[1], kitchen);
  reg('Bedroom', REGION_COLORS[2], bedroom);
  const obj = (type, r, cc) => c.objects.push({ id: uid('obj'), type, emoji: (DEFAULT_OBJECTS.find((o) => o.type === type) || { emoji: '❓' }).emoji, r, c: cc });
  obj('sofa', 1, 1); obj('TV', 0, 0); obj('shelf', 2, 2); obj('chair', 3, 1);
  obj('bed', 4, 0); obj('table', 1, 4);
  let i = 0;
  const person = (name, gender, r, cc, isVictim, clue) =>
    c.people.push({ id: uid('p'), name, gender, isVictim: !!isVictim, color: TOKEN_COLORS[i++ % TOKEN_COLORS.length], r, c: cc, clue });
  person('Austin', 'he', 2, 3, false, 'He was beside the shelf.');
  person('Barbara', 'she', 4, 0, false, 'She was on the bed.');
  person('Charlotte', 'she', 3, 1, false, 'She was the only person sitting in a chair.');
  person('Dean', 'he', 1, 4, false, 'He was in the Kitchen.');
  person('Enid', 'she', 0, 5, false, 'She was in the last column.');
  person('Vaughn', 'he', 5, 2, true, 'He was alone with the murderer.');
  c.generalClues = ['The TV was still playing when the body was found.', 'The cash register was untouched — robbery wasn’t the motive.'];
  return c;
}

/* ============================== INIT ================================== */
function changeDim(dim, val) {
  val = Math.max(3, Math.min(9, val));
  S[dim] = val;
  for (const k in S.cellRegion) { const [r, cc] = k.split(',').map(Number); if (r >= S.rows || cc >= S.cols) delete S.cellRegion[k]; }
  S.objects = S.objects.filter((o) => o.r < S.rows && o.c < S.cols);
  S.people.forEach((p) => { if (placed(p) && (p.r >= S.rows || p.c >= S.cols)) { p.r = p.c = null; } });
  save(); render();
}

function bindAccordion() {
  document.querySelectorAll('.panel-head').forEach((h) => {
    h.onclick = () => h.closest('[data-panel]').classList.toggle('open');
  });
}

function init() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* ignore */ }
  if (saved && saved.people) loadCase(saved);
  else { loadCase(sampleCase()); save(); }
  bindGrid();
  bindAccordion();
  setupEmojiPickers();

  document.querySelectorAll('.tool').forEach((t) => t.onclick = () => { mode = t.dataset.mode; render(); });

  $('btn-generate').onclick = openGenerateModal;
  $('btn-validate').onclick = runValidate;
  $('btn-solve').onclick = runSolve;
  $('btn-new').onclick = () => { loadCase(blankCase()); save(); flash('New blank case.'); };
  $('btn-sample').onclick = () => { loadCase(sampleCase()); save(); flash('Loaded the sample case.'); };
  $('btn-export').onclick = exportJSON;
  $('btn-export-png').onclick = exportPNG;
  $('btn-import').onclick = importJSON;
  $('btn-print').onclick = printSheet;

  $('scene-title').onchange = (e) => { S.title = e.target.value || 'Untitled Case'; save(); };
  $('rows').onchange = (e) => changeDim('rows', +e.target.value);
  $('cols').onchange = (e) => changeDim('cols', +e.target.value);
  document.querySelectorAll('[data-dim]').forEach((b) => b.onclick = () => changeDim(b.dataset.dim, S[b.dataset.dim] + (+b.dataset.d)));

  $('new-region-color').value = REGION_COLORS[0];
  $('add-region').onclick = () => {
    const name = $('new-region').value.trim() || `Region ${S.regions.length + 1}`;
    const id = uid('reg');
    S.regions.push({ id, name, color: $('new-region-color').value });
    sel.regionId = id; mode = 'region'; $('new-region').value = '';
    $('new-region-color').value = REGION_COLORS[S.regions.length % REGION_COLORS.length];
    save(); render();
  };
  $('new-region').onkeydown = (e) => { if (e.key === 'Enter') $('add-region').click(); };

  const addObject = (occupiable, nameId, cfg) => {
    const name = $(nameId).value.trim().toLowerCase();
    const emoji = $(cfg.hidden).value.trim() || DEFAULT_EMOJI;
    if (!name) { flash('Name the object.'); return; }
    if (S.objectTypes.find((o) => o.type === name)) { flash('That object already exists.'); return; }
    S.objectTypes.push({ type: name, emoji, occupiable });
    sel.objType = name; mode = 'object'; $(nameId).value = ''; resetEmojiPick(cfg); $(cfg.pop).hidden = true; save(); render();
  };
  $('add-object-occ').onclick = () => addObject(true, 'new-object-occ', EMOJI_PICKERS[0]);
  $('add-object-non').onclick = () => addObject(false, 'new-object-non', EMOJI_PICKERS[1]);
  $('new-object-occ').onkeydown = (e) => { if (e.key === 'Enter') $('add-object-occ').click(); };
  $('new-object-non').onkeydown = (e) => { if (e.key === 'Enter') $('add-object-non').click(); };

  $('new-person-color').value = TOKEN_COLORS[0];
  $('add-person').onclick = () => {
    const name = $('new-person').value.trim() || `Suspect ${S.people.length + 1}`;
    const p = { id: uid('p'), name, gender: 'they', isVictim: false, color: $('new-person-color').value, r: null, c: null, clue: '' };
    S.people.push(p); sel.personId = p.id; mode = 'character'; $('new-person').value = '';
    $('new-person-color').value = TOKEN_COLORS[S.people.length % TOKEN_COLORS.length];
    save(); render();
  };
  $('new-person').onkeydown = (e) => { if (e.key === 'Enter') $('add-person').click(); };

  $('add-general').onclick = () => {
    const t = $('new-general').value.trim(); if (!t) return;
    S.generalClues.push(t); $('new-general').value = ''; save(); renderGeneralClues();
  };
  $('new-general').onkeydown = (e) => { if (e.key === 'Enter') $('add-general').click(); };

  $('modal-close').onclick = closeModal;
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  render();
}

document.addEventListener('DOMContentLoaded', init);
