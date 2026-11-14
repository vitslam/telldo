# Codex capability verification

Verified on the company Linux development host on 2026-11-14 using `/home/developer/.local/bin/codex` (noninteractive SSH PATH does not contain it). Commands executed before adapter business code: `codex --version`, `codex exec --help`, `codex login --help`, `codex login status`. Version: **codex-cli 0.162.1**. Login status reported **Logged in using ChatGPT**. These commands inspect public CLI behavior; Telldo never reads, copies or exports credential files.

## Verified help capabilities

- `exec -`: prompt read through stdin.
- `--json`: JSONL progress/events, never the business proposal itself.
- `--output-schema <FILE>` and `--output-last-message <FILE>`: schema-constrained final output and separate final-output file.
- `--sandbox read-only`.
- `--ignore-user-config`: documented to skip config.toml while retaining the user's existing authentication.
- `--ignore-rules`.
- `--ephemeral`, `--skip-git-repo-check`.
- `login status` subcommand.

The adapter probes the executable on each application startup/recheck; flags are emitted only if that executable's help advertises them. It checks PATH first, then the explicitly configured absolute executable path. No credential-directory scanning or repair is performed. A missing executable, unverified login, or missing read-only/event-stream capability disables the AI input; all manual operations remain available.

## Isolation limits

**No enforced no-shell, no-MCP or no-network isolation is claimed.** Help confirms read-only sandbox and ignore-config/rules switches, not an ability to disable every tool or inherited hook. This implementation does not invent config keys or flags. The prompt forbids all tools. If the JSONL stream reports command execution, file changes, MCP, web search or another recognized tool call, Telldo kills the process group and rejects the entire run; it does not accept those tool results. Detection is after the event is emitted and cannot retroactively prevent external side effects. Tool schema/event additions in future CLI versions may require updates. The model has no database API or database path in its prompt and cannot write through Telldo's Task Service.

The transport schema requires all action metadata fields (nullable when inapplicable) and represents sparse patches as an array of `{key,value}` entries. Local validation converts them into the canonical object patch; duplicate keys and unknown fields are rejected. This satisfies the strict schema shape described in [official Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs). Empty action arrays are clarification responses and never reach the database.

Requests run with `spawn(executable, argv, {shell:false})`, in a new empty temporary working directory (schema and final-output files are siblings, outside that working directory), with a bounded subset of context (up to 30 task summaries and 30 lists). Only source intent plus necessary title, notes, dates, tags and version information is sent. The host's login and inherited proxy environment are reused; no tokens or keys are exported by Telldo. Optional company proxy environment: `https_proxy=http://192.0.2.10:3128 http_proxy=http://192.0.2.10:3128`. These variables are runtime configuration, not hardcoded app defaults.

## Fallbacks and unverified behavior

Without `--output-schema`, the JSON schema is included in the prompt and the final response is parsed as strict JSON and validated locally. Without `--output-last-message`, only the final completed `agent_message` event is considered as final output. Arbitrary events and tool output are never interpreted as a proposal. Malformed streams, nonzero exit, authentication errors, quota errors, timeout and cancellation reject the request before database application.

Account quota beyond the synthetic check below, future authentication expiry, production notification permissions, and macOS behavior cannot be established by CLI help. Automated adapter tests simulate process streams and errors. No paid inference was used for capability detection. macOS users must separately install/login to Codex on their Mac, or run the app on the company desktop with its local CLI; this MVP does not silently bridge a Mac app to remote credentials or provide an SSH AI service.

## Real integration smoke, 2026-11-14

A single synthetic request was verified on the company Linux host, through the supplied HTTP proxy. Adapter capability checks passed and the request completed in **13.819 seconds**. Input was `明天下午交周报`; context contained only a synthetic Work list, current date 2026-11-14, and Asia/Shanghai as the test zone. The final validated proposal was a single low-risk create titled `交周报`, due 2026-11-15 at 15:00 in that zone (`2026-11-15T07:00:00Z`). No tool call was emitted, and no database was opened or changed. This verifies one successful inference path, not universal availability or isolation.

To repeat deliberately (uses your own Codex quota), run `TELLDO_CODEX_PATH=/absolute/path/to/codex node scripts/codex-live-check.mjs` from the repository, with any needed proxy variables. The check uses synthetic context only. Ordinary `npm test` uses mocked processes and consumes no AI quota.
