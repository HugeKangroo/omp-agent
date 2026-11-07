#!/usr/bin/env python3
"""Trusted launcher with an independent parent-death/deadline watchdog.

The TypeScript supervisor starts this wrapper with detach/setsid so the
wrapper is a session and process-group leader. The wrapper verifies that its
actual parent is the host-supplied supervisor PID, lowers limits, and forks a
trusted watchdog into its own session *before* any untrusted interpreter is
executed.

The watchdog registers kqueue NOTE_EXIT for the known supervisor PID and the
known script PID (this wrapper, whose PID survives exec), then reports an
armed record on the event control descriptor. The wrapper does not exec
sandbox-exec until the supervisor has validated that record and acknowledged
it on the acknowledgement descriptor. A missing, malformed, late or failed
handshake exits without executing untrusted code; there is no fallback.

Only the launcher/watchdog may write the event descriptor. Untrusted code
inherits neither control descriptor: both are closed immediately before exec
(and marked close-on-exec as a second barrier). The watchdog closes stdio and
every other descriptor, clears its environment to a tiny allow-list, and does
not depend on the control stream to decide to kill: if the supervisor dies or
the descriptor breaks, kqueue and the shared deadline still drive TERM/KILL.
"""

import errno
import fcntl
import hashlib
import json
import os
import resource
import select
import signal
import stat
import sys
import time

CONTROL_PROTOCOL = "g2a2-watchdog-v1"
ENV_ALLOW = {
    "LANG",
    "LC_ALL",
    "OMP_EXEC_RUNTIME",
    "OMP_INPUTS_MANIFEST",
    "OMP_WORK_DIR",
    "PATH",
    "TMPDIR",
}
WATCHDOG_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
EXIT_LAUNCH_FAILURE = 111
EXIT_WATCHDOG_FAILURE = 112
EXIT_WATCHDOG_UNCONFIRMED = 113
ACK_TIMEOUT_SECONDS = 5.0
ARM_TIMEOUT_SECONDS = 5.0
MAX_CONTROL_LINE = 4096
MAX_ACK_LINE = 1024


def fail(message):
    try:
        os.write(2, ("isolated-exec: " + message + "\n").encode("utf-8", "replace"))
    finally:
        os._exit(EXIT_LAUNCH_FAILURE)


def absolute_regular_file(value):
    if not os.path.isabs(value):
        fail("expected an absolute path")
    try:
        info = os.stat(value)
    except OSError as error:
        fail("cannot stat trusted input: %s" % error)
    if not stat.S_ISREG(info.st_mode):
        fail("trusted input is not a regular file")
    return value


def sha256_file(value):
    digest = hashlib.sha256()
    with open(value, "rb") as handle:
        while True:
            chunk = handle.read(65536)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def set_cloexec(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFD)
    fcntl.fcntl(fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)


def is_open(fd):
    try:
        fcntl.fcntl(fd, fcntl.F_GETFD)
        return True
    except OSError as error:
        if error.errno == errno.EBADF:
            return False
        raise


def descriptors_outside(keep):
    """Return actually-open descriptors outside `keep`.

    /dev/fd may list an enumeration-time descriptor that is already closed by
    the time it is inspected, so each candidate is checked with F_GETFD and
    EBADF entries are ignored. Enumeration failure raises; callers fail closed.
    """
    keep = set(keep)
    names = os.listdir("/dev/fd")
    result = []
    for name in names:
        if not name.isdigit():
            continue
        fd = int(name)
        if fd in keep:
            continue
        if is_open(fd):
            result.append(fd)
    return sorted(result)


def close_fds_except(keep):
    """Close every actual descriptor outside `keep`, including high numbers.

    Enumeration through /dev/fd observes the real table rather than assuming a
    low soft limit. Each candidate is checked before closing so transient
    directory entries are ignored, and a verification pass reports leftovers.
    """
    keep = set(keep)
    for _attempt in range(2):
        for fd in descriptors_outside(keep):
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    pass
    leftover = descriptors_outside(keep)
    if leftover:
        raise OSError(errno.EBADF, "descriptors remain open: %s" % leftover)


