# Data and proposal integrity

`TaskService` owns SQLite access in the Electron main process. Its `schedules` collaborator owns recurrence and notification operations. No database handle, database path, or arbitrary SQL method crosses the renderer bridge or enters model context. SQLite is bundled with Electron through Node’s synchronous `node:sqlite` API; it needs no external native addon. The database uses foreign keys, WAL journaling and a busy timeout; application writes use synchronous statements and transactions.

Tasks keep a local calendar day (`due_date`) separate from an absolute instant (`due_at`). A date-only task has neither an instant nor a time zone. A timed task has an offset-qualified instant and an IANA time zone, and its calendar day must agree with that instant in its task time zone. Updates require the current task version; successful updates increment it. Children must remain in the same list as their parent and can be only one level deep. Moving a parent moves its children in one transaction. Deleting a task soft-deletes its children too.

Recurring templates cannot have their date, time zone, nesting or completion changed while a repeat rule is active. Change an occurrence instead, or remove the repeat rule before editing the template. This also applies to AI proposals, which cannot silently rewrite a series through a task update.

## Calendar date transactions (0.2.0)

`CalendarService` handles preview, apply and undo in the main process. The renderer sends an entity reference, the version captured when editing/dragging started, the intended field and displayed date/time zone. A repeated instance additionally checks the template version. The service revalidates inside the write transaction and keeps a durable inverse in `calendar_changes`; undo refuses a later version or a replaced series. An undo advances versions and does not rewind unrelated task fields.

Occurrences migrate in place with `version`, nullable `override_due_at`, `reminder_override` (`inherit`/`explicit`) and nullable `override_reminder_at`. The original `(series_id, occurrence_key)` remains unchanged. Instance edits have an `occurrence_audit` record. JSON transfer preserves date/time/reminder overrides, while newly imported IDs and versions belong to independent entities; old exports receive the new defaults. Database backups also preserve calendar undo and notification history.

Both Planned presentations use the same `projectCalendar` query. A task belongs to a month if either its planned day or its displayed due day is inside the range. Two date marks still refer to one entity. Recurring rows use instance deadlines; a template planned day is not an instance arrangement.

## Proposal transport

`resources/proposal.schema.json` is the strict structured-output wire schema. Each action includes `type`, nullable `target_id`, nullable `temp_id`, nullable `expected_version`, and `patch`, an array of `{key, value}` changes. An empty patch is used for complete, uncomplete and delete actions. This representation distinguishes an omitted change from an explicit null that clears a nullable field while allowing every schema property to be required by providers. `parseProposal` normalizes it into the application's ordinary patch object, rejects duplicate keys and unknown fields, and applies enum, length, date and version checks. Canonical object patches are also accepted for internal calls and tests. Empty transport actions signal clarification or refusal and are never stored as an applicable proposal.

Only a single top-level create can be low risk; the service elevates all other proposals to high risk regardless of the model's claim. A maximum of 50 actions and 50 affected tasks, including implicit child changes, is permitted. Main-process context scope limits existing target IDs. Before applying, every existing target must still exist and have its expected version. Parent deletions and list moves also recheck the dependent child IDs and versions captured when the proposal was saved. All actions and audit records are written in one transaction. Any failure rolls back prior actions. High-risk changes require explicit confirmation. The UI may also request confirmation for all changes.

A unique idempotency key prevents duplicate application; using the same key for different content is rejected. Applied proposals can be undone transactionally through their audit snapshots. Undo refuses to overwrite any subsequent task change or newly added subtask. Restored task versions advance rather than reverting, so stale clients remain detectable. Already-undone proposals do not reapply.

## Backup and JSON transfer

Backup uses SQLite's online backup API after a passive checkpoint, rather than copying an open database file. Backup and JSON export reject the active database and WAL/SHM paths, including symbolic and hard-link aliases, as destinations. JSON exports are written to a temporary sibling file and renamed atomically so a failed export does not truncate an existing export. Ordinary writes can continue after a backup without changing the snapshot.

JSON export is a consistent transactional snapshot of active lists and tasks, tags, recurrence definitions and occurrence state. Import validates the export version, limits batch sizes, creates new list/task/series IDs, remaps parent and recurrence relationships, and restores occurrence state in one transaction. Malformed references roll back the entire import. Existing records are not overwritten. Audit history, proposals, preferences and notification logs are not imported; imported tasks are independent new tasks. Notification history is preserved in database backups.

The database contains no Codex authentication tokens. The application never reads or copies credential files.
