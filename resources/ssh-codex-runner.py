#!/usr/bin/env python3
"""Telldo's SSH stdio bridge. No credentials or database files are read here.

Protocol v1: one request JSON line, then keep stdin open. EOF cancels the
owned Codex process group. Stdout is bounded JSONL; only proposal.raw is a
business result. The desktop TaskService remains the authoritative validator.
"""
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

MAX_INPUT = 512 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
TOOL_TYPE = re.compile(r"command_execution|file_change|tool|function_call|mcp|web_search|shell|patch|exec_command|computer", re.I)


class RunnerError(Exception):
    def __init__(self, message, code="failed"):
        super().__init__(message)
        self.code = code


def emit(kind, **fields):
    try:
        print(json.dumps(dict(type=kind, **fields), ensure_ascii=False), flush=True)
    except (BrokenPipeError, OSError):
        raise RunnerError("SSH connection closed / SSH 连接已关闭", "cancelled")


def friendly(text):
    if re.search(r"auth|log.?in|unauthori[sz]ed|401|token.*expir", text, re.I):
        return RunnerError("Remote Codex login is missing or expired. Run codex login on the company computer. / 远端 Codex 未登录或登录过期，请在公司电脑重新登录。", "authentication")
    if re.search(r"quota|usage.limit|rate.limit|429|credits|insufficient|billing", text, re.I):
        return RunnerError("Remote Codex quota or rate limit reached. / 远端 Codex 额度不足或请求受限。", "quota")
    return RunnerError("Remote Codex failed. Check the company computer's network/proxy and CLI. No tasks were changed. / 远端 Codex 未完成，请检查网络、代理和 CLI；任务未更改。")


def is_tool(value):
    if isinstance(value, dict):
        return any((key in ("type", "kind") and isinstance(item, str) and TOOL_TYPE.search(item)) or is_tool(item) for key, item in value.items())
    if isinstance(value, list):
        return any(is_tool(item) for item in value)
    return False


