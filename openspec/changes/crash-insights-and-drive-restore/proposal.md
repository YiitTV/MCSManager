## Why

Operators need to identify likely causes of unexpected Minecraft server stops and see whether a Drive-only backup restore completed successfully.

## What Changes

- Collect and retain up to ten crash summaries per instance and display them on the instance page. Mark the latest crash on instance cards.
- Label Google Drive copies in the backup list, allow administrators to select Google Drive as the restore source, and display progress and the outcome.
- Document the existing local-copy boundary for backup downloads.

## Capabilities

### New Capabilities

- `instance-crash-insights` — bounded crash capture, parsing, and authorized presentation.
- `backup-restore-visibility` — Drive source selection and restore outcomes for the in-flight instance-backups capability.

### Modified Capabilities

None.

## Impact

Daemon lifecycle and backup runner, panel instance and backup APIs, instance and backup Vue widgets, and English, Chinese, and Turkish translations.
