"""Experiment-side controller; model execution stays in the DSH SDK.

No benchmark, evaluator, or model API is configured implicitly. Custom /meta
commands use the plugin-owned Unix socket because DSH's SDK query recognizes
only selected builtin commands. Importing this module starts nothing.
"""
from __future__ import annotations

import http.client
import json
import socket
import time
from typing import Callable


class MetaTeamControl:
    def __init__(self, socket_path: str, token: str, session_id: str):
        self.socket_path = socket_path
        self.token = token
        self.session_id = session_id

    def command(self, operation: str, payload=None):
        command = "/meta " + operation
        if payload is not None:
            command += " " + (payload if isinstance(payload, str) else json.dumps(payload))
        connection = http.client.HTTPConnection("localhost", timeout=30)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(30)
        connection.sock.connect(self.socket_path)
        try:
            connection.request("POST", "/meta", json.dumps({"sessionId": self.session_id, "command": command}), headers={
                "Authorization": "Bearer " + self.token, "Content-Type": "application/json",
            })
            response = connection.getresponse()
            result = json.loads(response.read())
            if response.status != 200 or result.get("kind") != "success":
                raise RuntimeError(f"Meta-Team control failed: {result}")
            return json.loads(result["text"])
        finally:
            connection.close()

    def wait_for(self, phases: set[str], timeout: float):
        deadline = time.monotonic() + timeout
        while True:
            state = self.command("status")
            if state.get("phase") in phases:
                return state
            if state.get("phase") == "aborted":
                raise RuntimeError("Meta-Team episode aborted; inspect the episode audit log")
            if time.monotonic() >= deadline:
                self.command("abort", "external experiment timeout")
                raise TimeoutError("Meta-Team episode timeout")
            time.sleep(0.2)


def run_episode(harness, control: MetaTeamControl, episode_id: str, task: str,
                evaluator: Callable[[str], object], timeout: float = 600):
    """Execute, evaluate once outside the model, then finish the reflection phases.

    The caller must have explicitly configured model credentials and equivalent
    environment tools. The evaluator receives the committed task output, not
    the model's last tool acknowledgment. In fixed mode no evaluation feedback
    is fed into an update. Each independent task should use a fresh Session id.
    """
    harness.client.get_working_directory(control.session_id)
    control.command("begin", {"id": episode_id, "task": task})
    session = harness.start_session(control.session_id)
    execution = session.run(task)
    state = control.wait_for({"awaiting-feedback", "complete"}, timeout)
    feedback = evaluator(state["output"])
    if state["phase"] == "awaiting-feedback":
        control.command("feedback", feedback)
        state = control.wait_for({"complete"}, timeout)
    return {"state": state, "evaluation": feedback, "execution_events": execution.events}
