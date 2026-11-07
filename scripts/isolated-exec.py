#!/usr/bin/env python3
"""Trusted launcher between the TypeScript supervisor and sandbox-exec.

The supervisor starts this wrapper with detach/setsid so the wrapper is a
session and process-group leader. The wrapper then lowers the file-size limit,
closes every inherited descriptor above stdio, reconstructs a small environment
allow-list, and execs sandbox-exec with a host-generated profile and an exact
interpreter argv. No shell and no fork occur: sandbox-exec and the untrusted
interpreter replace this same process.

Failure before exec exits without ever running untrusted code. There is no
unsandboxed fallback.
"""

import errno
import fcntl
import os
import resource
import signal
import stat
import sys

ENV_ALLOW = {
    "LANG",
    "LC_ALL",
    "OMP_EXEC_RUNTIME",
    "OMP_INPUTS_MANIFEST",
    "OMP_WORK_DIR",
    "PATH",
    "TMPDIR",
}
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
EXIT_LAUNCH_FAILURE = 111


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


def main(argv):
    if len(argv) < 6 or argv[1] != "--profile" or argv[3] != "--fsize" or argv[5] != "--":
        fail("usage: isolated-exec.py --profile PROFILE --fsize BYTES -- INTERPRETER [ARG ...]")
    profile = absolute_regular_file(argv[2])
    try:
        fsize = int(argv[4])
    except ValueError:
        fail("invalid file-size limit")
    if fsize <= 0 or fsize > 4 * 1024 * 1024:
        fail("file-size limit is outside the allowed range")
    interpreter = absolute_regular_file(argv[6])
    interpreter_args = argv[7:]
    if os.path.dirname(interpreter) in ("", "."):
        fail("interpreter must be an explicit host path")
    if not os.path.isabs(SANDBOX_EXEC) or not os.access(SANDBOX_EXEC, os.X_OK):
        fail("sandbox-exec is unavailable")

    # The supervisor sets detached=true; without a real session/process group
    # leader the sandbox signal boundary cannot be attributed or cleaned up.
    try:
        if os.getsid(0) != os.getpid() or os.getpgid(0) != os.getpid():
            fail("launcher is not a session and process-group leader")
    except OSError as error:
        fail("cannot verify session leadership: %s" % error)

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

    # Enumerate the process's actual descriptor table through /dev/fd. Do not
    # iterate only to the current RLIMIT_NOFILE: an inherited descriptor can
    # remain open above a later-lowered soft limit and would otherwise leak
    # into the sandbox. listdir itself uses one transient descriptor; it is
    # part of the observed set and is closed together with the rest. The
    # enumerated maximum is the actual high-water mark, not an arbitrary cap.
    try:
        inherited = sorted({
            int(name) for name in os.listdir("/dev/fd")
            if name.isdigit() and int(name) >= 3
        })
    except OSError as error:
        fail("cannot enumerate inherited descriptors: %s" % error)
    high_water = inherited[-1] if inherited else 2
    try:
        os.closerange(3, high_water + 1)
    except OSError as error:
        fail("cannot close inherited descriptors: %s" % error)
    for fd in inherited:
        try:
            fcntl.fcntl(fd, fcntl.F_GETFD)
        except OSError as error:
            if error.errno != errno.EBADF:
                fail("cannot verify descriptor %d is closed: %s" % (fd, error))
            continue
        fail("inherited descriptor %d remains open after cleanup" % fd)

    env = {name: value for name, value in os.environ.items() if name in ENV_ALLOW}
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"

    os.execve(
        SANDBOX_EXEC,
        [SANDBOX_EXEC, "-f", profile, interpreter] + interpreter_args,
        env,
    )


if __name__ == "__main__":
    main(sys.argv)
