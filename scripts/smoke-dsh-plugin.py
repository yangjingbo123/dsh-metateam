"""Load the compiled plugin through the official SDK profile, without a model.

Requires the inspected DSH checkout/build and its Python SDK dependencies.
Does not modify that checkout, submit prompts, run agents, or read credentials.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import subprocess
import http.client
import socket
import time
import shutil
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DSH = Path(os.environ["DSH_CHECKOUT"]).expanduser().resolve() if os.environ.get("DSH_CHECKOUT") else None
NODE = os.environ.get("RUNTIME_NODE") or shutil.which("node")


def main():
    if DSH is None or NODE is None:
        raise SystemExit("请设置 DSH_CHECKOUT，并安装 Node.js 或设置 RUNTIME_NODE。")
    scripted = "--scripted" in sys.argv
    packed = "--packed" in sys.argv
    if packed and scripted:
        raise SystemExit("发布包不包含测试模型，--packed 与 --scripted 不能同时使用。")
    for key in list(os.environ):
        if key.endswith(("_API_KEY", "_API_TOKEN")) or key in {"DSH_HOME", "DEEPSEEK_BASE_URL", "OPENAI_BASE_URL"}:
            os.environ.pop(key, None)
    sys.path.insert(0, str(DSH / "python/sdk/src"))
    from deepseek_harness import DeepSeekHarness

    (ROOT / "work").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="plugin-smoke-", dir=ROOT / "work") as tmp:
        folder = Path(tmp)
        plugin_root = ROOT
        if packed:
            with tarfile.open(ROOT / "work/release/dsh-meta-team-0.1.0.tgz") as archive:
                archive.extractall(folder / "packed", filter="data")
            plugin_root = folder / "packed/package"
            # Only test dependencies are borrowed; the package's runtime and
            # resources must resolve entirely from the unpacked tarball.
            (plugin_root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        pool = folder / "pool"
        (pool / "chairman").mkdir(parents=True)
        (pool / "pool.yaml").write_text("chairman: chairman\n")
        (pool / "constitution.md").write_text("Never call a model during this test.\n")
        (pool / "chairman/config.yaml").write_text("name: chairman\nmodel: unused\ntools: []\n")
        (pool / "chairman/prompt.md").write_text("Audit chairman.\n")
        if scripted:
            (pool / "worker").mkdir()
            (pool / "worker/config.yaml").write_text("name: worker\nmodel: mock\nmax_steps: 50\ntools: []\n")
            (pool / "worker/prompt.md").write_text("Audit worker.\n")
        launcher = folder / "dsh"
        launcher.write_text(f'#!/bin/sh\nexec "{NODE}" "{DSH / "apps/cli/lib/bin.js"}" "$@"\n')
        launcher.chmod(0o700)
        config = {
            "poolDir": str(pool), "stateDir": str(folder / "state"),
            "workspace": str(folder), "resources": str(ROOT / "plugins/meta-team/resources/upstream.json"),
            "mode": "collaborative" if scripted else "fixed",
            "controlSocket": str(folder / "control.sock"),
            "controlToken": "offline-smoke-token-only",
        }
        if packed:
            config.pop("resources")
        patch = folder / "plugin.yml"
        # JSON is a YAML subset; no additional parser dependency needed.
        entries = [{"id": "meta-team-research", "name": str(plugin_root / "dist/index.js"), "config": config}]
        if scripted:
            entries.insert(0, {"id": "meta-scripted", "name": str(ROOT / "dist/testing/scripted-model.js")})
        patch.write_text(json.dumps([{"insert": entries}]))
        dumped = subprocess.run([str(launcher), "--profile", "sdk", "--patch", str(patch), "--dump-config"], env={**os.environ, "DSH_HOME": str(folder / "home")}, capture_output=True, text=True, timeout=30)
        (ROOT / "work/plugin-config-dump.txt").write_text(dumped.stdout + dumped.stderr)
        with DeepSeekHarness(
            dsh_bin=str(launcher), dsh_home=str(folder / "home"),
            cwd=str(folder), runtime_cwd=str(ROOT), profile="sdk",
            patches=(str(patch),), base_url="http://127.0.0.1:9",
            provider="meta-scripted" if scripted else "deepseek-official",
            model="mock" if scripted else "deepseek-v4-flash",
            env={"DEEPSEEK_API_KEY": ""}, initialize_timeout_seconds=30,
            request_timeout_seconds=15, shutdown_timeout_seconds=5,
        ) as harness:
            session = harness.start_session("plugin-audit")
            # SDK query deliberately recognizes only builtin commands. Use the
            # plugin-owned authenticated socket, not a spoofed builtin identity.
            def control(session_id, command):
                harness.client.get_working_directory(session_id)
                if not Path(config["controlSocket"]).exists():
                    diagnostic = folder / "state/plugin-startup-error.json"
                    raise RuntimeError(diagnostic.read_text() if diagnostic.exists() else "Plugin control socket absent without startup diagnostic")
                connection = http.client.HTTPConnection("localhost", timeout=10)
                connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.sock.settimeout(10)
                connection.sock.connect(config["controlSocket"])
                try:
                    connection.request("POST", "/meta", json.dumps({"sessionId": session_id, "command": command}), headers={"Authorization": "Bearer " + config["controlToken"], "Content-Type": "application/json"})
                    response = connection.getresponse()
                    payload = json.loads(response.read())
                    assert response.status == 200 and payload.get("kind") == "success", payload
                    return json.loads(payload["text"])
                finally:
                    connection.close()
            initial = control("plugin-audit", "/meta status")
            assert initial["phase"] == "not-started", initial
            begun = control("plugin-audit", '/meta begin {"id":"audit1","task":"offline audit"}')
            assert begun["phase"] == "execution", begun
            active = control("plugin-audit", "/meta status")
            assert active["sessions"]["chairman"] == "plugin-audit", active
            visible = control("plugin-audit", "/meta inspect")
            assert "start_agent" in visible["tools"] and "update_skill" not in visible["tools"], visible
            assert ("finalize_task" if scripted else "set_final_output") in visible["tools"], visible
            assert "Audit chairman." in visible["context"], visible
            if scripted:
                session.run("Run the deterministic two-member task.")
                state = control("plugin-audit", "/meta status")
                assert state["phase"] == "awaiting-feedback", state
                assert state["output"] == "Scripted answer with evidence.", state
                control("plugin-audit", "/meta feedback {\"success\":false,\"summary\":\"Check evidence\"}")
                deadline = time.monotonic() + 20
                while True:
                    state = control("plugin-audit", "/meta status")
                    if state["phase"] == "complete":
                        break
                    if state["phase"] == "aborted" or time.monotonic() >= deadline:
                        raise RuntimeError(f"Scripted native pipeline did not finish: {state}")
                    time.sleep(0.1)
                frozen = control("plugin-audit", '/meta freeze {"name":"scripted-export"}')
                tree = Path(frozen["destination"])
                assert "Verify citations" in (tree / "constitution.md").read_text()
                assert (tree / "worker/skills/verify-evidence/SKILL.md").exists()
                assert (tree / "chairman/evolution/teammate_profiles.yaml").exists()
                assert (tree / "worker/evolution/correlations/chairman.md").exists()
                report = {"native_scripted_pipeline": "passed", "phases": ["execution", "awaiting-feedback", "l1", "l2", "l3", "complete"], "real_model_requests": 0, "synthetic_reported_tokens": state["tokens"]}
                (ROOT / "work/dsh-scripted-result.json").write_text(json.dumps(report, indent=2) + "\n")
                print(json.dumps(report, indent=2))
                return
            aborted = control("plugin-audit", "/meta abort offline check complete")
            assert aborted["phase"] == "aborted", aborted
            frozen = control("plugin-audit", '/meta freeze {"name":"audit-export"}')
            assert Path(frozen["destination"]).is_dir(), frozen
            second = harness.start_session("plugin-audit-second")
            again = control("plugin-audit-second", '/meta begin {"id":"audit2","task":"new offline task"}')
            assert again["phase"] == "execution", again
            control("plugin-audit-second", "/meta abort end")
        report = {"plugin_load": "passed", "member_scope_mount": "passed", "episode_restart": "passed", "snapshot_freeze": "passed", "model_prompts_submitted": 0, "packed_artifact": packed}
    (ROOT / ("work/dsh-packed-smoke-result.json" if packed else "work/dsh-plugin-smoke-result.json")).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
