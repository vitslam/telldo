"""Run with python3 -m unittest discover -s tests -p test_ssh_runner.py.

Fake executable only: no real login, credentials, provider calls or database.
"""
import json
import base64
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
import base64, json, os, pathlib, subprocess, sys, time
args=sys.argv[1:]
behavior=os.environ.get('FAKE_BEHAVIOR','success')
if args==['--version']:
 print('codex-cli fake-1');sys.exit(0)
if args==['exec','--help']:
 flags=['--image FILE'] if os.environ.get('FAKE_NO_IMAGE')!='yes' else []
 flags+=['--json','--sandbox read-only','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check']
 if os.environ.get('FAKE_FALLBACK')!='yes':flags+=['--output-schema FILE','--output-last-message FILE']
 print('\n'.join(flags));sys.exit(0)
if args==['app-server','--help']:
 print('--listen stdio://' if os.environ.get('FAKE_NATIVE')=='yes' else 'unsupported');sys.exit(0 if os.environ.get('FAKE_NATIVE')=='yes' else 1)
if args==['login','--help']:
 print('Commands: status');sys.exit(0)
if args==['login','status']:
 print('Not logged in' if behavior=='auth' else 'Logged in');sys.exit(1 if behavior=='auth' else 0)
if args[:1]==['app-server']:
 trace={'argv':args,'cwd':os.getcwd(),'files':sorted(os.listdir('.')),'proxy':os.environ.get('https_proxy'),'images':[],'requests':[]}
 pathlib.Path(os.environ['FAKE_TRACE']).write_text(json.dumps(trace))
 if behavior=='hang':
  code="import time,pathlib;time.sleep(1.2);pathlib.Path("+repr(os.environ['FAKE_MARKER'])+").write_text('orphan')"
  subprocess.Popen([sys.executable,'-c',code])
  while True:time.sleep(.05)
 def emit(value):print(json.dumps(value),flush=True)
 def event(method,**params):emit({'method':method,'params':params})
 for line in sys.stdin:
  message=json.loads(line);trace['requests'].append(message)
  pathlib.Path(os.environ['FAKE_TRACE']).write_text(json.dumps(trace))
  if message['method']=='initialize':
   event('mcpServer/startupStatus/updated',threadId=None,name='PRIVATE MCP NAME',status='ready',error=None,failureReason=None)
   emit({'id':1,'result':{'userAgent':'fake'}})
  elif message['method']=='thread/start':emit({'id':2,'result':{'thread':{'id':'thread-1'}}})
  elif message['method']=='turn/start':
   trace['images']=[{'path':i['path'],'base64':base64.b64encode(pathlib.Path(i['path']).read_bytes()).decode('ascii')} for i in message['params']['input'] if i['type']=='localImage']
   pathlib.Path(os.environ['FAKE_TRACE']).write_text(json.dumps(trace))
   emit({'id':3,'result':{'turn':{'id':'turn-1'}}})
   event('turn/started',threadId='thread-1',turn={'id':'turn-1'})
   if behavior=='tool':emit({'id':99,'method':'item/commandExecution/requestApproval','params':{}});time.sleep(10)
   if behavior=='mcp':event('item/started',threadId='thread-1',turnId='turn-1',item={'type':'mcpToolCall','id':'tool'});time.sleep(10)
   if behavior=='nativecameltool':event('item/started',threadId='thread-1',turnId='turn-1',item={'type':'commandExecution','id':'tool'});time.sleep(10)
   if behavior=='nativewrongid':emit({'id':55,'result':{}});time.sleep(10)
   if behavior=='nativefailed':event('turn/completed',threadId='thread-1',turn={'id':'turn-1','status':'failed','error':{'message':'network failure'}});time.sleep(10)
   event('item/started',threadId='thread-1',turnId='turn-1',item={'type':'reasoning','id':'reason','text':'PRIVATE REASONING'})
   event('item/reasoning/textDelta',threadId='thread-1',turnId='turn-1',itemId='reason',delta='PRIVATE REASONING')
   event('item/started',threadId='thread-1',turnId='turn-1',item={'type':'agentMessage','id':'answer'})
   raw=os.environ['FAKE_PROPOSAL'] if behavior!='badfinal' else '```json\n{}\n```'
   for char in raw:
    event('item/agentMessage/delta',threadId='wrong' if behavior=='nativewrongthread' else 'thread-1',turnId='turn-1',itemId='answer',delta=char)
    if behavior=='nativeslow':time.sleep(.001)
   event('item/completed',threadId='thread-1',turnId='turn-1',item={'type':'agentMessage','id':'answer','text':raw,'phase':'final_answer'})
   event('turn/completed',threadId='thread-1',turn={'id':'turn-1','status':'completed'})
   while True:time.sleep(.05)
 sys.exit(0)
