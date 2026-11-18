# Operator Runbook: Minefield custom release and low-memory operation

This is run by the operator (with the assistant walking through it) on the production VM and on a build host. Nothing here is executed by the repository. Run each block on its own, read the "Check" line, and stop on any surprise. Commands marked (server) run on the Azure VM as root or with `sudo`; (build) runs on the build host with Node.js 22.x.

Conventions: `$MCSM=/opt/mcsmanager`. Replace `<owner>/<repo>` with the fork's GitHub path and `<N>` with the fork build number. Never `cat` or paste `daemon/data/Config/global.json`, `web/data/User/*.json` or `web/data/RemoteServiceConfig/*.json`; they hold secrets.

Honest budget: the VM has about 7.7 GB. Platform target is about 1 GB, so at most about 6.5 GB is left; after JVM non-heap overhead and page cache, plan for about 5 GB of total JVM heap (section R11).

---

## Part A. Baseline and safety

### R1. Record the baseline (server)

Run before changing anything and save the output (for example into `~/baseline-before.txt`).

```bash
free -m; echo; swapon --show; echo; uname -r; echo; systemctl is-active mcsm-web mcsm-daemon caddy
```

Check: `mcsm-web`, `mcsm-daemon`, `caddy` all `active`. Note `used` and `available`.

```bash
for u in mcsm-web mcsm-daemon caddy; do pid=$(systemctl show -p MainPID --value $u); printf '%s pid=%s RSS_MB=%s PSS_MB=%s\n' "$u" "$pid" "$(awk '/^VmRSS/{printf "%.1f",$2/1024}' /proc/$pid/status)" "$(awk '/^Pss:/{s+=$2} END{printf "%.1f",s/1024}' /proc/$pid/smaps_rollup)"; done
```

Check: one line per service; panel RSS about 136 MB and daemon about 43 MB match your earlier numbers. Record all three PSS values and their sum.

```bash
ps -eo rss,pid,comm --sort=-rss | head -20
```

Check: the biggest consumers are the three JVMs, then node, caddy, then system services. Record any system service above about 15 MB (candidates for R9).

```bash
systemd-cgtop -m -n 1 --depth=2 2>/dev/null | head -20
```

Check: per-unit memory including children. `mcsm-daemon.service` includes the game servers because they are its child processes.

### R2. Preflight: how the units are defined (server)

```bash
systemctl cat mcsm-web mcsm-daemon --no-pager
```

Check, and write down: (a) the `ExecStart=` lines and whether they contain `--max-old-space-size=`; (b) `WorkingDirectory=`; (c) `User=` (none means root); (d) any `KillMode=`, `MemoryMax=`, `MemoryHigh=`, `Restart=`.

```bash
systemctl show mcsm-daemon -p KillMode -p MemoryMax -p MemoryHigh -p Restart -p User
```

Check: `KillMode=control-group` (default) means stopping or restarting `mcsm-daemon` kills the game servers. Then every daemon restart in this runbook needs the instances stopped gracefully first (R5). `MemoryMax` and `MemoryHigh` must read `infinity` for the daemon and stay that way.

```bash
ls -ld $MCSM $MCSM/web $MCSM/daemon $MCSM/web/data $MCSM/daemon/data $MCSM/daemon/lib; df -h /opt; stat -c '%U:%G' $MCSM/web/app.js $MCSM/daemon/app.js
```

Check: directories exist, `/opt` has at least 1 GB free, and note the owner of `app.js` (used for `chown` later). Run `export MCSM=/opt/mcsmanager` first if the variable is empty.

```bash
grep -m1 '"version"' $MCSM/web/package.json $MCSM/daemon/package.json
```

Check: `10.22.1` and `4.19.3` (or whatever you installed). This is the version to roll back to.

### R2b. Backups (server)

```bash
TS=$(date +%Y%m%d-%H%M%S); echo $TS; mkdir -p /opt/mcsm-backup/$TS && cd /opt/mcsm-backup/$TS && pwd
```

