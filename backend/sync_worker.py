import asyncio
import os
import re
import uuid
from datetime import datetime, date, timezone
from typing import Dict, List, Optional
import aiosqlite

DB_PATH = os.environ.get("DB_PATH", "/app-data/jobs.db")
COOKIE_DIR = os.environ.get("COOKIE_DIR", "/app-data/cookies")

# How long (seconds) with zero output before we consider the process stalled.
# icloudpd goes silent during large downloads, so 15 min is a reasonable threshold.
STALL_TIMEOUT = int(os.environ.get("STALL_TIMEOUT", 900))  # default 15 min
HEARTBEAT_INTERVAL = 60  # log a "still running" line every 60 s of silence

# Patterns in icloudpd output that mean it's waiting for a 2FA code from the user
TWO_FA_PATTERNS = [
    "enter the code",
    "enter the 6 digit",
    "enter the verification",
    "two-factor",
    "two-step",
    "2fa code",
    "verification code",
    "code sent to",
    "check your device",
    "approve this sign",
]

# Patterns that mean icloudpd is asking "Trust this browser/computer? (y/n)"
# We auto-answer "y" — it just writes a cookie, which is what we want.
TRUST_PATTERNS = [
    "trust this computer",
    "trust this browser",
    "save this browser",
    "(y/n)",
]


