#!/usr/bin/env python3
"""Narrow stdlib PTY driver for the native human-review harness.

Inert unless a root-authorized plan and a frozen SHA manifest are supplied by
the Bun runner. This driver starts the real OMP binary, sends real terminal
bytes, records the raw PTY stream and the transparent observer audit, verifies
actual execution/watchdog identities, and writes a bounded evidence bundle.
It never imports product or test modules, never fabricates terminal replies and
never treats raw ANSI as a screenshot.
"""
from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

MAX_PTY_BYTES = 8 * 1024 * 1024
MAX_AUDIT_EVENTS = 8001
MAX_AUDIT_BYTES = 16 * 1024 * 1024 + 64 * 1024
MAX_TREE_FILES = 128
MAX_TREE_BYTES = 1024 * 1024
MAX_LOG_BYTES = 16 * 1024 * 1024 + 64 * 1024
POLL_SECONDS = 0.03
IDENTITY_TIMEOUT_SECONDS = 10.0
IDENTITY_MAX_BYTES = 512
CHILD_IDENTITY_ACK = b"1\n"
DEADLINE_MIN_ELAPSED_MS = 299_500
DEADLINE_MAX_ELAPSED_MS = 340_000
DEADLINE_ABORT_MESSAGE = "The operation was aborted."
FATAL_AUDIT_EVENT_TYPES = {
    "harness_error",
    "audit_overflow",
    "audit_failure",
    "audit_byte_limit",
}
PROVEN_NO_SPAWN_EVENTS = {
    "execution_preparation_failed",
    "execution_aborted_before_spawn",
    "execution_revoked_before_spawn",
    "execution_not_dispatched_record_failed",
}
SPAWN_EVIDENCE_EVENTS = {
    "execution_staged",
    "execution_process_settled",
    "execution_completed",
    "execution_artifacts_exported",
}


def sha_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def fail(message: str, stage: str, **extra):
    return {"type": "DriverFailure", "stage": stage, "message": message, **extra}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_events(path: Path):
    if not path.exists():
        return []
    data = path.read_bytes()
    if len(data) > MAX_AUDIT_BYTES:
        raise RuntimeError(f"audit file {path} exceeds {MAX_AUDIT_BYTES} bytes")
    lines = data.split(b"\n")
    if data and not data.endswith(b"\n"):
        lines = lines[:-1]
    events = []
    for index, line in enumerate(lines):
        if not line:
            continue
        try:
            value = json.loads(line.decode("utf-8"))
        except Exception as error:  # noqa: BLE001
            raise RuntimeError(f"audit line {index + 1} in {path} is not valid JSON: {error}")
        if not isinstance(value, dict):
            raise RuntimeError(f"audit line {index + 1} in {path} is not an object")
        events.append(value)
    if len(events) > MAX_AUDIT_EVENTS:
        raise RuntimeError(f"audit event count {len(events)} exceeds {MAX_AUDIT_EVENTS}")
    return events


def resolve_member(repo_root: Path, member: str) -> Path:
    path = Path(member)
    return path if path.is_absolute() else (repo_root / path)


