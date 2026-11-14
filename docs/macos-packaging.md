# macOS artifacts from the Linux development host

The application uses Electron's built-in synchronous `node:sqlite`, so it does not carry a Linux-only SQLite addon into the macOS app. Build the source first with `npm run build`, then run:

```sh
node scripts/package-mac-linux.mjs
```

Pass `arm64` or `x64` to build just one architecture. `--prepare-only` downloads and validates runtimes without packaging. Downloads use the official Electron release and SHA256 checksums (or official GitHub release asset digests); a mirror fallback is accepted only when its hash matches the official value. Proxy variables, if needed, are supplied by the caller and are not hardcoded.

The script produces `release/Telldo-<version>-mac-arm64-unsigned.zip` and `release/Telldo-<version>-mac-x64-unsigned.zip`, each with a `.json` evidence manifest. It checks Mach-O CPU architecture, refuses unexpected external native modules, tests ZIP integrity, and preserves framework symlinks. The source checkout's native modules are never replaced. The manifest explicitly records whether the source checkout had uncommitted changes.

These are **unsigned and unnotarized** development packages. Cross-packaging and archive inspection on Linux do not verify execution on macOS, Gatekeeper acceptance, notification authorization, tray behavior, or installed Codex discovery on a Mac. Test those on the target Mac before distributing a release. The standard `npm run package:mac` / `npm run dist:mac` path remains appropriate for building on macOS; production signing/notarization requires the owner's Apple credentials and is outside this MVP implementation.

## Verified artifacts on 2026-11-14

Both architectures were rebuilt with the requested SSH transport and final Python helper from the final renderer build with Electron 45.3.2. The app identity/version in Info.plist, Mach-O architectures, ZIP integrity, absence of external `.node` modules, and all 14 framework symlinks per app were verified. Packaged main code and final CSS/JavaScript were compared byte-for-byte with the build output.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| `Telldo-0.1.0-mac-arm64-unsigned.zip` | 126582326 | `46e5e2e3f742ca6012f6020360acaa05a1e3f672749d891bcd12229bce5ef4f9` |
| `Telldo-0.1.0-mac-x64-unsigned.zip` | 130793623 | `c0cf36eaaa7725e95c5689de8494b28ab1ab7f0bba0f0ec7c76e822842b582c9` |

The cross-build manifests alone do not establish runtime execution. A subsequent **Apple Silicon Mac runtime acceptance passed** after local ad-hoc signing: full manual GUI flow and Mac → SSH → company Codex → local transaction create/undo (14.055 seconds, no renderer errors). The verified client is installed at `/Users/developer/Applications/Telldo.app`, configured for the supplied SSH endpoint, with zero user tasks. Its live SQLite directory is `/Users/developer/Library/Application Support/Telldo/`.

The Intel archive remains untested on Intel macOS. System notification permission/delivery and future network availability are not established by these tests. See [acceptance details](acceptance.md).

## Calendar release 0.2.0

The Apple Silicon calendar package and local installation are recorded in [calendar acceptance](calendar-acceptance.md). Mac runtime acceptance for 0.2.0 is left to the user; the earlier runtime results above concern 0.1.0.
