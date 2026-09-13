# Large terminal R, quieter landing page

The hero uses the terminal's exact 64 × 20 ASCII projection, cropped only around
its empty columns, at its independent 80 ms cadence. Geometry and lighting remain
shared. The large R sits left of the headline and installation command on desktop,
and above them on mobile. The header carries the wordmark and three links.

The palette stays canonical: background #191714, foreground #f3ede5, muted #b7ac9e,
orange #f3a05b, ember #d96545, highlight #e7c29c. System sans-serif provides the readable copy;
monospace glyphs preserve the terminal's character. No added font or animation dependency.

| Before | After | Why |
| --- | --- | --- |
| Small rotating navigation ornament | Large shared R in the hero | Make the actual terminal identity the primary visual. |
| Main-navigation motion button and automatic video | Quiet footer preference and explicitly played demo | Keep one automatic animation; preserve an accessible stop control. |
| Permanently expanded current and earlier results | Honest current totals, full-record disclosure, archive artifacts off the homepage | Reduce initial text while retaining every failure, invalid attempt and source record. |
| Side-mounted terminal controls | Single play/pause control beside a quiet demo label | Put interaction next to what it changes. |

Applied installed `frontend-design` and `emil-design-eng` guidance. Reviewed
`recurs-web-design-guidelines`, installed from Vercel's agent-skills at pinned
commit `063bee94c3f4df8453406c830b0a7df0f2860278`.
Primary guidance: [Vercel interface rules](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md),
[Emil's design exercises](https://emilkowal.ski/ui/train-your-judgement), and
[W3C pause/stop guidance](https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide.html).

Native buttons, disclosures and links retain visible focus and keyboard access.
Reduced motion and saved pause settle the art and counts. The footer toggle remains
available for people without an operating-system preference. User-selected video
playback has its own control. No benchmark record, score, model route or audit is changed.

Follow-up: reduced headline size, removed the Activity/Changes/Approvals tab row and provenance caption, and removed historical results from the homepage. Original downloadable records remain byte-identical. Current evidence retains complete totals and all attempts in a disclosure.

Verification: 35 website tests pass, including exact shared terminal geometry, reduced-motion/pause behavior, all 12 current attempts and byte-identical historical artifacts. Focused ESLint passes. Browser checks at 1280, 390 and 320 CSS pixels found no horizontal page overflow; demo playback, pause, keyboard disclosure and footer animation toggle work.
