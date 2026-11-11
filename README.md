# freehouseholdplanner

A local-first app to plan household chores and home projects: recurring tasks, renovation projects,
budgets and quotes, and an idea board. Made for one household, free and open source.

**Status: in development.** There is no release yet. The repository holds the product requirements and
two proofs of concept.

## Principles

- **Local-first.** Every device holds all household data and works offline. There is no central server
  and no account with any service.
- **Private.** Devices pair with a QR code and sync peer-to-peer, end-to-end encrypted. No tracking,
  no external scripts, no data to third parties.
- **Nothing required.** A household with only phones has every feature. An always-on device at home or
  a relay only make sync faster.
- **Apps** for Android, Windows and Linux, built with Tauri 2 and TypeScript. The interface is in Dutch
  and translatable.

## Repository

| Path | Contents |
| --- | --- |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements (in Dutch): features, decisions, delivery steps |
| [`poc/sync`](poc/sync) | Sync proof of concept: Automerge, QR pairing, encryption, unpairing |
| [`poc/android`](poc/android) | How timely a Tauri app on Android receives messages in the background |
| [`CLAUDE.md`](CLAUDE.md) | Guidelines for code, security and git |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability privately |

## License

Copyright (C) 2026 the freehouseholdplanner contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
Affero General Public License, version 3, as published by the Free Software Foundation. It comes with
no warranty. See [`LICENSE`](LICENSE).

## Contributing

The project is young and its direction is still set by the maintainer, so please open an issue before
a large change. Contributions are accepted under the same license (AGPL-3.0-only).
