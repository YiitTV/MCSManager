## Purpose

Help operators diagnose unexpected server exits from small, per-instance crash summaries.

## ADDED Requirements

### Requirement: Bounded crash history
The daemon SHALL retain the ten most recent unexpected stops per instance. It SHALL summarize the newest report created in the previous two minutes and the current run's last 300 output lines, extracting an exception, early stack frames, and a likely plugin when supported by the evidence.

#### Scenario: Paper exception
- **WHEN** an unexpected stop has a recent Paper report and a matching plugin stack frame
- **THEN** the summary includes the exception class and message, early frames, and the likely plugin

#### Scenario: Missing evidence
- **WHEN** an unexpected stop has no usable report or exception
- **THEN** history still records the time and exit code

#### Scenario: Expected stop
- **WHEN** the daemon classifies a stop as expected
- **THEN** it adds no summary

#### Scenario: Unsafe path
- **WHEN** a crash report or plugin path leads outside the instance working directory
- **THEN** the daemon skips that source

### Requirement: Authorized crash presentation
The panel SHALL show summaries to administrators and assigned users on the instance page and mark a crash on the corresponding instance card.

#### Scenario: Unassigned user
- **WHEN** a regular user requests crash history for another instance
- **THEN** the panel denies access