Check: a new directory path is printed. Keep this shell for the next three blocks (they use `$TS`); if you open a new shell, `export TS=<that value>` again.

```bash
tar -czf /opt/mcsm-backup/$TS/web-code.tgz -C $MCSM/web --exclude=./data --exclude=./logs --exclude=./node_modules .
```

Check: no error; then `ls -lh /opt/mcsm-backup/$TS`. This holds app.js, package.json, public/ only (no data).

```bash
tar -czf /opt/mcsm-backup/$TS/daemon-code.tgz -C $MCSM/daemon --exclude=./data --exclude=./logs --exclude=./node_modules --exclude=./lib .
```

Check: no error. `lib/` is excluded on purpose; it is never touched by a deployment.

```bash
chmod 700 /opt/mcsm-backup && tar -czf /opt/mcsm-backup/$TS/data.tgz -C $MCSM web/data daemon/data && chmod 600 /opt/mcsm-backup/$TS/data.tgz && ls -lh /opt/mcsm-backup/$TS
```

Check: `data.tgz` exists with non-zero size and is mode 600 (it contains the sensitive files). This backup is taken while services run; it is a safety copy, `data/` itself is never modified by the deployment.

```bash
(cd $MCSM && find web/data daemon/data -type f -printf '%p %s\n' | sort > /opt/mcsm-backup/$TS/data-listing-before.txt); wc -l /opt/mcsm-backup/$TS/data-listing-before.txt
```

Check: a line count greater than 0. This is compared after deployment (R4, R5).

---

## Part B. Build the fork (build host)

### R3a. Build (build)

```bash
git fetch origin && git checkout <fork-branch> && git pull --ff-only && git log -1 --oneline
```

Check: the commit is the one you intend to ship; the tree is clean (`git status --short` prints nothing).

```bash
./install-dependents.sh
```

Check: first time only (or after dependency changes). It installs packages and builds `common`. No errors.

```bash
./build.sh
```

Check: ends with "Compilation completed!". Harmless warnings: log4js "Critical dependency", vite chunk size. `production-code/web/app.js`, `production-code/web/public/index.html` and `production-code/daemon/app.js` exist.

```bash
node scripts/build-release-update-packages.mjs --tag minefield-<N> --repo <owner>/<repo> --out ./release-out --notes "Minefield build <N>"
```

Check: prints the files it wrote into `release-out/`: `mcsmanager_web_update.tar.gz`, `mcsmanager_daemon_update.tar.gz`, `mcsmanager_update_manifest.json`.

```bash
tar -tzf release-out/mcsmanager_web_update.tar.gz | grep -E '^(\./)?(data|logs|node_modules|lib)/' ; echo "forbidden-entries-exit=$?"
```

Check: prints `forbidden-entries-exit=1` (grep found nothing). Repeat with the daemon tarball. Then:

```bash
grep -o 'https://github.com/[^"]*' release-out/mcsmanager_update_manifest.json
```

Check: every URL starts with `https://github.com/<owner>/<repo>/releases/download/`, none with the upstream owner.

```bash
(cd release-out && sha256sum mcsmanager_web_update.tar.gz mcsmanager_daemon_update.tar.gz | tee SHA256SUMS)
```

Check: two hashes. Copy the two tarballs and `SHA256SUMS` to the server, for example:

```bash
scp release-out/mcsmanager_web_update.tar.gz release-out/mcsmanager_daemon_update.tar.gz release-out/SHA256SUMS <user>@<server>:/tmp/minefield-<N>/
```

Check: three files arrive under `/tmp/minefield-<N>/` on the server (create the directory first with `mkdir -p`).

---

## Part C. Disable official auto-update (server)

### R3b. Panel setting

In the panel UI: Settings, Auto Update tab. Clear both "update source" fields (primary and backup) and save.

Check: the tab shows the feature as not configured and no update is offered.

