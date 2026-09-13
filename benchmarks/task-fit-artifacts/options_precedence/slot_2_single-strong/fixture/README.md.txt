# Workspace maintenance task

Fix resolveOptions in src/options.js: for each own enumerable default key, choose the highest-priority own property whose value is not undefined (cli, then project, then defaults). Preserve false, 0, empty string and null. Ignore inherited overrides and unknown keys, preserve own __proto__ keys as data, and never mutate inputs. Keep the synchronous API and dependency-free implementation. Change only src/options.js and run npm test.
