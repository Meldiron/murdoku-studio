'use strict';
/* ============================================================================
 * Murdoku play sheet — standalone, refreshable.
 *
 * Opened as `print.html?d=<base64url>`, where the param is the UTF-8 + base64url
 * encoding of a self-contained "print data" object built by the Studio. Because
 * all the case data lives in the URL, refreshing the page simply re-renders a
 * clean board (no more about:blank / lost state).
 *
 * Interactions:
 *   - left-click a cell        → cross it out (darken + ✕)
 *   - right-click a cell       → menu to place a full person token, OR add a
 *                                small "note" marker in the upper-right corner
 * ========================================================================== */

function fromB64(b64) {
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

function readData() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('d');
  if (!raw) return null;
  try { return JSON.parse(fromB64(raw)); } catch (e) { return null; }
}

/* ------------------------------ render --------------------------------- */
function gridHTML(d) {
  let h = `<div class="grid" style="grid-template-columns:repeat(${d.cols},64px)">`;
  for (const cell of d.grid) {
    h += `<div class="gc" data-r="${cell.r}" data-c="${cell.c}" style="background:${cell.color}">`;
    if (cell.emoji) h += `<span class="gobj">${cell.emoji}</span>`;
    h += `</div>`;
  }
  return h + '</div>';
}

function renderSheet(d) {
  const legItems = (arr) => `<div class="legend">${arr.map((m) =>
    `<div class="leg"><span class="leg-emoji">${m.emoji}</span> ${escapeHtml(m.type)}</div>`).join('')}</div>`;
  const regionLegend = d.regions.length ? `<h2>Regions</h2><div class="legend">${d.regions.map((g) =>
    `<div class="leg"><span class="leg-swatch" style="background:${g.color}"></span> ${escapeHtml(g.name)}</div>`).join('')}</div>` : '';
  const objLegend = (d.occ.length || d.non.length) ? `<h2>Objects</h2>` +
    (d.occ.length ? `<div class="lg-label">People can stand here</div>${legItems(d.occ)}` : '') +
    (d.non.length ? `<div class="lg-label">Scenery — cannot be occupied</div>${legItems(d.non)}` : '') : '';
  const genHtml = d.general.length ? `<h2>General clues</h2><div class="ps-cols">${d.general.map((g) =>
    `<div class="ps-card ps-gen">${escapeHtml(g)}</div>`).join('')}</div>` : '';
  const cards = d.cards.map((c) => `
    <div class="ps-card${c.victim ? ' ps-victim' : ''}"><div class="ps-name">${escapeHtml(c.name)}${c.victim ? ' · victim' : ''}</div>
    <div class="ps-clue">${c.clue && c.clue.trim() ? escapeHtml(c.clue) : '<i>no clue</i>'}</div></div>`).join('');
  const clueCols = d.cards.length ? `<h2>Clue cards</h2><div class="ps-cols">${cards}</div>` : '';

  document.getElementById('sheet').innerHTML = `
    <h1>${escapeHtml(d.title)}</h1>
    ${gridHTML(d)}
    <div class="toolbar-print noprint">
      <button class="btn-print" id="do-print">🖨 Print</button>
      <button class="btn-print ghost" id="do-reset">↺ Reset board</button>
    </div>
    <p class="tip noprint">Tip: <b>left-click</b> a cell to cross it out, <b>right-click</b> to place a person or add a note. Refresh to reset the board.</p>
    ${regionLegend}
    ${objLegend}
    <div class="page-break">
      ${genHtml}
      ${clueCols}
    </div>`;
  document.title = d.title || 'Murdoku — play sheet';
  document.getElementById('do-print').onclick = () => window.print();
  document.getElementById('do-reset').onclick = () => location.reload();
}

