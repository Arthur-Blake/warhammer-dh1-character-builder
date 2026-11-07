# Project instructions

- This project is a small, dependency-free browser application using plain HTML, CSS, and JavaScript.
- Keep the Russian-language UI and the existing visual style unless the task asks to change them.
- Preserve compatibility with the current `localStorage` data and XML import/export format unless a migration is explicitly requested.
- Keep game rules and reference data in separate SQLite tables initialized from `reference_seed.json` by `server.py`; keep application behavior in `app.js` and markup in `index.html`.
- Make the smallest change that satisfies the request. Avoid unrelated refactors, new frameworks, and dependencies.
- Before editing, inspect the relevant code and the current working-tree changes. Do not overwrite unrelated user changes.
- After editing, inspect the diff and run checks that are available in the repository. Do not claim a check passed if it was not run.
- Keep long sessions compact: inspect only relevant file sections, avoid repeating prior findings or reproducing large data, and use concise progress notes with decisions, changed files, checks, and the next action. Give agents only the context needed for their task.