```bash
python3 - <<'PY'
import json
p="/opt/mcsmanager/web/data/SystemConfig/config.json"
d=json.load(open(p))
print({k:d.get(k) for k in ("updateSourceUrl","updateSourceUrlFallback")})
PY
```

Check: prints `{'updateSourceUrl': '', 'updateSourceUrlFallback': ''}`. This prints only those two keys. If the path does not exist, `ls $MCSM/web/data/SystemConfig/`.

### R3c. Daemon config (daemon stopped, instances already stopped; do this together with R5)

Do this only in the R5 window while `mcsm-daemon` is stopped, otherwise the running daemon can overwrite the file.

```bash
python3 - <<'PY'
import json, os
p="/opt/mcsmanager/daemon/data/Config/global.json"
st=os.stat(p)
d=json.load(open(p))
d["updateSourceUrl"]=""
d["updateSourceUrlFallback"]=""
tmp=p+".tmp"
with open(tmp,"w") as f: json.dump(d,f,indent=4)
os.chmod(tmp, st.st_mode & 0o7777)
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp,p)
print({k:d[k] for k in ("updateSourceUrl","updateSourceUrlFallback")})
PY
```

Check: prints both keys empty; nothing else is printed (the access key is never shown). `ls -l $MCSM/daemon/data/Config/global.json` still shows the original owner and mode.

---

## Part D. Deploy the fork build

### R4. Panel (server)

Panel restarts do not touch game servers.

```bash
cd /tmp/minefield-<N> && sha256sum -c SHA256SUMS
```

Check: both lines `OK`. If either fails, stop: nothing has been changed.

```bash
systemctl stop mcsm-web && systemctl is-active mcsm-web
```

Check: `inactive`.

```bash
rm -rf $MCSM/web/public && tar -xzf /tmp/minefield-<N>/mcsmanager_web_update.tar.gz -C $MCSM/web --no-same-owner && chown -R "$(stat -c '%U:%G' $MCSM/web/data)" $MCSM/web/app.js $MCSM/web/app.js.map $MCSM/web/package.json $MCSM/web/public
```

Check: no error. Only `app.js`, `app.js.map`, `package.json`, `public/` are written. `data/`, `logs/`, `node_modules/` are untouched.

```bash
systemctl start mcsm-web && sleep 5 && systemctl is-active mcsm-web && ss -ltn | grep -E ':23333\b'
```

