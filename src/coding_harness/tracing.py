from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from openinference.semconv.trace import OpenInferenceSpanKindValues as Kind
from openinference.semconv.trace import SpanAttributes as A
from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode

PROJECT = "coding-harness"
MAX_TEXT = 8000

_provider = None


def _tracer() -> trace.Tracer:
    """Traces go straight from the runner to Phoenix; without PHOENIX_BASE_URL spans are no-ops."""
    global _provider
    base = os.environ.get("PHOENIX_BASE_URL")
    if base and _provider is None:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        key = os.environ.get("PHOENIX_API_KEY")
        exporter = OTLPSpanExporter(
            endpoint=f"{base.rstrip('/')}/v1/traces",
            headers={"authorization": f"Bearer {key}"} if key else None,
        )
        _provider = TracerProvider(resource=Resource.create({"openinference.project.name": PROJECT}))
        _provider.add_span_processor(BatchSpanProcessor(exporter))
    return (_provider or trace.get_tracer_provider()).get_tracer("coding-harness")


def flush() -> None:
    if _provider is not None:
        _provider.force_flush()


@contextmanager
def span(name: str, kind: Kind, session_id: str, **attributes: Any) -> Iterator[Span]:
    with _tracer().start_as_current_span(name) as current:
        current.set_attribute(A.OPENINFERENCE_SPAN_KIND, kind.value)
        current.set_attribute(A.SESSION_ID, session_id)
        set_attributes(current, **attributes)
        yield current


def set_attributes(current: Span, **attributes: Any) -> None:
    for key, value in attributes.items():
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            value = json.dumps(value)
        if isinstance(value, str):
            value = value[:MAX_TEXT]
        current.set_attribute(key, value)


def fail(current: Span, message: str) -> None:
    current.set_status(Status(StatusCode.ERROR, message[:500]))


def ids(current: Span) -> dict[str, str]:
    ctx = current.get_span_context()
    return {"trace_id": format(ctx.trace_id, "032x"), "span_id": format(ctx.span_id, "016x")}


__all__ = ["PROJECT", "A", "Kind", "fail", "flush", "ids", "set_attributes", "span"]
