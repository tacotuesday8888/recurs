# Terminal Logo Design QA

## Evidence

- Source visual truth: `docs/assets/recurs-mark.svg` (validated against the supplied canonical-logo reference).
- Reported implementation issue: the supplied 520 × 78 terminal-header screenshot showing the `↻R` signature.
- Revised implementation: `docs/assets/terminal-preview.svg`.
- Source size: 160 × 160 SVG view box.
- Reported issue pixels: 520 × 78 at the supplied image density.
- Revised preview size: 1400 × 540 SVG view box; inspected through a 1400 × 1400 Quick Look capture.
- State: dark terminal, color-capable TTY, guided-onboarding welcome header.
- Full-view comparison evidence: the canonical source mark and revised terminal preview were opened together in one comparison input.
- Focused region comparison: the header and mark are fully readable in the full-view evidence, so a separate detail crop was not necessary.

## Findings

No actionable P0, P1, or P2 mismatch remains within the intentional constraints of a portable text terminal.

- Fonts and typography: the title retains the existing bold monospace treatment and sits beside the second logo row, creating a clear lockup without changing terminal font assumptions.
- Spacing and layout rhythm: the mark is four rows high and seven columns wide; it no longer dominates the onboarding screen, and the body begins after one clear blank line.
- Colors and visual tokens: the existing blue-to-cyan-to-mint ANSI palette follows the same direction as the canonical vector gradient. Plain and color-disabled output remains logo-free and readable.
- Image quality and asset fidelity: the terminal is intentionally code-native and cannot display the smooth vector asset portably. The four-row box-drawing adaptation preserves the canonical upper loop, lower return arrow, open right side, and descending leg without requiring image-protocol support.
- Copy and content: the welcome title and onboarding copy are unchanged.

## Comparison History

1. Earlier P1: the one-line `↻R` signature read as two unrelated characters and lost the canonical logo silhouette.
2. Fix: replaced it with a compact four-row terminal mark derived from the canonical loop-and-return geometry, kept the title alongside it, and retained the established ANSI gradient.
3. Post-fix evidence: the revised preview visibly contains the upper loop, returning arrow, and descending leg while remaining compact enough for the CLI header.

## Follow-up Polish

- P3: terminal fonts vary in box-drawing alignment. The chosen characters are broadly supported, and focused tests cover the exact emitted rows, but users with unusual fonts may see small joins between glyphs.

final result: passed
