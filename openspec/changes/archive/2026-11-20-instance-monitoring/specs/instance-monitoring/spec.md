# Spec Delta

## Purpose

Give authorized users a recent view of instance resource usage and Minecraft tick performance, with warnings for sustained tick degradation or memory pressure.

## ADDED Requirements

### Requirement: Collect bounded instance metrics

The daemon SHALL sample running instances once per minute and retain up to 1,440 samples from the past 24 hours in memory per instance. Deleting an instance SHALL remove its history.

#### Scenario: Sample a running instance

- **WHEN** a running instance reaches its sample interval
- **THEN** the daemon records the available resident memory and CPU measurements from its process or container

#### Scenario: Probe a spark installation

- **WHEN** a supported running Java Minecraft console has a local `plugins/spark` directory
- **THEN** the daemon sends `spark tps` at most once per 60 seconds and uses the available TPS and MSPT fields from replies received within five seconds

#### Scenario: Stop, age out, or delete an instance

- **WHEN** an instance stops
- **THEN** current metrics and warnings are unavailable while recent history remains available
- **AND** the daemon discards samples older than 24 hours and removes the history on deletion

### Requirement: Serve authorized instance metrics

The panel SHALL provide current values and chronological history through a read-only endpoint that validates the daemon and instance identifiers and enforces existing instance permissions.

#### Scenario: Read history

- **WHEN** a panel user requests monitoring for an assigned instance or an administrator requests monitoring for an instance
- **THEN** the panel returns its monitoring history, current values, and warning state

#### Scenario: Deny an unassigned instance

- **WHEN** a regular user requests monitoring for an instance outside their assignments
- **THEN** the panel denies the request before it reaches the daemon

### Requirement: Show monitoring and warnings

Normal and board instance cards SHALL show a small trend and current RAM, CPU, and available TPS. The instance page SHALL show the 24-hour trends, including MSPT when available. The interface SHALL show red warnings while measured RAM exceeds 90% of the resolved limit or TPS is below 15 for three consecutive samples.

#### Scenario: Resolve the RAM limit

- **WHEN** an instance has a literal JVM maximum heap in its startup configuration
- **THEN** the daemon compares RSS with that limit, falling back to the configured memory limit and then host total RAM when needed

#### Scenario: Interrupt a low TPS streak

- **WHEN** TPS recovers to at least 15, a sample has no TPS, or the instance stops or restarts
- **THEN** the low TPS streak resets
