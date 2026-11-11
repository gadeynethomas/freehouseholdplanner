# CLAUDE.md — freehouseholdplanner

Local-first app for planning household chores and home projects (see `docs/PRD.md`, decisions N4 and N5).
No central server: every device holds all household data and syncs peer-to-peer, end-to-end encrypted.
Stack (direction, details in the technical document): Tauri 2 + TypeScript, SQLite, a CRDT library (Automerge or similar; being validated in `poc/sync`).
Targets: Android, Windows, Linux (K1). License: AGPL-3.0.
UI language: Dutch, all strings translatable. Code, comments, commits: English.
PRD glossary: "toestel" = household appliance (`appliance`), "apparaat" = a phone or PC running the app (`device`).

## Code

- Write small, single-responsibility functions and components.
- TypeScript `strict` mode everywhere; no implicit or explicit `any`. Use `unknown` and narrow it. Rust code (Tauri core) passes `clippy` without warnings.
- Validate all external input at the boundary with a schema: sync messages from other devices, pairing payloads (K2), web-view requests (K10), imported files, backups. Inside the app, trust the types.
- Prefer pure functions for business logic (budget forecast, recurrence schedules, quick-entry parsing, merge rules). Keep I/O (storage, network, OS APIs) at the edges.
- Keep the domain model independent of Tauri, so it runs and is tested in plain Node.
- No dead code, no commented-out code, no TODOs without an issue or a PRD code.
- Name things after the PRD glossary (Huishouden → `household`, Ruimte → `room`, Offerte → `quote`, Uitvoerder → `assignee`, Apparaat → `device`, Toestel → `appliance`, …). Keep one consistent English term per concept.
- Reference PRD requirement codes (H2, B5, K3, …) in tests and PR descriptions when you implement them.

## Dependencies

- Do not add new third-party dependencies (npm or Cargo) without asking first. Say what it does, why the standard library or existing deps fall short, and how big and well-maintained it is.
- Pin exact versions and commit the lockfiles (`package-lock.json`, `Cargo.lock`). Use `npm ci` in CI.
- No runtime calls to external services, CDNs, fonts or analytics. Everything ships inside the app. The only network traffic is sync between household devices and, when needed, the household's own relay (K3).

## Security (from the start, not afterwards)

- Only paired devices get household data (K2). Pairing codes are one-time and expire after 10 minutes.
- All sync traffic is end-to-end encrypted with the household key (K4). A relay or network never sees content. Use well-reviewed primitives from an established library; never roll your own crypto.
- Unpairing a device rotates the household key (K8). Data at rest on a device is encrypted; the app can be locked with a PIN or fingerprint.
- Each household is a separate encrypted unit (A4). A test proves that data from one household never reaches another, for every sync and storage path.
- Treat everything from another device as untrusted: validate, bound sizes, and reject unknown or malformed changes without crashing (K9).
- SQLite: parameterized queries only. No string-built SQL.
- Attachments: enforce the size limit (G2), check the type by content and not only by extension.
- Read-only share links (E3, via the always-on device): random tokens with an expiry, revocable, and they never expose amounts or quotes.
- Web view (K10): off by default, local network only, one-time session code, session ends on stop, idle timeout or app exit; nothing is stored in the browser beyond the session; rate-limit code attempts; strict CSP without inline scripts or third-party origins; show a notification while it runs and warn on unknown networks.
- Log errors without personal data or secrets.
- Never commit secrets, keys or `.env` files. Commit a `.env.example` with dummy values where needed. Check `git status`/the diff before every commit.

## Efficiency and maintainability

- Design for a few thousand tasks per household. Add indexes for the queries you write, avoid N+1 queries and paginate lists.
- Sync exchanges only changes, not full copies (except on first pairing). Keep sync battery-friendly on phones.
- Schema and document-model changes go only through versioned migrations. Never edit a migration that has already run; add a new one. Older app versions must keep syncing with newer ones (K9).
- Store money as integer cents (incl. VAT, B7), never as floats. Store dates in UTC and display them in the household's timezone.
- Accessibility (WCAG 2.2 AA): use semantic HTML, label every form field, make everything work with the keyboard and check contrast.

## Tests

- Always add or update unit tests when building new logic.
- For bug fixes and security issues: first write a failing test that reproduces the problem, then fix it.
- Cover edge cases explicitly: empty, zero, negative, boundaries, timezones and DST, and cancelled tasks in the budget.
- Sync tests use several in-process devices: concurrent offline edits, merges in any order, conflicting fields (K5), unpairing and key rotation (K8), old and new versions together (K9).
- Storage tests run against real SQLite, not mocks.
- Smoke tests: the app starts, a household can be created, a second device can pair and sync, and the main screens load.

## Before finishing a task

1. Run type check, lint, formatter check and the full test suite locally (plus `cargo clippy` and `cargo test` when Rust changed). All must pass.
2. Review your own diff: scope, security, leftovers, secrets.
3. Report what you changed and what you verified. Mention anything you skipped or that failed, and don't call it done unless it is.

## Git and GitHub

- Work directly on `dev`; no feature branches. Only push to `dev`, never to `main`.
- Branch protection may not be available (free GitHub plan), so this rule is enforced by discipline: never run `git push` to `main`.
- A pull request to `main` is only made when the maintainer asks for it.
- Before any PR to `main`, do a code review of all changed code since the last merge (correctness, security, tests, maintainability) and report the findings first.
- Use small, focused commits with a clear message in imperative mood.
- Never force-push to shared branches, rewrite published history or skip hooks (`--no-verify`).

## CI

- Keep it simple (free GitHub plan): one GitHub Actions workflow file, no paid features, no external CI services. Keep runs short to save Actions minutes (cache `npm` and Cargo, no unneeded matrix builds; build release packages for all platforms only when asked).
- Every push to `dev` and every PR to `main` runs CI: type check, lint, full test suite and smoke tests.
- After pushing, follow the CI run until it finishes and report the result.
- If CI fails, find the cause and propose one of two options:
  - **Small fix forward**: the cause is clear, the fix is small and low-risk, and a test covers it.
  - **Roll back and reassess**: the cause is unclear, the fix is large, or data or security is at risk. Revert the commit on `dev` and discuss it before trying again.
- Never make CI green by disabling, skipping or weakening tests.

## When in doubt

- Ask before anything hard to reverse: deleting data or migrations, deleting files, changing CI, adding dependencies, changing the sync protocol or encryption, or changing security settings.
- If a requirement in the PRD is unclear or conflicts with these rules, ask. Don't guess.
