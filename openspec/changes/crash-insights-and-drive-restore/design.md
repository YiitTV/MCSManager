## Context

The daemon classifies unexpected stops before restart processing. Backup restores already resolve successful remote copies and emit a sanitized completion payload. The backup change is still active, so this change adds a companion spec for restore visibility.

## Goals / Non-Goals

Capture small summaries from the current process and existing report files without delaying restart. Restore from existing backup records and retain the most recent outcome for the jobs view.

## Decisions

- Keep a byte-capped suffix of process output for each active run so the final lines are available even before the asynchronous daemon log writer flushes. Parse only the last 300 lines. Capture report and plugin metadata asynchronously. Store summaries in daemon storage, expose only the latest crash time on inventory responses, and use the existing assigned-instance guard for full history. Cards update on their existing inventory refresh.
- Use descriptor-relative, no-follow file access on Linux to prevent path substitutions by writable instance content. On other systems, console evidence is available. Cap console and report bytes, scanned entries, concurrent evidence reads, and optional plugin descriptor work. Use Paper JAR provenance and plugin package names as hints.
- Accept an optional Google Drive source in the existing restore request. Preserve automatic source selection for existing callers. Include the latest bounded daemon result from the same path that emits the completion event in the existing jobs response. Continue polling only while work is active.
- The existing instance-backups download contract grants single-use streaming tickets for local copies. A Drive-only download would need a separate authorization and streaming flow for private Google objects, including cancellation and credential handling. The Drive restore continues to use the daemon destination driver and its short-lived staging archive.

## Risks / Trade-offs

- Plugin attribution is a heuristic. The UI presents it as a likely plugin.
- The latest restore result is kept in bounded daemon memory and is scoped to the daemon process lifetime.
- Large or unusable reports can yield console-only summaries.

## Migration Plan

Deploy daemon, panel, and frontend together. Existing backup records remain compatible and crash history starts with the next unexpected stop.
