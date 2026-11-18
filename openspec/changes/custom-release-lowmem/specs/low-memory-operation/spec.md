# Spec Delta

## Purpose
Defines the memory budget, tuning set and measurable acceptance criteria that let a single host run the panel, daemon and reverse proxy in about 1 GB so the remaining RAM is available to game servers.

## ADDED Requirements

### Requirement: Measurable idle memory target
After deployment and with all game servers stopped, the combined proportional set size (PSS) of the `mcsm-web`, `mcsm-daemon` and `caddy` processes SHALL be at most 350 MB, and the system's `used` memory reported by `free -m` SHALL be at most about 1024 MB. The measurement commands and the baseline taken before tuning SHALL be recorded in the operator runbook.

#### Scenario: Process memory within target
- **WHEN** the three processes have been idle for 10 minutes after a restart and their PSS is summed from `/proc/<pid>/smaps_rollup`
- **THEN** the sum is at most 350 MB

#### Scenario: System memory within target
- **WHEN** all game server instances are stopped and `free -m` is read after the same idle period
- **THEN** the `used` column is at most about 1024 MB

#### Scenario: Honest game-server budget
- **WHEN** the budget is documented
- **THEN** it states the machine's total RAM, the platform allowance, the remaining amount for game servers, and that the sum of JVM heaps MUST stay below that remainder with headroom for non-heap JVM memory

### Requirement: Bounded Node heap for panel and daemon
The panel and daemon processes SHALL run with an explicit V8 old-space ceiling (`--max-old-space-size`) of at most 256 MB each and a reduced semi-space (`--max-semi-space-size=4`), with `MALLOC_ARENA_MAX=2`, applied through systemd configuration. A tuning change SHALL be adopted only if the measured RSS after the change is not higher than before it.

#### Scenario: Flags are active on the running process
- **WHEN** `/proc/<pid>/cmdline` and `/proc/<pid>/environ` of each process are inspected
- **THEN** they show the old-space ceiling, the semi-space size and `MALLOC_ARENA_MAX=2` (and not a conflicting `--max-old-space-size=8192`)

#### Scenario: Regression is reverted
- **WHEN** a tuning step increases measured RSS or causes the process to restart on heap exhaustion
- **THEN** that step is reverted before the next one is applied

### Requirement: Daemon process group is never memory-limited by the service manager
Because game servers run as child processes of the daemon, the `mcsm-daemon` unit MUST NOT be given `MemoryMax=` or `MemoryHigh=` limits, and the panel unit MAY be limited.

#### Scenario: Daemon unit has no memory limit
- **WHEN** `systemctl show mcsm-daemon -p MemoryMax -p MemoryHigh` is read
- **THEN** both report no limit (`infinity`)

### Requirement: OS memory hygiene
The host SHALL cap the journal size (`SystemMaxUse` at most 100 MB), provide compressed in-RAM swap (zram) sized at about 25% of RAM, and have its running services reviewed so that only services the host needs are enabled. Any service disabled SHALL be checked first with `systemctl list-units --type=service --state=running` and recorded together with how to re-enable it. Services required by the cloud platform (for example the Azure guest agent) MUST NOT be disabled.

#### Scenario: Journal is capped
- **WHEN** `journalctl --disk-usage` is read after the cap is applied
- **THEN** usage is at most 100 MB

#### Scenario: zram swap is active
- **WHEN** `swapon --show` is run
- **THEN** a zram device of about 25% of RAM using zstd is listed

#### Scenario: Disabled services are traceable
- **WHEN** a service has been disabled for memory reasons
- **THEN** the runbook record names the service, its measured RSS and the command to re-enable it

### Requirement: Game-server JVM guidance is advisory
The change SHALL provide JVM sizing guidance (equal `-Xms` and `-Xmx`, the Aikar G1 flag set for Paper-family servers, a small heap for the Velocity proxy, and a total heap budget) as operator recommendations only; the repository MUST NOT modify instance start commands.

#### Scenario: No repository change to instance commands
- **WHEN** the change is implemented
- **THEN** no instance configuration or start script in the repository is altered by it
