# Murdoku puzzle engine

Generates, solves and validates **Murdoku** cases that are guaranteed to be:

- **valid** — one victim, a full permutation (one person per row & column), and a
  murder room containing exactly one suspect;
- **uniquely solvable** — exactly one arrangement satisfies the clues;
- **logic-solvable (no guessing)** — pure constraint propagation places everyone;
- **victim-last** — the victim carries no clue, so its cell is only pinned once
  every suspect is placed (the single leftover row × column).

All logic lives in **`engine.js`**, which runs in Node (the CLIs below) and in the
browser (the Studio loads it as `window.MurdokuEngine`).

## The three processes

```bash
# 1. GENERATE — asks for grid size, writes an importable case + structured clues.
#    Re-validates and re-solves every candidate; regenerates on any failure
#    (max 1000 attempts).
node generate.js            # interactive
node generate.js 6          # size 6×6
node generate.js 6 case.json 42   # + output path + RNG seed (reproducible)

# 2. SOLVE — certifies the two hard guarantees and prints the deduction order.
node solve.js case.json

# 3. VALIDATE — independently re-checks every rule (structure, permutation,
#    murder room, clue truth, prose match, uniqueness, logic, victim-last).
node validate.js case.json
```

`generate.js` writes the app's **authoring JSON** (importable straight into
Murdoku Studio) plus a `_murdoku` block carrying the machine-readable structured
clues. The Studio ignores unknown keys on import; `solve.js`/`validate.js` (and
the Studio's Solve/Validate buttons) read `_murdoku` to re-prove the puzzle.

## How it works

- **Clues are structured data** that render to the app's free-text prose. The
  solver reasons over the structure; the prose is what the player reads. The
  vocabulary:
  - *Absolute / board*: `region`, `notRegion`, `row`, `col`, `rowParity`,
    `colParity`, `rowMax`/`rowMin`/`colMax`/`colMin` (within the top/bottom k
    rows, leftmost/rightmost k columns), `corner`, `edge`, `interior`,
    `onFurniture`, `standing`, `on` (an object), `beside` (an object).
  - *Anchored to an object*: `dirObj` (somewhere N/S/E/W of the shelf),
    `diagObj` (to the NE of the shelf), `offsetObj` (exactly k rows/columns from
    the shelf), `vectorObj` (exactly a rows + b columns from the shelf).
  - *Exclusive*: `aloneRegion` ("the only person in the Kitchen"),
    `onlyOn` ("the only person on the bed").
  - *Relative to one person*: `dir` (somewhere N/S/E/W), `diag` (NW/NE/SW/SE),
    `offset` (exactly k rows/columns away), `vector` (exactly a rows + b columns
    away — a precise 2-D pin), `adjdiag` (diagonally touching), `near` (within 2
    cells), `sameRegion`.
  - *Relative to two people*: `between` (ordered between B and C along a
    row or column).
  - *Logical combinators*: `not`, `and`, `or` over the clues above — e.g.
    "in the Kitchen **and** not on the table", "in the Living Room **or** the
    Kitchen", "north of Mara **and** in the same room as Mara". To keep solving
    exact and sound, a combinator references **at most one** other person
    (`between`/exclusive clues are never nested); the solver pre-filters
    target-less combinators and arc-consistency-prunes single-target ones, so
    they behave just like the primitive clues.

  Because two people never share a row or column, literal "directly next to"
  and "same row as" are impossible — the diagonal/`near`/`between` forms cover
  those ideas instead.
- **Solver** = constraint propagation: unary clue filtering, relative
  arc-consistency, permutation elimination, and Sudoku-style hidden singles on
  rows/columns. It only ever *eliminates* cells — it never guesses. Because it is
  sound, reducing every person to one cell is itself a proof of uniqueness; an
  exhaustive backtracking count re-confirms it independently.
- **Generation** lays out a random permutation, grows contiguous regions (picking
  a murder room with exactly two people), places a unique occupiable object on
  every suspect cell, then chooses one clue per suspect via directed repair +
  a variety-maximizing upgrade pass so the clues stay interesting.

## Studio integration

`../index.html` loads `generator/engine.js`. In the app:

- **✨ Generate** (top bar) opens a modal to pick the grid size and builds a puzzle.
- **✅ Validate** / **🧠 Solve** (Case status panel) re-prove the current case.
