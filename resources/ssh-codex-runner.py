#!/usr/bin/env python3
"""Telldo's SSH stdio bridge. No credentials or database files are read here.

Protocol v1: one request JSON line, then keep stdin open. EOF cancels the
owned Codex process group. Stdout is bounded JSONL; only proposal.raw is a
business result. The desktop TaskService remains the authoritative validator.
"""
import json
import base64
import binascii
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

MAX_INPUT = 72 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_TOTAL = 50 * 1024 * 1024
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



class PublicProgress:
    """Forward observable execution stages and answer summary only, never reasoning."""
    LABELS = {"connection": "连接 Codex", "model": "处理请求", "response": "生成回复"}

    def __init__(self, delta_mode=False):
        self.delta_mode = delta_mode
        self.states = {}
        self.preview = ""

    def activity(self, phase, status, detail=None):
        if self.states.get(phase) == status:
            return
        self.states[phase] = status
        event = dict(type="activity", id=phase, phase=phase, status=status, label=self.LABELS[phase])
        if detail:
            event["detail"] = detail[:240]
        emit("progress", event=event)

    def summary(self, raw, complete=False):
        text = summary_prefix(raw)
        if not text or text == self.preview:
            return
        # Older desktop builds accept cumulative snapshots; keep their wire volume bounded.
        if not self.delta_mode and not complete and len(text) - len(self.preview) < 24:
            return
        event = dict(type="response")
        if self.delta_mode and text.startswith(self.preview):
            event["delta"] = text[len(self.preview):]
        else:
            event["text"] = text
        self.preview = text
        emit("progress", event=event)

    def consume(self, event):
        kind, item = event.get("type"), event.get("item", {})
        if kind == "thread.started":
            self.activity("connection", "completed")
        elif kind == "turn.started":
            self.activity("connection", "completed")
            self.activity("model", "running")
        if kind in ("item.started", "item.updated", "item.completed") and isinstance(item, dict) and item.get("type") == "agent_message":
            self.activity("response", "running")
            if isinstance(item.get("text"), str):
                self.summary(item["text"], kind == "item.completed")
            if kind == "item.completed":
                self.activity("response", "completed")
        if kind == "turn.completed":
            self.activity("model", "completed")