trace={'argv':args,'cwd':os.getcwd(),'files':sorted(os.listdir('.')),'proxy':os.environ.get('https_proxy'),'images':[{'path':args[i+1],'base64':base64.b64encode(pathlib.Path(args[i+1]).read_bytes()).decode('ascii')} for i,arg in enumerate(args) if arg=='--image']}
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
print(json.dumps({'type':'turn.started'}),flush=True)
if behavior=='progress':
 print(json.dumps({'type':'item.completed','item':{'type':'reasoning','text':'PRIVATE REASONING'}}),flush=True)
 print(json.dumps({'type':'item.updated','item':{'type':'agent_message','text':'{"summary":"This is a sufficiently long partial answer'}}),flush=True)

print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':raw}}),flush=True)
print(json.dumps({'type':'turn.completed'}),flush=True)
'''


class Running:
    def __init__(self, process):
        self.process = process
        self.stdout, self.stderr = [], []
        self.readers = []
        for stream, target in ((process.stdout, self.stdout), (process.stderr, self.stderr)):
            def read_lines(s=stream, t=target):
                for line in s:
                    t.append(line)
            thread = threading.Thread(target=read_lines, daemon=True)
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

    def start(self, behavior="success", mode="run", fallback=False, timeout=3000, prompt=None, codex_path=None, images=None, no_image=False, native=False, proposal=None, response_deltas=True):
        env = dict(os.environ, PATH=str(self.root), FAKE_BEHAVIOR=behavior, FAKE_FALLBACK="yes" if fallback else "no",
                   FAKE_NATIVE="yes" if native else "no", FAKE_NO_IMAGE="yes" if no_image else "no", FAKE_TRACE=str(self.trace), FAKE_MARKER=str(self.marker), FAKE_PROPOSAL=json.dumps(proposal or PROPOSAL))
        process = subprocess.Popen([sys.executable, "-I", str(RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        running = Running(process)
        self.running.append(running)
        request = dict(version=1, mode=mode, codexPath=str(self.fake) if codex_path is None else codex_path, proxyUrl="http://192.0.2.10:3128", timeoutMs=timeout,
                       prompt=prompt or "Create a task. Do not use tools. $(touch NEVER) `touch NEVER2`", schema=json.dumps({"type": "object"}))
        if response_deltas is not None: request["responseDeltas"] = response_deltas
        if images is not None: request["images"] = images
        process.stdin.write(json.dumps(request) + "\n")
        process.stdin.flush()
        return running

    def wait_started(self):
        deadline = time.monotonic() + 3
        while not self.trace.exists() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(self.trace.exists(), "fake Codex execution did not start")

    def test_native_probe_advertises_real_streaming(self):
        code, frames = self.start(mode="probe", native=True).finish()
        self.assertEqual(code, 0)
        self.assertTrue(frames[-1]["capabilities"]["appServer"])
        self.assertTrue(frames[-1]["capabilities"]["streaming"])
        self.assertIn("ephemeral", frames[-1]["capabilities"]["isolation"])

    def test_native_true_deltas_survive_over_100_unicode_fragments_without_reasoning(self):
        proposal = dict(PROPOSAL, summary="每个字😀都能实时到达" + "字" * 150)
        running = self.start(native=True, behavior="nativeslow", proposal=proposal)
        self.wait_started()
        deadline = time.monotonic() + 3
        while not any('"delta"' in line for line in running.stdout) and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(any('"delta"' in line for line in running.stdout), "No live delta before completion")
        self.assertIsNone(running.process.poll(), "Stream arrived only after process completion")
        code, frames = running.finish()
        self.assertEqual(code, 0)
        events = [frame["event"] for frame in frames if frame["type"] == "progress"]
        replies = [event for event in events if event["type"] == "response"]
        self.assertGreater(len(replies), 100)
        text = ""
        for event in replies: text = event["text"] if "text" in event else text + event["delta"]
        self.assertEqual(text, proposal["summary"])
        self.assertNotIn("PRIVATE", json.dumps(events))
        self.assertNotIn("idempotency_key", json.dumps(events))
        self.assertEqual(json.loads(frames[-1]["raw"]), proposal)
        self.assertLess(sum(len(json.dumps(frame).encode()) for frame in frames), 100000)
        trace = json.loads(self.trace.read_text())
        thread = next(r["params"] for r in trace["requests"] if r["method"] == "thread/start")
        self.assertIn("--disable", trace["argv"])
        self.assertIn("hooks", trace["argv"])
        self.assertIn("project_doc_max_bytes=0", trace["argv"])
        self.assertEqual(thread["sandbox"], "read-only")
        self.assertEqual(thread["approvalPolicy"], "never")
        self.assertTrue(thread["ephemeral"])
        turn = next(r["params"] for r in trace["requests"] if r["method"] == "turn/start")
        self.assertEqual(turn["outputSchema"], {"type":"object"})
        self.assertFalse(Path(trace["cwd"]).exists())

    def test_legacy_clients_receive_cumulative_text_without_delta_negotiation(self):
        for negotiated in (None, False):
            with self.subTest(response_deltas=negotiated):
                code, frames = self.start(native=True, response_deltas=negotiated).finish()
                self.assertEqual(code, 0)
                replies = [frame["event"] for frame in frames if frame["type"] == "progress" and frame["event"]["type"] == "response"]
                self.assertTrue(replies)
                self.assertTrue(all("text" in event and "delta" not in event for event in replies))
                self.assertEqual(replies[-1]["text"], PROPOSAL["summary"])

    def test_legacy_snapshot_batches_still_deliver_the_short_final_suffix(self):
        summary = "保留旧客户端" * 20 + "最后"
        code, frames = self.start(native=True, response_deltas=False, proposal=dict(PROPOSAL, summary=summary)).finish()
        self.assertEqual(code, 0)
        replies = [frame["event"] for frame in frames if frame["type"] == "progress" and frame["event"]["type"] == "response"]
        self.assertLessEqual(len(replies), len(summary) // 24 + 1)
        self.assertEqual(replies[-1]["text"], summary)
        self.assertTrue(all("delta" not in event for event in replies))

    def test_native_local_images_reach_model_and_are_cleaned(self):
        image = self.image()
        code, frames = self.start(native=True, images=[image]).finish()
        self.assertEqual(code, 0)
        trace = json.loads(self.trace.read_text())
        self.assertEqual(trace["images"][0]["base64"], image["base64"])
        self.assertFalse(Path(trace["images"][0]["path"]).exists())

    def test_native_errors_tools_and_wrong_scope_never_return_proposal(self):
        for behavior in ("tool", "mcp", "nativecameltool", "nativewrongid", "nativewrongthread", "nativefailed", "badfinal"):
            with self.subTest(behavior=behavior):
                code, frames = self.start(native=True, behavior=behavior).finish()
                self.assertNotEqual(code, 0)
                self.assertFalse(any(frame["type"] == "proposal" for frame in frames))

    def test_native_disconnect_and_timeout_kill_entire_group(self):
        for cancel in (True, False):
            with self.subTest(cancel=cancel):
                if self.trace.exists(): self.trace.unlink()
                running = self.start(native=True, behavior="hang", timeout=3000 if cancel else 650)
                self.wait_started()
                if cancel: running.process.stdin.close()
                code, frames = running.finish()
                self.assertNotEqual(code, 0)
                self.assertEqual(frames[-1]["code"], "cancelled" if cancel else "timeout")
                time.sleep(1.3)
                self.assertFalse(self.marker.exists())

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

    def test_public_progress_hides_reasoning_and_streams_summary_only(self):
        code, frames = self.start(behavior="progress").finish()
        self.assertEqual(code, 0)
        progress = [frame["event"] for frame in frames if frame["type"] == "progress"]
        text = json.dumps(progress)
        self.assertNotIn("PRIVATE REASONING", text)
        self.assertNotIn("idempotency_key", text)
        replies, current = [], ""
        for event in progress:
            if event["type"] != "response": continue
            current = event["text"] if "text" in event else current + event["delta"]
            replies.append(current)
        self.assertEqual(replies, ["This is a sufficiently long partial answer", PROPOSAL["summary"]])
        self.assertTrue(any(event.get("phase") == "model" and event.get("status") == "completed" for event in progress))

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

    def image(self):
        return dict(id="asset-image",mime="image/png",base64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBx8AAAAASUVORK5CYII=")

    def test_image_bytes_reach_codex_and_owned_files_are_removed(self):
        image = self.image()
        code, frames = self.start(images=[image]).finish()
        self.assertEqual(code, 0)
        trace = json.loads(self.trace.read_text())
        self.assertEqual(trace["images"][0]["base64"], image["base64"])
        self.assertFalse(Path(trace["images"][0]["path"]).exists())
        self.assertEqual(trace["argv"][-2:], ["--", "-"])
        self.assertEqual(trace["files"], [])

    def test_invalid_images_and_unsupported_cli_do_not_run_codex(self):
        variants = [dict(self.image(), id="../escape"),dict(self.image(), mime="image/jpeg"),dict(self.image(), base64="not-base64"),dict(self.image(), base64=base64.b64encode(b"<svg>bad</svg>").decode())]
        for image in variants:
            with self.subTest(image=image):
                code, frames = self.start(images=[image]).finish()
                self.assertNotEqual(code, 0)
                self.assertFalse(self.trace.exists())
                self.assertFalse(any(frame["type"] == "proposal" for frame in frames))
        code, frames = self.start(images=[self.image()],no_image=True).finish()
        self.assertNotEqual(code, 0)
        self.assertEqual(frames[-1]["code"], "unsupported_input")
        self.assertFalse(self.trace.exists())

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
