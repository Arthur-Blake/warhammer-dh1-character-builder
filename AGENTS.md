# Project instructions

- This project is a small, dependency-free browser application using plain HTML, CSS, and JavaScript.
- Keep the Russian-language UI and the existing visual style unless the task asks to change them.
- Preserve compatibility with the current `localStorage` data and XML import/export format unless a migration is explicitly requested.
- Keep game rules and reference data in `data.js`; keep application behavior in `app.js` and markup in `index.html`.
- Make the smallest change that satisfies the request. Avoid unrelated refactors, new frameworks, and dependencies.
- Before editing, inspect the relevant code and the current working-tree changes. Do not overwrite unrelated user changes.
- After editing, inspect the diff and run checks that are available in the repository. Do not claim a check passed if it was not run.
- The default `orchestrator` coordinates work: use `analyst` to clarify ambiguous requirements, `explorer` to investigate code, `implementer` to make changes, and `reviewer` for independent diff review. Keep delegation proportional to task size; do not launch agents for routine work that one focused implementation can handle.
- Conserve context: inspect only relevant files/sections, avoid dumping whole files or repeating prior findings, and pass concise handoffs with the goal, acceptance criteria, constraints, and next action.
