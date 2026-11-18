# Spec Delta

## Purpose
Defines how a customised fork build of MCSManager is produced and deployed over a live single-host install without losing data and with a tested way back.

## ADDED Requirements

### Requirement: Official updates disabled for fork installs
An install running a fork build SHALL have official update checks disabled by clearing both `updateSourceUrl` and `updateSourceUrlFallback` in the panel settings and in the daemon configuration, without changing code defaults. The operator MAY later set both to the fork's own manifest URL to re-enable manual updates from the fork.

#### Scenario: Panel reports no update after both sources are cleared
- **WHEN** both source fields are empty in the panel settings and the panel is restarted
- **THEN** the panel upgrade info reports the feature as not configured and the UI offers no update

#### Scenario: Daemon honours its own cleared sources
- **WHEN** both source fields are empty in the daemon configuration and the panel forwards no source
- **THEN** the daemon upgrade info reports not configured and no download is attempted

#### Scenario: Fork manifest can be re-enabled later
- **WHEN** the operator sets `updateSourceUrl` to a manifest hosted by the fork and `updateSourceUrlFallback` to empty
- **THEN** update information is fetched only from the fork's manifest

### Requirement: Fork release artifacts are code-only
The fork build SHALL be produced with `build.sh` (`BUNDLE=1`) on a build host and packed with `scripts/build-release-update-packages.mjs` into the existing code-only `mcsmanager_web_update.tar.gz` and `mcsmanager_daemon_update.tar.gz`. The package URLs in the generated manifest MUST point to the fork repository, never to the upstream repository.

#### Scenario: Packages hold only built code
- **WHEN** the two tarballs are listed
- **THEN** `app.js`, `app.js.map` and `package.json` are present (plus `public/` for web) and no `data/`, `logs/`, `node_modules/`, `lib/` or runtime binaries appear

#### Scenario: Manifest points at the fork
- **WHEN** the manifest is generated with `--repo <fork-owner>/<fork-repo>`
- **THEN** every `url` in it starts with `https://github.com/<fork-owner>/<fork-repo>/releases/download/`

### Requirement: Safe deployment over a live install
A deployment SHALL back up the code files being replaced and the `data/` directories before any change, MUST NOT modify, delete or overwrite `data/`, `logs/` or `daemon/lib/`, SHALL verify the tarball checksum before extraction, and SHALL finish with the post-deploy verification checklist of the `mcsmanager-build` skill. Restarting the daemon MUST be preceded by a check that the game-server processes survive it or by a graceful stop of all instances.

#### Scenario: Data is preserved
- **WHEN** a deployment completes
- **THEN** the file listing and checksums of `web/data` and `daemon/data` equal those taken before the deployment

#### Scenario: Corrupt transfer is rejected
- **WHEN** the tarball's SHA-256 differs from the value produced on the build host
- **THEN** nothing is extracted and the running install is unchanged

#### Scenario: Verification checklist passes
- **WHEN** the services are restarted after extraction
- **THEN** ports 23333 and 24444 listen, the panel answers HTTP 200 locally, the web log shows the daemon connection and key validation succeeded, and the daemon log shows the session authenticated

### Requirement: Rollback
Every deployment SHALL be reversible by restoring the pre-deployment code backup and restarting the services, with `data/` untouched, and the procedure SHALL be documented and rehearsed once before first production use.

#### Scenario: Rollback restores the previous version
- **WHEN** the operator restores the code backup and restarts the services
- **THEN** the panel reports the previous version and the existing instances and users are intact
