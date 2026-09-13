# Build watcher: repair incremental rebuild planning

Three existing modules miss changes in a build watcher's dependency graph.
Repair src/changes.js, src/dependents.js and src/plan.js. All exports are
synchronous, dependency-free, and must not mutate inputs. Change only those
three files; public tests are immutable. Run npm test.

Acceptance requirements:
- diffSnapshots(previous, current): each snapshot is an object mapping module
  names to opaque string content hashes. Use only own enumerable keys (including
  names like __proto__ and constructor); inherited properties are ignored.
  Return exactly {changed, removed}. changed contains added names or names whose
  hash changed, removed contains names absent from current. Both arrays are
  unique and sorted by JavaScript's default string sort, with no locale folding.
  Empty-string hashes are valid and must be compared by equality, not truthiness.
- affectedModules(graph, changed): graph maps every known module name to an
  array of names it directly imports. Return changed known modules AND every
  transitive importer, once each, sorted using default string sort. Ignore
  changed names that are not OWN enumerable keys of graph. Handle empty graphs,
  cycles, self imports, duplicate edges, and diamonds without hanging. The graph
  is an inventory spanning the before/after change: deleted modules can still
  appear as keys so their surviving importers can be invalidated. All dependency
  names are graph keys. No additional validation of these valid inputs is needed.
- planBuild(graph, previous, current) returns exactly {changed, removed, build}.
  changed and removed are diffSnapshots results. build is affectedModules seeded
  by BOTH lists, filtered to modules that are OWN enumerable keys of current.
  A changed module outside graph still appears in changed, but not build.
  Deleted modules are never built. Do not compare hashes as numeric values and
  do not infer a rename. Preserve function names and module responsibilities:
  snapshot comparison in changes.js, traversal in dependents.js, composition
  in plan.js. Consumers rely on deterministic output and untouched inputs.

Scope: rebuild selection only, not compilation, filesystem watching, topological
scheduling, or cache correctness across real toolchains. Transitive invalidation
is conservative; no timing or parallel execution advantage is built into grading.
