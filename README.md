# Murdoku Studio

A puzzle maker for **Murdoku** — the murder-mystery-meets-Sudoku game. Design a
crime scene, place your cast, and the tool writes the clue cards *and proves the
puzzle has exactly one solution* before you publish it.

> Open `index.html` in any browser. No build step, no server. Everything saves to
> your browser's local storage.

## How Murdoku works (the rules this tool enforces)

- An **R×C grid** is the crime scene. Every person — suspects **and** the victim —
  stands in one cell. **Row/Column constraint:** at most one person per row and per
  column (just like Sudoku).
- The grid is split into named, colored **regions** (Living Room, Kitchen…).
  **Objects** (shelf, bed, chair, TV…) sit on cells and get referenced by clues.
- Each suspect carries **one clue card** describing where they stood.
- The victim's card is the **murder condition**: *"…was alone with the murderer."*
  The victim shares a region with **exactly one** suspect — that suspect is the
  murderer.

## Workflow

1. **Grid** — set the size (3–9 each way).
2. **🎨 Paint regions** — add a region, then click/drag cells to color them.
3. **🪑 Place objects** — pick an object, click cells. Add custom ones with any emoji.
4. **🧍 Place people** — add suspects, mark one **victim** (🩸 → 💀), then drop each on the board.
   Keep it a valid permutation (one per row & column).
5. **🗂️ Clue cards** — hit **✨ Auto-build solvable set** and the tool picks one clue
   per suspect that yields a *single* solution. Use the dropdown / ↻ on any card to
   swap in a different true clue; the verdict re-checks live.
6. **Export / Print** — download the case JSON, or print a play-ready sheet with an
   answer key.

## Case status panel

Live validation: victim & suspect counts, everyone placed, the row/column
constraint, the murder condition (who's alone with the victim), and — the important
one — **how many solutions the clues admit**. You want *"Exactly one solution."*

## Design

The look is lifted from the [murdoku.fans](https://murdoku.fans) guide: Nunito +
Patrick Hand, warm paper, thick ink borders, hard offset "sticker" shadows, and a
pastel accent palette. Tokens live in `styles.css` under `:root`.