class ProcessManager:
    def __init__(self):
        self.processes: Dict[str, asyncio.subprocess.Process] = {}
        self.run_ids: Dict[int, str] = {}  # job_id -> run_id
        self.needs_2fa: Dict[str, bool] = {}
        self.stop_requested: set = set()  # run_ids that have been asked to stop

    def is_running(self, job_id: int) -> bool:
        return job_id in self.run_ids

    def get_run_id(self, job_id: int) -> Optional[str]:
        return self.run_ids.get(job_id)

    async def send_input(self, run_id: str, text: str):
        proc = self.processes.get(run_id)
        if proc and proc.stdin:
            try:
                proc.stdin.write((text + "\n").encode())
                await proc.stdin.drain()
                self.needs_2fa[run_id] = False
            except Exception as e:
                print(f"Error sending input to process {run_id}: {e}")

    async def stop_process(self, job_id: int):
        run_id = self.run_ids.get(job_id)
        if not run_id:
            return
        # Mark as stop-requested so the album loop won't start a new process
        self.stop_requested.add(run_id)
        # Kill whatever process is currently running for this run
        proc = self.processes.get(run_id)
        if proc:
            try:
                proc.kill()   # SIGKILL — immediate, no waiting for current transfer
                await proc.wait()
            except Exception as e:
                print(f"Error stopping process: {e}")

    def check_needs_2fa(self, run_id: str) -> bool:
        return self.needs_2fa.get(run_id, False)

    async def start_job(self, job: dict) -> str:
        job_id = job["id"]

        if job_id in self.run_ids:
            raise RuntimeError(f"Job {job_id} is already running")

        run_id = str(uuid.uuid4())

        # Create run record in DB
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO runs (id, job_id, started_at, status) VALUES (?, ?, ?, ?)",
                (run_id, job_id, datetime.now(timezone.utc).isoformat(), "running"),
            )
            await db.execute(
                "UPDATE jobs SET last_run_at=?, last_run_status=?, updated_at=? WHERE id=?",
                (
                    datetime.now(timezone.utc).isoformat(),
                    "running",
                    datetime.now(timezone.utc).isoformat(),
                    job_id,
                ),
            )
            await db.commit()

        self.run_ids[job_id] = run_id
        self.needs_2fa[run_id] = False

        os.makedirs(COOKIE_DIR, exist_ok=True)
        os.makedirs(self._resolve_output_dir(job), exist_ok=True)

        asyncio.create_task(self._run_sync_phases(job, run_id))
        return run_id

    # Regex to filter icloudpd log-header lines from stdout (same as in main.py)
    _LOG_LINE_RE = re.compile(
        r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(INFO|DEBUG|WARNING|ERROR|CRITICAL)\b"
    )

    # iCloud built-in system albums — syncing these causes duplicates because
    # their photos already appear in user-created albums or the main library.
    _SYSTEM_ALBUMS = {
        "time-lapse", "videos", "slo-mo", "bursts", "favorites",
        "panoramas", "screenshots", "live", "recently deleted", "hidden",
        # Localised Swedish equivalents (icloudpd may return either)
        "tidsförlopp", "sakta ned", "skärmdumpar", "senast raderade", "dold",
    }

    async def _list_albums(self, job: dict, run_id: str, job_id: int,
                           library: Optional[str] = None) -> List[str]:
        """
        Ask icloudpd for the album list of a given library.
        Pass library=None for Personal Library, or a SharedSync-… name for Shared.
        Returns the names, filtering out log-header lines and system albums.
        """
        label = library or "Personal Library"
        await self._log(run_id, job_id, "info",
                        f"Fetching album list for per-album sync ({label})…")
        cmd = [
            "icloudpd",
            "--username", job["username"],
            "--password", job["password"],
            "--directory", self._resolve_output_dir(job),
            "--cookie-directory", COOKIE_DIR,
            "--no-progress-bar",
            "--log-level", "info",
            "--list-albums",
        ]
        if library:
            cmd.extend(["--library", library])
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env={**os.environ, "ICLOUDPD_NO_PROGRESS": "1"},
            )
            self.processes[run_id] = proc  # register so stop_process can kill it
            try:
                stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=120)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise
            self.processes.pop(run_id, None)
            names = []
            for raw in stdout.decode("utf-8", errors="replace").splitlines():
                text = raw.strip()
                if not text:
                    continue
                # Skip log-header lines (timestamp + level)
                if self._LOG_LINE_RE.match(text):
                    continue
                # Skip icloudpd section-header lines.
                # These end with ":" (e.g. "Albums:") or are the localised
                # smart-album divider ("Smart Albums", "Smarta album", etc.)
                if text.endswith(":"):
                    continue
                if "smart" in text.lower() and "album" in text.lower():
                    continue
                # Skip iCloud built-in system albums — their photos already
                # exist in the main library or user albums, so syncing them
                # separately would create duplicates.
                # Exception: Favorites can be opted-in via job.sync_favorites.
                lower = text.lower()
                if lower in self._SYSTEM_ALBUMS:
                    is_favorites = lower in ("favorites", "favoriter", "favoritter",
                                             "suosikit", "favoris", "favoriten")
                    if not (is_favorites and job.get("sync_favorites")):
                        continue
                names.append(text)
            await self._log(run_id, job_id, "info",
                            f"Found {len(names)} albums: {', '.join(names) or '(none)'}")
            return names
        except asyncio.TimeoutError:
            await self._log(run_id, job_id, "warning",
                            "Timed out fetching album list — falling back to single run")
            return []
        except Exception as e:
            await self._log(run_id, job_id, "warning",
                            f"Could not fetch album list: {e} — falling back to single run")
            return []

    async def _run_one_phase(self, job: dict, run_id: str, job_id: int,
                              library: Optional[str] = None,
                              album_override: Optional[str] = None,
                              shared_library_root: bool = False) -> int:
        """
        Build and run a single icloudpd command.
        album_override (if given) replaces job['album'] for this invocation only.
        shared_library_root: redirect output into <output_dir>/Shared Library/
        Returns the exit code.
        """
        cmd = self._build_command(job, run_id, library=library,
                                  album_override=album_override,
                                  shared_library_root=shared_library_root)
        safe = [c if c != job["password"] else "***" for c in cmd]
        await self._log(run_id, job_id, "info", f"Command: {' '.join(safe)}")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "ICLOUDPD_NO_PROGRESS": "1"},
        )
        self.processes[run_id] = proc
        return await self._drain_process(proc, run_id, job_id)

    async def _run_sync_phases(self, job: dict, run_id: str):
        """
        Orchestrates all sync phases:
          • If organize_by_album=True and album="All Photos":
              - fetch album list, then run once per album into <output>/<AlbumName>/
          • Otherwise: single icloudpd run for Personal Library
          • Then optionally a second run for Shared Library
        """
        job_id = job["id"]
        final_status = "success"

        album = job.get("album", "All Photos") or "All Photos"
        multi_album = job.get("organize_by_album") and album == "All Photos"

        try:
            # ── Personal Library ───────────────────────────────────────────
            if multi_album:
                albums = await self._list_albums(job, run_id, job_id)
                if run_id in self.stop_requested:
                    return
                if albums:
                    for alb in albums:
                        if run_id in self.stop_requested or final_status != "success":
                            break
                        await self._log(run_id, job_id, "info",
                                        f"──── Syncing album: {alb} ────")
                        rc = await self._run_one_phase(job, run_id, job_id,
                                                       library=None,
                                                       album_override=alb)
                        if rc != 0:
                            final_status = "error"
                else:
                    # Fallback: no albums found, sync everything without album folders
                    await self._log(run_id, job_id, "info",
                                    "No albums found — syncing all photos without album folders")
                    rc = await self._run_one_phase(job, run_id, job_id, library=None)
                    if rc != 0:
                        final_status = "error"
            else:
                await self._log(run_id, job_id, "info", "Starting Personal Library sync")
                rc = await self._run_one_phase(job, run_id, job_id, library=None)
                if rc != 0:
                    final_status = "error"

            # ── Shared Library (optional) ──────────────────────────────────
            if (run_id not in self.stop_requested
                    and final_status == "success"
                    and job.get("include_shared_library")
                    and job.get("library")):
                shared_lib = job["library"]
                await self._log(run_id, job_id, "info",
                                f"──── Syncing Shared Library: {shared_lib} ────")

                # In multi-album mode, discover SharedSync photos that belong to
                # PrimarySync albums using a cross-zone CloudKit query via
                # pyicloud_ipd.  Albums exist only in PrimarySync; SharedSync has
                # no user-created albums so icloudpd --album crashes there.
                # Instead we query the SharedSync zone directly using the
                # PrimarySync album's parentId filter — iCloud stores cross-library
                # ContainerRelation records in the photo's zone (SharedSync).
                if multi_album and albums:
                    await self._log(run_id, job_id, "info",
                                    "Discovering SharedSync photos per album via pyicloud_ipd …")
                    await self._sync_shared_photos_by_ps_albums(
                        job, run_id, job_id, albums)

                # Always run a full SharedSync pass to capture photos not in any
                # named album (organised by date only).
                if run_id not in self.stop_requested:
                    await self._log(run_id, job_id, "info",
                                    "Syncing all shared photos → Shared Library/ (date organised)")
                    rc = await self._run_one_phase(job, run_id, job_id,
                                                   library=shared_lib,
                                                   album_override="All Photos",
                                                   shared_library_root=True)
                    if rc != 0:
                        final_status = "error"

        except Exception as e:
            await self._log(run_id, job_id, "error", f"Sync error: {e}")
            final_status = "error"
        finally:
            stopped = run_id in self.stop_requested
            if stopped:
                final_status = "stopped"
            await self._log(run_id, job_id, final_status,
                            f"Process finished with status: {final_status}")
            await self._finish_run(run_id, job_id, final_status)
            self.run_ids.pop(job_id, None)
            self.processes.pop(run_id, None)
            self.needs_2fa.pop(run_id, None)
            self.stop_requested.discard(run_id)

    # ── Cross-library album sync (pyicloud_ipd) ────────────────────────────

    def _run_shared_album_sync_blocking(
        self, job: dict, albums: List[str], run_id: str
    ) -> List[tuple]:
        """
        Synchronous worker (runs in a thread executor) that uses pyicloud_ipd
        to download SharedSync photos belonging to PrimarySync albums.

        Strategy: iCloud stores CPLContainerRelation records for cross-library
        album membership in the *photo's* zone (SharedSync), tagged with the
        PrimarySync album's record name as parentId.  We create a PhotoAlbum
        proxy that points at the SharedSync zone but uses the PrimarySync
        album's container filter, so the CloudKit query returns exactly the
        SharedSync photos that are in that album.

        Returns a list of (level, message) tuples for the caller to log.
        """
        logs: List[tuple] = []

        shared_lib_name = job.get("library", "")
        base_dir = self._resolve_output_dir(job)
        shared_out = (
            job.get("shared_output_dir") or os.path.join(base_dir, "Shared Library")
        )
        raw_fmt = job.get("folder_structure") or "{:%Y}"
        # Convert icloudpd format ("{:%Y}") to plain strftime format ("%Y")
        strftime_fmt = re.sub(r"\{:(.*?)\}", r"\1", raw_fmt)

        # ── Import pyicloud_ipd ───────────────────────────────────────────
        try:
            from pyicloud_ipd import PyiCloudService          # type: ignore
            from pyicloud_ipd.services.photos import PhotoAlbum as _PA  # type: ignore
        except Exception as exc:
            logs.append(("warning",
                         f"pyicloud_ipd import failed ({type(exc).__name__}: {exc}) — "
                         "shared-album sync skipped"))
            return logs

        # ── Authenticate (reuses cookies stored by icloudpd) ──────────────
        try:
            icloud = PyiCloudService(
                job["username"],
                job["password"],
                cookie_directory=COOKIE_DIR,
            )
        except Exception as exc:
            logs.append(("warning",
                         f"pyicloud_ipd auth failed: {exc} — shared-album sync skipped"))
            return logs

        if getattr(icloud, "requires_2fa", False) or getattr(icloud, "requires_2sa", False):
            logs.append(("warning",
                         "iCloud 2FA required — shared-album sync skipped"))
            return logs

        # ── Locate the SharedSync library ─────────────────────────────────
        shared_libs = getattr(icloud.photos, "shared_libraries", {})
        shared_svc = shared_libs.get(shared_lib_name)
        if shared_svc is None:
            logs.append(("warning",
                         f"Shared library '{shared_lib_name}' not found — "
                         "shared-album sync skipped"))
            return logs

        # ── List PrimarySync albums ───────────────────────────────────────
        try:
            ps_albums = icloud.photos.albums
        except Exception as exc:
            logs.append(("warning",
                         f"Cannot list PrimarySync albums: {exc} — "
                         "shared-album sync skipped"))
            return logs

        # ── Per-album cross-zone query and download ───────────────────────
        for alb_name in albums:
            if run_id in self.stop_requested:
                break

            ps_album = ps_albums.get(alb_name)
            if ps_album is None:
                continue

            # Build the cross-zone PhotoAlbum:
            #   • connection params come from the SharedSync service (so
            #     queries hit the SharedSync CloudKit endpoint/zone)
            #   • list_type / obj_type / query_filter come from the
            #     PrimarySync album (so the parentId filter is the album's
            #     folder record name, not a SharedSync container)
            try:
                shared_zone_id = getattr(shared_svc, "_zone_id", None)
                cross_album = _PA(
                    params=shared_svc.params,
                    session=shared_svc.session,
                    service_endpoint=shared_svc.service_endpoint,
                    name=alb_name,
                    list_type=ps_album._list_type,
                    obj_type=ps_album._obj_type,
                    query_filter=ps_album._query_filter,
                    zone_id=shared_zone_id,
                )
            except Exception as exc:
                logs.append(("warning",
                             f"Cannot build cross-zone album '{alb_name}': {exc}"))
                continue

            safe_album = alb_name.replace("/", "_").replace("\\", "_")
            downloaded = 0

            try:
                for photo in cross_album.photos:
                    if run_id in self.stop_requested:
                        break

                    # Determine output subdirectory
                    try:
                        year_str = photo.created.strftime(strftime_fmt)
                    except Exception:
                        year_str = "unknown"

                    if job.get("organize_by_year") and job.get("organize_by_album"):
                        sub = os.path.join(shared_out, year_str, safe_album)
                    elif job.get("organize_by_year"):
                        sub = os.path.join(shared_out, year_str)
                    elif job.get("organize_by_album"):
                        sub = os.path.join(shared_out, safe_album)
                    else:
                        sub = shared_out

                    os.makedirs(sub, exist_ok=True)
                    target = os.path.join(sub, photo.filename)

                    if os.path.exists(target):
                        continue

                    # Download via the authenticated session
                    try:
                        versions = getattr(photo, "versions", {})
                        # Pick the original version; fall back to any version
                        version_obj = None
                        for _key, _ver in versions.items():
                            if "original" in str(_key).lower():
                                version_obj = _ver
                                break
                        if version_obj is None and versions:
                            version_obj = next(iter(versions.values()))
                        if version_obj is None:
                            continue

                        url = getattr(version_obj, "url", None)
                        if not url:
                            continue

                        resp = shared_svc.session.get(url, stream=True)
                        resp.raise_for_status()
                        with open(target, "wb") as f:
                            for chunk in resp.iter_content(chunk_size=8192):
                                if chunk:
                                    f.write(chunk)
                        downloaded += 1

                    except Exception as dl_exc:
                        logs.append(("warning",
                                     f"Failed to download '{photo.filename}': {dl_exc}"))

            except Exception as exc:
                logs.append(("warning",
                             f"Error iterating cross-zone album '{alb_name}': {exc}"))
                continue

            if downloaded > 0:
                logs.append(("info",
                             f"Downloaded {downloaded} SharedSync photo(s) "
                             f"for album '{alb_name}'"))

        return logs

    async def _sync_shared_photos_by_ps_albums(
        self, job: dict, run_id: str, job_id: int, albums: List[str]
    ) -> None:
        """
        Async wrapper: runs _run_shared_album_sync_blocking in a thread
        executor so it does not block the event loop, then logs all messages.
        """
        if not albums or not job.get("library"):
            return
        loop = asyncio.get_event_loop()
        logs: List[tuple] = await loop.run_in_executor(
            None,
            self._run_shared_album_sync_blocking,
            job, albums, run_id,
        )
        for level, msg in logs:
            await self._log(run_id, job_id, level, msg)

    def _resolve_output_dir(self, job: dict) -> str:
        # Always use the base output directory.
        # Year and album sub-paths are handled via --folder-structure so the
        # order is always: base / year / album / photo.jpg
        return job.get("output_dir", "/data/photos")

    def _build_command(self, job: dict, run_id: str,
                       library: Optional[str] = None,
                       album_override: Optional[str] = None,
                       shared_library_root: bool = False) -> list:
        """
        Build the icloudpd command for one sync run.

        album_override: when set, use this album name instead of job['album'].
          This is used in multi-album mode so each album gets its own subfolder.
        shared_library_root: when True, downloads go into <output_dir>/Shared Library/
          so shared photos are kept separate from the per-album personal photos.
        """
        base_dir = self._resolve_output_dir(job)
        if shared_library_root:
            # Use dedicated shared dir if configured, otherwise a "Shared Library"
            # subfolder inside the main output dir.
            output_dir = job.get("shared_output_dir") or os.path.join(base_dir, "Shared Library")
        else:
            output_dir = base_dir
        os.makedirs(output_dir, exist_ok=True)

        cmd = [
            "icloudpd",
            "--username", job["username"],
            "--password", job["password"],
            "--directory", output_dir,
            "--cookie-directory", COOKIE_DIR,
            "--no-progress-bar",
            "--log-level", "info",
        ]

        # Library override — None means Personal Library (no flag needed)
        if library:
            cmd.extend(["--library", library])

        # Resolve the effective album for this run
        album = album_override or job.get("album", "All Photos") or "All Photos"

        # Always pass --album when a specific album is selected
        if album != "All Photos":
            cmd.extend(["--album", album])

        # --folder-structure controls the subfolder layout inside output_dir.
        #
        # When organize_by_album is True the album name becomes part of the path.
        # We always use the actual album name (never "All Photos").
        #
        #   organize_by_year + organize_by_album → {:%Y}/Album Name
        #   organize_by_year only               → {:%Y}
        #   organize_by_album only              → Album Name
        #   neither                             → none
        #
        use_album_folder = job.get("organize_by_album") and album != "All Photos"
        date_fmt = job.get("folder_structure") or "{:%Y}"
        safe_album = album.replace("/", "_").replace("\\", "_") if use_album_folder else ""

        if job.get("organize_by_year") and use_album_folder:
            folder_struct = f"{date_fmt}/{safe_album}"
        elif job.get("organize_by_year"):
            folder_struct = date_fmt
        elif use_album_folder:
            folder_struct = safe_album
        else:
            folder_struct = "none"

        cmd.extend(["--folder-structure", folder_struct])

        # Date range filtering by photo creation date (the date the photo was taken).
        # icloudpd uses --skip-created-before / --skip-created-after (skip = exclude),
        # so "from date" maps to --skip-created-before, "to date" to --skip-created-after.
        if job.get("date_from"):
            try:
                date.fromisoformat(job["date_from"])  # validate format
                cmd.extend(["--skip-created-before", job["date_from"]])
            except ValueError:
                pass
        if job.get("date_to"):
            try:
                date.fromisoformat(job["date_to"])  # validate format
                cmd.extend(["--skip-created-after", job["date_to"]])
            except ValueError:
                pass

        return cmd

    async def _auto_trust(self, proc: asyncio.subprocess.Process, run_id: str, job_id: int):
        """Automatically answer 'y' to icloudpd trust-device prompts."""
        await asyncio.sleep(0.3)
        if proc.stdin:
            try:
                proc.stdin.write(b"y\n")
                await proc.stdin.drain()
                await self._log(run_id, job_id, "info", "Auto-answered trust prompt with 'y'")
            except Exception:
                pass

    async def _drain_process(self, proc: asyncio.subprocess.Process,
                             run_id: str, job_id: int) -> int:
        """
        Reads all output from proc, logs it, handles 2FA. Returns the exit code.

        Uses a per-read timeout so we can:
         • Log a heartbeat every HEARTBEAT_INTERVAL seconds of silence (so the
           user can see the process is still alive during large downloads).
         • Automatically kill the process after STALL_TIMEOUT seconds of silence.
        """
        loop = asyncio.get_running_loop()
        silent_since = loop.time()
        last_heartbeat_logged = loop.time()

        try:
            while True:
                try:
                    line = await asyncio.wait_for(
                        proc.stdout.readline(), timeout=HEARTBEAT_INTERVAL
                    )
                except asyncio.TimeoutError:
                    # No output in the last HEARTBEAT_INTERVAL seconds.
                    silent_for = loop.time() - silent_since
                    mins = int(silent_for // 60)
                    secs = int(silent_for % 60)

                    if silent_for >= STALL_TIMEOUT:
                        await self._log(
                            run_id, job_id, "warning",
                            f"No output for {mins}m {secs}s — process appears stalled, killing."
                        )
                        proc.kill()
                        break

                    # Only log the heartbeat once per interval (avoid duplicates)
                    now = loop.time()
                    if now - last_heartbeat_logged >= HEARTBEAT_INTERVAL:
                        await self._log(
                            run_id, job_id, "info",
                            f"icloudpd running silently… ({mins}m {secs}s without output, "
                            f"stall timeout in {int((STALL_TIMEOUT - silent_for) // 60)}m)"
                        )
                        last_heartbeat_logged = now
                    continue

                if not line:
                    break

                # Got a line — reset the silence timer
                silent_since = loop.time()
                last_heartbeat_logged = loop.time()

                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue

                level = "info"
                lower = text.lower()
                if "error" in lower or "failed" in lower:
                    level = "error"
                elif "warning" in lower or "warn" in lower:
                    level = "warning"
                elif "downloaded" in lower or "uploading" in lower:
                    level = "success"

                if any(p in lower for p in TRUST_PATTERNS):
                    level = "warning"
                    asyncio.create_task(self._auto_trust(proc, run_id, job_id))
                elif any(p in lower for p in TWO_FA_PATTERNS):
                    self.needs_2fa[run_id] = True
                    level = "warning"

                await self._log(run_id, job_id, level, text)

        except Exception as e:
            await self._log(run_id, job_id, "error", f"Output reader error: {e}")

        return await proc.wait()

    async def _log(self, run_id: str, job_id: int, level: str, message: str):
        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "INSERT INTO logs (run_id, job_id, timestamp, level, message) VALUES (?, ?, ?, ?, ?)",
                (run_id, job_id, datetime.now(timezone.utc).isoformat(), level, message),
            )
            await db.commit()

    async def _finish_run(self, run_id: str, job_id: int, status: str):
        async with aiosqlite.connect(DB_PATH) as db:
            now = datetime.now(timezone.utc).isoformat()
            await db.execute(
                "UPDATE runs SET finished_at=?, status=? WHERE id=?",
                (now, status, run_id),
            )
            await db.execute(
                "UPDATE jobs SET last_run_status=?, updated_at=? WHERE id=?",
                (status, now, job_id),
            )
            await db.commit()


process_manager = ProcessManager()
