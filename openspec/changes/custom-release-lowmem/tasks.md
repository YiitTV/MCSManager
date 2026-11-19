# Tasks

## 1. Fork version marker (code)

- [x] 1.1 Add cases to `common/src/__test__/upgrade.test.ts`: `compareVersions("10.22.1.1","10.22.1")` is 1, `("10.22.1.1","10.22.2")` is -1, `("10.22.1.1","10.22.1.1")` is 0; `isComparableVersion("10.22.1.1")` is true; `isComparableVersion("10.22.1-minefield.1")` is false. Verify: `cd common && npm test`.
- [x] 1.2 Add a case to the frontend version test (the existing test for `frontend/src/tools/version.ts`, or a new `frontend/src/tools/__test__/version.test.ts`) asserting `hasVersionUpdate("4.19.3.1","4.19.3")` and `hasVersionUpdate("10.22.1.1","10.22.1")` are false. Verify: `cd frontend && npm run type-check && npm run lint && npm test`.
- [x] 1.3 Set `version` to `10.22.1.1` and `daemonVersion` to `4.19.3.1` in `panel/package.json` and `version` to `4.19.3.1` in `daemon/package.json` (and the matching root entries in each `package-lock.json`). Grep `panel/src`, `daemon/src`, `scripts/` and `frontend/src` for hard-coded `10.22.1` / `4.19.3` expectations and update any test fixtures that assert the real package version. Verify: `cd panel && npm test && npm run build`, `cd daemon && npm test && npm run build`. If any consumer rejects a four-segment version, revert this task and record it in the design (the marker is optional).

## 2. Release build and packaging (build host)

- [ ] 2.1 Optional: in `.github/workflows/release.yml` change the packaging step to `node scripts/build-release-update-packages.mjs --tag "${GITHUB_REF_NAME}" --repo "${GITHUB_REPOSITORY}"` so a fork release writes fork URLs into the manifest. Verify by `git diff` review and a local run of the script with `--repo <owner>/<repo>` against an existing `production-code/`, checking that no manifest `url` mentions the upstream owner.
- [ ] 2.2 Run `./build.sh` on a Node 22.x build host from the fork branch; verify `production-code/web/{app.js,package.json,public/index.html}` and `production-code/daemon/{app.js,package.json}` exist and the package versions are the new four-segment ones.
- [ ] 2.3 Run `node scripts/build-release-update-packages.mjs --tag minefield-<N> --repo <owner>/<repo> --out ./release-out`; verify the tarball listings contain no `data/`, `logs/`, `node_modules/`, `lib/`, and record `sha256sum` output (runbook R3a).
- [ ] 2.4 Run the update harnesses as a regression check of the unchanged updater with the four-segment versions: `node scripts/verify-auto-update.mjs` and `node scripts/verify-auto-update-strict.mjs` (they need a fresh `production-code/` from 2.2 and reset its `data/`). Verify both report success.
- [ ] 2.5 Run the full gate per AGENTS.md section 10 using the `mcsmanager-test` skill: `cd common && npm test && npm run test:integration`, `cd daemon && npm test`, `cd panel && npm test`, `cd frontend && npm test`. Verify all pass and report the results.

## 3. Documentation

- [x] 3.1 Add a short "Fork installs" section to `docs/auto-update.md`: disabling by clearing both source fields (panel and daemon), the four-segment version convention, the `--repo` flag, and pointing the source at a fork manifest with an empty backup. Docs-only; verify by reading the rendered Markdown and checking the stated field names against `panel/src/app/entity/setting.ts` and `daemon/src/entity/config.ts`.

## 4. Operator runbook (run on server)

Commands and expected output for each item are in `runbook.md` (section ids in brackets). The assistant walks the operator through these; each item ends with its Check line. Run items 4.1 to 4.4 in order; item 4.5 needs a maintenance window.

- [ ] 4.1 Baseline and preflight [R1, R2]: record `free -m`, per-process RSS and PSS, `ps` top consumers, `systemctl cat` of both units, `KillMode`/limits, install owner and free disk. Verify the notes include the existing `ExecStart` lines and the decision on `KillMode`.
- [ ] 4.2 Backups [R2b]: code-only tarballs, `data.tgz` (mode 600) and the data file listing under `/opt/mcsm-backup/<timestamp>/`. Verify the listing line count is above 0 and all three archives are non-empty.
- [ ] 4.3 Disable official auto-update in the panel settings [R3b]. Verify the config file shows both fields empty and the UI offers no update after a panel restart.
- [ ] 4.4 Deploy the panel build [R3a, R4]: checksum, stop `mcsm-web`, replace `public/` and extract the web tarball, start, run the verification checklist (listening on 23333, HTTP 200, daemon connection log line, data listing unchanged, new version visible).
- [ ] 4.5 Deploy the daemon build in a maintenance window [R5, R3c]: stop instances gracefully, stop `mcsm-daemon`, clear the daemon update sources (keys only, secrets never printed), extract the daemon tarball, start, run the checklist (24444 listening, authenticated log line, node online, instances start).
- [ ] 4.6 Apply Node tuning one step at a time [R6a to R6d]: pre-test the flags, `MALLOC_ARENA_MAX=2`, then `--max-semi-space-size=4`, then `--max-old-space-size=256`, for the panel first, then the daemon in a window; measure PSS after each 10-minute idle period and keep only non-regressing steps. Verify the live cmdline/environ shows the flags, no `8192` remains, no heap error in the journal, and `mcsm-daemon` has no `MemoryMax`/`MemoryHigh`.
- [ ] 4.7 Cap the journal [R7]. Verify `journalctl --disk-usage` is at most 100 MB.
- [ ] 4.8 Enable zram swap and sysctl [R8a to R8c]. Verify `swapon --show` lists zram of about 1.9 GB with zstd and `sysctl vm.swappiness` is 30.
- [ ] 4.9 Review idle services [R9, R10]: list running services and timers, decide per service, record memory and the undo command for anything disabled, never touch the Azure guest agent, ssh, networking, time sync or ufw; confirm Caddy config and size. Verify ssh, panel, HTTPS and the game servers still work afterwards.
- [ ] 4.10 Apply the JVM recommendations to the three `start.sh` files if the operator agrees [Part G]. Verify `ps -o rss,cmd -C java` and that `free -m` `available` stays at roughly 700 MB or more with all three servers running.
- [ ] 4.11 Acceptance measurement [R12] with the game servers stopped: combined PSS of `mcsm-web`, `mcsm-daemon`, `caddy` is at most 350 MB and `free -m` used is at most about 1024 MB. Verify and keep the before/after numbers.
- [ ] 4.12 Rehearse the rollback once [R13]. Verify the panel serves the previous version with `data/` intact, then redeploy the new build.

## 5. Wrap-up

- [ ] 5.1 Review the whole diff for unrelated changes, confirm the notes from section 4 (baseline, final numbers, disabled services) are recorded for the operator, then archive with `/openspec-archive-change`. Deploy together with the `minefield-branding` change if it is ready.
