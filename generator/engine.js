'use strict';
/* ============================================================================
 * Murdoku ENGINE — the single source of truth for generating, solving and
 * validating cases. Runs both in Node (required by the CLIs) and in the browser
 * (exposed as window.MurdokuEngine and used by the Studio app).
 *
 * Everything is 1-based: row 1 = top, col 1 = left (the authoring JSON schema).
 *
 * A case is a FULL permutation — N people on an N×N grid, one per row and one
 * per column. The victim carries NO clue, so the victim's cell is pinned only
 * once every suspect is placed (the single leftover row × column). That makes
 * "the victim is solved LAST" structural, not luck. The victim is modelled as a
 * free variable (domain = all cells), which also keeps Sudoku-style hidden
 * singles valid (every row and column is occupied).
 *
 * Clues are STRUCTURED data that render to the app's free-text prose. The three
 * public operations:
 *   - generate(N, opts) : build a case; re-validate + re-solve each candidate
 *     and regenerate on any failure (up to opts.maxAttempts).
 *   - solveModel(model) : prove logic-solvable (no guessing) + exactly one
 *     solution; report the deduction order (victim last).
 *   - validateModel(model) : re-check every structural & solving rule.
 * ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MurdokuEngine = api;
})(this, function () {

  /* ------------------------------ basics --------------------------------- */
  const K = (r, c) => r + ',' + c;
  const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const PRON = { he: { subj: 'He', verb: 'was' }, she: { subj: 'She', verb: 'was' }, they: { subj: 'They', verb: 'were' } };
  const subjOf = (g) => (PRON[g] || PRON.they).subj;
  const verbOf = (g) => (PRON[g] || PRON.they).verb;

  function allCells(N) {
    const out = [];
    for (let r = 1; r <= N; r++) for (let c = 1; c <= N; c++) out.push([r, c]);
    return out;
  }

  /* ------------------------------ RNG ------------------------------------ */
  function mulberry32(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ----------------------------- scene ----------------------------------- */
  function makeScene(model) {
    const N = model.grid.rows;
    const cellRegion = {};
    for (const reg of model.regions) for (const [r, c] of reg.cells) cellRegion[K(r, c)] = reg.name;
    const objCells = {};                 // type -> Set of "r,c"
    const occCells = new Set();          // cells holding an occupiable object (furniture)
    const anyObjCells = new Set();       // cells holding any object
    for (const o of model.objects) {
      (objCells[o.type] = objCells[o.type] || new Set()).add(K(o.row, o.col));
      anyObjCells.add(K(o.row, o.col));
      if (o.occupiable !== false) occCells.add(K(o.row, o.col));
    }
    const regionNames = model.regions.map((r) => r.name);
    const objArr = {};                   // type -> [[r,c],...]
    for (const t in objCells) objArr[t] = [...objCells[t]].map((k) => k.split(',').map(Number));
    return {
      N, regions: model.regions, regionNames, cellRegion, objCells, objArr,
      objTypes: Object.keys(objCells),
      regionAt: (r, c) => cellRegion[K(r, c)] || null,
      hasObj: (type, r, c) => !!objCells[type] && objCells[type].has(K(r, c)),
      objCellsOf: (type) => objArr[type] || [],
      onFurniture: (r, c) => occCells.has(K(r, c)),
      anyObject: (r, c) => anyObjCells.has(K(r, c)),
    };
  }

  /* ------------------------------ clues ---------------------------------- *
   * Clue families:
   *   UNARY      — depend only on the person's own cell (+ board).
   *   ALONE      — "the only person in region R" (own cell in R + nobody else in R).
   *   BINARY     — relate the person to ONE other person.
   *   BETWEEN    — relate the person to TWO others (ordering along a row/column).
   * Under the row/column rule two people never share a row or column, so several
   * "obvious" relations (directly-adjacent, same-row) are impossible and are
   * deliberately absent; "near"/"between"/diagonal forms replace them.
   * -------------------------------------------------------------------------- */
  const UNARY_TYPES = new Set(['region', 'notRegion', 'row', 'col', 'rowParity', 'colParity',
    'rowMax', 'rowMin', 'colMax', 'colMin', 'corner', 'edge', 'interior', 'onFurniture', 'standing', 'on', 'beside',
    'dirObj', 'diagObj', 'offsetObj', 'vectorObj']);  // *Obj = relative to a fixed object (own-cell only)
  const BINARY_TYPES = new Set(['dir', 'diag', 'offset', 'vector', 'adjdiag', 'near', 'sameRegion']);
  const EXCLUSIVE_TYPES = new Set(['aloneRegion', 'onlyOn']); // "A and nobody else in <set>"
  const isUnary = (clue) => clue && UNARY_TYPES.has(clue.type);
  const isExclusive = (clue) => clue && EXCLUSIVE_TYPES.has(clue.type);
  const isBinary = (clue) => clue && BINARY_TYPES.has(clue.type);
  const isBetween = (clue) => clue && clue.type === 'between';
  const isRelative = (clue) => isBinary(clue) || isBetween(clue); // needs other people → init domain = all cells

  // The cells that an EXCLUSIVE clue's "set" covers (region cells, or object cells).
  function exclusiveCells(scene, clue) {
    if (clue.type === 'aloneRegion') return scene.regions.find((g) => g.name === clue.region) ? scene.regions.find((g) => g.name === clue.region).cells : [];
    if (clue.type === 'onlyOn') return scene.objCellsOf(clue.obj);
    return [];
  }
  // direction of (sr,sc) relative to an object: true if it holds against ANY instance.
  function dirObjHolds(scene, dir, obj, sr, sc) {
    for (const [tr, tc] of scene.objCellsOf(obj)) {
      if (dir === 'north' && sr < tr) return true;
      if (dir === 'south' && sr > tr) return true;
      if (dir === 'west' && sc < tc) return true;
      if (dir === 'east' && sc > tc) return true;
    }
    return false;
  }
  function diagObjHolds(scene, dir, obj, sr, sc) {
    for (const [tr, tc] of scene.objCellsOf(obj)) {
      if (dir === 'northwest' && sr < tr && sc < tc) return true;
      if (dir === 'northeast' && sr < tr && sc > tc) return true;
      if (dir === 'southwest' && sr > tr && sc < tc) return true;
      if (dir === 'southeast' && sr > tr && sc > tc) return true;
    }
    return false;
  }

  function holdsUnary(scene, clue, r, c) {
    const N = scene.N;
    switch (clue.type) {
      case 'region':    return scene.regionAt(r, c) === clue.region;
      case 'notRegion': return scene.regionAt(r, c) !== clue.region;
      case 'row':       return r === clue.row;
      case 'col':       return c === clue.col;
      case 'rowParity': return (r % 2 === 1) === (clue.parity === 'odd');
      case 'colParity': return (c % 2 === 1) === (clue.parity === 'odd');
      case 'rowMax':    return r <= clue.k;
      case 'rowMin':    return r >= clue.k;
      case 'colMax':    return c <= clue.k;
      case 'colMin':    return c >= clue.k;
      case 'corner':    return (r === 1 || r === N) && (c === 1 || c === N);
      case 'edge':      return r === 1 || r === N || c === 1 || c === N;
      case 'interior':  return r > 1 && r < N && c > 1 && c < N;
      case 'onFurniture': return scene.onFurniture(r, c);
      case 'standing':  return !scene.anyObject(r, c);
      case 'on':        return scene.hasObj(clue.obj, r, c);
      case 'beside': {
        const myReg = scene.regionAt(r, c);
        for (const [dr, dc] of ORTHO) {
          const nr = r + dr, nc = c + dc;
          if (scene.hasObj(clue.obj, nr, nc) && scene.regionAt(nr, nc) === myReg) return true;
        }
        return false;
      }
      case 'dirObj':  return dirObjHolds(scene, clue.dir, clue.obj, r, c);
      case 'diagObj': return diagObjHolds(scene, clue.dir, clue.obj, r, c);
      case 'offsetObj':
        for (const [tr, tc] of scene.objCellsOf(clue.obj)) {
          if (clue.axis === 'row' && r === tr + clue.delta) return true;
          if (clue.axis === 'col' && c === tc + clue.delta) return true;
        }
        return false;
      case 'vectorObj':
        for (const [tr, tc] of scene.objCellsOf(clue.obj)) if (r === tr + clue.dr && c === tc + clue.dc) return true;
        return false;
      default: return null;
    }
  }

  // binary relation: is `self` (sr,sc) related to `target` (tr,tc) per the clue?
  function relHolds(scene, clue, sr, sc, tr, tc) {
    switch (clue.type) {
      case 'dir':
        if (clue.dir === 'north') return sr < tr;
        if (clue.dir === 'south') return sr > tr;
        if (clue.dir === 'west')  return sc < tc;
        if (clue.dir === 'east')  return sc > tc;
        return false;
      case 'diag':
        if (clue.dir === 'northwest') return sr < tr && sc < tc;
        if (clue.dir === 'northeast') return sr < tr && sc > tc;
        if (clue.dir === 'southwest') return sr > tr && sc < tc;
        if (clue.dir === 'southeast') return sr > tr && sc > tc;
        return false;
      case 'offset':
        if (clue.axis === 'row') return sr === tr + clue.delta;
        if (clue.axis === 'col') return sc === tc + clue.delta;
        return false;
      case 'vector': return sr === tr + clue.dr && sc === tc + clue.dc;
      case 'adjdiag': return Math.abs(sr - tr) === 1 && Math.abs(sc - tc) === 1;
      case 'near':    return Math.max(Math.abs(sr - tr), Math.abs(sc - tc)) <= (clue.k || 2) && !(sr === tr && sc === tc);
      case 'sameRegion': return scene.regionAt(sr, sc) === scene.regionAt(tr, tc);
      default: return false;
    }
  }

  // A is "between" B and C along an axis (strict ordering; either order of B,C).
  function betweenHolds(clue, sr, sc, br, bc, cr, cc) {
    const s = clue.axis === 'row' ? sr : sc;
    const b = clue.axis === 'row' ? br : bc;
    const cc2 = clue.axis === 'row' ? cr : cc;
    return (b < s && s < cc2) || (cc2 < s && s < b);
  }

  /* ---- logical combinators: NOT / AND / OR -------------------------------- *
   * Leaves are simple clues. To keep propagation exact and sound, a combinator
   * may reference AT MOST ONE other person (all relational leaves point to the
   * same target); `between` and the exclusive clues are never nested.
   * ------------------------------------------------------------------------- */
  const isCompound = (clue) => clue && (clue.type === 'and' || clue.type === 'or' || clue.type === 'not');

  // collect every person referenced anywhere in the tree
  function collectTargets(node, set) {
    if (!node) return set;
    if (node.type === 'and' || node.type === 'or') node.subs.forEach((s) => collectTargets(s, set));
    else if (node.type === 'not') collectTargets(node.sub, set);
    else if (isBinary(node)) set.add(node.target);
    else if (isBetween(node)) node.targets.forEach((t) => set.add(t));
    return set;
  }
  const compoundTarget = (clue) => { const s = collectTargets(clue, new Set()); return s.size ? [...s][0] : null; };
  // a clue needs another person's position to be evaluated → its domain starts open
  const hasTarget = (clue) => isBinary(clue) || isBetween(clue) || (isCompound(clue) && compoundTarget(clue) != null);

  // evaluate any node given the owner's cell and (its single) target's cell (or null)
  function evalNode(scene, node, a, tcell) {
    if (node.type === 'and') return node.subs.every((s) => evalNode(scene, s, a, tcell));
    if (node.type === 'or')  return node.subs.some((s) => evalNode(scene, s, a, tcell));
    if (node.type === 'not') return !evalNode(scene, node.sub, a, tcell);
    if (isUnary(node))  return holdsUnary(scene, node, a[0], a[1]);
    if (isBinary(node)) return tcell ? relHolds(scene, node, a[0], a[1], tcell[0], tcell[1]) : false;
    return false; // between/exclusive are never nested
  }

  // pair predicate used by the solver's arc-consistency (binary OR compound)
  function pairHolds(scene, clue, ar, ac, br, bc) {
    return isCompound(clue) ? evalNode(scene, clue, [ar, ac], [br, bc]) : relHolds(scene, clue, ar, ac, br, bc);
  }
  // owner-cell filter for clues that need no target (unary, or target-less compound)
  function staticHolds(scene, clue, r, c) {
    return isCompound(clue) ? evalNode(scene, clue, [r, c], null) : holdsUnary(scene, clue, r, c);
  }

  function holdsFull(scene, clue, self, assign) {
    if (isUnary(clue)) return holdsUnary(scene, clue, self[0], self[1]);
    if (isExclusive(clue)) {
      // self must be in the set, and be the ONLY person in it
      const cells = exclusiveCells(scene, clue);
      const inSet = (r, c) => cells.some(([cr, cc]) => cr === r && cc === c);
      if (!inSet(self[0], self[1])) return false;
      let cnt = 0;
      for (const k in assign) if (inSet(assign[k][0], assign[k][1])) cnt++;
      return cnt === 1;
    }
    if (isBinary(clue)) {
      const t = assign[clue.target];
      return t ? relHolds(scene, clue, self[0], self[1], t[0], t[1]) : false;
    }
    if (isBetween(clue)) {
      const b = assign[clue.targets[0]], c = assign[clue.targets[1]];
      return b && c ? betweenHolds(clue, self[0], self[1], b[0], b[1], c[0], c[1]) : false;
    }
    if (isCompound(clue)) {
      const t = compoundTarget(clue);
      const tcell = t ? assign[t] : null;
      if (t && !tcell) return false;
      return evalNode(scene, clue, self, tcell);
    }
    return false;
  }

  const ORD = (n) => ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'][n] || (n + 'th');
  // "2 rows south of X" / "3 columns east of X" (predicate only)
  function offsetPhrase(axis, delta, anchor) {
    const n = Math.abs(delta);
    if (axis === 'row') return `${n} row${n > 1 ? 's' : ''} ${delta > 0 ? 'south' : 'north'} of ${anchor}`;
    return `${n} column${n > 1 ? 's' : ''} ${delta > 0 ? 'east' : 'west'} of ${anchor}`;
  }
  function vectorPhrase(dr, dc, anchor) {
    const nr = Math.abs(dr), nc = Math.abs(dc);
    return `exactly ${nr} row${nr > 1 ? 's' : ''} ${dr > 0 ? 'south' : 'north'} and ${nc} column${nc > 1 ? 's' : ''} ${dc > 0 ? 'east' : 'west'} of ${anchor}`;
  }

  // the predicate clause of a clue (no subject/verb), e.g. "in the Kitchen".
  function phrase(clue) {
    switch (clue.type) {
      case 'and': return clue.subs.map(phrase).join(' and ');
      case 'or':  return clue.subs.map(phrase).join(' or ');
      case 'not': return 'not ' + phrase(clue.sub);
      case 'region':    return `in the ${clue.region}`;
      case 'notRegion': return `not in the ${clue.region}`;
      case 'row':       return `in the ${ORD(clue.row)} row`;
      case 'col':       return clue.col === clue._cols ? 'in the last column' : `in the ${ORD(clue.col)} column`;
      case 'rowParity': return `in an ${clue.parity}-numbered row`;
      case 'colParity': return `in an ${clue.parity}-numbered column`;
      case 'rowMax':    return clue.k === 1 ? 'in the top row' : `within the top ${clue.k} rows`;
      case 'rowMin': {  const b = clue._n - clue.k + 1; return b === 1 ? 'in the bottom row' : `within the bottom ${b} rows`; }
      case 'colMax':    return clue.k === 1 ? 'in the leftmost column' : `within the leftmost ${clue.k} columns`;
      case 'colMin': {  const b = clue._n - clue.k + 1; return b === 1 ? 'in the rightmost column' : `within the rightmost ${b} columns`; }
      case 'corner':    return 'in a corner of the grid';
      case 'edge':      return 'against an outer wall';
      case 'interior':  return 'away from every outer wall';
      case 'onFurniture': return 'sitting on a piece of furniture';
      case 'standing':  return 'standing in an open space';
      case 'on':        return `on the ${clue.obj}`;
      case 'beside':    return `beside the ${clue.obj}`;
      case 'aloneRegion': return `the only person in the ${clue.region}`;
      case 'onlyOn':    return `the only person on the ${clue.obj}`;
      case 'dir':       return `somewhere ${clue.dir} of ${clue.target}`;
      case 'diag':      return `to the ${clue.dir} of ${clue.target}`;
      case 'dirObj':    return `somewhere ${clue.dir} of the ${clue.obj}`;
      case 'diagObj':   return `to the ${clue.dir} of the ${clue.obj}`;
      case 'offset':    return offsetPhrase(clue.axis, clue.delta, clue.target);
      case 'offsetObj': return offsetPhrase(clue.axis, clue.delta, 'the ' + clue.obj);
      case 'vector':    return vectorPhrase(clue.dr, clue.dc, clue.target);
      case 'vectorObj': return vectorPhrase(clue.dr, clue.dc, 'the ' + clue.obj);
      case 'adjdiag':   return `diagonally next to ${clue.target}`;
      case 'near':      return `near ${clue.target}`;
      case 'sameRegion': return `in the same room as ${clue.target}`;
      case 'between':   return `${clue.axis === 'row' ? 'vertically' : 'horizontally'} between ${clue.targets[0]} and ${clue.targets[1]}`;
      default: return '';
    }
  }

  // `subj` may be a gender key ('he'/'she'/'they') or a literal subject word.
  function prose(clue, subj) {
    let v = 'was';
    if (PRON[subj]) { v = PRON[subj].verb; subj = PRON[subj].subj; }
    else if (subj === 'They') v = 'were';
    return `${subj} ${v} ${phrase(clue)}.`;
  }

  /* ============================================================================
   * LOGIC SOLVER — constraint propagation, NO guessing/backtracking.
   * ========================================================================== */
  function logicSolve(scene, people) {
    const N = scene.N, NC = N * N;
    const ROW = new Int8Array(NC), COL = new Int8Array(NC);
    for (let r = 1; r <= N; r++) for (let c = 1; c <= N; c++) { const id = (r - 1) * N + (c - 1); ROW[id] = r; COL[id] = c; }

    const idsOfCells = (cells) => cells.map(([r, c]) => (r - 1) * N + (c - 1));

    const nameToIdx = {};
    people.forEach((p, i) => { nameToIdx[p.name] = i; });
    const dom = people.map((p) => {
      const s = new Set();
      const cl = p.clue;
      if (p.isVictim || !cl || hasTarget(cl)) { for (let id = 0; id < NC; id++) s.add(id); }   // needs a target → start open
      else if (isExclusive(cl)) { for (const id of idsOfCells(exclusiveCells(scene, cl))) s.add(id); }
      else { for (let id = 0; id < NC; id++) if (staticHolds(scene, cl, ROW[id], COL[id])) s.add(id); } // unary or target-less compound
      return s;
    });
    const rels = [], terns = [], excls = [];   // rels holds single-target binary AND compound clues
    people.forEach((p, i) => {
      if (!p.clue) return;
      if (isBinary(p.clue)) rels.push({ i, t: nameToIdx[p.clue.target], clue: p.clue });
      else if (isBetween(p.clue)) terns.push({ i, b: nameToIdx[p.clue.targets[0]], c: nameToIdx[p.clue.targets[1]], clue: p.clue });
      else if (isExclusive(p.clue)) excls.push({ i, ids: idsOfCells(exclusiveCells(scene, p.clue)) });
      else if (isCompound(p.clue) && compoundTarget(p.clue)) rels.push({ i, t: nameToIdx[compoundTarget(p.clue)], clue: p.clue });
    });

    const order = [], sweepOf = {}, seen = new Set();
    const note = (sweep) => people.forEach((p, i) => {
      if (dom[i].size === 1 && !seen.has(i)) { seen.add(i); order.push(p.name); sweepOf[p.name] = sweep; }
    });
    note(0);

    let changed = true, guard = 0;
    while (changed) {
      changed = false;
      if (++guard > 10000) break;

      // (0) exclusive ("alone in region" / "only person on X"): nobody but `i`
      // may stand in any of those cells
      for (const { i, ids } of excls) {
        for (const id of ids) for (let j = 0; j < people.length; j++) {
          if (j !== i && dom[j].delete(id)) changed = true;
        }
      }

      // (1) single-target relations (binary or compound) — arc consistency
      for (const { i, t, clue } of rels) {
        const Ds = dom[i], Dt = dom[t];
        for (const a of [...Ds]) {
          let ok = false;
          for (const b of Dt) if (b !== a && pairHolds(scene, clue, ROW[a], COL[a], ROW[b], COL[b])) { ok = true; break; }
          if (!ok) { Ds.delete(a); changed = true; }
        }
        for (const b of [...Dt]) {
          let ok = false;
          for (const a of Ds) if (a !== b && pairHolds(scene, clue, ROW[a], COL[a], ROW[b], COL[b])) { ok = true; break; }
          if (!ok) { Dt.delete(b); changed = true; }
        }
      }

      // (2) ternary "between" — sound pruning via the other two domains' extremes
      for (const { i, b, c, clue } of terns) {
        const AX = clue.axis === 'row' ? ROW : COL;
        const Da = dom[i], Db = dom[b], Dc = dom[c];
        let minB = Infinity, maxB = -Infinity; for (const x of Db) { const v = AX[x]; if (v < minB) minB = v; if (v > maxB) maxB = v; }
        let minC = Infinity, maxC = -Infinity; for (const x of Dc) { const v = AX[x]; if (v < minC) minC = v; if (v > maxC) maxC = v; }
        for (const a of [...Da]) { const v = AX[a]; if (!((minB < v && maxC > v) || (maxB > v && minC < v))) { Da.delete(a); changed = true; } }
        // recompute A extremes for the reverse prunes
        for (const x of [...Db]) { const bv = AX[x]; let ok = false; for (const a of Da) { const v = AX[a]; if ((bv < v && maxC > v) || (bv > v && minC < v)) { ok = true; break; } } if (!ok) { Db.delete(x); changed = true; } }
        for (const x of [...Dc]) { const cv = AX[x]; let ok = false; for (const a of Da) { const v = AX[a]; if ((minB < v && cv > v) || (maxB > v && cv < v)) { ok = true; break; } } if (!ok) { Dc.delete(x); changed = true; } }
      }

      for (let i = 0; i < people.length; i++) {
        if (dom[i].size !== 1) continue;
        const id = dom[i].values().next().value, r = ROW[id], c = COL[id];
        for (let j = 0; j < people.length; j++) {
          if (j === i) continue;
          const Dj = dom[j];
          for (const k of [...Dj]) if (ROW[k] === r || COL[k] === c) { Dj.delete(k); changed = true; }
        }
      }

      for (let r = 1; r <= N; r++) {
        let only = -1, many = false;
        for (let i = 0; i < people.length && !many; i++)
          for (const k of dom[i]) if (ROW[k] === r) { if (only === -1) only = i; else if (only !== i) many = true; break; }
        if (!many && only !== -1) { const D = dom[only]; for (const k of [...D]) if (ROW[k] !== r) { D.delete(k); changed = true; } }
      }
      for (let c = 1; c <= N; c++) {
        let only = -1, many = false;
        for (let i = 0; i < people.length && !many; i++)
          for (const k of dom[i]) if (COL[k] === c) { if (only === -1) only = i; else if (only !== i) many = true; break; }
        if (!many && only !== -1) { const D = dom[only]; for (const k of [...D]) if (COL[k] !== c) { D.delete(k); changed = true; } }
      }

      note(guard);
    }

    const sizes = {};
    let empty = null;
    people.forEach((p, i) => { sizes[p.name] = dom[i].size; if (dom[i].size === 0) empty = p.name; });
    if (empty) return { ok: false, contradiction: true, reason: `no cell left for ${empty}`, order, sweepOf, sizes };

    const solved = people.every((_, i) => dom[i].size === 1);
    const assign = {};
    if (solved) people.forEach((p, i) => { const id = dom[i].values().next().value; assign[p.name] = [ROW[id], COL[id]]; });
    return { ok: solved, contradiction: false, assign, order, sweepOf, sizes };
  }

  /* ============================================================================
   * EXHAUSTIVE SOLUTION COUNTER — ground-truth uniqueness, independent of the
   * propagator. Stops at `cap`.
   * ========================================================================== */
  function countSolutions(scene, people, cap) {
    cap = cap || 2;
    const cells = allCells(scene.N);
    // pre-filter each person's feasible cells: unary by predicate, exclusive to
    // its cell set, binary/between left open (verified at the leaf).
    const feas = people.map((p) => {
      const cl = p.clue;
      if (p.isVictim || !cl || hasTarget(cl)) return cells.slice();
      if (isExclusive(cl)) { const set = exclusiveCells(scene, cl); return cells.filter(([r, c]) => set.some(([cr, cc]) => cr === r && cc === c)); }
      return cells.filter(([r, c]) => staticHolds(scene, cl, r, c)); // unary or target-less compound
    });
    const idx = people.map((_, i) => i).sort((a, b) => feas[a].length - feas[b].length);
    const assign = {}, usedR = new Set(), usedC = new Set();
    let count = 0;
    (function rec(pos) {
      if (count >= cap) return;
      if (pos === idx.length) {
        // full assignment: verify every clue (covers binary, between, alone, unary)
        for (const p of people) if (p.clue && !holdsFull(scene, p.clue, assign[p.name], assign)) return;
        count++; return;
      }
      const p = people[idx[pos]];
      for (const [r, c] of feas[idx[pos]]) {
        if (usedR.has(r) || usedC.has(c)) continue;
        // cheap early checks against an already-placed target
        if (isBinary(p.clue)) { const t = assign[p.clue.target]; if (t && !relHolds(scene, p.clue, r, c, t[0], t[1])) continue; }
        else if (isCompound(p.clue)) { const tn = compoundTarget(p.clue); if (tn) { const t = assign[tn]; if (t && !evalNode(scene, p.clue, [r, c], t)) continue; } }
        assign[p.name] = [r, c]; usedR.add(r); usedC.add(c);
        rec(pos + 1);
        delete assign[p.name]; usedR.delete(r); usedC.delete(c);
        if (count >= cap) return;
      }
    })(0);
    return count;
  }

  /* ============================================================================
   * VALIDATE — re-check every rule of a finished case.
   * ========================================================================== */
  function validateModel(model) {
    const scene = makeScene(model);
    const N = scene.N;
    const people = model.people;
    const suspects = people.filter((p) => !p.isVictim);
    const victim = people.find((p) => p.isVictim);
    const checks = [];
    const add = (label, ok, detail) => checks.push({ label, ok: !!ok, detail: detail || '' });

    add('A1 · grid size 3–9 and square', model.grid.rows >= 3 && model.grid.rows <= 9 && model.grid.cols === model.grid.rows, `${model.grid.rows}×${model.grid.cols}`);
    add('A2 · exactly one victim', people.filter((p) => p.isVictim).length === 1);
    add('A3 · at least one suspect', suspects.length >= 1, `${suspects.length} suspects`);
    add('A4 · everyone on the grid', people.every((p) => p.row >= 1 && p.row <= N && p.col >= 1 && p.col <= N));

    const rs = new Set(), cs = new Set(); let perm = true;
    for (const p of people) { if (rs.has(p.row) || cs.has(p.col)) perm = false; rs.add(p.row); cs.add(p.col); }
    add('B1 · no shared row / column (Sudoku rule)', perm);

    const vReg = victim ? scene.regionAt(victim.row, victim.col) : null;
    add('C1 · victim stands inside a region', !!vReg, vReg || '(none)');
    const inRoom = suspects.filter((p) => scene.regionAt(p.row, p.col) === vReg);
    add('C2 · victim region has exactly one suspect', inRoom.length === 1, `${inRoom.length} suspect(s) in ${vReg}`);
    if (inRoom.length === 1 && model.murderer) add('C3 · declared murderer matches deduction', inRoom[0].name === model.murderer, `${model.murderer}`);

    const truth = {}; for (const p of people) truth[p.name] = [p.row, p.col];
    let truthOK = true, proseOK = true;
    for (const s of suspects) {
      if (!holdsFull(scene, s.clue, [s.row, s.col], truth)) { truthOK = false; }
      if (model._proseByName && model._proseByName[s.name] !== undefined) {
        if (model._proseByName[s.name] !== prose(s.clue, subjOf(s.gender))) proseOK = false;
      }
    }
    add('D1 · every suspect clue is TRUE at their cell', truthOK);
    if (model._proseByName) add('D2 · authoring prose matches structured clue', proseOK);

    const refsVictim = (s) => victim && collectTargets(s.clue, new Set()).has(victim.name);
    add('E1 · victim carries no clue', !victim || !victim.clue);
    add('E2 · no suspect clue references the victim', !suspects.some(refsVictim));

    const nSol = countSolutions(scene, people, 3);
    add('F1 · exactly one solution', nSol === 1, `${nSol >= 3 ? '3+' : nSol} solution(s)`);

    const res = logicSolve(scene, people);
    add('G1 · solvable by pure logic (no guessing)', res.ok, res.ok ? '' : (res.reason || 'propagation stalled'));
    if (res.ok) add('G2 · logic solution matches placement', people.every((p) => res.assign[p.name][0] === p.row && res.assign[p.name][1] === p.col));

    if (res.ok && victim) {
      const maxSus = Math.max(...suspects.map((s) => res.sweepOf[s.name]));
      add('H1 · victim is determined LAST', suspects.every((s) => res.sweepOf[s.name] <= res.sweepOf[victim.name]), `victim sweep ${res.sweepOf[victim.name]}, last suspect ${maxSus}`);
      add('H2 · victim is the unreferenced leftover cell', res.sweepOf[victim.name] >= maxSus && !suspects.some(refsVictim));
    }

    const pass = checks.every((c) => c.ok);
    return { pass, checks, order: res.order, solveOrder: res.order };
  }

  /* ============================================================================
   * SOLVE — certify logic-solvable + unique; report deduction order.
   * ========================================================================== */
  function solveModel(model) {
    const scene = makeScene(model);
    const people = model.people;
    const suspects = people.filter((p) => !p.isVictim);
    const victim = people.find((p) => p.isVictim);
    const res = logicSolve(scene, people);
    const nSol = countSolutions(scene, people, 3);
    const logicOK = res.ok;
    const victimLast = res.ok && victim && suspects.every((s) => res.sweepOf[s.name] <= res.sweepOf[victim.name]);
    const matches = res.ok && people.every((p) => res.assign[p.name][0] === p.row && res.assign[p.name][1] === p.col);

    let murderer = null, scene_region = null;
    if (res.ok && victim) {
      scene_region = scene.regionAt(...res.assign[victim.name]);
      const m = suspects.find((s) => scene.regionAt(...res.assign[s.name]) === scene_region);
      murderer = m ? m.name : null;
    }
    const pass = logicOK && nSol === 1 && !!victimLast;
    return {
      pass, logicOK, unique: nSol === 1, nSol, victimLast, matches,
      order: res.order, sweepOf: res.sweepOf, assign: res.ok ? res.assign : null,
      sizes: res.sizes, murderer, sceneRegion: scene_region, victim: victim ? victim.name : null,
      grid: { rows: scene.N, cols: scene.N }, reason: res.reason || null,
    };
  }

  /* ============================================================================
   * GENERATION
   * ========================================================================== */
  const NAMES = ['Austin', 'Barbara', 'Charlotte', 'Dean', 'Enid', 'Felix', 'Greta', 'Hugo', 'Iris', 'Jonas', 'Kira', 'Liam', 'Mara', 'Nadia', 'Otis', 'Petra'];
  const GENDERS = ['he', 'she', 'they'];
  const REGION_DEFS = [
    ['Living Room', '#d6f0ea'], ['Kitchen', '#d8edcb'], ['Bedroom', '#e6dcf0'],
    ['Study', '#f0e2cf'], ['Garden', '#cfeede'], ['Hallway', '#f0d9d9'],
    ['Bathroom', '#d3e6f0'], ['Attic', '#efe0ec'], ['Cellar', '#e3e3d2'],
  ];
  const OCCUPIABLE = [['bed', '🛏️'], ['chair', '🪑'], ['sofa', '🛋️'], ['table', '🍽️'], ['desk', '🗄️'], ['bench', '🪑'], ['stool', '🪑'], ['armchair', '🛋️'], ['cot', '🛌'], ['hammock', '🪢']];
  const SCENERY = [['shelf', '📚'], ['tv', '📺'], ['plant', '🪴'], ['lamp', '💡'], ['painting', '🖼️'], ['fridge', '🧊'], ['sink', '🚰'], ['window', '🪟'], ['clock', '🕰️']];

  function makeHelpers(rng) {
    const randInt = (n) => Math.floor(rng() * n);
    const pick = (a) => a[randInt(a.length)];
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const weightedPick = (items, wf) => {
      const w = items.map(wf); let total = w.reduce((x, y) => x + y, 0), x = rng() * total;
      for (let i = 0; i < items.length; i++) { x -= w[i]; if (x <= 0) return items[i]; }
      return items[items.length - 1];
    };
    return { randInt, pick, shuffle, weightedPick };
  }

  function randomPermutation(N, H) {
    const cols = H.shuffle([...Array(N)].map((_, i) => i + 1));
    return [...Array(N)].map((_, i) => ({ row: i + 1, col: cols[i] }));
  }

  function growRegions(N, numRegions, H) {
    const cellRegion = {};
    const seeds = H.shuffle(allCells(N)).slice(0, numRegions);
    const frontier = seeds.map(() => []);
    seeds.forEach(([r, c], i) => { cellRegion[K(r, c)] = i; });
    const addFrontier = (i, r, c) => {
      for (const [dr, dc] of ORTHO) { const nr = r + dr, nc = c + dc; if (nr < 1 || nr > N || nc < 1 || nc > N) continue; if (cellRegion[K(nr, nc)] === undefined) frontier[i].push([nr, nc]); }
    };
    seeds.forEach(([r, c], i) => addFrontier(i, r, c));
    let remaining = N * N - numRegions, guard = 0;
    while (remaining > 0 && guard++ < N * N * 20) {
      const live = frontier.map((f, i) => i).filter((i) => frontier[i].length);
      if (!live.length) break;
      const i = H.pick(live);
      let cell = null;
      while (frontier[i].length) { const cand = frontier[i].splice(H.randInt(frontier[i].length), 1)[0]; if (cellRegion[K(cand[0], cand[1])] === undefined) { cell = cand; break; } }
      if (!cell) continue;
      cellRegion[K(cell[0], cell[1])] = i; addFrontier(i, cell[0], cell[1]); remaining--;
    }
    for (const [r, c] of allCells(N)) {
      if (cellRegion[K(r, c)] !== undefined) continue;
      let asn = 0;
      for (const [dr, dc] of ORTHO) { const v = cellRegion[K(r + dr, c + dc)]; if (v !== undefined) { asn = v; break; } }
      cellRegion[K(r, c)] = asn;
    }
    const regions = [...Array(numRegions)].map((_, i) => ({ name: REGION_DEFS[i][0], color: REGION_DEFS[i][1], cells: [] }));
    for (const [r, c] of allCells(N)) regions[cellRegion[K(r, c)]].cells.push([r, c]);
    return regions.filter((g) => g.cells.length);
  }

  function buildSceneAndVictim(N, perm, H) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const numRegions = Math.min(REGION_DEFS.length, 2 + H.randInt(Math.max(1, Math.min(N - 1, 4))));
      const regions = growRegions(N, numRegions, H);
      const regionOf = {};
      for (const g of regions) for (const [r, c] of g.cells) regionOf[K(r, c)] = g.name;
      const countByRegion = {};
      for (const p of perm) { const rn = regionOf[K(p.row, p.col)]; countByRegion[rn] = (countByRegion[rn] || 0) + 1; }
      const rooms = Object.keys(countByRegion).filter((rn) => countByRegion[rn] === 2);
      if (!rooms.length) continue;
      const room = H.pick(rooms);
      const victim = H.pick(perm.filter((p) => regionOf[K(p.row, p.col)] === room));
      return { regions, regionOf, victim, murderRoom: room };
    }
    return null;
  }

  // Put a UNIQUE occupiable object on EVERY suspect cell (so each suspect always
  // has an "on the X" clue that pins them instantly — guarantees a solvable
  // fallback). Add scenery beside some suspects + a few decoys for clue variety.
  function buildObjects(N, perm, victim, regionOf, H) {
    const objects = [];
    const occ = H.shuffle(OCCUPIABLE.slice());
    const scn = H.shuffle(SCENERY.slice());
    const used = new Set();
    const suspects = perm.filter((p) => p !== victim);
    const onType = {}; // "r,c" -> object type sitting there

    suspects.forEach((p, i) => {
      const [type, emoji] = occ[i % occ.length];
      objects.push({ type, emoji, occupiable: true, row: p.row, col: p.col });
      used.add(K(p.row, p.col)); onType[K(p.row, p.col)] = type;
    });

    let si = 0;
    for (const p of suspects) {
      if (si >= scn.length) break;
      if (H.randInt(10) < 6) {
        const spots = ORTHO.map(([dr, dc]) => [p.row + dr, p.col + dc])
          .filter(([r, c]) => r >= 1 && r <= N && c >= 1 && c <= N && regionOf[K(r, c)] === regionOf[K(p.row, p.col)] && !used.has(K(r, c)) && !perm.some((q) => q.row === r && q.col === c));
        if (spots.length) { const [r, c] = H.pick(spots); const [type, emoji] = scn[si++]; objects.push({ type, emoji, occupiable: false, row: r, col: c }); used.add(K(r, c)); }
      }
    }
    const empties = H.shuffle(allCells(N).filter(([r, c]) => !used.has(K(r, c)) && !perm.some((q) => q.row === r && q.col === c)));
    const decoys = Math.min(empties.length, 1 + H.randInt(2));
    for (let i = 0; i < decoys && si < scn.length; i++) { const [r, c] = empties[i]; const [type, emoji] = scn[si++]; objects.push({ type, emoji, occupiable: false, row: r, col: c }); }
    return { objects, onType };
  }

  // Enumerate every TRUE structured clue available to `self`. Relations only ever
  // reference OTHER SUSPECTS — never the victim — so the victim stays solvable last.
  function candidateClues(scene, people, self, N, H) {
    const out = [];
    const [r, c] = [self.row, self.col];
    const W = (clue, w) => out.push(Object.assign(clue, { _w: w }));
    const myReg = scene.regionAt(r, c);

    /* ---- absolute / board (unary) ---- */
    W({ type: 'region', region: myReg }, 1);
    for (const rn of scene.regionNames) if (rn !== myReg) W({ type: 'notRegion', region: rn }, 1.2);
    W({ type: 'row', row: r }, 1.6);
    W({ type: 'col', col: c, _cols: N }, (c === 1 || c === N) ? 2.6 : 1.6);
    W({ type: 'rowParity', parity: r % 2 === 1 ? 'odd' : 'even' }, 2.2);
    W({ type: 'colParity', parity: c % 2 === 1 ? 'odd' : 'even' }, 2.2);
    if (r >= 2 && r <= N - 1) { W({ type: 'rowMax', k: r, _n: N }, 2.6); W({ type: 'rowMin', k: r, _n: N }, 2.6); }
    if (c >= 2 && c <= N - 1) { W({ type: 'colMax', k: c, _n: N }, 2.6); W({ type: 'colMin', k: c, _n: N }, 2.6); }
    if ((r === 1 || r === N) && (c === 1 || c === N)) W({ type: 'corner' }, 3.2);
    if (r === 1 || r === N || c === 1 || c === N) W({ type: 'edge' }, 2.2);
    else W({ type: 'interior' }, 2.4);
    if (scene.onFurniture(r, c)) W({ type: 'onFurniture' }, 2);
    if (!scene.anyObject(r, c)) W({ type: 'standing' }, 2);
    /* ---- object-anchored (unary) ---- */
    const onPeople = (cells) => people.filter((p) => cells.some(([cr, cc]) => cr === p.row && cc === p.col)).length;
    for (const type of scene.objTypes) {
      const inst = scene.objCellsOf(type);
      if (scene.hasObj(type, r, c)) {
        W({ type: 'on', obj: type }, 6);
        if (onPeople(inst) === 1) W({ type: 'onlyOn', obj: type }, 5.5); // A is the only person on this object
      }
      if (holdsUnary(scene, { type: 'beside', obj: type }, r, c)) W({ type: 'beside', obj: type }, 4);
      // direction / diagonal relative to the object (works for any instance count)
      for (const d of ['north', 'south', 'east', 'west']) if (dirObjHolds(scene, d, type, r, c)) W({ type: 'dirObj', dir: d, obj: type }, 2.2);
      for (const d of ['northwest', 'northeast', 'southwest', 'southeast']) if (diagObjHolds(scene, d, type, r, c)) W({ type: 'diagObj', dir: d, obj: type }, 3);
      // exact offsets/vectors are only crisp when the object is unique
      if (inst.length === 1) {
        const [tr, tc] = inst[0];
        if (r !== tr) W({ type: 'offsetObj', axis: 'row', delta: r - tr, obj: type }, 3.6);
        if (c !== tc) W({ type: 'offsetObj', axis: 'col', delta: c - tc, obj: type }, 3.6);
        if (r !== tr && c !== tc) W({ type: 'vectorObj', dr: r - tr, dc: c - tc, obj: type }, 4.4);
      }
    }

    /* ---- alone in region (semi-global) ---- */
    if (people.filter((p) => scene.regionAt(p.row, p.col) === myReg).length === 1) W({ type: 'aloneRegion', region: myReg }, 5.5);

    /* ---- relations to other suspects ---- */
    const others = people.filter((p) => !p.isVictim && p.name !== self.name);
    for (const q of others) {
      const qr = q.row, qc = q.col, dr = r - qr, dc = c - qc;
      if (r < qr) W({ type: 'dir', dir: 'north', target: q.name }, 2);
      if (r > qr) W({ type: 'dir', dir: 'south', target: q.name }, 2);
      if (c < qc) W({ type: 'dir', dir: 'west', target: q.name }, 2);
      if (c > qc) W({ type: 'dir', dir: 'east', target: q.name }, 2);
      // diagonal direction (both axes differ — always true under the perm rule)
      const diag = (r < qr ? 'north' : 'south') + (c < qc ? 'west' : 'east');
      W({ type: 'diag', dir: diag, target: q.name }, 4);
      W({ type: 'offset', axis: 'row', delta: dr, target: q.name }, 4.5);
      W({ type: 'offset', axis: 'col', delta: dc, target: q.name }, 4.5);
      W({ type: 'vector', dr, dc, target: q.name }, 5); // exact 2-D offset — strongest relation
      if (Math.abs(dr) === 1 && Math.abs(dc) === 1) W({ type: 'adjdiag', target: q.name }, 3.6);
      if (Math.max(Math.abs(dr), Math.abs(dc)) <= 2) W({ type: 'near', k: 2, target: q.name }, 3.4);
      if (scene.regionAt(r, c) === scene.regionAt(qr, qc)) W({ type: 'sameRegion', target: q.name }, 4);
    }

    /* ---- between two other suspects (ordering along a row/column) ---- */
    for (let a = 0; a < others.length; a++) for (let b = a + 1; b < others.length; b++) {
      const B = others[a], C = others[b];
      if ((B.col < c && c < C.col) || (C.col < c && c < B.col)) W({ type: 'between', axis: 'col', targets: [B.name, C.name] }, 4.2);
      if ((B.row < r && r < C.row) || (C.row < r && r < B.row)) W({ type: 'between', axis: 'row', targets: [B.name, C.name] }, 4.2);
    }

    /* ---- logical combinators: AND / OR / NOT (each references ≤ 1 person) ----
     * All built from clauses that are TRUE for this suspect, so the whole
     * combinator is true. Leaves are copied (without weights) to stay clean. */
    const leaf = (cl) => { const { _w, ...rest } = cl; return rest; };
    const trueUnary = out.filter((cl) => isUnary(cl)).map(leaf);
    const binByTarget = {};
    for (const cl of out) if (isBinary(cl)) (binByTarget[cl.target] = binByTarget[cl.target] || []).push(leaf(cl));
    const notOnTypes = scene.objTypes.filter((t) => !scene.hasObj(t, r, c)); // A is NOT on these

    // OR: "in the Kitchen or the Living Room" (true via the real region)
    for (const rn of H.shuffle(scene.regionNames.filter((x) => x !== myReg)).slice(0, 2))
      W({ type: 'or', subs: [{ type: 'region', region: myReg }, { type: 'region', region: rn }] }, 1.6);

    // AND of two independent true facts → an intersection (often strong)
    for (let k = 0; k < 3 && trueUnary.length >= 2; k++) {
      const a1 = H.pick(trueUnary), a2 = H.pick(trueUnary);
      if (a1.type !== a2.type) W({ type: 'and', subs: [a1, a2] }, 4);
    }

    // AND with a negation: "in the Kitchen and not on the table"
    for (const t of H.shuffle(notOnTypes).slice(0, 2))
      W({ type: 'and', subs: [{ type: 'region', region: myReg }, { type: 'not', sub: { type: 'on', obj: t } }] }, 2.8);
    if (notOnTypes.length) W({ type: 'not', sub: { type: 'on', obj: H.pick(notOnTypes) } }, 1.3); // standalone "not on the table"

    // combinators that lean on a single other person
    for (const tn of H.shuffle(Object.keys(binByTarget)).slice(0, 2)) {
      const ls = binByTarget[tn];
      if (ls.length >= 2) {
        const two = H.shuffle(ls.slice()).slice(0, 2);
        if (two[0].type !== two[1].type) W({ type: 'and', subs: two }, 3.6);  // "north of B and in the same room as B"
      }
      W({ type: 'and', subs: [{ type: 'region', region: myReg }, H.pick(ls)] }, 3.2); // "in the Kitchen and north of B"
      W({ type: 'or', subs: [{ type: 'region', region: myReg }, H.pick(ls)] }, 1.6);  // "in the Kitchen or north of B"
    }
    return out;
  }

  // Directed repair: start varied, then downgrade unresolved suspects to their
  // guaranteed-singleton "on the X" clue until propagation solves with the
  // victim last. Restart a few times and keep the most VARIED solving set.
  function selectClues(scene, people, N, victimName, H) {
    const suspects = people.filter((p) => !p.isVictim);
    const cand = {};
    for (const s of suspects) {
      cand[s.name] = candidateClues(scene, people, s, N, H);
      cand[s.name]._on = cand[s.name].find((cl) => cl.type === 'on') || null;
      if (!cand[s.name].length) return null;
    }
    const BORING = new Set(['on', 'onlyOn']); // singleton object clues — fine, but interchangeable
    const distinctTypes = (set) => new Set(suspects.map((s) => set[s.name].type)).size;
    const nonBoring = (set) => suspects.filter((s) => !BORING.has(set[s.name].type)).length;
    const solvesWith = (set) => {
      for (const s of suspects) s.clue = set[s.name];
      const res = logicSolve(scene, people);
      const vl = res.ok && suspects.every((s) => res.sweepOf[s.name] <= res.sweepOf[victimName]);
      return res.ok && vl ? res : null;
    };

    // Phase 1 — directed repair: start varied, downgrade the most-unresolved
    // suspect to its guaranteed-singleton "on the X" clue until it solves.
    const repair = (rst) => {
      const cur = {};
      for (const s of suspects) cur[s.name] = H.weightedPick(cand[s.name], (cl) => Math.pow(cl._w, rst === 0 ? 0.7 : 1.4));
      for (let step = 0; step <= suspects.length + 2; step++) {
        for (const s of suspects) s.clue = cur[s.name];
        const res = logicSolve(scene, people);
        if (res.ok && suspects.every((s) => res.sweepOf[s.name] <= res.sweepOf[victimName])) return cur;
        let target = null, biggest = 1;
        for (const s of suspects) { const sz = res.sizes[s.name] || 1; if (sz > biggest && cur[s.name].type !== 'on' && cand[s.name]._on) { biggest = sz; target = s; } }
        if (!target) target = suspects.find((s) => cur[s.name].type !== 'on' && cand[s.name]._on);
        if (!target) return null;
        cur[target.name] = cand[target.name]._on;
      }
      return null;
    };

    // Phase 2 — diversity upgrade: swap each singleton object clue ("on"/"only
    // person on X") for a more interesting TRUE clue, preferring clue TYPES not
    // yet used so the final set spans many rules — but only when the puzzle still
    // solves uniquely with the victim last.
    const upgrade = (set) => {
      for (let pass = 0; pass < 2; pass++) {
        for (const s of H.shuffle(suspects.slice())) {
          if (!BORING.has(set[s.name].type)) continue;
          const counts = {};
          for (const x of suspects) counts[set[x.name].type] = (counts[set[x.name].type] || 0) + 1;
          const curType = set[s.name].type;
          const alts = cand[s.name].filter((cl) => !BORING.has(cl.type))
            .sort((a, b) => {
              const ua = counts[a.type] || 0, ub = counts[b.type] || 0;
              if (ua !== ub) return ua - ub;                 // least-used type first → spreads variety
              return b._w - a._w + (H.randInt(3) - 1) * 0.4;  // then strongest (with jitter)
            }).slice(0, 28);
          // also allow the alternate boring form (onlyOn↔on) as a last resort
          for (const alt of alts) {
            if (alt.type === curType) continue;
            const trial = Object.assign({}, set); trial[s.name] = alt;
            if (solvesWith(trial)) { set[s.name] = alt; break; }
          }
        }
      }
      return set;
    };

    let best = null, bestScore = -1, bestNon = -1;
    for (let rst = 0; rst < 6; rst++) {
      let set = repair(rst);
      if (!set) continue;
      set = upgrade(set);
      const d = distinctTypes(set), nb = nonBoring(set);
      if (d > bestScore || (d === bestScore && nb > bestNon)) { bestScore = d; bestNon = nb; best = set; }
      if (bestScore === suspects.length) break;
    }
    if (!best) return null;
    const res = solvesWith(best);
    return { sweepOf: res.sweepOf, order: res.order, variety: nonBoring(best), distinctTypes: distinctTypes(best) };
  }

  // Build ONE complete candidate case. Returns a normalized `g` or null.
  function buildOneCase(N, H) {
    for (let boards = 0; boards < 60; boards++) {
      const perm = randomPermutation(N, H);
      const sv = buildSceneAndVictim(N, perm, H);
      if (!sv) continue;
      const { regions, regionOf, victim, murderRoom } = sv;
      const { objects } = buildObjects(N, perm, victim, regionOf, H);
      const names = H.shuffle(NAMES.slice()).slice(0, N);
      const people = perm.map((pos, i) => ({ name: names[i], gender: H.pick(GENDERS), row: pos.row, col: pos.col, isVictim: pos === victim, clue: null }));
      const victimName = people.find((p) => p.isVictim).name;
      const scene = makeScene({ grid: { rows: N, cols: N }, regions, objects });
      const sel = selectClues(scene, people, N, victimName, H);
      if (!sel) continue;
      const vPos = people.find((p) => p.isVictim);
      const murderer = people.find((p) => !p.isVictim && regionOf[K(p.row, p.col)] === regionOf[K(vPos.row, vPos.col)]);
      return { N, regions, objects, people, victim: victimName, murderer: murderer.name, murderRoom, order: sel.order, variety: sel.variety, distinctTypes: sel.distinctTypes };
    }
    return null;
  }

  // Normalized `model` (for solve/validate) from a generated `g`.
  function modelFromG(g) {
    return {
      grid: { rows: g.N, cols: g.N },
      regions: g.regions,
      objects: g.objects,
      people: g.people.map((p) => ({ name: p.name, gender: p.gender, row: p.row, col: p.col, isVictim: p.isVictim, clue: p.clue })),
      victim: g.victim, murderer: g.murderer, murderRoom: g.murderRoom,
    };
  }

  // App authoring JSON (+ _murdoku structured payload) from a generated `g`.
  function authoringFromG(g, title) {
    const suspects = g.people.filter((p) => !p.isVictim);
    const victim = g.people.find((p) => p.isVictim);
    const objects = g.objects.map((o) => ({ type: o.type, emoji: o.emoji, occupiable: o.occupiable, row: o.row, col: o.col }));
    return {
      title,
      grid: { rows: g.N, cols: g.N },
      regions: g.regions.map((r) => ({ name: r.name, color: r.color, cells: r.cells })),
      objects,
      people: [
        ...suspects.map((p) => ({ name: p.name, gender: p.gender, row: p.row, col: p.col, clue: prose(p.clue, subjOf(p.gender)) })),
        { name: victim.name, gender: victim.gender, row: victim.row, col: victim.col, victim: true },
      ],
      generalClues: [
        'Every person stands in a distinct row and a distinct column.',
        'The victim was alone with the murderer — the only other person in their room.',
      ],
      _murdoku: {
        version: 1,
        grid: { rows: g.N, cols: g.N },
        regions: g.regions,
        objects,
        victim: victim.name,
        murderer: g.murderer,
        murderRoom: g.murderRoom,
        suspects: suspects.map((p) => ({ name: p.name, gender: p.gender, row: p.row, col: p.col, clue: p.clue })),
        victimSolveOrder: g.order,
      },
    };
  }

  // Build a normalized model from an app `_murdoku` payload + authoring people
  // (used by the Studio for the Solve / Validate buttons).
  function modelFromMurdoku(m, authoringPeople) {
    const va = (authoringPeople || []).find((p) => p.victim) || {};
    const proseByName = {};
    (authoringPeople || []).forEach((p) => { if (!p.victim) proseByName[p.name] = p.clue; });
    return {
      grid: m.grid,
      regions: m.regions,
      objects: m.objects,
      people: [
        ...m.suspects.map((s) => ({ name: s.name, gender: s.gender, row: s.row, col: s.col, isVictim: false, clue: s.clue })),
        { name: m.victim, gender: va.gender, row: va.row != null ? va.row : (m.victimRow), col: va.col != null ? va.col : (m.victimCol), isVictim: true, clue: null },
      ],
      victim: m.victim, murderer: m.murderer, murderRoom: m.murderRoom,
      _proseByName: proseByName,
    };
  }

  /* High-level generate: regenerate until validate + solve both pass. */
  function generate(N, opts) {
    opts = opts || {};
    const maxAttempts = opts.maxAttempts || 1000;
    const rng = opts.rng || (opts.seed != null ? mulberry32(opts.seed) : Math.random);
    const H = makeHelpers(rng);
    let attempts = 0;
    for (; attempts < maxAttempts; attempts++) {
      const g = buildOneCase(N, H);
      if (!g) continue;
      const model = modelFromG(g);
      const val = validateModel(model);
      const sol = solveModel(model);
      if (val.pass && sol.pass) {
        const title = opts.title || `Murdoku ${N}×${N} — ${g.murderRoom} Murder`;
        return { ok: true, attempts: attempts + 1, g, model, authoring: authoringFromG(g, title), validate: val, solve: sol, title };
      }
    }
    return { ok: false, attempts };
  }

  return {
    // primitives
    K, allCells, ORTHO, PRON, subjOf, mulberry32, makeScene,
    holdsUnary, relHolds, isRelative, holdsFull, prose,
    logicSolve, countSolutions,
    // high-level
    generate, validateModel, solveModel,
    // converters / builders
    modelFromG, authoringFromG, modelFromMurdoku,
    // data
    REGION_DEFS, OCCUPIABLE, SCENERY, NAMES,
  };
});