def summary_prefix(raw):
    """Read a safe prefix of the top-level summary JSON string, ignoring other fields."""
    text = raw.lstrip()
    if not text.startswith("{"):
        return ""

    def string_at(start):
        value, index = [], start + 1
        escapes = {'"': '"', '\\': '\\', '/': '/', 'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f'}
        while index < len(text):
            ch = text[index]
            if ch == '"':
                return ''.join(value), index + 1, True
            if ch == '\\':
                index += 1
                if index >= len(text):
                    break
                ch = text[index]
                if ch == 'u':
                    hex_value = text[index + 1:index + 5]
                    if not re.fullmatch(r'[0-9a-fA-F]{4}', hex_value):
                        break
                    value.append(chr(int(hex_value, 16)))
                    index += 4
                elif ch in escapes:
                    value.append(escapes[ch])
                else:
                    break
            elif ord(ch) < 32:
                break
            else:
                value.append(ch)
            index += 1
        return ''.join(value), index, False

    depth, index = 0, 0
    while index < len(text):
        ch = text[index]
        if ch == '"':
            token, end, closed = string_at(index)
            if not closed:
                return ""
            index = end - 1
            if depth == 1 and token == 'summary':
                cursor = end
                while cursor < len(text) and text[cursor].isspace():
                    cursor += 1
                if cursor >= len(text) or text[cursor] != ':':
                    index += 1
                    continue
                cursor += 1
                while cursor < len(text) and text[cursor].isspace():
                    cursor += 1
                if cursor >= len(text) or text[cursor] != '"':
                    return ""
                value = string_at(cursor)[0]
                # Combine escaped surrogate pairs and discard incomplete trailing ones.
                value = value.encode('utf-16', 'surrogatepass').decode('utf-16', 'ignore')
                return re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', value)[:2000]
        elif ch in '{[':
            depth += 1
        elif ch in '}]':
            depth -= 1
        index += 1
    return ""


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
                    schema=False, outputFile=False, json=False, readOnly=False, ignoreUserConfig=False, ignoreRules=False, ephemeral=False, skipGitCheck=False, imageInput=False,
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
        caps.update(version=version.strip()[:200], imageInput=has("--image"), schema=has("--output-schema"), outputFile=has("--output-last-message"),
                    json=has("--json"), readOnly=has("--sandbox") and "read-only" in help_text,
                    ignoreUserConfig=has("--ignore-user-config"), ignoreRules=has("--ignore-rules"), ephemeral=has("--ephemeral"), skipGitCheck=has("--skip-git-repo-check"))
        code, native_help, error = self.command(path, ["app-server", "--help"], cwd)
        caps["appServer"] = code == 0 and "--listen" in native_help + error
        caps["streaming"] = caps["appServer"]
        code, login_help, error = self.command(path, ["login", "--help"], cwd)
        if code == 0 and re.search(r"\bstatus\b", login_help + error):
            code, _, _ = self.command(path, ["login", "status"], cwd)
            caps["loggedIn"] = code == 0
        caps["available"] = caps["loggedIn"] and caps["json"] and caps["readOnly"]
        caps["reason"] = ("" if caps["available"] else "Remote Codex needs login and support for JSON events plus a read-only sandbox. / 远端 Codex 需登录，并支持 JSON 事件与只读沙箱。")
        if caps["appServer"]:
            caps["isolation"] = "App-server: read-only sandbox, approvals never, ephemeral thread, temporary cwd. User config/rules are not claimed ignored; observed tools and server requests fail the request. / 原生增量模式：只读沙箱、临时会话；检测到工具或服务器请求即中止。"
            return caps
        caps["isolation"] = "Read-only: %s; ignore user config: %s; ignore rules: %s. No forced no-shell/MCP/network guarantee. Observed tool calls fail the request. / 不保证强制无工具隔离；检测到工具调用即失败。" % (caps["readOnly"], caps["ignoreUserConfig"], caps["ignoreRules"])
        return caps

    def run_native(self, path, cwd, prompt, schema, images):
        """One ephemeral native turn. Real deltas are decoded before crossing SSH."""
        args = [path, "app-server", "--listen", "stdio://"]
        for feature in ("shell_tool", "hooks", "apps", "browser_use", "computer_use"):
            args.extend(["--disable", feature])
        args.extend(["-c", "mcp_servers={}", "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0"])
        child = self.spawn(args, cwd)
        progress = PublicProgress(self.request.get("responseDeltas") is True)
        thread_id = turn_id = None
        completed = False
        expected_rpc = 1
        raw_items = {}
        raw_final = None
        pending = bytearray()
        outgoing = bytearray()
        stderr = bytearray()
        total = 0
        selector = selectors.DefaultSelector()
        allowed_items = {"userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"}
        try:
            os.set_blocking(child.stdin.fileno(), False)
            selector.register(child.stdout, selectors.EVENT_READ, "stdout")
            selector.register(child.stderr, selectors.EVENT_READ, "stderr")

            def send(message):
                outgoing.extend((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))
                try:
                    selector.get_key(child.stdin)
                except KeyError:
                    selector.register(child.stdin, selectors.EVENT_WRITE, "stdin")

            def rpc_error():
                raise RunnerError("Native Codex protocol failed / Codex 原生流式协议失败", "invalid_output")

            def scope(params, require_turn=True):
                if params.get("threadId") != thread_id:
                    rpc_error()
                if require_turn and (not turn_id or params.get("turnId") != turn_id):
                    rpc_error()

            def item_value(item):
                if not isinstance(item, dict) or item.get("type") not in allowed_items:
                    raise RunnerError("Codex attempted a tool call; request rejected / Codex 尝试调用工具，请求已拒绝", "tool_call")
                if item["type"] == "agentMessage":
                    ident = item.get("id")
                    if not isinstance(ident, str) or not ident:
                        rpc_error()
                    return ident
                return None

            def consume(line):
                nonlocal thread_id, turn_id, completed, raw_final, expected_rpc
                try:
                    message = json.loads(line)
                except (ValueError, UnicodeError):
                    rpc_error()
                if not isinstance(message, dict):
                    rpc_error()
                if "method" in message and "id" in message:
                    # Approval, dynamic tool and credential requests are never delegated.
                    raise RunnerError("Codex requested an unsupported tool or approval / Codex 请求了不受支持的工具或批准", "tool_call")
                if "id" in message:
                    if type(message["id"]) is not int or message["id"] != expected_rpc:
                        rpc_error()
                    if message.get("error"):
                        raise friendly(json.dumps(message["error"]))
                    result = message.get("result")
                    if not isinstance(result, dict):
                        rpc_error()
                    if message["id"] == 1:
                        expected_rpc = 2
                        send(dict(method="initialized", params={}))
                        send(dict(id=2, method="thread/start", params=dict(
                            cwd=cwd, approvalPolicy="never", sandbox="read-only", ephemeral=True,
                            dynamicTools=[], environments=[], config={"features.shell_tool": False, "features.hooks": False, "features.apps": False,
                                "features.browser_use": False, "features.computer_use": False,
                                "web_search": "disabled", "mcp_servers": {}, "project_doc_max_bytes": 0})))
                    elif message["id"] == 2:
                        expected_rpc = 3
                        thread_id = result.get("thread", {}).get("id")
                        if not isinstance(thread_id, str) or not thread_id:
                            rpc_error()
                        progress.activity("connection", "completed")
                        inputs = [dict(type="text", text=prompt, text_elements=[])]
                        inputs.extend(dict(type="localImage", path=image) for image in images)
                        send(dict(id=3, method="turn/start", params=dict(
                            threadId=thread_id, cwd=cwd, approvalPolicy="never", input=inputs, outputSchema=schema)))
                    elif message["id"] == 3:
                        expected_rpc = None
                        ident = result.get("turn", {}).get("id")
                        if not isinstance(ident, str) or not ident or (turn_id and turn_id != ident):
                            rpc_error()
                        turn_id = ident
                    else:
                        rpc_error()
                    return
                method, params = message.get("method"), message.get("params", {})
                if not isinstance(method, str) or not isinstance(params, dict):
                    rpc_error()
                if method == "turn/started":
                    scope(params, False)
                    ident = params.get("turn", {}).get("id")
                    if not isinstance(ident, str) or not ident or (turn_id and turn_id != ident):
                        rpc_error()
                    turn_id = ident
                    progress.activity("model", "running")
                elif method in ("item/started", "item/completed"):
                    scope(params)
                    item = params.get("item")
                    ident = item_value(item)
                    if ident:
                        if method == "item/started":
                            if ident in raw_items:
                                rpc_error()
                            raw_items[ident] = ""
                        else:
                            if ident not in raw_items or not isinstance(item.get("text"), str):
                                rpc_error()
                            raw_items[ident] = item["text"]
                            if item.get("phase") != "commentary":
                                raw_final = item["text"]
                            progress.summary(item["text"], complete=True)
                            progress.activity("response", "completed")
                elif method == "item/agentMessage/delta":
                    scope(params)
                    ident, delta = params.get("itemId"), params.get("delta")
                    if ident not in raw_items or not isinstance(delta, str):
                        rpc_error()
                    raw_items[ident] += delta
                    if len(raw_items[ident].encode("utf-8")) > MAX_OUTPUT:
                        raise RunnerError("Codex response exceeded the safety limit", "output_limit")
                    progress.activity("response", "running")
                    progress.summary(raw_items[ident])
                elif method == "turn/completed":
                    scope(params, False)
                    turn = params.get("turn", {})
                    if not turn_id or turn.get("id") != turn_id:
                        rpc_error()
                    if turn.get("status") != "completed":
                        if turn.get("status") == "interrupted":
                            raise RunnerError("Codex request cancelled / Codex 请求已取消", "cancelled")
                        raise friendly(json.dumps(turn.get("error") or {}))
                    if not isinstance(raw_final, str) or not raw_final.strip():
                        rpc_error()
                    progress.activity("model", "completed")
                    completed = True
                elif method == "error":
                    if not params.get("willRetry", False):
                        raise friendly(json.dumps(params.get("error") or {}))
                elif method == "mcpServer/startupStatus/updated":
                    # Lifecycle status is not a tool invocation; never forward its payload.
                    pass
                elif re.search(r"commandExecution|fileChange|tool|mcp|webSearch|approval|requestUserInput", method, re.I):
                    raise RunnerError("Codex attempted a tool operation: " + re.sub(r"[^a-zA-Z0-9_/-]", "", method)[:120], "tool_call")
                # Ignore lifecycle, reasoning and usage notifications completely.

            send(dict(id=1, method="initialize", params=dict(
                clientInfo=dict(name="telldo", title="Telldo", version="0.2.0"), capabilities=dict(experimentalApi=True))))
            while not completed:
                self.check()
                if not selector.get_map():
                    raise friendly(stderr.decode("utf-8", "replace"))
                for key, _ in selector.select(0.05):
                    if key.data == "stdin":
                        try:
                            written = os.write(child.stdin.fileno(), outgoing)
                            del outgoing[:written]
                        except (BlockingIOError, InterruptedError):
                            continue
                        except (BrokenPipeError, OSError):
                            raise friendly(stderr.decode("utf-8", "replace"))
                        if not outgoing:
                            selector.unregister(child.stdin)
                        continue
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(chunk)
                    if total > MAX_OUTPUT:
                        raise RunnerError("Codex output exceeded the safety limit", "output_limit")
                    if key.data == "stderr":
                        stderr.extend(chunk)
                    else:
                        pending.extend(chunk)
                        while b"\n" in pending:
                            line, _, rest = pending.partition(b"\n")
                            pending = bytearray(rest)
                            if line.strip():
                                consume(line.decode("utf-8"))
                            if completed:
                                break
                    if completed:
                        break
            self.check()
            # Parent still validates the full JSON/schema before applying any action.
            return raw_final
        finally:
            selector.close()
            self.kill()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.kill()
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()
            self.child = None

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
        images = self.request.get("images", [])
        if not isinstance(images, list) or len(images) > 8:
            raise RunnerError("Attach up to 8 images / 每条消息最多发送 8 张图片", "invalid_request")
        if images and not caps.get("imageInput"):
            raise RunnerError("Remote Codex does not support image input / 远端 Codex 不支持图片输入", "unsupported_input")
        total = 0
        image_paths = []
        ids = set()
        for index, image in enumerate(images):
            self.check()
            if not isinstance(image, dict) or not isinstance(image.get("id"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,200}", image["id"]) or image["id"] in ids:
                raise RunnerError("Invalid image attachment", "invalid_request")
            ids.add(image["id"])
            encoded = image.get("base64")
            if not isinstance(encoded, str) or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
                raise RunnerError("Image exceeds 20 MB / 图片不能超过 20 MB", "invalid_request")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise RunnerError("Invalid image bytes", "invalid_request")
            if base64.b64encode(data).decode("ascii") != encoded:
                raise RunnerError("Invalid image encoding", "invalid_request")
            total += len(data)
            if not data or len(data) > MAX_IMAGE_BYTES or total > MAX_IMAGE_TOTAL:
                raise RunnerError("Image inputs exceed 50 MB / 图片总大小不能超过 50 MB", "invalid_request")
            extension, mime = None, None
            if data.startswith(b"\x89PNG\r\n\x1a\n"):
                extension, mime = "png", "image/png"
            elif data.startswith(b"\xff\xd8\xff"):
                extension, mime = "jpg", "image/jpeg"
            elif data[:6] in (b"GIF87a", b"GIF89a"):
                extension, mime = "gif", "image/gif"
            elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
                extension, mime = "webp", "image/webp"
            if not extension or image.get("mime") != mime:
                raise RunnerError("Unsupported or mismatched image type / 图片格式无效", "invalid_request")
            path = Path(cwd) / ("image-%d.%s" % (index, extension))
            path.write_bytes(data)
            path.chmod(0o600)
            args.extend(["--image", str(path)])
            image_paths.append(str(path))
            self.check()
        if caps.get("appServer"):
            raw = self.run_native(caps["path"], str(workdir), prompt, schema, image_paths)
            self.check()
            try:
                proposal = json.loads(raw)
            except (ValueError, TypeError):
                proposal = None
            if not isinstance(proposal, dict):
                raise RunnerError("Codex final response must be a strict JSON object", "invalid_output")
            emit("proposal", raw=raw)
            return
        if images:
            args.append("--")
        args.append("-")
        last_message = [None]
        progress = PublicProgress(self.request.get("responseDeltas") is True)
        progress.activity("connection", "completed", "远端 Codex 已就绪")
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
            progress.consume(event)
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
        progress.summary(raw, complete=True)
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
