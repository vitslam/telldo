# Telldo

你说一句话，事情办到清单上。 / Say it. Get it on your list.

MIT licensed, free, local-first personal macOS task app. Electron + React + TypeScript + SQLite. English and Chinese; no account or cloud synchronization. Manual features work without Codex.

AI reuses your own installed and logged-in Codex CLI. Telldo has no AI subscription. Your provider subscription, quota or API fees remain your responsibility. Cloud inference sends task titles, notes, dates and selected context to the model provider; **AI is not entirely local**.

The active SQLite database lives under the OS application data directory (`~/Library/Application Support/Telldo/` on macOS). Never put the live database in iCloud Drive, Syncthing, or another file synchronization folder. Use consistent backup or JSON export instead. Import creates fresh IDs to avoid overwriting existing data.

Implementation and acceptance instructions are being added with each feature commit.
