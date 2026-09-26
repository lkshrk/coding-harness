from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .config import ROOT, load_experiment, load_task


def _trust_extra_ca() -> None:
    """Host-side clients (urllib, httpx) use certifi, not the OS keychain; add the private CA to their bundle."""
    extra = os.environ.get("EXTRA_CA_CERT")
    if not extra or os.environ.get("SSL_CERT_FILE"):
        return
    import certifi

    bundle = ROOT / "runs" / ".ca-bundle.pem"
    bundle.parent.mkdir(exist_ok=True)
    bundle.write_text(Path(certifi.where()).read_text() + "\n" + Path(extra).read_text())
    os.environ["SSL_CERT_FILE"] = str(bundle)


def main() -> None:
    _trust_extra_ca()
    parser = argparse.ArgumentParser(prog="harness")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run one benchmark task under one experiment, locally")
    run.add_argument("task", help="task id (benchmark/<id>.yaml) or path")
    run.add_argument("experiment", help="experiment name (experiments/<name>.yaml) or path")

    val = sub.add_parser("validate", help="check each task: hidden tests fail on base, all checks pass on reference")
    val.add_argument("tasks", nargs="*", help="task ids (default: all)")

    ds = sub.add_parser("dataset", help="upload benchmark/ as a Phoenix dataset")
    ds.add_argument("--name", default="coding-harness-benchmark")

    exp = sub.add_parser("experiment", help="run an experiment over a Phoenix dataset")
    exp.add_argument("experiment")
    exp.add_argument("--dataset", default="coding-harness-benchmark")

    args = parser.parse_args()
    if args.command == "run":
        from .runner import run_task

        result = run_task(load_task(_path(args.task, "benchmark")), load_experiment(_path(args.experiment, "experiments")))
        print(json.dumps({k: v for k, v in result.items() if k not in ("steps", "verifications")}, indent=2))
    elif args.command == "validate":
        from .validate import validate_tasks

        raise SystemExit(0 if validate_tasks(args.tasks) else 1)
    elif args.command == "dataset":
        from .phoenix import sync_dataset

        sync_dataset(args.name)
    else:
        from .phoenix import run_experiment

        run_experiment(load_experiment(_path(args.experiment, "experiments")), args.dataset)


def _path(value: str, directory: str) -> str:
    return value if value.endswith(".yaml") else str(ROOT / directory / f"{value}.yaml")
