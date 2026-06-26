'use strict';
/* ============================================================================
 * Murdoku SOLVER (CLI)
 *
 *   node solve.js <case.json>
 *
 * Certifies the two hard guarantees:
 *   1. LOGIC-SOLVABLE (no guessing) — pure constraint propagation places every
 *      person (it only eliminates, never branches).
 *   2. EXACTLY ONE SOLUTION — confirmed by an exhaustive backtracking count,
 *      independent of the propagator.
 * Also prints the deduction order (victim falls out LAST) and the solution.
 * Exit 0 iff both guarantees hold (and the victim is last).
 * ========================================================================== */

const fs = require('fs');
const E = require('./engine');

function load(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('ERROR: cannot read/parse JSON: ' + e.message); process.exit(1); }
  if (!raw._murdoku) { console.error('ERROR: no `_murdoku` block — the solver needs the structured clues the generator embeds.'); process.exit(1); }
  return { raw, model: E.modelFromMurdoku(raw._murdoku, raw.people) };
}

function drawGrid(N, assign) {
  const at = {};
  for (const [name, [r, c]] of Object.entries(assign)) at[r + ',' + c] = name;
  const w = Math.max(3, ...Object.keys(assign).map((n) => n.length)) + 1;
  const bar = '    +' + Array(N).fill('-'.repeat(w)).join('+') + '+';
  const lines = [];
  for (let r = 1; r <= N; r++) {
    lines.push(bar);
    let row = `  r${r}|`;
    for (let c = 1; c <= N; c++) { const who = at[r + ',' + c] || '·'; row += who.slice(0, w).padStart(Math.ceil((w + who.slice(0, w).length) / 2)).padEnd(w) + '|'; }
    lines.push(row);
  }
  lines.push(bar);
  return lines.join('\n');
}

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node solve.js <case.json>'); process.exit(1); }
  const { raw, model } = load(file);
  const N = model.grid.rows;
  const nSus = model.people.filter((p) => !p.isVictim).length;
  const s = E.solveModel(model);

  console.log(`\nSolving: ${file}   (${N}×${N}, ${nSus} suspects + 1 victim)\n`);
  console.log('Deduction order (each name resolves to a single cell):');
  console.log('  ' + (s.order.length ? s.order.map((n) => (n === s.victim ? `[${n}]` : n)).join(' → ') : '(nothing could be pinned by pure logic)'));
  console.log('  (victim in [brackets]; it should appear last)\n');

  console.log('Guarantees:');
  console.log(`  ${s.logicOK ? '✓' : '✗'} Logic-solvable with NO guessing`);
  console.log(`  ${s.unique ? '✓' : '✗'} Exactly ONE solution (exhaustive search found ${s.nSol >= 3 ? '3+' : s.nSol})`);
  if (s.logicOK) {
    console.log(`  ${s.victimLast ? '✓' : '✗'} Victim is determined LAST`);
    console.log(`  ${s.matches ? '✓' : '✗'} Logic solution matches the stated placement`);
    console.log('\nSolution:\n' + drawGrid(N, s.assign));
    console.log(`\n  Victim "${s.victim}" was in the ${s.sceneRegion}; the only suspect there is ${s.murderer || '???'} → the murderer.`);
  } else if (s.reason) {
    console.log(`\n  Contradiction: ${s.reason}`);
  }

  console.log('\n' + (s.pass ? 'SOLVER VERDICT: valid logic puzzle — single solution, no guessing, victim last.'
                              : 'SOLVER VERDICT: FAILED — see ✗ above.'));
  process.exit(s.pass ? 0 : 1);
}

main();
