# freehouseholdplanner

A local-first app to plan household chores and home projects: recurring tasks, renovation projects,
budgets and quotes, and an idea board. Made for one household, free and open source.

**Status: in development.** There is no release yet. Step 1 (foundation) is being built: the app
starts on Linux and Android but does nothing useful yet.

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
| [`docs/TECHNICAL.md`](docs/TECHNICAL.md) | Technical design: architecture, data model, sync, security |
| [`crates/core`](crates/core) | Rust core: data, business rules, storage and sync, without Tauri |
| [`app`](app) | The app: Svelte UI (`app/src`) and Tauri shell (`app/src-tauri`, Android project in `gen/android`) |
| [`poc/sync`](poc/sync) | Sync proof of concept: Automerge, QR pairing, encryption, unpairing |
| [`poc/android`](poc/android) | How timely a Tauri app on Android receives messages in the background |
| [`CLAUDE.md`](CLAUDE.md) | Guidelines for code, security and git |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability privately |

## Building

Needs Rust (stable), Node.js 26 and, on Linux, the WebKitGTK 4.1 development package. Android also
needs the Android SDK (platform 37) with the NDK and JDK 17; `app/android-env.sh` shows the expected
paths.

```sh
cargo test -p fhp-core            # core tests
cd app && npm ci && npm run check # UI: type check, lint, format, tests, build
npm run tauri dev                 # run the desktop app
source android-env.sh && npm run tauri android build -- --debug --apk --target aarch64
```

The version number lives in the root `Cargo.toml` and in `app/src-tauri/tauri.conf.json`; a test
keeps them equal.

## License

Copyright (C) 2026 the freehouseholdplanner contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
Affero General Public License, version 3, as published by the Free Software Foundation. It comes with
no warranty. See [`LICENSE`](LICENSE).

## Contributing

The project is young and its direction is still set by the maintainer, so please open an issue before
a large change. Contributions are accepted under the same license (AGPL-3.0-only).