Check: `active` and a LISTEN line on 23333.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:23333/
```

Check: `200`.

```bash
tail -n 40 $MCSM/web/logs/current.log | grep -i -E 'connected to remote daemon|validation|error' | tail -n 10
```

Check: a line saying the daemon connection and key validation succeeded; no new errors.

```bash
(cd $MCSM && find web/data daemon/data -type f -printf '%p %s\n' | sort) | diff - /opt/mcsm-backup/$TS/data-listing-before.txt | head
```

Check: only runtime-changing files (logs/stat caches) may differ; no data file is missing. Log in through Caddy (the duckdns URL) and confirm instances and users are intact and the footer/about shows the new version (for example `10.22.1.1`).

### R5. Daemon (server, maintenance window)

First, in the panel, stop all three instances gracefully (use each server's normal stop command so worlds are saved). Skip the daemon step entirely if the daemon code did not change in this build.

```bash
pgrep -af 'java|velocity|paper|purpur' | head
```

Check: no game-server processes remain. If any do, stop them from the panel first.

```bash
systemctl stop mcsm-daemon && systemctl is-active mcsm-daemon
```

Check: `inactive`. Now run R3c (daemon config) if not done yet. Then:

```bash
tar -xzf /tmp/minefield-<N>/mcsmanager_daemon_update.tar.gz -C $MCSM/daemon --no-same-owner && chown "$(stat -c '%U:%G' $MCSM/daemon/data)" $MCSM/daemon/app.js $MCSM/daemon/app.js.map $MCSM/daemon/package.json && ls -ld $MCSM/daemon/lib
```

Check: `lib/` still exists and is unchanged (the daemon tarball never contains it).

```bash
systemctl start mcsm-daemon && sleep 5 && systemctl is-active mcsm-daemon && ss -ltn | grep -E ':24444\b'
```

Check: `active` and a LISTEN line on 24444.

```bash
tail -n 40 $MCSM/daemon/logs/current.log | grep -i -E 'authenticated|error' | tail -n 10
```

Check: a "Session ... has successfully authenticated" line after the panel reconnects (give it up to a minute); the panel Nodes page shows the node online. Start the instances from the panel and confirm players can connect.

### R13. Rollback (server)

Rehearse once on a quiet moment.

```bash
systemctl stop mcsm-web && rm -rf $MCSM/web/public && tar -xzf /opt/mcsm-backup/$TS/web-code.tgz -C $MCSM/web && systemctl start mcsm-web && sleep 5 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:23333/
```

Check: `200`; `grep -m1 '"version"' $MCSM/web/package.json` shows the old version. For the daemon, stop instances first, then:

```bash
systemctl stop mcsm-daemon && tar -xzf /opt/mcsm-backup/$TS/daemon-code.tgz -C $MCSM/daemon && systemctl start mcsm-daemon && sleep 5 && systemctl is-active mcsm-daemon
```

Check: `active` and the old version in `daemon/package.json`. `data/` was never changed, so users and instances are intact. If something went wrong with `data/` itself (it should not), restore from `data.tgz` into a scratch directory first and compare before copying anything back.

---

## Part E. Node tuning (server), one step at a time

After each step: restart the unit(s), wait 10 minutes idle, repeat the PSS block from R1, and keep the change only if PSS did not increase and there is no heap error in `journalctl -u <unit> -n 50`. Revert a step by deleting its drop-in line and `systemctl daemon-reload && systemctl restart <unit>`.

### R6a. Pre-test the flags with the server's own node

```bash
NODE=$(systemctl cat mcsm-web | sed -n 's/^ExecStart=\([^ ]*node[^ ]*\).*/\1/p' | head -1); echo "node=$NODE"; "$NODE" --version
```

Check: a path and a version of 22.x. If empty, the unit starts a script; look at the script named in `ExecStart=` and find its `node` line.

```bash
NODE_OPTIONS="--max-old-space-size=256 --max-semi-space-size=4" "$NODE" -e 'console.log("ok", process.env.NODE_OPTIONS)'
```

Check: prints `ok --max-old-space-size=256 --max-semi-space-size=4`. If node says an option "is not allowed in NODE_OPTIONS", use the ExecStart variant below.

### R6b. Step 1: MALLOC_ARENA_MAX (panel first)

```bash
systemctl edit mcsm-web
```

In the editor, enter exactly:

```ini
[Service]
Environment=MALLOC_ARENA_MAX=2
```

Then apply and measure:

```bash
systemctl restart mcsm-web && sleep 600 && tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value mcsm-web)/environ | grep MALLOC_ARENA_MAX
```

Check: prints `MALLOC_ARENA_MAX=2`. Re-run the PSS block from R1 and compare with the baseline. Do the same for `mcsm-daemon` only in a window where the daemon may restart (R5 preconditions).

### R6c. Step 2 and 3: semi-space and heap ceiling

If `systemctl cat` (R2) showed NO `--max-old-space-size` in `ExecStart`, add to the same drop-in:

```ini
[Service]
Environment=MALLOC_ARENA_MAX=2
Environment="NODE_OPTIONS=--max-semi-space-size=4 --max-old-space-size=256"
```

If `ExecStart` DOES contain `--max-old-space-size=8192` (a command-line flag beats `NODE_OPTIONS`), reset and restate it with your exact original path and arguments, changing only the numbers:

```ini
[Service]
Environment=MALLOC_ARENA_MAX=2
ExecStart=
ExecStart=<original node path> --max-semi-space-size=4 --max-old-space-size=256 --enable-source-maps app.js
```

Then verify the live flags and measure:

```bash
systemctl daemon-reload && systemctl restart mcsm-web && sleep 600 && tr '\0' ' ' < /proc/$(systemctl show -p MainPID --value mcsm-web)/cmdline; echo; tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value mcsm-web)/environ | grep -E 'NODE_OPTIONS|MALLOC'
```

Check: the flags show up (in `cmdline` or `NODE_OPTIONS`) and no `8192` remains. Check logs for crashes:

```bash
journalctl -u mcsm-web -n 50 --no-pager | grep -i -E 'heap|out of memory|fatal' ; echo "exit=$?"
```

Check: `exit=1` (nothing found). If you see a heap error, raise the ceiling to 384 and re-measure. Repeat for the daemon in a maintenance window; do NOT add `MemoryMax=` or `MemoryHigh=` to `mcsm-daemon`.

### R6d. Optional safety net for the panel only

```ini
[Service]
MemoryHigh=300M
```

Add it to the `mcsm-web` drop-in. Check: `systemctl show mcsm-web -p MemoryHigh` shows 314572800. Never on `mcsm-daemon`.

---

## Part F. OS tuning (server)

### R7. Cap the journal

```bash
mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nSystemMaxUse=100M\nRuntimeMaxUse=50M\n' > /etc/systemd/journald.conf.d/99-minefield.conf && systemctl restart systemd-journald && journalctl --vacuum-size=100M
```

Check: `journalctl --disk-usage` reports at most 100 MB.

### R8a. zram swap

```bash
apt-cache policy systemd-zram-generator | head -3
```

Check: a candidate version is shown. If not, use `zram-tools` (R8c).

```bash
apt-get update && apt-get install -y systemd-zram-generator
```

Check: installs without removing other packages (read the apt summary before confirming).

```bash
mkdir -p /etc/systemd/zram-generator.conf.d && printf '[zram0]\nzram-size = ram / 4\ncompression-algorithm = zstd\nswap-priority = 100\n' > /etc/systemd/zram-generator.conf.d/99-minefield.conf && systemctl daemon-reload && systemctl start systemd-zram-setup@zram0.service
```

Check: `swapon --show` lists `/dev/zram0` of about 1.9 GB; `zramctl` shows algorithm `zstd`.

### R8b. sysctl

```bash
printf 'vm.swappiness=30\nvm.page-cluster=0\n' > /etc/sysctl.d/99-minefield.conf && sysctl --system | grep -E 'swappiness|page-cluster'
```

Check: both values printed. Tune later using `vmstat 1 10` while players are online: sustained non-zero `si`/`so` means the heap budget is too big, so lower a server heap instead of raising swappiness.

### R8c. Fallback if systemd-zram-generator is unavailable

```bash
apt-get install -y zram-tools && printf 'ALGO=zstd\nPERCENT=25\nPRIORITY=100\n' > /etc/default/zramswap && systemctl restart zramswap && swapon --show
```

Check: same result as R8a.

### R9. Review running services (decide, do not assume)

```bash
systemctl list-units --type=service --state=running --no-pager
```

Check: for each service you do not recognise, look up what it is. Keep: ssh, networking/netplan/systemd-networkd or NetworkManager, systemd-resolved, chrony/timesyncd, ufw, caddy, mcsm-web, mcsm-daemon, cron, rsyslog if used, and the Azure guest agent (`walinuxagent` or `waagent`).

```bash
for s in snapd multipathd ModemManager udisks2 lxd-agent; do systemctl list-unit-files "$s.service" --no-legend 2>/dev/null; done
```

Check: lists only those that exist on this image. For a candidate you decided to remove, first record its memory, then disable, and note the undo:

```bash
systemctl show <service> -p MemoryCurrent && systemctl disable --now <service>
```

Check: the service is `inactive` and the VM is still healthy (ssh, panel, game servers). Undo with `systemctl enable --now <service>`. Record service, memory and undo command in your notes.

```bash
systemctl list-timers --all --no-pager | head -20
```

Check: where `apt-daily*` and `unattended-upgrades` run. Keep security updates enabled; if their run time overlaps peak play hours, move it off-peak with a drop-in rather than removing it.

### R10. Caddy

```bash
systemctl cat caddy --no-pager | sed -n 1,30p; caddy version 2>/dev/null; grep -n -E 'encode|log|reverse_proxy' /etc/caddy/Caddyfile
```

Check: reverse proxy to `127.0.0.1:23333`; if you want compressed responses, a single `encode zstd gzip` line there is fine (leave the panel's own `gzip` setting off). Caddy RSS is expected around 30 to 40 MB; no change required.

---

## Part G. Game-server JVM recommendations (advisory; you decide)

Not applied by any code. Edit each instance's `start.sh` yourself. With about 7.7 GB total:

| Component | Suggested heap | Notes |
| --- | --- | --- |
| OS + panel + daemon + Caddy | about 1.0 GB (not a heap) | measured in R12 |
| Main | `-Xms3G -Xmx3G` | largest world/player load |
| Lobi | `-Xms1536M -Xmx1536M` | lobby is light |
| Velocity | `-Xms512M -Xmx512M` | proxy is small |
| Total heap | about 5.0 GB | plus about 10 to 15% JVM non-heap (about 0.6 to 0.75 GB) |
| Left for page cache and slack | about 1 GB | world files and bursts |

Keep `-Xms` equal to `-Xmx`. For Paper-family servers (Aikar flags, heaps under 12 GB):

```bash
java -Xms3G -Xmx3G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true -jar server.jar nogui
```

Check (after you change a server): `ps -o rss,cmd -C java | cut -c1-120` shows RSS close to heap plus 10 to 15%; with `-XX:+AlwaysPreTouch` RSS reaches the heap size at start, so total RSS across all three is visible immediately.

For Velocity:

```bash
java -Xms512M -Xmx512M -XX:+UseG1GC -XX:G1HeapRegionSize=4M -XX:+UnlockExperimentalVMOptions -XX:+ParallelRefProcEnabled -XX:+AlwaysPreTouch -XX:MaxInlineLevel=15 -jar velocity.jar
```

Check: after all three run, `free -m` shows `available` of roughly 700 MB or more at idle; if it drops under about 400 MB or `vmstat` shows sustained swap-out, reduce a heap (Main first).

---

## Part H. Acceptance (server)

### R12. Measure (game servers stopped, 10 minutes idle after the last restart)

```bash
tot=0; for u in mcsm-web mcsm-daemon caddy; do pid=$(systemctl show -p MainPID --value $u); pss=$(awk '/^Pss:/{s+=$2} END{printf "%.1f",s/1024}' /proc/$pid/smaps_rollup); rss=$(awk '/^VmRSS/{printf "%.1f",$2/1024}' /proc/$pid/status); echo "$u RSS_MB=$rss PSS_MB=$pss"; tot=$(echo "$tot + $pss" | bc -l 2>/dev/null || python3 -c "print($tot+$pss)"); done; echo "TOTAL_PSS_MB=$tot (target <= 350)"
```

Check: `TOTAL_PSS_MB` is at most 350. Compare with the baseline from R1 and keep both in your notes.

```bash
free -m
```

Check: the `used` column is at most about 1024 MB with the game servers stopped (the `buff/cache` column is reclaimable and not counted).

```bash
journalctl --disk-usage; swapon --show; sysctl vm.swappiness; systemctl show mcsm-daemon -p MemoryMax -p MemoryHigh
```

Check: journal at most 100 MB; zram listed; swappiness 30; both daemon limits `infinity`.

If `free -m` used is above about 1 GB while the three processes sum to 350 MB or less, find the rest with `ps -eo rss,pid,comm --sort=-rss | head -20` and `systemd-cgtop -m -n 1`, then decide per service in R9.
