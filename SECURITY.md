# Security policy

freehouseholdplanner keeps a household's data on its own devices and syncs it end-to-end encrypted.
Security problems matter, so please report them privately.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/gadeynethomas/freehouseholdplanner/security/advisories/new)
(under the **Security** tab of this repository).

Please include what you found, how to reproduce it and what an attacker could do with it. You will get
a reply within two weeks. Once a fix is out, the advisory is published, with credit to you if you
want it.

## Supported versions

There is no release yet. Until there is, reports apply to the `dev` branch. After the first release,
only the latest release gets security fixes.

## Scope

In scope: pairing and key handling, sync and encryption, storage on the device, the web view on the
home network, read-only share links, and the release and update chain.

Out of scope: problems that need an already unlocked, paired device in the attacker's hands, and
denial of service on a local network the attacker already controls.
