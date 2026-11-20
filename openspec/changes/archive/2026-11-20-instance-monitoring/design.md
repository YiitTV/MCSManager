# Design

## Context

The daemon already uses pidusage for host process details and collects Docker CPU and memory data. Normal and board cards share the Shortcut widget. The panel has an existing per-instance permission gate.

## Goals

Keep collection independent of browser traffic, support the existing host and Docker process paths, and keep monitoring memory and console traffic bounded.

## Decisions

- Use a single daemon timer, a bounded ring per observed instance, and process identity to separate runs. Reuse pidusage and cache resident memory from existing Docker stats. On Linux, look for the JVM below a recognized startup wrapper when applicable.
- Resolve the limit from a literal start-command flag, then a bounded read of the local `start.sh`, then configured memory in MiB, then host bytes. Treat the script as text and accept plain numeric JVM sizes with binary suffixes.
- Probe through the existing command preset with a fixed literal, limited to supported local JVM launchers or startup scripts. Skip instances whose command preset uses RCON. Detect a real local plugin directory without following symlinks. Use the one-minute TPS and reported one-minute median tick duration when available.
- Expose `GET /api/protected_instance/monitoring` with `daemonId`, `uuid`, and optional `view=compact`. Compact requests get the latest hour. Cards request compact data. The instance detail requests the full history. Charts leave gaps for missing values.
- History is daemon-local and in memory, so a daemon restart clears it.

## Risks / Trade-offs

The console path may echo the command and spark may emit several lines per probe. Monitoring adds one command per eligible instance per minute at most. It leaves the normal output and log stream intact so routine console diagnosis still works. Hosts and containers can run launchers that do not expose a recognizable JVM console or provide RSS, so unsupported measurements appear as gaps. RSS includes resident native memory as well as Java heap pages, which can put it above the heap limit.