/* --------------------------- interactions ------------------------------ */
function wireInteractions(PEOPLE) {
  const grid = document.querySelector('.grid');
  if (!grid) return;
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
  document.addEventListener('click', closeMenu);
  window.addEventListener('scroll', closeMenu, true);

  grid.addEventListener('click', (e) => {
    if (menu) { closeMenu(); return; }
    const cell = e.target.closest('.gc'); if (!cell) return;
    cell.classList.toggle('xed');
    let x = cell.querySelector('.xmark');
    if (cell.classList.contains('xed')) {
      if (!x) { x = document.createElement('div'); x.className = 'xmark'; x.textContent = '✕'; cell.appendChild(x); }
    } else if (x) { x.remove(); }
  });

  // Placing a real person clears any notes in that cell (a cell holds either a
  // confirmed person or pencil-mark notes, never both).
  const placePerson = (cell, p) => {
    const w = cell.querySelector('.pnote-wrap'); if (w) w.remove();
    let t = cell.querySelector('.ptoken');
    if (!t) { t = document.createElement('div'); cell.appendChild(t); }
    t.className = 'ptoken' + (p.victim ? ' victim' : '');
    t.style.background = p.victim ? '' : p.color;
    t.textContent = p.victim ? '💀' : p.initials;
    t.title = p.name;
  };

  // Adding a note clears the confirmed person token first (demotes to a note),
  // then toggles this person's note. The data-note guard prevents duplicates.
  const toggleNote = (cell, p) => {
    const tok = cell.querySelector('.ptoken'); if (tok) tok.remove();
    let wrap = cell.querySelector('.pnote-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'pnote-wrap'; cell.appendChild(wrap); }
    const existing = wrap.querySelector('[data-note="' + CSS.escape(p.name) + '"]');
    if (existing) { existing.remove(); if (!wrap.children.length) wrap.remove(); return; }
    const n = document.createElement('div');
    n.className = 'pnote' + (p.victim ? ' victim' : '');
    n.dataset.note = p.name;
    n.style.background = p.victim ? '' : p.color;
    n.textContent = p.victim ? '💀' : p.initials;
    n.title = p.name + ' (note)';
    wrap.appendChild(n);
  };

  const hasNote = (cell, name) => {
    const w = cell.querySelector('.pnote-wrap');
    return !!(w && w.querySelector('[data-note="' + CSS.escape(name) + '"]'));
  };
  // one row per person: clicking the row places a full token; the ✎ button on
  // the right toggles a small corner note (and leaves the menu open).
  const mkPersonRow = (cell, p) => {
    const row = document.createElement('div'); row.className = 'pm-person';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.victim ? '#fcd4d8' : p.color; dot.textContent = p.victim ? '💀' : p.initials;
    const lab = document.createElement('span'); lab.className = 'pm-name'; lab.textContent = p.name;
    const note = document.createElement('button'); note.className = 'pm-note-btn' + (hasNote(cell, p.name) ? ' on' : ''); note.textContent = '✎'; note.title = 'Add as note';
    row.appendChild(dot); row.appendChild(lab); row.appendChild(note);
    row.addEventListener('click', (ev) => { ev.stopPropagation(); placePerson(cell, p); closeMenu(); });
    note.addEventListener('click', (ev) => { ev.stopPropagation(); toggleNote(cell, p); closeMenu(); });
    return row;
  };
  const mkRow = (dotBg, dotText, label, onClick) => {
    const b = document.createElement('button');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = dotBg; dot.textContent = dotText;
    const lab = document.createElement('span'); lab.textContent = label;
    b.appendChild(dot); b.appendChild(lab);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); closeMenu(); });
    return b;
  };
  const mkHead = (txt) => { const h = document.createElement('div'); h.className = 'pm-head'; h.textContent = txt; return h; };

  grid.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const cell = e.target.closest('.gc'); if (!cell) return;
    closeMenu();
    menu = document.createElement('div'); menu.className = 'person-menu';
    menu.appendChild(mkHead('Click a name to place · ✎ for a note'));
    PEOPLE.forEach((p) => menu.appendChild(mkPersonRow(cell, p)));
    menu.appendChild(mkHead(''));
    menu.appendChild(mkRow('#eee', '✕', 'Clear person', () => { const t = cell.querySelector('.ptoken'); if (t) t.remove(); }));
    menu.appendChild(mkRow('#eee', '✕', 'Clear notes', () => { const w = cell.querySelector('.pnote-wrap'); if (w) w.remove(); }));
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    menu.addEventListener('contextmenu', (ev) => ev.preventDefault());
    document.body.appendChild(menu);
    let x = e.pageX, y = e.pageY;
    const vw = window.scrollX + document.documentElement.clientWidth;
    const vh = window.scrollY + document.documentElement.clientHeight;
    if (x + menu.offsetWidth > vw) x = Math.max(window.scrollX + 4, x - menu.offsetWidth);
    if (y + menu.offsetHeight > vh) y = Math.max(window.scrollY + 4, y - menu.offsetHeight);
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
  });
}

/* ------------------------------- boot ---------------------------------- */
(function () {
  const d = readData();
  if (!d) {
    document.getElementById('sheet').innerHTML = '<h1>Murdoku — play sheet</h1><p class="empty-note">No case data in the URL. Open this sheet from Murdoku Studio via <b>Print sheet</b>.</p>';
    return;
  }
  renderSheet(d);
  wireInteractions(d.people || []);
})();
