'use strict';
/* ============================================================================
 * Murdoku puzzle GENERATOR (CLI)
 *
 *   node generate.js                 # interactive: asks for grid size
 *   node generate.js 6               # non-interactive size
 *   node generate.js 6 out.json      # + output path
 *   node generate.js 6 out.json 42   # + RNG seed (reproducible)
 *
 * Produces the app's authoring JSON (importable by Murdoku Studio) plus a
 * `_murdoku` block of structured clues. Every candidate is re-validated and
 * re-solved by the engine; it regenerates on any failure (up to 1000 attempts).
 * Guarantees: valid, single solution, logic-solvable (no guessing), victim last.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const E = require('./engine');

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function main() {
  const [argN, argOut, argSeed] = process.argv.slice(2);
  let N = parseInt(argN, 10);
  if (!Number.isInteger(N)) N = parseInt(await ask('Grid size (3–9, the board is N×N): '), 10);
  if (!Number.isInteger(N) || N < 3 || N > 9) { console.error('Grid size must be an integer from 3 to 9.'); process.exit(1); }
  const seed = argSeed !== undefined ? parseInt(argSeed, 10) : undefined;

  process.stdout.write(`\nGenerating a ${N}×${N} Murdoku puzzle…\n`);
  const t0 = Date.now();
  const r = E.generate(N, { seed, maxAttempts: 1000 });
  if (!r.ok) { console.error(`Failed after ${r.attempts} attempts. Try again or another size.`); process.exit(1); }

  const outPath = path.resolve(argOut || `murdoku-${N}x${N}.json`);
  fs.writeFileSync(outPath, JSON.stringify(r.authoring, null, 2));

  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(2)}s · ${r.attempts} attempt(s) · validated + solved.`);
  console.log(`  Victim:   ${r.g.victim}  (room: ${r.g.murderRoom})`);
  console.log(`  Murderer: ${r.g.murderer}`);
  console.log(`  Solve order (victim last): ${r.solve.order.join(' → ')}`);
  console.log(`  Clue variety: ${r.g.distinctTypes} distinct clue types · ${r.g.variety}/${r.g.people.length - 1} non-"on-object" clues`);
  console.log(`  Wrote: ${outPath}`);
  console.log(`\nValidate:  node ${path.relative(process.cwd(), path.join(__dirname, 'validate.js'))} ${path.relative(process.cwd(), outPath)}`);
  console.log(`Solve:     node ${path.relative(process.cwd(), path.join(__dirname, 'solve.js'))} ${path.relative(process.cwd(), outPath)}`);
}

if (require.main === module) main();
