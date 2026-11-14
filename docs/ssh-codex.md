# Mac desktop + company Codex over SSH

Telldo runs on your Mac and keeps its SQLite database in the Mac application's user-data directory. The optional SSH transport runs only Codex inference on your company computer. It is **not** cloud database sync, a remote desktop, or a shared account service. Manual task operations remain available when SSH or Codex is unavailable.

## Configure

In Telldo settings choose SSH for AI, then provide host, username, port, remote Codex path, Python runner path, and an optional HTTP(S) proxy URL. For this deployment:

- Host: `198.51.100.10`, user: `developer`, port: `2222`.
- Remote Codex: `/home/developer/.local/bin/codex`.
- Runner: `/opt/telldo/resources/ssh-codex-runner.py`.
- Optional proxy: `http://192.0.2.10:3128`.

The helper is part of this repository and needs Python 3 on the company computer. No daemon or public HTTP port is required. Before the first connection, use your ordinary SSH client to establish the trusted host key and working key/agent authentication. Telldo uses `BatchMode=yes` and `StrictHostKeyChecking=yes`; it does not bypass a changed or unknown host key, prompt for passwords, or store credentials. Agent forwarding, SSH tunnel forwards and local-command hooks are disabled for this invocation. Remote Codex reuses its existing login. Neither the Mac adapter nor helper reads or copies Codex credential files.

## Request flow and limits

The Mac launches OpenSSH with an argv array and `shell:false`. The only remote command is `python3 -I` followed by an explicitly configured absolute runner path restricted to safe path characters. OpenSSH still uses the server's shell to launch this fixed helper; no arbitrary model-generated shell command is exposed. Host/user/port/path/proxy settings are validated. User intent, prompts, schema and up to 30 relevant task summaries and 30 lists are sent as a JSON envelope over encrypted stdin, never interpolated into the SSH command. Database paths and unrelated context are excluded. Local API-secret environment variables are not inherited by the SSH subprocess.

The remote helper probes the actual CLI on every request, uses advertised flags only, invokes Codex with `shell=False`, and provides an initially empty temporary work directory. The schema and final-output file are separate from that work directory. JSONL Codex events are used for progress and forbidden-tool detection; the business proposal comes only from the final response and is validated again on the Mac. The Mac's Task Service alone applies a confirmed or eligible low-risk proposal in a transaction with optimistic versions, auditing and undo.

Read-only sandbox and ignore-user-config/rules do **not** establish forced no-shell/MCP/network isolation. Observed tool events fail the entire request; they cannot retroactively undo external side effects. Task content goes to the company computer and, for cloud inference, to the model provider. Your Codex subscription, API charges and quotas still apply; Telldo has no AI subscription layer.

## Cancellation and failure

The request envelope is one line, and stdin remains open. Cancel, local timeout, or disconnect closes the stream; the helper watches EOF and termination signals and kills the entire Codex process group. A separate bounded remote deadline also applies (at most 120 seconds), so a lost connection cannot leave Codex running indefinitely. The local adapter waits briefly for cleanup before killing a stuck SSH client. It never accepts a proposal before the SSH process exits successfully, and rejects malformed/duplicate frames, late remote errors, and nonzero exits even when a proposal frame was already received.

`npm test` covers the mocked Mac-side transport without spending AI quota. `python3 -m unittest discover -s tests -p 'test_ssh_runner.py'` covers the remote helper. A real end-to-end check must be recorded separately; mocked tests are not proof of a particular SSH key, network route, or provider's availability.