def remember_event(events, event, **fields):
    """Keep a small bounded audit trail in memory; I/O happens after cleanup."""
    if len(events) >= 16:
        return
    record = {"event": event, "at": round(time.monotonic(), 6)}
    for key, value in fields.items():
        if isinstance(value, str) and len(value) > 200:
            value = value[:200]
        record[key] = value
    events.append(record)


def flush_audit(log_fd, events):
    """Best-effort flush after required kill/escalation work is complete."""
    if log_fd is None:
        return
    for record in events:
        try:
            line = (json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8", "replace")
            if len(line) <= MAX_CONTROL_LINE:
                os.write(log_fd, line)
        except BaseException:
            # A blocked/failed evidence write cannot retroactively undo cleanup.
            return


def safe_control_write(control_fd, payload):
    """Write one bounded JSON line to a non-blocking fd. Never raises/blocks."""
    try:
        line = (json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8", "replace")
    except BaseException:
        return False
    if len(line) > MAX_CONTROL_LINE:
        return False
    try:
        written = os.write(control_fd, line)
        return written == len(line)
    except BaseException:
        return False


def safe_killpg(pid, number):
    try:
        os.killpg(pid, number)
        return True
    except ProcessLookupError:
        return False
    except BaseException:
        return False


def watchdog(
    host_pid,
    script_pid,
    control_fd,
    ack_fd,
    log_path,
    deadline,
    duration_ms,
    grace_ms,
    config_token,
    runtime,
    profile_sha256,
    launch_identity,
    armed_wfd,
):
    """Trusted watchdog. Never reads readiness or identities from the script."""
    log_fd = None
    kq = None
    armed = False
    audit_events = []
    try:
        # The watchdog must be in its own session so the supervisor can kill
        # the script's process group without also killing the watchdog.
        if os.getsid(0) == os.getpid():
            raise OSError("watchdog unexpectedly leads the script session")
        os.setsid()
        if os.getsid(0) != os.getpid() or os.getpgrp() != os.getpid():
            raise OSError("watchdog is not an independent session leader")
        if os.getppid() != script_pid or script_pid == host_pid or os.getpid() in (host_pid, script_pid):
            raise OSError("watchdog process identity is inconsistent")

        # Ignore asynchronous termination signals. Only kqueue, the shared
        # deadline, or an explicit SIGKILL may end supervision.
        for name in ("SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGPIPE", "SIGXCPU"):
            number = getattr(signal, name, None)
            if number is not None:
                try:
                    signal.signal(number, signal.SIG_IGN)
                except (OSError, ValueError):
                    pass

        close_fds_except({control_fd, armed_wfd})
        stdio_closed = True
        for fd in (0, 1, 2):
            try:
                fcntl.fcntl(fd, fcntl.F_GETFD)
            except OSError as error:
                if error.errno != errno.EBADF:
                    stdio_closed = False
            else:
                stdio_closed = False
        # The watchdog retains no supervisor stdio or secret environment.
        os.environ.clear()
        os.environ.update(WATCHDOG_ENV)
        # A full/backpressured control socket must never delay TERM/KILL. The
        # armed write still fails closed on EAGAIN; later notifications drop.
        os.set_blocking(control_fd, False)

        try:
            log_fd = os.open(
                log_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
            )
        except OSError:
            log_fd = None

        kq = select.kqueue()
        changes = [
            select.kevent(
                pid,
                filter=select.KQ_FILTER_PROC,
                flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_ONESHOT,
                fflags=select.KQ_NOTE_EXIT,
            )
            for pid in (host_pid, script_pid)
        ]
        kq.control(changes, 0, 0)

        armed_at = time.monotonic()
        armed_payload = {
            "type": "armed",
            "protocol": CONTROL_PROTOCOL,
            "armed": True,
            "watchdogPid": os.getpid(),
            "watchdogSid": os.getsid(0),
            "watchdogPgid": os.getpgrp(),
            "scriptPid": script_pid,
            "supervisorPid": host_pid,
            "deadlineBasis": "python-monotonic",
            "durationMs": duration_ms,
            "graceMs": grace_ms,
            "armedAtMonotonic": armed_at,
            "deadlineMonotonic": deadline,
            "configToken": config_token,
            "runtime": runtime,
            "profileSha256": profile_sha256,
            "parentVerified": launch_identity["parentVerified"],
            "scriptIsSessionLeader": launch_identity["scriptIsSessionLeader"],
            "stdioClosed": stdio_closed,
            "environmentKeys": sorted(os.environ),
            "signalsIgnored": True,
        }
        if not safe_control_write(control_fd, armed_payload):
            remember_event(audit_events, "watchdog_failure", error="armed_control_write_failed")
            try:
                os.write(armed_wfd, b"FAIL\n")
            except BaseException:
                pass
            flush_audit(log_fd, audit_events)
            os._exit(EXIT_WATCHDOG_UNCONFIRMED)
        armed = True
        remember_event(
            audit_events,
            "armed",
            watchdogPid=armed_payload["watchdogPid"],
            watchdogSid=armed_payload["watchdogSid"],
            scriptPid=script_pid,
            supervisorPid=host_pid,
            deadlineBasis="python-monotonic",
            durationMs=duration_ms,
            armedAtMonotonic=armed_at,
            deadlineMonotonic=deadline,
            runtime=runtime,
        )
        try:
            os.write(armed_wfd, b"ARMED\n")
        except BaseException:
            remember_event(audit_events, "watchdog_failure", error="armed_internal_write_failed")
            safe_control_write(control_fd, {
                "type": "watchdog_failure",
                "protocol": CONTROL_PROTOCOL,
                "watchdogPid": os.getpid(),
                "scriptPid": script_pid,
                "supervisorPid": host_pid,
                "error": "armed_internal_write_failed",
            })
            safe_killpg(script_pid, signal.SIGKILL)
            flush_audit(log_fd, audit_events)
            os._exit(EXIT_WATCHDOG_UNCONFIRMED)
        try:
            os.close(armed_wfd)
        except OSError:
            pass
        armed_wfd = -1

        reason = None
        script_exited = False
        while reason is None:
            wait = deadline - time.monotonic()
            if wait <= 0:
                reason = "absolute_deadline"
                break
            try:
                events = kq.control([], 8, wait)
            except OSError as error:
                if error.errno == errno.EINTR:
                    continue
                raise
            exited = {
                int(event.ident)
                for event in events
                if event.filter == select.KQ_FILTER_PROC and event.fflags & select.KQ_NOTE_EXIT
            }
            if script_pid in exited:
                script_exited = True
                reason = "script_exit"
            elif host_pid in exited:
                reason = "supervisor_exit"
            elif time.monotonic() >= deadline:
                reason = "absolute_deadline"

        remember_event(audit_events, "trigger", reason=reason, scriptExitObserved=script_exited)
        safe_control_write(control_fd, {
            "type": "trigger",
            "protocol": CONTROL_PROTOCOL,
            "watchdogPid": os.getpid(),
            "scriptPid": script_pid,
            "supervisorPid": host_pid,
            "reason": reason,
            "scriptExitObserved": script_exited,
        })

        if not script_exited:
            # Drain exits already queued before using the numeric process-group
            # handle, so a script that exited normally is not signalled.
            try:
                events = kq.control([], 8, 0)
            except OSError as error:
                if error.errno != errno.EINTR:
                    raise
                events = []
            script_exited = any(
                int(event.ident) == script_pid and event.filter == select.KQ_FILTER_PROC
                and event.fflags & select.KQ_NOTE_EXIT
                for event in events
            )

        if not script_exited:
            term_sent = safe_killpg(script_pid, signal.SIGTERM)
            remember_event(audit_events, "term_sent", sent=term_sent)
            safe_control_write(control_fd, {
                "type": "term_sent",
                "protocol": CONTROL_PROTOCOL,
                "watchdogPid": os.getpid(),
                "scriptPid": script_pid,
                "supervisorPid": host_pid,
                "sent": term_sent,
            })
            grace_end = time.monotonic() + max(0, grace_ms) / 1000.0
            while not script_exited and time.monotonic() < grace_end:
                try:
                    events = kq.control([], 8, max(0, grace_end - time.monotonic()))
                except OSError as error:
                    if error.errno == errno.EINTR:
                        continue
                    raise
                script_exited = any(
                    int(event.ident) == script_pid and event.filter == select.KQ_FILTER_PROC
                    and event.fflags & select.KQ_NOTE_EXIT
                    for event in events
                )
            if not script_exited:
                kill_sent = safe_killpg(script_pid, signal.SIGKILL)
                remember_event(audit_events, "kill_sent", sent=kill_sent)
                safe_control_write(control_fd, {
                    "type": "kill_sent",
                    "protocol": CONTROL_PROTOCOL,
                    "watchdogPid": os.getpid(),
                    "scriptPid": script_pid,
                    "supervisorPid": host_pid,
                    "sent": kill_sent,
                })
                kill_end = time.monotonic() + 1.0
                while not script_exited and time.monotonic() < kill_end:
                    try:
                        events = kq.control([], 8, max(0, kill_end - time.monotonic()))
                    except OSError as error:
                        if error.errno == errno.EINTR:
                            continue
                        raise
                    script_exited = any(
                        int(event.ident) == script_pid and event.filter == select.KQ_FILTER_PROC
                        and event.fflags & select.KQ_NOTE_EXIT
                        for event in events
                    )

        remember_event(audit_events, "watchdog_exit", reason=reason, scriptExitObserved=script_exited)
        # Required termination/escalation is complete; evidence flush is last.
        flush_audit(log_fd, audit_events)
        safe_control_write(control_fd, {
            "type": "watchdog_exit",
            "protocol": CONTROL_PROTOCOL,
            "watchdogPid": os.getpid(),
            "scriptPid": script_pid,
            "supervisorPid": host_pid,
            "reason": reason,
            "scriptExitObserved": script_exited,
        })
        try:
            kq.close()
        except BaseException:
            pass
        kq = None
        if log_fd is not None:
            try:
                os.close(log_fd)
            except BaseException:
                pass
            log_fd = None
        try:
            os.close(control_fd)
        except BaseException:
            pass
        os._exit(0 if script_exited else EXIT_WATCHDOG_FAILURE)
    except BaseException as error:
        # Every evidence/notification attempt here is guarded independently.
        # The kill path executes before any potentially slow evidence flush.
        remember_event(audit_events, "watchdog_failure", error=type(error).__name__, message=str(error))
        if armed:
            safe_killpg(script_pid, signal.SIGKILL)
        else:
            try:
                os.write(armed_wfd, b"FAIL\n")
            except BaseException:
                pass
            safe_killpg(script_pid, signal.SIGKILL)
        flush_audit(log_fd, audit_events)
        safe_control_write(control_fd, {
            "type": "watchdog_failure",
            "protocol": CONTROL_PROTOCOL,
            "watchdogPid": os.getpid(),
            "scriptPid": script_pid,
            "supervisorPid": host_pid,
            "error": type(error).__name__,
        })
        if kq is not None:
            try:
                kq.close()
            except BaseException:
                pass
        if log_fd is not None:
            try:
                os.close(log_fd)
            except BaseException:
                pass
        try:
            os.close(control_fd)
        except BaseException:
            pass
        os._exit(EXIT_WATCHDOG_FAILURE)


def parse_integer(value, label, minimum, maximum):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        fail("invalid %s" % label)
    if parsed < minimum or parsed > maximum:
        fail("%s is outside the allowed range" % label)
    return parsed


def main(argv):
    if len(argv) < 4:
        fail("trusted launcher arguments are incomplete")
    profile = None
    fsize = None
    supervisor_pid = None
    duration_ms = None
    grace_ms = None
    control_fd = None
    ack_fd = None
    log_path = None
    config_token = None
    runtime = None
    separator = None
    index = 1
    options = {
        "--profile": "profile",
        "--fsize": "fsize",
        "--supervisor-pid": "supervisor_pid",
        "--deadline-ms": "duration_ms",
        "--grace-ms": "grace_ms",
        "--control-fd": "control_fd",
        "--ack-fd": "ack_fd",
        "--watchdog-log": "log_path",
        "--config-token": "config_token",
        "--runtime": "runtime",
    }
    values = {}
    while index < len(argv):
        token = argv[index]
        if token == "--":
            separator = index
            break
        if token not in options or index + 1 >= len(argv):
            fail("unexpected trusted launcher argument")
        values[options[token]] = argv[index + 1]
        index += 2
    if separator is None or separator + 2 >= len(argv):
        fail("missing -- INTERPRETER [ARG ...]")
    if set(values) != set(options.values()):
        fail("trusted launcher options are incomplete")
    profile = absolute_regular_file(values["profile"])
    fsize = parse_integer(values["fsize"], "file-size limit", 1, 4 * 1024 * 1024)
    supervisor_pid = parse_integer(values["supervisor_pid"], "supervisor pid", 2, 2**31 - 1)
    duration_ms = parse_integer(values["duration_ms"], "deadline", 100, 60000)
    grace_ms = parse_integer(values["grace_ms"], "termination grace", 20, 5000)
    control_fd = parse_integer(values["control_fd"], "control fd", 3, 1024)
    ack_fd = parse_integer(values["ack_fd"], "ack fd", 3, 1024)
    if control_fd == ack_fd:
        fail("control and acknowledgement descriptors must differ")
    log_path = values["log_path"]
    if not os.path.isabs(log_path):
        fail("watchdog log path must be absolute")
    if os.path.commonpath([log_path, os.getcwd()]) == os.getcwd():
        fail("watchdog log path must not be inside the writable work directory")
    config_token = values["config_token"]
    if not config_token or len(config_token) > 128 or "\n" in config_token or "\r" in config_token:
        fail("invalid config token")
    runtime = values["runtime"]
    if runtime not in ("python", "bun"):
        fail("invalid runtime name")
    interpreter = absolute_regular_file(argv[separator + 1])
    interpreter_args = argv[separator + 2:]
    if os.path.dirname(interpreter) in ("", "."):
        fail("interpreter must be an explicit host path")
    if not os.path.isabs(SANDBOX_EXEC) or not os.access(SANDBOX_EXEC, os.X_OK):
        fail("sandbox-exec is unavailable")

    try:
        if os.getsid(0) != os.getpid() or os.getpgid(0) != os.getpid():
            fail("launcher is not a session and process-group leader")
        if os.getppid() != supervisor_pid:
            fail("launcher parent is not the host-supplied supervisor")
        for fd in (control_fd, ack_fd):
            fcntl.fcntl(fd, fcntl.F_GETFD)
            set_cloexec(fd)
    except OSError as error:
        fail("cannot verify launcher trust boundary: %s" % error)

    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
    except (OSError, ValueError) as error:
        fail("cannot set RLIMIT_FSIZE: %s" % error)

    for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGPIPE", "SIGXCPU"):
        number = getattr(signal, name, None)
        if number is not None:
            try:
                signal.signal(number, signal.SIG_DFL)
            except (OSError, ValueError):
                pass

    child_env = {name: value for name, value in os.environ.items() if name in ENV_ALLOW}
    child_env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
    try:
        profile_sha256 = sha256_file(profile)
    except OSError as error:
        fail("cannot hash trusted profile: %s" % error)

    launch_identity = {"parentVerified": True, "scriptIsSessionLeader": True}
    # This PID survives exec of sandbox-exec and the interpreter; it is the
    # numeric process-group handle the watchdog must supervise. Capture it
    # before fork so the child never mistakes its own PID for the script.
    script_pid = os.getpid()
    # The deadline is computed once, in the trusted launcher, immediately
    # before fork. The watchdog receives this same numeric value; host and
    # watchdog monotonic numbers are never compared across languages.
    deadline = time.monotonic() + duration_ms / 1000.0
    rfd, wfd = os.pipe()
    try:
        set_cloexec(rfd)
        set_cloexec(wfd)
        watchdog_pid = os.fork()
    except OSError as error:
        fail("cannot fork trusted watchdog: %s" % error)
    if watchdog_pid == 0:
        try:
            os.close(rfd)
        except OSError:
            pass
        watchdog(
            supervisor_pid,
            script_pid,
            control_fd,
            ack_fd,
            log_path,
            deadline,
            duration_ms,
            grace_ms,
            config_token,
            runtime,
            profile_sha256,
            launch_identity,
            wfd,
        )
        os._exit(EXIT_WATCHDOG_FAILURE)

    # Parent: wait for the watchdog registration record, then for the
    # supervisor's acknowledgement. Any failure exits before sandbox exec.
    os.close(wfd)
    armed = False
    try:
        arm_deadline = min(deadline, time.monotonic() + ARM_TIMEOUT_SECONDS)
        payload = b""
        while time.monotonic() < arm_deadline:
            ready, _, _ = select.select([rfd], [], [], max(0, arm_deadline - time.monotonic()))
            if not ready:
                continue
            chunk = os.read(rfd, 64)
            if not chunk:
                break
            payload += chunk
            if len(payload) > 64:
                break
            if b"\n" in payload:
                break
        armed = payload.strip() == b"ARMED"
    except BaseException:
        armed = False
    try:
        os.close(rfd)
    except OSError:
        pass

    if not armed:
        try:
            os.kill(watchdog_pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(watchdog_pid, 0)
        except OSError:
            pass
        fail("trusted watchdog did not arm; refusing to execute")
    try:
        os.kill(watchdog_pid, 0)
        if os.getsid(watchdog_pid) != watchdog_pid or os.getpgid(watchdog_pid) != watchdog_pid:
            raise OSError("watchdog is not an independent session leader")
    except OSError as error:
        try:
            os.kill(watchdog_pid, signal.SIGKILL)
        except OSError:
            pass
        fail("trusted watchdog is not independently live: %s" % error)

    acknowledged = False
    try:
        ack_deadline = min(deadline, time.monotonic() + ACK_TIMEOUT_SECONDS)
        buffer = b""
        while time.monotonic() < ack_deadline:
            ready, _, _ = select.select([ack_fd], [], [], max(0, ack_deadline - time.monotonic()))
            if not ready:
                continue
            chunk = os.read(ack_fd, MAX_ACK_LINE + 1)
            if not chunk:
                break
            buffer += chunk
            if len(buffer) > MAX_ACK_LINE:
                break
            if b"\n" in buffer:
                break
        if b"\n" in buffer:
            line = buffer.split(b"\n", 1)[0]
            try:
                message = json.loads(line.decode("utf-8", "strict"))
            except BaseException:
                message = None
            if isinstance(message, dict) and message.get("type") == "ack" \
                    and message.get("protocol") == CONTROL_PROTOCOL \
                    and message.get("configToken") == config_token \
                    and message.get("scriptPid") == os.getpid() \
                    and message.get("supervisorPid") == supervisor_pid:
                acknowledged = True
    except BaseException:
        acknowledged = False

    if not acknowledged:
        try:
            os.kill(watchdog_pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            os.waitpid(watchdog_pid, 0)
        except OSError:
            pass
        fail("trusted watchdog acknowledgement missing or invalid; refusing to execute")

    # Both control directions are closed before untrusted code. The watchdog
    # keeps its own duplicate of the event descriptor; the host sees EOF only
    # when the watchdog actually exits.
    for fd in (control_fd, ack_fd):
        try:
            os.close(fd)
        except OSError:
            pass
    try:
        close_fds_except({0, 1, 2})
        leftover = descriptors_outside({0, 1, 2})
    except OSError as error:
        fail("cannot verify descriptor cleanup: %s" % error)
    if leftover:
        fail("trusted descriptors remain open after cleanup")

    os.environ.clear()
    os.environ.update(child_env)
    os.execve(
        SANDBOX_EXEC,
        [SANDBOX_EXEC, "-f", profile, interpreter] + interpreter_args,
        child_env,
    )


if __name__ == "__main__":
    main(sys.argv)
