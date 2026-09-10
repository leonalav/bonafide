#!/usr/bin/env python3
"""
Bonafide W&B Shim — stdio JSON-RPC adapter for the wandb SDK.

Entry point: python scripts/wandb_shim.py [--api-key KEY] [--project PROJECT]
Transport:    stdin/stdout, one JSON-RPC request per line (newline-delimited).
              stderr carries structured events as JSON lines.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VENV_BASE = os.path.expanduser("~/.bonafide/shim-venv")

if sys.platform == "win32":
    VENV_BIN = os.path.join(VENV_BASE, "Scripts")
else:
    VENV_BIN = os.path.join(VENV_BASE, "bin")

VENV_PYTHON = os.path.join(VENV_BIN, "python.exe" if sys.platform == "win32" else "python")
VENV_PIP = os.path.join(VENV_BIN, "pip.exe" if sys.platform == "win32" else "pip")


# ---------------------------------------------------------------------------
# Structured logging to stderr
# ---------------------------------------------------------------------------

def log_event(event: str, **kwargs) -> None:
    """Emit a structured JSON line to stderr."""
    payload = {"event": event}
    payload.update(kwargs)
    sys.stderr.write(json.dumps(payload) + "\n")
    sys.stderr.flush()


def log_progress(stage: str, percent: int, message: str) -> None:
    log_event("install_progress", stage=stage, percent=percent, message=message)


def log_error(kind: str, message: str) -> None:
    log_event("error", kind=kind, message=message)


# ---------------------------------------------------------------------------
# Virtual environment / wandb installation
# ---------------------------------------------------------------------------

def ensure_wandb() -> None:
    """
    Check whether wandb is importable.  If not, bootstrap a venv at
    VENV_BASE and install the package there.
    Emits progress events to stderr (picked up by the Rust side).
    """
    try:
        import wandb  # type: ignore
        return
    except ImportError:
        pass

    # wandb not available — install it
    log_progress("creating_venv", 10, "Creating Python virtual environment…")
    os.makedirs(VENV_BASE, exist_ok=True)

    python_exe = sys.executable

    # Create the venv (reuse python if already a venv to avoid symlink issues)
    result = subprocess.run(
        [python_exe, "-m", "venv", VENV_BASE],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        log_error("no_python", f"Failed to create venv: {result.stderr}")
        sys.exit(1)

    log_progress("installing", 30, "Installing wandb…")
    result = subprocess.run(
        [VENV_PIP, "install", "wandb"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        log_error("install_failed", f"pip install wandb failed: {result.stderr}")
        sys.exit(1)

    log_progress("verifying", 95, "Verifying wandb installation…")
    # Quick smoke-check
    result = subprocess.run(
        [VENV_PYTHON, "-c", "import wandb; print(wandb.__version__)"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        log_error("install_failed", f"wandb import check failed: {result.stderr}")
        sys.exit(1)

    log_progress("ready", 100, f"wandb {result.stdout.strip()} installed")


# ---------------------------------------------------------------------------
# JSON-RPC helpers
# ---------------------------------------------------------------------------

def make_response(req_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def make_error(req_id, code: int, message: str) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


# ---------------------------------------------------------------------------
# wandb API wrapper
# ---------------------------------------------------------------------------

class WandbApi:
    """Thin wrapper around the wandb SDK, scoped to one authenticated session."""

    def __init__(self, api_key: str | None = None):
        if api_key:
            os.environ["WANDB_API_KEY"] = api_key
        import wandb as _wandb
        self._wandb = _wandb
        # Validate the key by hitting entity_settings
        try:
            api = self._wandb.Api()
            api.entity_settings()
        except Exception as exc:
            log_error("auth_failed", str(exc))
            raise

    # ------------------------------------------------------------------
    # Tracker provider surface (matches tracker/mod.rs TrackerProvider)
    # ------------------------------------------------------------------

    def list_runs(self, project: str, limit: int = 50, cursor: str | None = None) -> dict:
        api = self._wandb.Api()
        filters = {}
        runs = api.runs(project, filters=filters, per_page=limit)
        # wandb-sdk paginates lazily; cursor is a page token
        run_list = [
            {
                "id": r.id,
                "name": r.name,
                "state": r.state,
                "created_at": int(r.created_at.timestamp()) if r.created_at else 0,
                "summary_metrics": r.summary._json_dict if hasattr(r, "summary") else {},
            }
            for r in runs
        ]
        # Note: wandb SDK doesn't expose a raw cursor; approximate with None
        return {"runs": run_list, "next_cursor": None}

    def get_run(self, run_id: str) -> dict:
        api = self._wandb.Api()
        r = api.run(run_id)
        return {
            "id": r.id,
            "name": r.name,
            "state": r.state,
            "created_at": int(r.created_at.timestamp()) if r.created_at else 0,
            "finished_at": int(r.finished_at.timestamp()) if getattr(r, "finished_at", None) else None,
            "config": r.config._json_dict if hasattr(r, "config") else {},
            "summary_metrics": r.summary._json_dict if hasattr(r, "summary") else {},
            "tags": list(r.tags) if hasattr(r, "tags") else [],
            "notes": r.notes if hasattr(r, "notes") else "",
        }

    def get_metric_series(self, run_id: str, key: str) -> list[dict]:
        api = self._wandb.Api()
        r = api.run(run_id)
        history = r.history(keys=[key])
        points = []
        for _, row in history.iterrows():
            if key in row:
                step_val = row.get("_step")
                step = int(step_val) if (isinstance(step_val, (int, float)) and not math.isnan(float(step_val))) else 0
                points.append({
                    "step": step,
                    "value": float(row[key]),
                    "ts": 0,  # wandb history doesn't expose per-row timestamps by default
                })
        return points

    def get_run_config(self, run_id: str) -> dict:
        api = self._wandb.Api()
        r = api.run(run_id)
        return {
            "run_id": r.id,
            "config": r.config._json_dict if hasattr(r, "config") else {},
        }

    def list_artifacts(self, run_id: str) -> list[dict]:
        api = self._wandb.Api()
        r = api.run(run_id)
        artifacts = []
        for art in r.logged_artifacts():
            artifacts.append({
                "name": art.name,
                "digest": art.digest,
                "size_bytes": art.size,
                "created_at": int(art.created_at.timestamp()) if art.created_at else 0,
            })
        return artifacts


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------

def handle_request(method: str, params: dict, api: WandbApi) -> dict:
    req_id = params.get("_req_id")

    try:
        if method == "list_runs":
            result = api.list_runs(
                project=params["project"],
                limit=params.get("limit", 50),
                cursor=params.get("cursor"),
            )
        elif method == "get_run":
            result = api.get_run(run_id=params["run_id"])
        elif method == "get_metric_series":
            result = api.get_metric_series(
                run_id=params["run_id"],
                key=params["key"],
            )
        elif method == "get_run_config":
            result = api.get_run_config(run_id=params["run_id"])
        elif method == "list_artifacts":
            result = api.list_artifacts(run_id=params["run_id"])
        else:
            return make_error(req_id, -32601, f"Method not found: {method}")
    except Exception as exc:
        log_error("tracker_error", str(exc))
        return make_error(req_id, -32000, str(exc))

    return make_response(req_id, result)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(prog="wandb_shim", description="Bonafide W&B stdio JSON-RPC shim")
    parser.add_argument("--api-key", dest="api_key", default=None, help="W&B API key")
    parser.add_argument("--project", dest="project", default=None, help="Default W&B project")
    args = parser.parse_args()

    # Bootstrap wandb (installs venv if needed)
    ensure_wandb()

    # Re-import after ensure_wandb so we pick up the venv site-packages
    # (The venv python IS the interpreter running this script, so wandb
    # is already importable — ensure_wandb only installs if it wasn't found.)
    try:
        api = WandbApi(api_key=args.api_key)
    except Exception as exc:
        # Auth errors are already logged by WandbApi.__init__
        sys.exit(1)

    log_event("shim_ready", project=args.project or "")

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                log_error("parse_error", f"Invalid JSON: {exc}")
                continue

            method = request.get("method")
            req_id = request.get("id")
            req_params = request.get("params", {})
            # Attach req_id so make_response / make_error can use it
            req_params["_req_id"] = req_id

            response = handle_request(method, req_params, api)
            print(json.dumps(response), flush=True)
    except KeyboardInterrupt:
        log_event("shim_stopped", reason="keyboard_interrupt")
    except Exception as exc:
        log_error("shim_crashed", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