class Runtime:
    def __init__(self, request):
        timeout = request.get("timeoutMs", 120000)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise RunnerError("Invalid request timeout", "invalid_request")
        self.deadline = time.monotonic() + min(timeout, 120000) / 1000
        self.cancelled = threading.Event()
        self.child = None
        self.env = os.environ.copy()
        proxy = request.get("proxyUrl", "")
        if proxy:
            parsed = urlparse(proxy)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or any(c in proxy for c in "\r\n\x00"):
                raise RunnerError("Proxy must be an HTTP(S) URL without embedded credentials", "invalid_request")
            self.env.update({name: proxy for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")})
        self.request = request

    def kill(self):
        child = self.child
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def cancel(self, *_):
        self.cancelled.set()
        self.kill()

    def watch_stdin(self):
        try:
            # No additional protocol messages are expected. Disconnect/close is cancellation.
            while os.read(sys.stdin.fileno(), 1):
                pass
        except (OSError, ValueError):
            pass
        self.cancel()

    def check(self):
        if self.cancelled.is_set():
            raise RunnerError("Codex request cancelled / Codex 请求已取消", "cancelled")
        if time.monotonic() >= self.deadline:
            self.kill()
            raise RunnerError("Remote Codex request timed out. No tasks were changed. / 远端 Codex 请求超时；任务未更改。", "timeout")

    def spawn(self, argv, cwd):
        self.check()
        child = subprocess.Popen(argv, cwd=cwd, env=self.env, shell=False, start_new_session=True,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.child = child
        # Close the race where EOF arrived between check() and Popen().
        if self.cancelled.is_set():
            self.kill()
        return child

    def collect(self, child, input_data=b"", on_line=None, limit_seconds=None):
        """Drain both streams concurrently, bounded by bytes and time; never trust tool output."""
        output = bytearray()
        errors = bytearray()
        pending = bytearray()
        local_deadline = min(self.deadline, time.monotonic() + limit_seconds) if limit_seconds else self.deadline
        try:
            def feed():
                try:
                    child.stdin.write(input_data)
                    child.stdin.close()
                except (BrokenPipeError, OSError, ValueError):
                    pass
            # A CLI stuck before reading stdin must still obey cancellation and timeout.
            threading.Thread(target=feed, daemon=True).start()
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ, "stdout")
                selector.register(child.stderr, selectors.EVENT_READ, "stderr")
                while selector.get_map():
                    self.check()
                    if time.monotonic() >= local_deadline:
                        self.kill()
                        raise RunnerError("Codex capability probe timed out / Codex 能力检测超时", "timeout")
                    for key, _ in selector.select(0.05):
                        chunk = os.read(key.fileobj.fileno(), 8192)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        target = output if key.data == "stdout" else errors
                        target.extend(chunk)
                        if len(output) + len(errors) > MAX_OUTPUT:
                            raise RunnerError("Codex output exceeded the safety limit", "output_limit")
                        if key.data == "stdout" and on_line:
                            pending.extend(chunk)
                            while b"\n" in pending:
                                line, _, rest = pending.partition(b"\n")
                                pending = bytearray(rest)
                                if line.strip():
                                    on_line(line.decode("utf-8"))
                if pending.strip() and on_line:
                    on_line(pending.decode("utf-8"))
                while child.poll() is None:
                    self.check()
                    time.sleep(0.02)
            self.check()
            return child.returncode, output.decode("utf-8", "replace"), errors.decode("utf-8", "replace")
        finally:
            # Even a successful CLI must not leave descendants running after this request.
            self.kill()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.kill()
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream:
                    stream.close()
            self.child = None

    def command(self, path, args, cwd):
        return self.collect(self.spawn([path] + args, cwd), limit_seconds=10)

    def probe(self, cwd):
        requested = self.request.get("codexPath", "")
        if not isinstance(requested, str) or (requested and (not os.path.isabs(requested) or "\x00" in requested)):
            raise RunnerError("Codex path must be absolute", "invalid_request")
        path = shutil.which("codex", path=self.env.get("PATH"))
        if not path and os.path.isfile(requested) and os.access(requested, os.X_OK):
            path = requested
        caps = dict(available=False, version="", path=path or "", loggedIn=False, reason="Remote Codex is not installed / 远端未安装 Codex",
                    schema=False, outputFile=False, json=False, readOnly=False, ignoreUserConfig=False, ignoreRules=False, ephemeral=False, skipGitCheck=False,
                    isolation="Not verified / 未验证")
        if not path:
            return caps
        code, version, error = self.command(path, ["--version"], cwd)
        if code:
            raise friendly(error)
        code, help_text, error = self.command(path, ["exec", "--help"], cwd)
        if code:
            raise friendly(error)
        help_text += error
        def has(flag):
            return re.search(r"(^|\s)" + re.escape(flag) + r"(?=\s|[=<,]|$)", help_text, re.M) is not None
        caps.update(version=version.strip()[:200], schema=has("--output-schema"), outputFile=has("--output-last-message"),
                    json=has("--json"), readOnly=has("--sandbox") and "read-only" in help_text,
                    ignoreUserConfig=has("--ignore-user-config"), ignoreRules=has("--ignore-rules"), ephemeral=has("--ephemeral"), skipGitCheck=has("--skip-git-repo-check"))
        code, login_help, error = self.command(path, ["login", "--help"], cwd)
        if code == 0 and re.search(r"\bstatus\b", login_help + error):
            code, _, _ = self.command(path, ["login", "status"], cwd)
            caps["loggedIn"] = code == 0
        caps["available"] = caps["loggedIn"] and caps["json"] and caps["readOnly"]
        caps["reason"] = ("" if caps["available"] else "Remote Codex needs login and support for JSON events plus a read-only sandbox. / 远端 Codex 需登录，并支持 JSON 事件与只读沙箱。")
        caps["isolation"] = "Read-only: %s; ignore user config: %s; ignore rules: %s. No forced no-shell/MCP/network guarantee. Observed tool calls fail the request. / 不保证强制无工具隔离；检测到工具调用即失败。" % (caps["readOnly"], caps["ignoreUserConfig"], caps["ignoreRules"])
        return caps

    def run(self, caps, cwd):
        if not caps["available"]:
            raise RunnerError(caps["reason"], "unavailable")
        prompt, schema_text = self.request.get("prompt"), self.request.get("schema")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 200000 or not isinstance(schema_text, str) or len(schema_text) > 131072:
            raise RunnerError("Invalid prompt or schema envelope", "invalid_request")
        try:
            schema = json.loads(schema_text)
        except (ValueError, TypeError):
            raise RunnerError("Invalid schema JSON", "invalid_request")
        if not isinstance(schema, dict):
            raise RunnerError("Schema must be a JSON object", "invalid_request")
        schema_path, final_path = Path(cwd) / "proposal.schema.json", Path(cwd) / "final.json"
        schema_path.write_text(schema_text, encoding="utf-8")
        workdir = Path(cwd) / "work"
        workdir.mkdir()
        args = [caps["path"], "exec", "--sandbox", "read-only", "--json"]
        for field, flag in (("ignoreUserConfig", "--ignore-user-config"), ("ignoreRules", "--ignore-rules"), ("ephemeral", "--ephemeral"), ("skipGitCheck", "--skip-git-repo-check")):
            if caps[field]:
                args.append(flag)
        if caps["schema"]:
            args.extend(["--output-schema", str(schema_path)])
        if caps["outputFile"]:
            args.extend(["--output-last-message", str(final_path)])
        args.append("-")
        last_message = [None]
        def line(text):
            try:
                event = json.loads(text)
            except ValueError:
                raise RunnerError("Codex returned malformed JSONL events", "invalid_output")
            if not isinstance(event, dict):
                raise RunnerError("Codex returned an invalid event", "invalid_output")
            if is_tool(event):
                raise RunnerError("Codex attempted a tool call; the entire request was rejected. No tasks were changed. / Codex 尝试调用工具，整次请求已拒绝；任务未更改。", "tool_call")
            if event.get("type") in ("error", "turn.failed"):
                raise friendly(json.dumps(event))
            item = event.get("item", {})
            if event.get("type") == "item.completed" and isinstance(item, dict) and item.get("type") == "agent_message":
                last_message[0] = item.get("text")
            emit("progress", message="Codex: " + str(event.get("type", "event"))[:100])
        code, _, error = self.collect(self.spawn(args, str(workdir)), prompt.encode("utf-8"), on_line=line)
        if code:
            raise friendly(error)
        self.check()
        if caps["outputFile"]:
            if not final_path.is_file() or final_path.stat().st_size > MAX_OUTPUT:
                raise RunnerError("Codex did not return a valid final response file", "invalid_output")
            raw = final_path.read_text(encoding="utf-8").strip()
        else:
            raw = last_message[0]
        try:
            proposal = json.loads(raw) if isinstance(raw, str) else None
        except ValueError:
            proposal = None
        if not isinstance(proposal, dict):
            raise RunnerError("Codex final response must be a strict JSON object", "invalid_output")
        self.check()
        emit("proposal", raw=raw)


def main():
    runtime = None
    try:
        line = sys.stdin.buffer.readline(MAX_INPUT + 1)
        if len(line) > MAX_INPUT or not line.endswith(b"\n"):
            raise RunnerError("Request must be one bounded JSON line", "invalid_request")
        request = json.loads(line)
        if not isinstance(request, dict) or request.get("version") != 1 or request.get("mode") not in ("probe", "run"):
            raise RunnerError("Unsupported SSH protocol request", "invalid_request")
        runtime = Runtime(request)
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, runtime.cancel)
        threading.Thread(target=runtime.watch_stdin, daemon=True).start()
        with tempfile.TemporaryDirectory(prefix="telldo-codex-ssh-") as cwd:
            caps = runtime.probe(cwd)
            if request["mode"] == "probe":
                runtime.check()
                emit("capability", capabilities=caps)
            else:
                runtime.run(caps, cwd)
        return 0
    except RunnerError as error:
        try:
            emit("error", message=str(error), code=error.code)
        except RunnerError:
            pass
        return 1
    except (ValueError, TypeError, OSError, UnicodeError):
        try:
            emit("error", message="SSH Codex runner could not process the request. No tasks were changed. / SSH Codex 请求处理失败；任务未更改。", code="invalid_request")
        except RunnerError:
            pass
        return 1
    finally:
        if runtime:
            runtime.kill()


if __name__ == "__main__":
    sys.exit(main())
