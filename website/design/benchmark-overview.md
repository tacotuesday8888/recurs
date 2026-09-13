# Benchmark overview and visible installation choices

This pass follows the narrowed request: make the benchmark section easier to read
and put package-manager choices directly above the installation command. Jcode
messaging is a separate feature idea; no messaging demo or product feature is added.

| Before | After | Why |
| --- | --- | --- |
| Package managers hidden in a disclosure | npm, Bun and Homebrew directly above the command | All supported install choices are visible immediately. |
| Aggregate paragraph followed by a disclosure | Equal-size attempt grid grouped by task and product | Outcomes can be scanned and selected without overstating the evidence. |
| All detail reached through one disclosure | Each attempt opens its task's results and focuses the details | Keyboard and pointer users can inspect the relevant evidence. |

Keep the canonical canvas #191714, foreground #f3ede5, muted #b7ac9e, orange
#f3a05b and line #494139. Both products use identical outcome colors and dimensions.
Icons and accessible names distinguish outcomes without depending on color.
Five finished, five unfinished and two invalid slots preserve the audited record.
The full shared R and existing typography remain unchanged in this focused pass.

Verification: 37 website tests pass; focused ESLint passes. Browser checks cover
Bun/Homebrew command switching, the grid at desktop and 320px widths, keyboard
activation opening the matching task details and moving focus, and no horizontal
overflow. Benchmark artifacts and terminal geometry are unchanged.