def verify_manifest(manifest_path: Path, repo_root: Path):
    manifest = read_json(manifest_path)
    if manifest.get("phase") != "c2b-native-human-review":
        raise RuntimeError("manifest phase is not c2b-native-human-review")
    if manifest.get("authorizedByRoot") is not True or manifest.get("allowNativeExecution") is not True:
        raise RuntimeError("manifest is not root-authorized for native execution")
    if manifest.get("allowNetworkProviderCalls") is not False:
        raise RuntimeError("manifest must record allowNetworkProviderCalls=false")
    omp = manifest.get("omp")
    if not isinstance(omp, dict) or omp.get("expectedVersion") != "18.18.0":
        raise RuntimeError("manifest OMP identity is malformed")
    omp_path = Path(str(omp.get("path", "")))
    if not omp_path.is_absolute() or not omp_path.is_file():
        raise RuntimeError("manifest OMP path must be an absolute existing file")
    if sha_file(omp_path) != omp.get("sha256"):
        raise RuntimeError("OMP binary does not match the frozen manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeError("manifest has no frozen files")
    verified = {}
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not isinstance(entry.get("sha256"), str):
            raise RuntimeError("manifest file entry is malformed")
        path = resolve_member(repo_root, entry["path"])
        if not path.is_file():
            raise RuntimeError(f"frozen file is missing: {entry['path']}")
        actual = sha_file(path)
        if actual != entry["sha256"]:
            raise RuntimeError(f"frozen file changed: {entry['path']}")
        verified[str(path)] = actual
    return manifest, verified


def process_alive(pid: int, group: bool = False) -> bool:
    try:
        os.kill(-pid if group else pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def child_identity_message() -> bytes:
    identity = {
        "pid": os.getpid(),
        "pgid": os.getpgid(0),
        "sid": os.getsid(0),
    }
    return (json.dumps(identity, separators=(",", ":"), sort_keys=True) + "\n").encode("ascii")


def read_child_identity(read_fd: int, child_pid: int, timeout: float = IDENTITY_TIMEOUT_SECONDS) -> dict:
    deadline = time.monotonic() + timeout
    buffer = bytearray()
    while b"\n" not in buffer:
        if len(buffer) >= IDENTITY_MAX_BYTES:
            raise RuntimeError(f"child identity handshake exceeded {IDENTITY_MAX_BYTES} bytes")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError(f"child identity handshake timed out after {timeout:.1f}s")
        ready, _, _ = select.select([read_fd], [], [], remaining)
        if not ready:
            raise RuntimeError(f"child identity handshake timed out after {timeout:.1f}s")
        chunk = os.read(read_fd, IDENTITY_MAX_BYTES - len(buffer))
        if not chunk:
            raise RuntimeError("child identity handshake closed before reporting an identity")
        buffer.extend(chunk)
    line, _, extra = bytes(buffer).partition(b"\n")
    if extra:
        raise RuntimeError("child identity handshake contained trailing bytes")
    try:
        identity = json.loads(line.decode("ascii"))
    except Exception as error:  # noqa: BLE001
        raise RuntimeError(f"child identity handshake is not valid JSON: {error}") from error
    if not isinstance(identity, dict) or set(identity) != {"pid", "pgid", "sid"}:
        raise RuntimeError(f"child identity handshake is malformed: {identity!r}")
    for key in ("pid", "pgid", "sid"):
        value = identity.get(key)
        if not isinstance(value, int) or isinstance(value, bool):
            raise RuntimeError(f"child identity handshake field {key} is not an integer: {value!r}")
    if identity["pid"] != child_pid:
        raise RuntimeError(f"child identity handshake reports pid {identity['pid']}, expected owned child {child_pid}")
    if identity["pgid"] != child_pid or identity["sid"] != child_pid:
        raise RuntimeError(
            f"child {child_pid} is not its own process-group and session leader: "
            f"pgid={identity['pgid']} sid={identity['sid']}"
        )
    return identity


def confirm_child_identity(child_pid: int, identity: dict) -> int:
    parent_pgid = os.getpgid(0)
    parent_sid = os.getsid(0)
    if identity["pid"] != child_pid:
        raise RuntimeError("child identity does not belong to the owned child")
    if identity["pgid"] == parent_pgid or identity["sid"] == parent_sid:
        raise RuntimeError("child identity reports the harness process group or session")
    try:
        actual_pgid = os.getpgid(child_pid)
        actual_sid = os.getsid(child_pid)
    except ProcessLookupError as error:
        raise RuntimeError(f"owned child {child_pid} disappeared before identity confirmation") from error
    if actual_pgid != identity["pgid"] or actual_sid != identity["sid"]:
        raise RuntimeError(
            f"child identity mismatch: handshake pgid={identity['pgid']} sid={identity['sid']} "
            f"actual pgid={actual_pgid} sid={actual_sid}"
        )
    if actual_pgid != child_pid or actual_sid != child_pid:
        raise RuntimeError(
            f"child {child_pid} actual pgid={actual_pgid} sid={actual_sid} is not the group/session leader"
        )
    if actual_pgid == parent_pgid or actual_sid == parent_sid:
        raise RuntimeError("actual child identity is the harness process group or session")
    return actual_pgid


def child_handshake_and_wait(report_write: int, ack_read: int, timeout: float = IDENTITY_TIMEOUT_SECONDS) -> bool:
    acknowledged = False
    try:
        os.write(report_write, child_identity_message())
        ready, _, _ = select.select([ack_read], [], [], timeout)
        if ready:
            acknowledged = os.read(ack_read, len(CHILD_IDENTITY_ACK)) == CHILD_IDENTITY_ACK
    except BaseException:
        pass
    finally:
        for fd in (report_write, ack_read):
            try:
                os.close(fd)
            except OSError:
                pass
    return acknowledged


def establish_child_identity(report_read: int, ack_write: int, child_pid: int,
                             timeout: float = IDENTITY_TIMEOUT_SECONDS) -> int:
    identity = read_child_identity(report_read, child_pid, timeout)
    pgid = confirm_child_identity(child_pid, identity)
    os.write(ack_write, CHILD_IDENTITY_ACK)
    return pgid


def parse_run_content(text: str):
    match = re.search(r'^run runId="([^"]+)" callId="([^"]+)" taskId="([^"]+)" taskRevision=(\d+)', text, re.MULTILINE)
    if not match:
        return None
    return {"runId": match.group(1), "callId": match.group(2), "taskId": match.group(3), "taskRevision": int(match.group(4))}


def parse_preview_delivery(text: str):
    match = re.search(r"^deliveryId: (\S+)$", text, re.MULTILINE)
    return match.group(1) if match else None


def parse_review_result(text: str):
    if '"state":"committed"' in text or '"state": "committed"' in text or "reviewState: committed" in text:
        return "committed"
    match = re.search(r'reviewState: ([A-Za-z_-]+)', text)
    if match:
        return match.group(1)
    return None


def small_window_paint_problem(paint, columns: int, rows: int):
    if not isinstance(paint, dict):
        return "no completed small-window paint"
    if paint.get("alt") is not True:
        return "the small-window paint is not an alt-screen frame"
    if paint.get("columns") != columns or paint.get("rows") != rows:
        return (
            f"the small-window paint geometry is {paint.get('columns')}x{paint.get('rows')}, "
            f"expected {columns}x{rows}"
        )
    if paint.get("viewportTruncated") is not False:
        return "the small-window paint viewport is truncated"
    viewport = paint.get("plainViewport")
    widths = paint.get("plainWidths")
    if not isinstance(viewport, list) or len(viewport) != rows:
        actual = len(viewport) if isinstance(viewport, list) else "no"
        return f"the small-window paint has {actual} rows, expected {rows} complete rows"
    if not isinstance(widths, list) or len(widths) != rows or any(width != columns for width in widths):
        return f"the small-window paint does not contain {rows} complete {columns}-column rows"
    expected = ["Esc rejects", "Acceptance disabled"]
    padded = [row.ljust(columns) for row in expected]
    actual = [str(row) for row in viewport[:len(expected)]]
    if actual != padded:
        return f"the small-window paint rows are {actual!r}, expected {padded!r}"
    return None


def hybrid_host_problem(observer_events, host_events):
    created = [event for event in observer_events if event.get("type") == "host_entry_created"]
    ready = [event for event in host_events if event.get("type") == "fixture_ready"]
    if len(created) != 1:
        return f"hybrid host created {len(created)} entries, expected exactly one"
    if created[0].get("count") != 1:
        return f"hybrid host entry count is {created[0].get('count')!r}, expected 1"
    if len(ready) != 1:
        return f"hybrid host fixture_ready count is {len(ready)}, expected exactly one"
    return None


def event_sequence(event):
    value = event.get("sequence") if isinstance(event, dict) else None
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def audit_health_problem(events):
    fatal = [
        event for event in events
        if event.get("type") in FATAL_AUDIT_EVENT_TYPES
        or (event.get("type") == "evidence_truncation" and event.get("fatal") is True)
    ]
    if not fatal:
        return None
    return (
        "observer evidence is incomplete: "
        + json.dumps([{k: event.get(k) for k in ("type", "message", "truncationKind", "retained", "omitted")} for event in fatal])
    )


def deadline_result_problem(result):
    if not isinstance(result, dict):
        return "the deadline review result is not an event object"
    content = result.get("content")
    if not isinstance(content, str):
        return "the deadline review result has no JSON content"
    try:
        payload = json.loads(content)
    except Exception as error:  # noqa: BLE001
        return f"the deadline review result content is not JSON: {error}"
    if not isinstance(payload, dict):
        return "the deadline review result content is not a JSON object"
    review = payload.get("review")
    state = review.get("state") if isinstance(review, dict) else review
    if state != "expired":
        return f"the deadline review state is {state!r}, expected 'expired'"
    operation = payload.get("operation")
    if not isinstance(operation, dict) or operation.get("operationCommitted") is not False:
        return "the expired review result does not report operationCommitted=false"
    if payload.get("taskAccepted") is not False:
        return f"the expired review result reports taskAccepted={payload.get('taskAccepted')!r}, expected false"
    paths = payload.get("paths")
    if not isinstance(paths, dict) or paths.get("available") is not False:
        return "the expired review result does not report paths.available=false"
    return None


def deadline_closure_problem(events, start, result):
    health = audit_health_problem(events)
    if health is not None:
        return health
    if not isinstance(start, dict) or not isinstance(result, dict):
        return "the deadline review start/result events are malformed"
    start_sequence = event_sequence(start)
    result_sequence = event_sequence(result)
    if start_sequence is None or result_sequence is None or result_sequence <= start_sequence:
        return "the deadline review start/result sequences are malformed or out of order"
    start_monotonic = start.get("monotonicMs")
    if not isinstance(start_monotonic, (int, float)) or isinstance(start_monotonic, bool):
        return "the deadline review start has no monotonic timestamp"

    mounts = [event for event in events if event.get("type") == "custom_call"]
    if len(mounts) != 1:
        return f"the deadline review mounted {len(mounts)} custom calls, expected exactly one"
    mount = mounts[0]
    mount_sequence = event_sequence(mount)
    mount_id = mount.get("mountId")
    if mount_sequence is None or not (start_sequence < mount_sequence < result_sequence):
        return "the deadline custom mount is not between the request start and result"
    if not isinstance(mount_id, str) or not mount_id:
        return "the deadline custom mount has no mountId"
    if mount.get("mountCount") != 1:
        return f"the deadline custom mount count is {mount.get('mountCount')!r}, expected 1"

    factories = [
        event for event in events
        if event.get("type") == "factory" and event.get("mountId") == mount_id
    ]
    if len(factories) != 1:
        return f"the deadline review created {len(factories)} factories for {mount_id}, expected exactly one"

    closures = [event for event in events if event.get("type") in {"custom_settled", "custom_error"}]
    if len(closures) != 1:
        return f"the deadline review closed {len(closures)} times, expected exactly one"
    closure = closures[0]
    closure_sequence = event_sequence(closure)
    if closure_sequence is None or closure_sequence <= start_sequence:
        return "the deadline custom closure is not after the request start"
    if closure.get("mountId") != mount_id:
        return f"the deadline custom closure mountId is {closure.get('mountId')!r}, expected {mount_id!r}"
    closure_monotonic = closure.get("monotonicMs")
    if not isinstance(closure_monotonic, (int, float)) or isinstance(closure_monotonic, bool):
        return "the deadline custom closure has no monotonic timestamp"
    closure_elapsed = closure_monotonic - start_monotonic
    if closure_elapsed < DEADLINE_MIN_ELAPSED_MS or closure_elapsed > DEADLINE_MAX_ELAPSED_MS:
        return (
            f"the deadline custom closure arrived at {closure_elapsed:.3f}ms, "
            f"outside the production {DEADLINE_MIN_ELAPSED_MS}..{DEADLINE_MAX_ELAPSED_MS}ms bound"
        )

    if closure.get("type") == "custom_error":
        if closure.get("message") != DEADLINE_ABORT_MESSAGE:
            return (
                f"the deadline custom_error message is {closure.get('message')!r}, "
                "expected the actual OMP 18.18 abort closure"
            )
    elif closure.get("result") != "reject":
        return f"the deadline custom_settled result is {closure.get('result')!r}, expected reject"

    if closure.get("settledCount") != 1:
        return f"the deadline custom closure settled {closure.get('settledCount')!r} times, expected 1"
    disposed = closure.get("disposedInvocations")
    if not isinstance(disposed, int) or isinstance(disposed, bool) or disposed < 1:
        return "the deadline custom closure did not dispose its mounted invocation"
    if closure.get("subscriptions") != 0:
        return f"the deadline custom closure left {closure.get('subscriptions')!r} live subscriptions"
    subscription_state = closure.get("subscriptionState")
    if (not isinstance(subscription_state, dict)
            or subscription_state.get("paint") != "removed"
            or subscription_state.get("frame") != "removed"):
        return f"the deadline custom closure subscription cleanup is {subscription_state!r}"
    if closure.get("evidenceTruncations") != []:
        return f"the deadline custom closure reported evidence truncations: {closure.get('evidenceTruncations')!r}"
    if closure.get("harnessFailures") != 0:
        return f"the deadline custom closure reported {closure.get('harnessFailures')!r} harness failures"

    disposes = []
    for event in events:
        if event.get("type") != "dispose" or event.get("mountId") != mount_id:
            continue
        sequence = event_sequence(event)
        if sequence is not None and sequence > start_sequence:
            disposes.append(event)
    if not disposes:
        return "the deadline custom mount has no observed dispose"
    if not any(
        event.get("subscriptions") == 0
        and isinstance(event.get("subscriptionState"), dict)
        and event["subscriptionState"].get("paint") == "removed"
        and event["subscriptionState"].get("frame") == "removed"
        and event.get("harnessFailures") == 0
        for event in disposes
    ):
        return "the deadline custom mount dispose did not clean subscriptions"
    return None


class Driver:
    def __init__(self, plan_path: Path):
        self.plan_path = plan_path
        self.plan = read_json(plan_path)
        self.case = self.plan["case"]
        self.repo_root = Path(self.plan["repoRoot"]).resolve()
        self.manifest_path = Path(self.plan["manifestPath"]).resolve()
        self.runtime_root = Path(self.plan["runtimeRoot"]).resolve()
        self.evidence_root = Path(self.plan["evidenceRoot"]).resolve()
        self.audit_path = Path(self.plan["paths"]["audit"]).resolve()
        self.provider_audit_path = Path(self.plan["paths"]["providerAudit"]).resolve()
        self.host_audit_path = Path(self.plan["paths"].get("hostAudit") or "/nonexistent").resolve()
        self.owner_state_path = Path(self.plan["paths"]["ownerState"]).resolve()
        self.execution_root = Path(self.plan["paths"]["executionRoot"]).resolve()
        self.acceptance_root = Path(self.plan["paths"]["acceptanceRoot"]).resolve()
        self.initial_columns, self.initial_rows = self.plan["initialSize"]
        self.resize = self.plan.get("resize")
        self.timeout_seconds = int(self.plan["timeoutSeconds"])
        self.mode = self.plan["mode"]
        self.revisions = int(self.plan.get("revisions", 1))
        self.prompts = self.plan["prompts"]
        self.expected = self.plan["expected"]
        self.master = None
        self.pid = None
        self.pgid = None
        self.exit_status = None
        self.exit_code = None
        self.exit_signal = None
        self.exit_unavailable = False
        self.started = time.monotonic()
        self.deadline = self.started + self.timeout_seconds
        self.raw_captured = 0
        self.raw_truncated = False
        self.inputs = []
        self.resizes = []
        self.failure = None
        self.cleanup_failure = None
        self.fallback = []
        self.raw_path = self.evidence_root / "pty.bin"
        self.raw_handle = None
        self.run_facts = []
        self.process_identities = []
        self.provider_intents = []
        self.registration_order = []
        self.manifest = None
        self.manifest_verified = {}
        self.manifest_sha_at_start = None

    def note(self, message: str, stage: str, **extra):
        if self.failure is None:
            self.failure = fail(message, stage, **extra)

    def set_winsize(self, columns: int, rows: int, reason: str):
        if self.master is None:
            raise RuntimeError("PTY master is unavailable")
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.resizes.append({
            "reason": reason,
            "columns": columns,
            "rows": rows,
            "ms": round((time.monotonic() - self.started) * 1000),
        })

    def send(self, data: bytes, label: str):
        if self.master is None:
            raise RuntimeError("PTY master is unavailable")
        self.inputs.append({
            "label": label,
            "ms": round((time.monotonic() - self.started) * 1000),
            "hex": data.hex(),
            "text": data.decode("utf-8", "replace") if len(data) <= 4096 else None,
            "source": "automated_terminal_input",
        })
        os.write(self.master, data)

    def send_prompt(self, text: str, label: str):
        self.send(b"\x1b[200~" + text.encode("utf-8") + b"\x1b[201~" + b"\r", label)

    def pump(self):
        if time.monotonic() >= self.deadline:
            raise TimeoutError(f"case {self.case} exceeded {self.timeout_seconds}s")
        ready, _, _ = select.select([self.master], [], [], POLL_SECONDS)
        if ready:
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                self.raw_captured += len(chunk)
                if self.raw_handle is not None and self.raw_captured <= MAX_PTY_BYTES:
                    self.raw_handle.write(chunk)
                    self.raw_handle.flush()
                elif not self.raw_truncated:
                    self.raw_truncated = True
        if self.exit_status is None:
            try:
                got, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                self.exit_unavailable = True
                self.exit_status = "unavailable"
                self.exit_code = None
                self.exit_signal = None
                self.cleanup_failure = self.cleanup_failure or fail(
                    "child exit status is unavailable (ECHILD); no signal was sent to a numerical PID",
                    "cleanup-identity",
                )
                return
            if got:
                self.exit_status = status
                self.exit_code = os.waitstatus_to_exitcode(status)
                self.exit_signal = None if self.exit_code >= 0 else -self.exit_code

    def events(self):
        return read_events(self.audit_path)

    def check_health(self, events):
        problem = audit_health_problem(events)
        if problem is not None:
            raise RuntimeError(problem)

    def provider_events(self):
        return read_events(self.provider_audit_path)

    def host_events(self):
        return read_events(self.host_audit_path) if self.host_audit_path.exists() else []

    def wait(self, predicate, label: str, timeout: float):
        end = time.monotonic() + timeout
        while True:
            self.pump()
            events = self.events()
            self.check_health(events)
            if predicate(events):
                return events
            if self.exit_status is not None:
                raise RuntimeError(f"OMP exited before {label}; exit={self.exit_code}")
            if time.monotonic() >= end:
                raise TimeoutError(f"timed out waiting for {label}")
        # unreachable

    def latest_paint(self, events, columns=None, rows=None, alt=True):
        for event in reversed(events):
            if event.get("type") != "paint":
                continue
            if alt and event.get("alt") is not True:
                continue
            if columns is not None and event.get("columns") != columns:
                continue
            if rows is not None and event.get("rows") != rows:
                continue
            return event
        return None

    def paint_page(self, paint):
        if not paint:
            return None
        for row in paint.get("plainViewport") or []:
            match = re.match(r"^HUMAN REVIEW · page (\d+)/(\d+)\s*$", str(row).rstrip())
            if match:
                return int(match.group(1)), int(match.group(2))
        return None

    def paint_status(self, paint):
        if not paint:
            return None
        for row in paint.get("plainViewport") or []:
            text = str(row).rstrip()
            if text.startswith("pages shown: "):
                return text
        return None

    def paint_decision(self, paint):
        if not paint:
            return None
        for row in paint.get("plainViewport") or []:
            text = str(row).rstrip()
            if text.startswith("Decision: "):
                return text
        return None

    def wait_for_admission(self):
        events = self.wait(lambda values: any(event.get("type") == "session_start" for event in values), "startup admission", 15)
        admission = next(event for event in events if event.get("type") == "session_start")
        if admission.get("mode") != "tui": raise RuntimeError(f"admission mode is {admission.get('mode')}")
        if admission.get("kind") != "main": raise RuntimeError(f"admission agent kind is {admission.get('kind')}")
        if admission.get("hasUI") is not True: raise RuntimeError("admission hasUI is not true")
        if admission.get("stdinIsTTY") is not True or admission.get("stdoutIsTTY") is not True:
            raise RuntimeError("admission did not observe real TTYs")
        expected_model = self.expected["model"]
        if admission.get("model") != expected_model:
            raise RuntimeError(f"admission model mismatch: {admission.get('model')}")
        if admission.get("tools") != self.expected["tools"]:
            raise RuntimeError(f"admission tools mismatch: {admission.get('tools')} expected {self.expected['tools']}")
        registered = admission.get("registeredNames")
        expected_registered = self.expected.get("registeredNames")
        if not isinstance(registered, list) or any(not isinstance(name, str) or not name for name in registered):
            raise RuntimeError(f"admission registration names are malformed: {registered!r}")
        if not isinstance(expected_registered, list) or any(not isinstance(name, str) or not name for name in expected_registered):
            raise RuntimeError(f"expected registration names are malformed: {expected_registered!r}")
        if len(expected_registered) != len(set(expected_registered)):
            raise RuntimeError(f"expected registration names contain duplicates: {expected_registered!r}")
        if (len(registered) != len(expected_registered)
                or len(registered) != len(set(registered))
                or sorted(registered) != sorted(expected_registered)):
            raise RuntimeError(
                f"admission registration set mismatch: actual={registered!r} "
                f"expected_set={sorted(expected_registered)!r} (registration order is not a contract)"
            )
        self.registration_order = list(registered)
        if self.expected.get("defaultInvocation") == 1:
            invocations = [event for event in events if event.get("type") == "default_invocation"]
            if len(invocations) != 1 or invocations[0].get("count") != 1:
                raise RuntimeError("the real default execution entry was not invoked exactly once")
        if any(event.get("type") == "default_factory_error" for event in events):
            raise RuntimeError("the real default execution factory reported an error")
        if any(event.get("type") == "harness_error" for event in events):
            raise RuntimeError(f"observer harness error: {[e.get('message') for e in events if e.get('type') == 'harness_error']}")
        delivery = [event for event in events if event.get("type") == "tool_registered" and event.get("name") == "agent_deliver"]
        if self.expected.get("requestReview"):
            if len(delivery) != 1:
                raise RuntimeError("agent_deliver was not registered exactly once")
            schema = delivery[0].get("parameters") or {}
            enum = (((schema.get("properties") or {}).get("action") or {}).get("enum") or [])
            if "request_review" not in enum:
                raise RuntimeError(f"agent_deliver schema does not expose request_review: {enum}")
            if delivery[0].get("descriptionIncludesRequestReview") is not True:
                raise RuntimeError("agent_deliver description does not mention request_review")
        else:
            if delivery:
                enum = ((((delivery[0].get("parameters") or {}).get("properties") or {}).get("action") or {}).get("enum") or [])
                if "request_review" in enum:
                    raise RuntimeError("agent_deliver unexpectedly exposes request_review")
        if self.expected.get("hybridHost"):
            problem = hybrid_host_problem(events, self.host_events())
            if problem is not None:
                raise RuntimeError(problem)
            if self.expected.get("defaultInvocation") == 0:
                if any(event.get("type") == "default_invocation" for event in events):
                    raise RuntimeError("hybrid case loaded the default execution entry")
        provider = self.provider_events()
        if any(event.get("type") in {"provider_turn", "forbidden_model_request"} for event in provider):
            raise RuntimeError("a provider request occurred before business input")
        return admission

    def wait_for_first_turn(self, timeout=20):
        return self.wait(
            lambda values: any(event.get("type") == "provider_turn" and event.get("step") == 0 for event in self.provider_events()),
            "first provider turn",
            timeout,
        )

    def wait_for_agent_end(self, timeout=25, after_sequence=0):
        return self.wait(
            lambda values: any(
                event.get("type") == "agent_end" and int(event.get("sequence", 0)) > after_sequence
                for event in values
            ),
            "agent_end",
            timeout,
        )

    def request_review_start(self):
        events = self.events()
        matches = [
            event for event in events
            if event.get("type") == "tool_call_start"
            and event.get("toolName") == "agent_deliver"
            and (event.get("params") or {}).get("action") == "request_review"
        ]
        if len(matches) != 1:
            raise RuntimeError(f"expected exactly one request_review call start, saw {len(matches)}")
        return matches[0]

    def wait_for_review_mount(self, timeout=35):
        events = self.wait(
            lambda values: any(event.get("type") == "factory" for event in values)
            and self.latest_paint(values, self.initial_columns, self.initial_rows) is not None
            and bool((self.latest_paint(values, self.initial_columns, self.initial_rows) or {}).get("plainViewport")),
            "review mount and completed paint",
            timeout,
        )
        paint = self.latest_paint(events, self.initial_columns, self.initial_rows)
        if paint is None:
            raise RuntimeError("no completed fullscreen paint at the initial geometry")
        return paint

    def wait_for_frame(self, columns, rows, predicate, label, timeout=15):
        events = self.wait(
            lambda values: predicate(self.latest_paint(values, columns, rows)),
            label,
            timeout,
        )
        return self.latest_paint(events, columns, rows)

    def traverse_pages(self, columns, rows):
        paint = self.latest_paint(self.events(), columns, rows)
        page = self.paint_page(paint)
        if page is None:
            raise RuntimeError("the supported review frame has no public page header")
        current, total = page
        if current != 1:
            raise RuntimeError(f"review did not start at page 1: {current}/{total}")
        while current < total:
            self.send(b"\x1b[B", f"page-down-{current}")
            target = current + 1
            paint = self.wait_for_frame(
                columns,
                rows,
                lambda value: value is not None and self.paint_page(value) == (target, total),
                f"page {target}/{total} paint",
            )
            current = target
            events = self.events()
            if any(event.get("type") == "harness_error" for event in events):
                raise RuntimeError("observer harness error during page traversal")
        ready = self.wait_for_frame(
            columns,
            rows,
            lambda value: value is not None and "Accept ready" in (self.paint_status(value) or ""),
            "Accept ready after complete traversal",
            10,
        )
        if not ready:
            raise RuntimeError("the completed traversal did not produce an Accept-ready frame")
        return total

    def select_accept_and_confirm(self, columns, rows):
        self.send(b"\x1b[B", "select-accept")
        paint = self.wait_for_frame(
            columns,
            rows,
            lambda value: value is not None and "● Accept reviewed files" in (self.paint_decision(value) or ""),
            "explicit Accept selection",
        )
        decision = self.paint_decision(paint) or ""
        if "● Accept reviewed files" not in decision:
            raise RuntimeError("the explicit Accept selection was not painted")
        if "Accept ready" not in (self.paint_status(paint) or ""):
            raise RuntimeError("the explicit Accept selection was not Accept-ready")
        self.send(b"\r", "confirm-accept-enter")

    def wait_for_review_result(self, timeout=20):
        start = self.request_review_start()
        tool_call_id = start.get("toolCallId")
        events = self.wait(
            lambda values: any(
                event.get("type") == "tool_call_end"
                and event.get("toolCallId") == tool_call_id
                for event in values
            ),
            "request_review tool result",
            timeout,
        )
        return next(
            event for event in events
            if event.get("type") == "tool_call_end" and event.get("toolCallId") == tool_call_id
        )

    def wait_for_custom_settle(self, timeout=20):
        events = self.wait(
            lambda values: any(event.get("type") in {"custom_settled", "custom_error"} for event in values),
            "custom settlement",
            timeout,
        )
        return next(event for event in events if event.get("type") in {"custom_settled", "custom_error"})

    def finish_normally(self):
        if self.exit_status is not None:
            raise RuntimeError(f"OMP exited before the diagnostic commands; exit={self.exit_code}")
        self.send(b"/review-native-echo\r", "editor-recovery-command")
        self.wait(lambda values: any(event.get("type") == "editor_recovered" for event in values), "editor recovery command", 10)
        self.send(b"/review-native-finish\r", "shutdown-command")
        self.wait(lambda values: any(event.get("type") == "session_shutdown" for event in values), "session_shutdown", 10)
        end = time.monotonic() + 15
        while self.exit_status is None and time.monotonic() < end:
            self.pump()
        if self.exit_status is None:
            raise TimeoutError("OMP did not exit after the shutdown command")

    def admission_case(self):
        self.wait_for_admission()
        time.sleep(0.2)
        self.finish_normally()

    def business_case(self):
        self.wait_for_admission()
        self.send_prompt(self.prompts["task"], "task-prompt-paste-enter")
        self.wait_for_first_turn()
        if self.revisions >= 2:
            self.wait_for_agent_end(30)
            time.sleep(0.15)
            self.send_prompt(self.prompts["revision"], "revision-prompt-paste-enter")
            self.wait(
                lambda values: any(event.get("type") == "provider_turn" and event.get("step") == 2 for event in self.provider_events()),
                "revision provider turn",
                20,
            )
        initial = self.wait_for_review_mount()
        if self.case == "resize-reject":
            problem = small_window_paint_problem(initial, self.initial_columns, self.initial_rows)
            if problem is not None:
                raise RuntimeError(problem)
            if self.paint_page(initial) is not None:
                raise RuntimeError("the small-window frame exposed evidence pages")
            self.send(b"\x1b[B", "small-window-down-ignored")
            time.sleep(0.2)
            if self.resize is None:
                raise RuntimeError("resize case has no target geometry")
            columns, rows = self.resize
            self.set_winsize(columns, rows, "resize-to-readable")
            os.kill(self.pid, signal.SIGWINCH)
            resized = self.wait_for_frame(
                columns,
                rows,
                lambda value: value is not None and self.paint_page(value) is not None and self.paint_page(value)[0] == 1,
                "resized page 1 paint",
                20,
            )
            page = self.paint_page(resized)
            if page is None:
                raise RuntimeError("resized review did not expose a page header")
            self.traverse_pages(columns, rows)
            self.send(b"\x1b", "resize-reject-escape")
            self.wait_for_custom_settle()
            result = self.wait_for_review_result()
            self.wait_for_agent_end(30, int(result.get("sequence", 0)))
            self.finish_normally()
            return
        columns, rows = self.initial_columns, self.initial_rows
        if self.case == "initial-enter":
            self.send(b"\r", "initial-enter")
            settle = self.wait_for_custom_settle()
            if settle.get("type") != "custom_settled" or settle.get("result") != "reject":
                raise RuntimeError(f"initial Enter did not close with a rejection: {settle}")
            result = self.wait_for_review_result()
            if "taskAccepted: true" in str(result.get("content")) or '"state":"committed"' in str(result.get("content")):
                raise RuntimeError("initial Enter produced an accepted result")
            self.wait_for_agent_end(30, int(result.get("sequence", 0)))
            self.finish_normally()
            return
        if self.case == "escape":
            self.send(b"\x1b", "escape")
            settle = self.wait_for_custom_settle()
            if settle.get("type") != "custom_settled" or settle.get("result") != "reject":
                raise RuntimeError(f"Escape did not close with a rejection: {settle}")
            result = self.wait_for_review_result()
            self.wait_for_agent_end(30, int(result.get("sequence", 0)))
            self.finish_normally()
            return
        if self.case == "deadline-expiry":
            start = self.request_review_start()
            result = self.wait_for_review_result(345)
            self.check_health(self.events())
            end_monotonic = result.get("monotonicMs")
            start_monotonic = start.get("monotonicMs")
            if not isinstance(end_monotonic, (int, float)) or not isinstance(start_monotonic, (int, float)):
                raise RuntimeError("request_review timing facts are missing")
            elapsed = end_monotonic - start_monotonic
            if elapsed < DEADLINE_MIN_ELAPSED_MS or elapsed > DEADLINE_MAX_ELAPSED_MS:
                raise RuntimeError(
                    f"actual review deadline elapsed {elapsed}ms, outside the production "
                    f"{DEADLINE_MIN_ELAPSED_MS}..{DEADLINE_MAX_ELAPSED_MS}ms bound"
                )
            result_problem = deadline_result_problem(result)
            if result_problem is not None:
                raise RuntimeError(result_problem)
            self.wait_for_agent_end(30, int(result.get("sequence", 0)))
            before = len(self.provider_events())
            closure = self.wait_for_custom_settle()
            events = self.events()
            self.check_health(events)
            closure_problem = deadline_closure_problem(events, start, result)
            if closure_problem is not None:
                raise RuntimeError(closure_problem)
            settle_sequence = int(closure["sequence"])
            self.send(b"\x1b[B", "late-down-after-expiry")
            self.send(b"\r", "late-enter-after-expiry")
            time.sleep(1.5)
            self.pump()
            after = len(self.provider_events())
            if after != before:
                raise RuntimeError("late keys after expiry caused a new provider request")
            late_events = self.events()
            self.check_health(late_events)
            closure_problem = deadline_closure_problem(late_events, start, result)
            if closure_problem is not None:
                raise RuntimeError(closure_problem)
            if any(
                event.get("type") == "factory" and int(event.get("sequence", 0)) > settle_sequence
                for event in late_events
            ):
                raise RuntimeError("late keys after expiry reopened a custom review")
            if self.acceptance_root.exists() and any(self.acceptance_root.iterdir()):
                raise RuntimeError("late keys after expiry installed an acceptance record")
            self.finish_normally()
            return
        if self.case in {"positive-no-contract", "positive-partial-hybrid"}:
            total = self.traverse_pages(columns, rows)
            self.select_accept_and_confirm(columns, rows)
            settle = self.wait_for_custom_settle()
            if settle.get("type") != "custom_settled" or settle.get("result") != "approve":
                raise RuntimeError(f"explicit accept did not return approve: {settle}")
            result = self.wait_for_review_result()
            content = str(result.get("content", ""))
            if "taskAccepted: true" not in content and '"state":"committed"' not in content and "committed" not in content.lower():
                raise RuntimeError("the review result did not report a committed acceptance")
            self.wait_for_agent_end(30, int(result.get("sequence", 0)))
            self.finish_normally()
            return
        raise RuntimeError(f"unsupported business case {self.case}")

    def start(self):
        self.evidence_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.manifest_sha_at_start = sha_file(self.manifest_path)
        self.manifest, self.manifest_verified = verify_manifest(self.manifest_path, self.repo_root)
        if self.case not in (self.manifest.get("cases") or []):
            raise RuntimeError(f"case {self.case} is not listed in the frozen manifest")
        if not self.plan["env"].get("REVIEW_NATIVE_AUDIT"):
            raise RuntimeError("plan has no observer audit path")
        version = subprocess.run(
            [self.plan["omp"]["path"], "--version"],
            cwd=self.plan["cwd"],
            env=self.plan["env"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        (self.evidence_root / "version.txt").write_text(version.stdout + version.stderr, encoding="utf-8")
        if version.returncode != 0 or not re.search(r"(?<![\d.])18\.18\.0(?![\d.])", version.stdout):
            raise RuntimeError("OMP version admission failed")
        self.raw_handle = self.raw_path.open("wb")
        report_read, report_write = os.pipe()
        ack_read, ack_write = os.pipe()
        try:
            pid, master = pty.fork()
        except BaseException:
            for fd in (report_read, report_write, ack_read, ack_write):
                os.close(fd)
            raise
        self.pid, self.master = pid, master
        if self.pid == 0:
            os.close(report_read)
            os.close(ack_write)
            if child_handshake_and_wait(report_write, ack_read):
                try:
                    os.chdir(self.plan["cwd"])
                    os.execve(self.plan["omp"]["path"], self.plan["argv"], self.plan["env"])
                except BaseException:
                    pass
            os._exit(127)
        os.close(report_write)
        os.close(ack_read)
        try:
            self.set_winsize(self.initial_columns, self.initial_rows, "initial")
            self.pgid = establish_child_identity(report_read, ack_write, self.pid)
        finally:
            os.close(report_read)
            os.close(ack_write)
        if self.mode == "admission":
            self.admission_case()
        else:
            self.business_case()

    def collect_run_evidence(self):
        events = self.events()
        starts = [
            event for event in events
            if event.get("type") == "execute_call_start" and event.get("toolName") == "agent_execute"
        ]
        self.provider_intents = []
        for event in self.provider_events():
            if event.get("type") != "provider_turn":
                continue
            call = event.get("call")
            if isinstance(call, dict) and call.get("type") == "toolCall" and call.get("name") == "agent_execute":
                self.provider_intents.append({
                    "providerCallId": call.get("id"),
                    "arguments": call.get("arguments") if isinstance(call.get("arguments"), dict) else {},
                    "step": event.get("step"),
                })
        start_map = {}
        for start in starts:
            tool_call_id = start.get("toolCallId")
            if not isinstance(tool_call_id, str) or not tool_call_id:
                raise RuntimeError("an actual agent_execute start has no toolCallId")
            if tool_call_id in start_map:
                raise RuntimeError(f"duplicate actual agent_execute start toolCallId {tool_call_id}")
            if not isinstance(start.get("input"), dict):
                raise RuntimeError(f"actual agent_execute start {tool_call_id} has no observed input")
            start_map[tool_call_id] = start
        ends = [event for event in events if event.get("type") == "execute_result_observed"]
        end_map = {}
        for end in ends:
            tool_call_id = end.get("toolCallId")
            if not isinstance(tool_call_id, str) or not tool_call_id:
                raise RuntimeError("an agent_execute result has no toolCallId")
            if tool_call_id in end_map:
                raise RuntimeError(f"duplicate agent_execute result toolCallId {tool_call_id}")
            end_map[tool_call_id] = end
        observed = []
        for start in starts:
            tool_call_id = start["toolCallId"]
            end = end_map.get(tool_call_id)
            if end is None:
                raise RuntimeError(f"agent_execute start {tool_call_id} has no matching terminal result")
            arguments = start["input"]
            actual_input = end.get("input") if isinstance(end.get("input"), dict) else {}
            for key in ("action", "runtime", "source", "inputIds", "expectedTaskId", "expectedTaskRevision"):
                if arguments.get(key) != actual_input.get(key):
                    raise RuntimeError(f"agent_execute {tool_call_id} actual start input {key} does not match terminal execute input")
            parsed = parse_run_content(str(end.get("content", "")))
            if parsed is None or end.get("isError") is True:
                raise RuntimeError(f"agent_execute {tool_call_id} has no parseable successful terminal run identity; invocation remains unknown")
            observed.append({
                "toolCallId": tool_call_id,
                "runId": parsed["runId"],
                "callId": parsed["callId"],
                "taskId": parsed["taskId"],
                "taskRevision": parsed["taskRevision"],
                "contentSha256": end.get("contentSha256"),
            })
        for end in ends:
            if end.get("toolCallId") not in start_map:
                raise RuntimeError(f"agent_execute result {end.get('toolCallId')} has no observed start")
        if len({row["runId"] for row in observed}) != len(observed):
            raise RuntimeError("duplicate observed runId in agent_execute results")
        records = {}
        if self.execution_root.exists():
            for directory in sorted(self.execution_root.iterdir()):
                if not directory.is_dir() or not directory.name.startswith("run-"):
                    continue
                record_path = directory / "record.json"
                if not record_path.is_file():
                    raise RuntimeError(f"{directory.name} has no record.json")
                record = read_json(record_path)
                run_id = record.get("runId")
                if not isinstance(run_id, str) or not run_id:
                    raise RuntimeError(f"{directory.name} record has no runId")
                if run_id in records:
                    raise RuntimeError(f"duplicate run record for {run_id}")
                records[run_id] = {"record": record, "directory": directory}
        audit_events = []
        audit_path = Path(self.plan["paths"]["executionAudit"]).resolve()
        if audit_path.exists():
            audit_events = read_events(audit_path)
        by_run = {}
        for event in audit_events:
            run_id = event.get("runId")
            if isinstance(run_id, str):
                by_run.setdefault(run_id, []).append(event)
        if self.mode != "admission" and len(observed) != 1:
            raise RuntimeError(f"business case must observe exactly one successful actual agent_execute run, saw {len(observed)}")
        if self.mode == "admission" and (starts or ends or observed or records or by_run):
            raise RuntimeError("admission case observed execution activity")
        for row in observed:
            found = records.get(row["runId"])
            if found is None:
                raise RuntimeError(f"observed run {row['runId']} has no run record")
            record = found["record"]
            if record.get("callId") != row["callId"]:
                raise RuntimeError(f"observed callId does not match record for {row['runId']}")
            if record.get("taskId") != row["taskId"] or record.get("taskRevision") != row["taskRevision"]:
                raise RuntimeError(f"observed task identity does not match record for {row['runId']}")
            events_for_run = by_run.get(row["runId"], [])
            if not events_for_run:
                raise RuntimeError(f"observed run {row['runId']} has no execution audit event")
            if not any(event.get("type") in SPAWN_EVIDENCE_EVENTS for event in events_for_run):
                raise RuntimeError(f"observed run {row['runId']} has no spawn/settlement audit evidence")
            process = record.get("process")
            if not isinstance(process, dict):
                raise RuntimeError(f"observed run {row['runId']} has no process facts")
            if record.get("phase") == "not_dispatched" or process.get("spawned") is not True:
                raise RuntimeError(f"observed run {row['runId']} contradicts a no-spawn record")
            pid = process.get("pid")
            pgid = process.get("pgid")
            if not isinstance(pid, int) or pid <= 1 or not isinstance(pgid, int) or pgid != pid:
                raise RuntimeError(f"observed run {row['runId']} has malformed script identity")
            watchdog = process.get("watchdog") or record.get("watchdog")
            if not isinstance(watchdog, dict) or watchdog.get("armed") is not True:
                raise RuntimeError(f"observed run {row['runId']} has no armed watchdog identity")
            watchdog_pid = watchdog.get("watchdogPid")
            if not isinstance(watchdog_pid, int) or watchdog_pid <= 1 or watchdog_pid in {pid, pgid}:
                raise RuntimeError(f"observed run {row['runId']} has malformed watchdog identity")
            if process.get("groupGone") is not True:
                raise RuntimeError(f"observed run {row['runId']} has no group-gone evidence")
            if watchdog.get("pidGone") is not True or watchdog.get("watchdogTerminated") is not True:
                raise RuntimeError(f"observed run {row['runId']} has no watchdog exit evidence")
            if process.get("exitCode") is None:
                raise RuntimeError(f"observed run {row['runId']} has no script exit code")
            if process_alive(pid, True):
                raise RuntimeError(f"observed run script group {pid} is still alive")
            if process_alive(pid, False):
                raise RuntimeError(f"observed run script PID {pid} is still alive")
            if process_alive(watchdog_pid, False):
                raise RuntimeError(f"observed run watchdog {watchdog_pid} is still alive")
            self.process_identities.append({
                "runId": row["runId"],
                "pid": pid,
                "pgid": pgid,
                "watchdogPid": watchdog_pid,
                "pidGone": not process_alive(pid, False),
                "groupGone": not process_alive(pid, True),
                "watchdogGone": not process_alive(watchdog_pid, False),
                "recordGroupGone": process.get("groupGone"),
                "recordWatchdogTerminated": watchdog.get("watchdogTerminated"),
            })
            self.run_facts.append({
                "runId": row["runId"],
                "callId": row["callId"],
                "toolCallId": row["toolCallId"],
                "recordPath": str(found["directory"] / "record.json"),
                "phase": record.get("phase"),
                "auditTypes": [event.get("type") for event in events_for_run],
                "process": process,
                "watchdog": watchdog,
            })
        for run_id in records:
            if not any(row["runId"] == run_id for row in observed):
                raise RuntimeError(f"run record {run_id} has no observed agent_execute call")
        for run_id, events_for_run in by_run.items():
            if run_id in records:
                continue
            types = {event.get("type") for event in events_for_run}
            if not (types & PROVEN_NO_SPAWN_EVENTS) or (types & SPAWN_EVIDENCE_EVENTS):
                raise RuntimeError(f"execution audit references {run_id} without retained run evidence")

    def copy_tree(self, source: Path, destination_name: str):
        rows = []
        if not source.exists():
            return rows
        destination = self.evidence_root / destination_name
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True, mode=0o700)
        count = 0
        for root, dirs, files in os.walk(source):
            dirs.sort()
            for name in sorted(files):
                full = Path(root) / name
                info = full.lstat()
                if info.st_size > MAX_TREE_BYTES:
                    raise RuntimeError(f"evidence file too large: {full}")
                if full.is_symlink():
                    raise RuntimeError(f"evidence tree refuses symlink: {full}")
                count += 1
                if count > MAX_TREE_FILES:
                    raise RuntimeError("evidence tree file bound exceeded")
                relative = full.relative_to(source)
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                data = full.read_bytes()
                target.write_bytes(data)
                rows.append({
                    "relativePath": str(relative),
                    "bytes": len(data),
                    "sha256": sha_bytes(data),
                    "nlink": info.st_nlink,
                    "mode": info.st_mode & 0o777,
                })
        return rows

    def write_result(self, extra_failure=None):
        failure = extra_failure or self.failure
        try:
            self.check_health(self.events())
        except Exception as error:  # noqa: BLE001
            failure = failure or fail(f"observer evidence health failed: {error}", "evidence-health")
        if self.cleanup_failure is not None:
            failure = self.cleanup_failure if failure is None else {
                "type": "CleanupFailure",
                "stage": "cleanup",
                "message": "; ".join(filter(None, [str(failure.get("message")), str(self.cleanup_failure.get("message"))])),
                "reviewPreserved": True,
                "reviewFailure": failure,
            }
        copies = {}
        evidence_omissions = []
        for source, name in [
            (self.audit_path, "observer-audit.jsonl"),
            (self.provider_audit_path, "provider-audit.jsonl"),
            (self.host_audit_path if self.host_audit_path.exists() else None, "host-audit.jsonl"),
            (Path(self.plan["paths"]["b1Audit"]).resolve(), "b1-audit.jsonl"),
            (Path(self.plan["paths"]["executionAudit"]).resolve(), "execution-audit.jsonl"),
            (self.owner_state_path, "owner-state.json"),
        ]:
            if source is None or not Path(source).is_file():
                continue
            data = Path(source).read_bytes()
            if len(data) > MAX_LOG_BYTES:
                omission = {
                    "name": name,
                    "source": str(source),
                    "bytes": len(data),
                    "maxBytes": MAX_LOG_BYTES,
                    "reason": "evidence log exceeds the bounded copy limit; the original runtime log is retained",
                }
                evidence_omissions.append(omission)
                failure = failure or fail(
                    f"evidence log {source} exceeds the bounded copy limit "
                    f"({len(data)} > {MAX_LOG_BYTES} bytes); the original runtime log is retained",
                    "evidence",
                    omission=omission,
                )
                continue
            target = self.evidence_root / name
            target.write_bytes(data)
            copies[name] = {"bytes": len(data), "sha256": sha_bytes(data)}
        trees = {}
        try:
            trees["delivery"] = self.copy_tree(Path(self.plan["paths"]["deliveryRoot"]).resolve(), "delivery")
            trees["acceptance"] = self.copy_tree(self.acceptance_root, "acceptance")
            trees["execution"] = self.copy_tree(self.execution_root, "execution")
            input_root = self.plan["paths"].get("inputRoot")
            if input_root:
                trees["inputs"] = self.copy_tree(Path(input_root).resolve(), "inputs")
        except Exception as error:  # noqa: BLE001
            failure = failure or fail(f"evidence tree copy failed: {error}", "evidence")
        try:
            self.collect_run_evidence()
        except Exception as error:  # noqa: BLE001
            failure = failure or fail(f"run identity reconciliation failed: {error}", "cleanup-identity")
            self.cleanup_failure = self.cleanup_failure or fail(f"run identity reconciliation failed: {error}", "cleanup-identity")
        result = {
            "schemaVersion": 1,
            "case": self.case,
            "provenance": "automated_terminal_input / engineering / no-human",
            "status": "pass" if failure is None else "fail",
            "failure": failure,
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "durationMs": round((time.monotonic() - self.started) * 1000),
            "caseTimeoutSeconds": self.timeout_seconds,
            "mode": self.mode,
            "revisions": self.revisions,
            "inputs": self.inputs,
            "resizes": self.resizes,
            "rawPty": {
                "path": str(self.raw_path),
                "bytesCaptured": self.raw_captured,
                "truncated": self.raw_truncated,
                "maxBytes": MAX_PTY_BYTES,
            },
            "exit": {
                "pid": self.pid,
                "pgid": self.pgid,
                "code": self.exit_code,
                "signal": self.exit_signal,
                "status": None if self.exit_unavailable else self.exit_status,
                "statusUnavailable": self.exit_unavailable,
                "groupGone": self.pgid is not None and not process_alive(self.pgid, True),
                "fallback": self.fallback,
            },
            "roots": {
                "runtimeRoot": str(self.runtime_root),
                "deliveryRoot": str(Path(self.plan["paths"]["deliveryRoot"]).resolve()),
                "acceptanceRoot": str(self.acceptance_root),
                "executionRoot": str(self.execution_root),
                "inputRoot": str(Path(self.plan["paths"].get("inputRoot") or "").resolve()) if self.plan["paths"].get("inputRoot") else None,
                "evidenceRoot": str(self.evidence_root),
            },
            "manifest": {
                "path": str(self.manifest_path),
                "sha256": sha_file(self.manifest_path),
                "omp": (self.manifest or {}).get("omp"),
                "filesVerified": len(self.manifest_verified),
            },
            "runFacts": self.run_facts,
            "processIdentities": self.process_identities,
            "providerIntents": self.provider_intents,
            "registrationOrder": self.registration_order,
            "cleanupFailure": self.cleanup_failure,
            "copies": copies,
            "evidenceOmissions": evidence_omissions,
            "trees": trees,
        }
        (self.evidence_root / "driver-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return result

    def cleanup_after_failure(self):
        if self.exit_unavailable:
            self.cleanup_failure = self.cleanup_failure or fail(
                "child ownership/exit status was lost; the harness did not signal a numerical PID",
                "cleanup-identity",
            )
            return
        if self.exit_status is not None:
            return
        self.fallback.append("OMP did not exit normally; the harness signalled only its owned OMP group")
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if self.exit_status is not None:
                break
            try:
                if self.pgid == self.pid:
                    os.killpg(self.pgid, sig)
                else:
                    os.kill(self.pid, sig)
            except ProcessLookupError:
                pass
            end = time.monotonic() + 1.0
            while time.monotonic() < end:
                try:
                    got, status = os.waitpid(self.pid, os.WNOHANG)
                except ChildProcessError:
                    self.exit_unavailable = True
                    self.exit_status = "unavailable"
                    self.exit_code = None
                    self.exit_signal = None
                    self.cleanup_failure = self.cleanup_failure or fail(
                        "child exit status became unavailable during cleanup; no further signal was sent",
                        "cleanup-identity",
                    )
                    break
                if got:
                    self.exit_status = status
                    self.exit_code = os.waitstatus_to_exitcode(status)
                    self.exit_signal = None if self.exit_code >= 0 else -self.exit_code
                    break
                time.sleep(0.02)
            if self.exit_unavailable:
                break
        if self.exit_status is None:
            self.failure = self.failure or fail("OMP did not exit after SIGKILL", "cleanup")

    def run(self):
        started_pid = None
        try:
            try:
                self.start()
            except BaseException as error:  # noqa: BLE001
                self.note(str(error), "runtime", exception=type(error).__name__)
        finally:
            started_pid = self.pid
            if started_pid is not None:
                self.cleanup_after_failure()
            if self.master is not None:
                try:
                    os.close(self.master)
                except OSError:
                    pass
            if self.raw_handle is not None:
                self.raw_handle.close()
        try:
            stable, _ = verify_manifest(self.manifest_path, self.repo_root)
            if self.manifest is not None and stable.get("omp", {}).get("sha256") != self.manifest.get("omp", {}).get("sha256"):
                self.failure = self.failure or fail("OMP binary changed during the case", "source-stability")
            if self.manifest_sha_at_start is not None and sha_file(self.manifest_path) != self.manifest_sha_at_start:
                self.failure = self.failure or fail("the frozen manifest changed during the case", "source-stability")
        except Exception as error:  # noqa: BLE001
            self.failure = self.failure or fail(f"manifest verification after the case failed: {error}", "source-stability")
        if self.exit_unavailable:
            self.cleanup_failure = self.cleanup_failure or fail(
                "OMP exit status is unavailable; runtime root must be retained",
                "cleanup-identity",
            )
        elif self.exit_status is not None:
            if self.exit_code != 0:
                self.failure = self.failure or fail(f"OMP exited with code {self.exit_code} signal {self.exit_signal}", "exit")
            if self.pgid is not None and process_alive(self.pgid, True):
                self.cleanup_failure = self.cleanup_failure or fail("owned OMP process group is still alive", "cleanup")
        return self.write_result()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    args = parser.parse_args()
    driver = Driver(Path(args.plan).resolve())
    result = driver.run()
    print(json.dumps({
        "status": result["status"],
        "case": result["case"],
        "failure": result["failure"],
        "result": str(driver.evidence_root / "driver-result.json"),
    }))
    if result["status"] != "pass":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
