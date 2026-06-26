'use strict';
/* ============================================================================
 * Murdoku VALIDATOR (CLI)
 *
 *   node validate.js <case.json>
 *
 * Independently re-checks every solving rule of a generated case (structure,
 * permutation, murder room, clue truth, prose match, uniqueness, logic-
 * solvability, victim-last). Exit 0 = all checks pass.
 * ========================================================================== */

const fs = require('fs');
const E = require('./engine');

function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node validate.js <case.json>'); process.exit(1); }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('ERROR: cannot read/parse JSON: ' + e.message); process.exit(1); }
  if (!raw._murdoku) { console.error('ERROR: no `_murdoku` block — this validator needs the structured clues the generator embeds.'); process.exit(1); }

  const m = raw._murdoku;
  const model = E.modelFromMurdoku(m, raw.people);
  const v = E.validateModel(model);
  const nSus = model.people.filter((p) => !p.isVictim).length;

  console.log(`\nValidating: ${file}`);
  console.log(`Case: ${raw.title || '(untitled)'}  ·  ${m.grid.rows}×${m.grid.cols}  ·  ${nSus} suspects + 1 victim\n`);
  for (const c of v.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail ? '  — ' + c.detail : ''}`);
  console.log('');
  if (v.pass) { console.log(`ALL CHECKS PASSED. Victim "${m.victim}" killed by "${m.murderer}" in the ${m.murderRoom}.`); process.exit(0); }
  console.log('VALIDATION FAILED — see ✗ above.'); process.exit(1);
}

main();
