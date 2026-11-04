#!/usr/bin/env python3
"""Hermes plugin backend sidecar.

Runs one Hermes Desktop plugin's FastAPI backend half (``dashboard/plugin_api.py``)
in its own process and serves it over a private Unix domain socket (falling back
to an ephemeral loopback TCP port where AF_UNIX is unavailable).

The Host half (``lib/backend.js``) spawns this file, reads exactly one JSON status
line from stdout when the ASGI server is actually listening, then proxies the
browser's requests onto that socket. Nothing else is ever written to stdout, so
the status line is unambiguous; every diagnostic goes to stderr.

Protocol
--------
stdout, one line, when listening::

    {"ready": true, "socket": "/var/folders/.../hph-xxxx/sock"}
    {"ready": true, "host": "127.0.0.1", "port": 53144}

stdout, one line, when startup fails before listening::

    {"ready": false, "error": "..."}

Exit status is 0 on SIGTERM/SIGINT (uvicorn's own graceful shutdown).

Usage
-----
    python3 sidecar.py --plugin-dir DIR [--api-file plugin_api.py] [--socket PATH]

``--api-file`` accepts either a bare filename resolved under ``DIR/dashboard`` or
an absolute path inside the plugin directory. When omitted, ``dashboard/
manifest.json``'s ``api`` field is used, defaulting to ``plugin_api.py``.

The router is mounted with **no prefix**: the plugin's own routes already carry
their paths (office-3d declares ``@router.get("/state")``), and the Host proxy
strips the ``/api/hermes-plugins/backend/<plugin>`` level before forwarding.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
import signal
import socket
import sys
import tempfile
import threading
import traceback

DEFAULT_API_FILE = "plugin_api.py"
HEALTH_PATH = "/__health"


def _log(message: str) -> None:
    """Diagnostics go to stderr only; stdout carries the single status line."""
    try:
        sys.stderr.write("[hermes-sidecar] %s\n" % (message,))
        sys.stderr.flush()
    except Exception:
        pass


def _emit(payload: dict) -> None:
    """Write the one and only status line."""
    try:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def _read_manifest_api(plugin_dir: str) -> str:
    """Best-effort read of ``dashboard/manifest.json``'s ``api`` field."""
    manifest = os.path.join(plugin_dir, "dashboard", "manifest.json")
    try:
        with open(manifest, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        value = data.get("api")
        if isinstance(value, str) and value.strip():
            return value.strip()
    except Exception:
        pass
    return DEFAULT_API_FILE


def _resolve_api_file(plugin_dir: str, requested: str) -> str:
    """Resolve the API module to an absolute path inside the plugin dir."""
    if os.path.isabs(requested):
        candidate = os.path.realpath(requested)
    else:
        candidate = os.path.realpath(os.path.join(plugin_dir, "dashboard", requested))
        if not os.path.isfile(candidate):
            fallback = os.path.realpath(os.path.join(plugin_dir, requested))
            if os.path.isfile(fallback):
                candidate = fallback
    root = os.path.realpath(plugin_dir)
    if candidate != root and not candidate.startswith(root + os.sep):
        raise RuntimeError("api file %r escapes the plugin directory" % (requested,))
    if not os.path.isfile(candidate):
        raise RuntimeError("api file not found: %s" % (candidate,))
    return candidate


def _load_router(plugin_dir: str, api_path: str):
    """Import the API module by path and return its ``router``."""
    dashboard = os.path.join(plugin_dir, "dashboard")
    # The plugin's own modules may be imported flat (`import helpers`), and its
    # dashboard modules may import each other, so both roots go on the path.
    for entry in (dashboard, plugin_dir):
        if os.path.isdir(entry) and entry not in sys.path:
            sys.path.insert(0, entry)
    if os.path.dirname(api_path) not in sys.path:
        sys.path.insert(0, os.path.dirname(api_path))

    module_name = "plugin_api"
    spec = importlib.util.spec_from_file_location(module_name, api_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot build an import spec for %s" % (api_path,))
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)

    router = getattr(module, "router", None)
    if router is None:
        raise RuntimeError("%s does not define a module-level `router`" % (api_path,))

    from fastapi import APIRouter  # noqa: F401  (imported for the isinstance-free check)

    if not hasattr(router, "routes"):
        raise RuntimeError("`router` in %s is not a FastAPI APIRouter" % (api_path,))
    return module, router


def _build_app(plugin_dir: str, api_path: str):
    from fastapi import FastAPI

    module, router = _load_router(plugin_dir, api_path)
    app = FastAPI(title="hermes-plugin-sidecar", docs_url=None, redoc_url=None)

    @app.get(HEALTH_PATH)
    async def __health():  # noqa: D401 - tiny health endpoint
        return {
            "ok": True,
            "plugin": os.path.basename(plugin_dir.rstrip(os.sep)),
            "api": os.path.basename(api_path),
            "routes": len(getattr(router, "routes", [])),
        }

    app.include_router(router)
    return app, module, router


def _pick_loopback_port() -> int:
    """Reserve an ephemeral loopback port, then release it for uvicorn."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])
    finally:
        try:
            probe.close()
        except Exception:
            pass


def _unix_socket_supported(directory: str) -> bool:
    if not hasattr(socket, "AF_UNIX"):
        return False
    # sun_path is capped (104 bytes on macOS, 108 on Linux); stay well under.
    if len(directory) > 60:
        return False
    probe = None
    try:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.bind(os.path.join(directory, "probe.sock"))
        return True
    except Exception:
        return False
    finally:
        if probe is not None:
            try:
                probe.close()
            except Exception:
                pass
        try:
            os.unlink(os.path.join(directory, "probe.sock"))
        except Exception:
            pass


def _cleanup(uds, temp_dir) -> None:
    """Remove the socket and our private temp directory.

    Called from the normal exit path (``main``'s ``finally``) and from the
    parent-death watchdog, which leaves via ``os._exit`` and therefore skips
    ``finally`` blocks. Both paths must run this, or a killed Host leaves an
    empty ``hph-sidecar-*`` directory and a stale socket in the system temp dir.
    """
    if temp_dir:
        try:
            import shutil

            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass
    if not uds:
        return
    try:
        os.unlink(uds)
    except Exception:
        pass
    # The Host normally owns and removes our socket's directory. When the Host
    # was killed instead, nobody is left to run that cleanup, so drop the empty
    # directory ourselves; `rmdir` refuses anything non-empty or not ours.
    try:
        parent = os.path.dirname(os.path.abspath(uds))
        if os.path.basename(parent).startswith("hph-sidecar-"):
            os.rmdir(parent)
    except Exception:
        pass


def _watch_parent_pipe(uds=None, temp_dir=None) -> None:
    """Exit when the Host that spawned us goes away.

    The Host keeps our stdin open for exactly as long as it lives. When it dies
    (a crash, SIGKILL, or a reload that forgets to stop us) the pipe closes and
    this read returns; exiting here means one Python process per plugin can
    never outlive its owner.
    """

    def _watch() -> None:
        try:
            while True:
                chunk = sys.stdin.buffer.read(4096)
                if chunk == b"":
                    break
        except Exception:
            pass
        _log("host closed the parent pipe; exiting")
        try:
            _cleanup(uds, temp_dir)
        except Exception:
            pass
        try:
            sys.stderr.flush()
        except Exception:
            pass
        os._exit(0)

    try:
        import stat as stat_module

        mode = os.fstat(0).st_mode
        # Only arm when stdin is a real parent-held channel. Node's
        # `child_process` pipes are socketpairs (S_ISSOCK) on macOS, so S_ISFIFO
        # alone would silently disable this protection where it matters most;
        # a terminal, /dev/null or a redirected regular file means nobody is
        # watching for our parent, and reading could steal the user's input.
        if not (stat_module.S_ISSOCK(mode) or stat_module.S_ISFIFO(mode)):
            return
    except Exception:
        return

    thread = threading.Thread(target=_watch, name="parent-watchdog", daemon=True)
    thread.start()


def _install_exit_sentinel() -> None:
    """Make a graceful SIGTERM finish with exit status 0 instead of 143.

    uvicorn 0.3x saves the handlers that existed before it started, restores
    them after a graceful shutdown, and then re-raises the captured signal so a
    supervisor sees the conventional 128+N status. Installing our own harmless
    handler first means that final re-raise lands here and returns, so control
    falls back out of ``serve()`` and the process exits 0 as the Host expects.
    Uvicorn's own handler is the one that actually drives the shutdown.
    """

    def _sentinel(signum, _frame):
        _log("shutdown signal %s received; exiting cleanly" % (signum,))

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _sentinel)
        except (ValueError, OSError):
            # Not the main thread, or an unsupported platform: harmless.
            pass


async def _serve(app, *, uds: str = None, host: str = None, port: int = None) -> None:
    import uvicorn

    config = uvicorn.Config(
        app,
        uds=uds,
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
        lifespan="off",
    )
    server = uvicorn.Server(config)

    async def announce() -> None:
        # `server.started` flips only after the listener is bound and serving.
        for _ in range(1500):
            if server.started:
                break
            await asyncio.sleep(0.02)
        if not server.started:
            return
        if uds:
            _emit({"ready": True, "socket": uds})
        else:
            actual = port
            try:
                for served in getattr(server, "servers", []) or []:
                    for sock in getattr(served, "sockets", []) or []:
                        actual = int(sock.getsockname()[1])
                        break
            except Exception:
                pass
            _emit({"ready": True, "host": "127.0.0.1", "port": int(actual)})

    announcer = asyncio.ensure_future(announce())
    try:
        await server.serve()
    finally:
        if not announcer.done():
            announcer.cancel()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Hermes plugin FastAPI sidecar")
    parser.add_argument("--plugin-dir", required=True, help="installed plugin directory")
    parser.add_argument("--api-file", default=None, help="API module under dashboard/")
    parser.add_argument("--socket", default=None, help="Unix socket path to bind")
    args = parser.parse_args(argv)

    plugin_dir = os.path.realpath(args.plugin_dir)
    if not os.path.isdir(plugin_dir):
        _emit({"ready": False, "error": "plugin directory not found: %s" % (plugin_dir,)})
        _log("plugin directory not found: %s" % (plugin_dir,))
        return 2

    try:
        requested = args.api_file or _read_manifest_api(plugin_dir)
        api_path = _resolve_api_file(plugin_dir, requested)
    except Exception as error:
        _emit({"ready": False, "error": str(error)})
        _log(traceback.format_exc())
        return 3

    try:
        app, _module, _router = _build_app(plugin_dir, api_path)
    except Exception as error:
        _emit({"ready": False, "error": "import failed: %s" % (error,)})
        _log(traceback.format_exc())
        return 4

    temp_dir = None
    uds = args.socket
    if uds:
        uds = os.path.abspath(uds)
        try:
            os.makedirs(os.path.dirname(uds), exist_ok=True)
            if os.path.exists(uds):
                os.unlink(uds)
        except Exception:
            uds = None
    else:
        try:
            temp_dir = tempfile.mkdtemp(prefix="hph-sidecar-")
            if _unix_socket_supported(temp_dir):
                uds = os.path.join(temp_dir, "sock")
            else:
                uds = None
        except Exception:
            uds = None

    port = None
    if not uds:
        port = _pick_loopback_port()

    _watch_parent_pipe(uds, temp_dir)
    try:
        _install_exit_sentinel()
        asyncio.run(_serve(app, uds=uds, host=None if uds else "127.0.0.1", port=port))
        return 0
    except KeyboardInterrupt:
        return 0
    except SystemExit as exit_error:  # uvicorn raises this on bind failures
        _emit({"ready": False, "error": str(exit_error)})
        _log(traceback.format_exc())
        return 5
    except Exception as error:
        _emit({"ready": False, "error": str(error)})
        _log(traceback.format_exc())
        return 5
    finally:
        _cleanup(uds, temp_dir)


if __name__ == "__main__":
    sys.exit(main())
