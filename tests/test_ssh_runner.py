"""Run with python3 -m unittest discover -s tests -p test_ssh_runner.py.

Fake executable only: no real login, credentials, provider calls or database.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

RUNNER = Path(__file__).resolve().parents[1] / "resources" / "ssh-codex-runner.py"
PROPOSAL = {"version": 1, "summary": "Create a task", "idempotency_key": "ssh-test", "risk": "low", "actions": [{"type": "create", "temp_id": "new", "patch": {"title": "Tomorrow task", "list_id": "work"}}]}
FAKE = r'''
import json, os, pathlib, subprocess, sys, time
args=sys.argv[1:]
behavior=os.environ.get('FAKE_BEHAVIOR','success')
if args==['--version']:
 print('codex-cli fake-1');sys.exit(0)
if args==['exec','--help']:
 flags=['--json','--sandbox read-only','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check']
 if os.environ.get('FAKE_FALLBACK')!='yes':flags+=['--output-schema FILE','--output-last-message FILE']
 print('\n'.join(flags));sys.exit(0)
if args==['login','--help']:
 print('Commands: status');sys.exit(0)
if args==['login','status']:
 print('Not logged in' if behavior=='auth' else 'Logged in');sys.exit(1 if behavior=='auth' else 0)
trace={'argv':args,'cwd':os.getcwd(),'files':sorted(os.listdir('.')),'proxy':os.environ.get('https_proxy')}
pathlib.Path(os.environ['FAKE_TRACE']).write_text(json.dumps(trace))
if behavior=='hang':
 code="import time,pathlib;time.sleep(1.2);pathlib.Path("+repr(os.environ['FAKE_MARKER'])+").write_text('orphan')"
 subprocess.Popen([sys.executable,'-c',code])
 while True:time.sleep(.05)
prompt=sys.stdin.read()
if behavior=='quota':print('quota exceeded',file=sys.stderr);sys.exit(1)
if behavior=='exit':print('network unavailable',file=sys.stderr);sys.exit(2)
if behavior=='tool':
 print(json.dumps({'type':'item.started','item':{'type':'command_execution','command':'write something'}}),flush=True)
 time.sleep(10);sys.exit(0)
if behavior=='mcp':
 print(json.dumps({'type':'item.completed','item':{'type':'mcp_tool_call'}}),flush=True);sys.exit(0)
if behavior=='malformed':print('not JSON');sys.exit(0)
raw=os.environ['FAKE_PROPOSAL'] if behavior!='badfinal' else '```json\n{}\n```'
if '--output-last-message' in args:pathlib.Path(args[args.index('--output-last-message')+1]).write_text(raw)
print(json.dumps({'type':'thread.started','thread_id':'fake'}),flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':raw}}),flush=True)
print(json.dumps({'type':'turn.completed'}),flush=True)
'''


class Running:
    def __init__(self, process):
        self.process = process
        self.stdout, self.stderr = [], []
        self.readers = []
        for stream, target in ((process.stdout, self.stdout), (process.stderr, self.stderr)):
            thread = threading.Thread(target=lambda s=stream, t=target: t.extend(s.readlines()), daemon=True)
            thread.start()
            self.readers.append(thread)

    def finish(self, timeout=5):
        self.process.wait(timeout=timeout)
        if not self.process.stdin.closed:
            self.process.stdin.close()
        for thread in self.readers:
            thread.join(timeout=1)
        result = [json.loads(line) for line in self.stdout if line.strip()]
        self.process.stdout.close()
        self.process.stderr.close()
        return self.process.returncode, result


class SSHRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="telldo-runner-test-")
        self.root = Path(self.temp.name)
        self.fake = self.root / "fake-codex"
        self.fake.write_text("#!" + sys.executable + "\n" + FAKE)
        self.fake.chmod(0o700)
        self.trace = self.root / "trace.json"
        self.marker = self.root / "orphan.txt"
        self.running = []

    def tearDown(self):
        for running in self.running:
            if running.process.poll() is None:
                running.process.stdin.close()
                try:running.process.wait(timeout=2)
                except subprocess.TimeoutExpired:running.process.kill();running.process.wait()
        self.temp.cleanup()

    def start(self, behavior="success", mode="run", fallback=False, timeout=3000, prompt=None, codex_path=None):
        env = dict(os.environ, PATH=str(self.root), FAKE_BEHAVIOR=behavior, FAKE_FALLBACK="yes" if fallback else "no",
                   FAKE_TRACE=str(self.trace), FAKE_MARKER=str(self.marker), FAKE_PROPOSAL=json.dumps(PROPOSAL))
        process = subprocess.Popen([sys.executable, "-I", str(RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        running = Running(process)
        self.running.append(running)
        request = dict(version=1, mode=mode, codexPath=str(self.fake) if codex_path is None else codex_path, proxyUrl="http://192.0.2.10:3128", timeoutMs=timeout,
                       prompt=prompt or "Create a task. Do not use tools. $(touch NEVER) `touch NEVER2`", schema=json.dumps({"type": "object"}))
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        return running

    def wait_started(self):
        deadline = time.monotonic() + 3
        while not self.trace.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(self.trace.exists(), "fake Codex execution did not start")

    def test_probe_real_help_flags_and_login(self):
        code, frames = self.start(mode="probe").finish()
        self.assertEqual(code, 0)
        self.assertEqual(frames[-1]["type"], "capability")
        caps = frames[-1]["capabilities"]
        self.assertTrue(caps["available"])
        self.assertTrue(caps["schema"])
        self.assertTrue(caps["ignoreUserConfig"])
        self.assertIn("No forced", caps["isolation"])

    def test_empty_path_discovers_path_only_without_a_hardcoded_user(self):
        code, frames = self.start(mode="probe", codex_path="").finish()
        self.assertEqual(code, 0)
        self.assertFalse(frames[-1]["capabilities"]["available"])
        (self.root / "codex").symlink_to(self.fake)
        code, frames = self.start(mode="probe", codex_path="").finish()
        self.assertEqual(code, 0)
        self.assertTrue(frames[-1]["capabilities"]["available"])

    def test_success_argv_temp_cwd_proxy_and_final_result(self):
        code, frames = self.start().finish()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(frames[-1]["raw"]), PROPOSAL)
        self.assertEqual(frames[-1]["type"], "proposal")
        trace = json.loads(self.trace.read_text())
        self.assertEqual(trace["argv"][-1], "-")
        self.assertIn("--sandbox", trace["argv"])
        self.assertIn("read-only", trace["argv"])
        self.assertEqual(trace["files"], [])
        self.assertNotIn("$(touch", " ".join(trace["argv"]))
        self.assertEqual(trace["proxy"], "http://192.0.2.10:3128")
        self.assertFalse(Path(trace["cwd"]).exists(), "temporary working directory was not removed")

    def test_schema_and_output_file_fallback_uses_final_agent_message(self):
        code, frames = self.start(fallback=True).finish()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(frames[-1]["raw"]), PROPOSAL)
        trace = json.loads(self.trace.read_text())
        self.assertNotIn("--output-schema", trace["argv"])
        self.assertNotIn("--output-last-message", trace["argv"])

    def test_unauthenticated_run_never_executes(self):
        code, frames = self.start(behavior="auth").finish()
        self.assertNotEqual(code, 0)
        self.assertEqual(frames[-1]["type"], "error")
        self.assertFalse(self.trace.exists())

    def test_all_tool_calls_fail_without_proposal(self):
        for behavior in ("tool", "mcp"):
            with self.subTest(behavior=behavior):
                code, frames = self.start(behavior=behavior).finish()
                self.assertNotEqual(code, 0)
                self.assertEqual(frames[-1]["code"], "tool_call")
                self.assertFalse(any(f["type"] == "proposal" for f in frames))

    def test_quota_nonzero_and_malformed_results_do_not_emit_proposal(self):
        for behavior in ("quota", "exit", "malformed", "badfinal"):
            with self.subTest(behavior=behavior):
                code, frames = self.start(behavior=behavior).finish()
                self.assertNotEqual(code, 0)
                self.assertEqual(frames[-1]["type"], "error")
                self.assertFalse(any(f["type"] == "proposal" for f in frames))

    def test_disconnect_eof_kills_entire_remote_process_group(self):
        running = self.start(behavior="hang")
        self.wait_started()
        time.sleep(.1)
        running.process.stdin.close()
        code, frames = running.finish()
        self.assertNotEqual(code, 0)
        self.assertEqual(frames[-1]["code"], "cancelled")
        time.sleep(1.3)
        self.assertFalse(self.marker.exists(), "grandchild survived disconnect")

    def test_sighup_cancels_and_kills_remote_process_group(self):
        running = self.start(behavior="hang")
        self.wait_started()
        time.sleep(.1)
        running.process.send_signal(signal.SIGHUP)
        code, frames = running.finish()
        self.assertNotEqual(code, 0)
        self.assertEqual(frames[-1]["code"], "cancelled")
        time.sleep(1.3)
        self.assertFalse(self.marker.exists(), "grandchild survived SIGHUP")

    def test_timeout_including_blocked_stdin_write_kills_remote_group(self):
        running = self.start(behavior="hang", timeout=600, prompt="x" * 180000)
        code, frames = running.finish()
        self.assertNotEqual(code, 0)
        self.assertEqual(frames[-1]["code"], "timeout")
        time.sleep(1.3)
        self.assertFalse(self.marker.exists(), "grandchild survived timeout")


if __name__ == "__main__":
    unittest.main()
