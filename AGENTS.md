# Project instructions

- The frontend uses plain HTML/CSS/JavaScript; `server.py` provides the Python-standard-library API and SQLite storage. Keep the Russian UI and existing visual style unless asked otherwise.
- Preserve existing SQLite/`localStorage` data, migration paths, and XML import/export compatibility. Change formats or add migrations only when explicitly requested.
- Keep reference datasets and table-driven rule parameters in dedicated SQLite tables, seeded from `reference_seed.json` by `server.py`. Keep rule/application logic in `app.js` and markup in `index.html`.
- Make the smallest focused change. Avoid unrelated refactors, frameworks, and dependencies.
- Delegate to an agent when parallel exploration, implementation, or independent review would add meaningful value; skip trivial or routine tasks.
- Before editing, inspect relevant code and working-tree changes; preserve unrelated user changes.
- After editing, review the diff and run relevant checks available in the repository. Report only checks actually run.
- Keep sessions efficient: inspect only relevant sections, avoid repeating findings or dumping large data, and give agents only necessary context. For multi-step work, send concise progress updates; summarize changed files and checks in the final response when applicable.
