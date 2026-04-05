import asyncio
import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional, Dict, Any
import uuid

import aiosqlite
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import DB_PATH, init_db
from sync_worker import process_manager, COOKIE_DIR, TWO_FA_PATTERNS, TRUST_PATTERNS

DEFAULT_PHOTOS_DIR = "/photos"

# ── Scheduler ────────────────────────────────────────────────────────────────

scheduler = AsyncIOScheduler(timezone="UTC")


async def scheduled_job_runner(job_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id=? AND enabled=1", (job_id,)) as cur:
            row = await cur.fetchone()
    if row:
        job = dict(row)
        if not process_manager.is_running(job_id):
            await process_manager.start_job(job)


def schedule_job(job: dict):
    job_id = job["id"]
    scheduler_job_id = f"job_{job_id}"
    # Remove existing schedule if any
    if scheduler.get_job(scheduler_job_id):
        scheduler.remove_job(scheduler_job_id)
    if job.get("schedule_enabled") and job.get("cron_expression") and job.get("enabled"):
        try:
            trigger = CronTrigger.from_crontab(job["cron_expression"])
            scheduler.add_job(
                scheduled_job_runner,
                trigger=trigger,
                args=[job_id],
                id=scheduler_job_id,
                replace_existing=True,
            )
        except Exception as e:
            print(f"Failed to schedule job {job_id}: {e}")


def unschedule_job(job_id: int):
    scheduler_job_id = f"job_{job_id}"
    if scheduler.get_job(scheduler_job_id):
        scheduler.remove_job(scheduler_job_id)


# ── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — ensure directories exist
    os.makedirs(DEFAULT_PHOTOS_DIR, exist_ok=True)
    os.makedirs(COOKIE_DIR, exist_ok=True)
    await init_db()
    scheduler.start()

    # Re-schedule all enabled jobs
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE schedule_enabled=1 AND enabled=1") as cur:
            rows = await cur.fetchall()
    for row in rows:
        schedule_job(dict(row))

    yield

    # Shutdown
    scheduler.shutdown(wait=False)


app = FastAPI(title="iCloud Sync", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Pydantic models ───────────────────────────────────────────────────────────

class JobCreate(BaseModel):
    name: str
    username: str
    password: str
    library: Optional[str] = None          # SharedSync library name (auto-detected)
    include_shared_library: bool = False   # run a second pass with --library if True
    album: str = "All Photos"
    output_dir: str = DEFAULT_PHOTOS_DIR
    shared_output_dir: Optional[str] = None  # separate dir for SharedSync; falls back to output_dir
    organize_by_album: bool = True
    sync_favorites: bool = False           # include Favorites system album in per-album sync
    organize_by_year: bool = True
    folder_structure: str = "{:%Y}"
    date_from: Optional[str] = None        # ISO date string YYYY-MM-DD
    date_to: Optional[str] = None          # ISO date string YYYY-MM-DD
    schedule_enabled: bool = False
    cron_expression: str = "0 2 * * *"
    enabled: bool = True


class JobUpdate(BaseModel):
    name: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    library: Optional[str] = None
    include_shared_library: Optional[bool] = None
    album: Optional[str] = None
    output_dir: Optional[str] = None
    shared_output_dir: Optional[str] = None
    organize_by_album: Optional[bool] = None
    sync_favorites: Optional[bool] = None
    organize_by_year: Optional[bool] = None
    folder_structure: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    schedule_enabled: Optional[bool] = None
    cron_expression: Optional[str] = None
    enabled: Optional[bool] = None


class AlbumListRequest(BaseModel):
    username: str
    password: str


class TwoFAInput(BaseModel):
    code: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def job_to_dict(row) -> dict:
    d = dict(row)
    # Convert SQLite integers to Python bools
    for key in ("organize_by_album", "organize_by_year", "schedule_enabled",
                "enabled", "include_shared_library", "sync_favorites"):
        if key in d:
            d[key] = bool(d[key])
    return d


# ── Job Routes ────────────────────────────────────────────────────────────────

@app.get("/api/jobs")
async def list_jobs():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs ORDER BY created_at DESC") as cur:
            rows = await cur.fetchall()

    jobs = []
    for row in rows:
        j = job_to_dict(row)
        j["is_running"] = process_manager.is_running(j["id"])
        run_id = process_manager.get_run_id(j["id"])
        j["run_id"] = run_id
        j["needs_2fa"] = process_manager.check_needs_2fa(run_id) if run_id else False
        jobs.append(j)
    return jobs


@app.post("/api/jobs", status_code=201)
async def create_job(body: JobCreate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """INSERT INTO jobs (name, username, password, library, include_shared_library,
               album, output_dir, shared_output_dir,
               organize_by_album, sync_favorites, organize_by_year, folder_structure,
               date_from, date_to, schedule_enabled, cron_expression, enabled)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                body.name, body.username, body.password, body.library,
                int(body.include_shared_library),
                body.album, body.output_dir, body.shared_output_dir,
                int(body.organize_by_album), int(body.sync_favorites),
                int(body.organize_by_year),
                body.folder_structure, body.date_from, body.date_to,
                int(body.schedule_enabled), body.cron_expression, int(body.enabled),
            ),
        )
        await db.commit()
        job_id = cur.lastrowid
        async with db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)) as c:
            row = await c.fetchone()

    job = job_to_dict(row)
    schedule_job(job)
    return job


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Job not found")
    j = job_to_dict(row)
    j["is_running"] = process_manager.is_running(job_id)
    j["run_id"] = process_manager.get_run_id(job_id)
    return j


@app.put("/api/jobs/{job_id}")
async def update_job(job_id: int, body: JobUpdate):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)) as cur:
            row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "Job not found")

        updates = body.model_dump(exclude_none=True)
        if not updates:
            return job_to_dict(row)

        # Convert bools to int for SQLite
        for key in ("organize_by_album", "organize_by_year", "schedule_enabled",
                    "enabled", "include_shared_library", "sync_favorites"):
            if key in updates:
                updates[key] = int(updates[key])

        set_clause = ", ".join(f"{k}=?" for k in updates)
        values = list(updates.values()) + [datetime.now(timezone.utc).isoformat(), job_id]
        await db.execute(
            f"UPDATE jobs SET {set_clause}, updated_at=? WHERE id=?", values
        )
        await db.commit()

        async with db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)) as c:
            updated_row = await c.fetchone()

    job = job_to_dict(updated_row)
    schedule_job(job)
    return job


@app.delete("/api/jobs/{job_id}", status_code=204)
async def delete_job(job_id: int):
    if process_manager.is_running(job_id):
        await process_manager.stop_process(job_id)
    unschedule_job(job_id)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM logs WHERE job_id=?", (job_id,))
        await db.execute("DELETE FROM runs WHERE job_id=?", (job_id,))
        await db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        await db.commit()
    return Response(status_code=204)


# ── Run control ───────────────────────────────────────────────────────────────

@app.post("/api/jobs/{job_id}/run")
async def run_job(job_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Job not found")
    if process_manager.is_running(job_id):
        raise HTTPException(409, "Job is already running")
    job = job_to_dict(row)
    run_id = await process_manager.start_job(job)
    return {"run_id": run_id, "status": "started"}


@app.post("/api/jobs/{job_id}/stop")
async def stop_job(job_id: int):
    if not process_manager.is_running(job_id):
        raise HTTPException(409, "Job is not running")
    await process_manager.stop_process(job_id)
    return {"status": "stopped"}


@app.post("/api/runs/{run_id}/2fa")
async def send_2fa(run_id: str, body: TwoFAInput):
    await process_manager.send_input(run_id, body.code)
    return {"status": "sent"}


# ── Run history & logs ────────────────────────────────────────────────────────

@app.get("/api/jobs/{job_id}/runs")
async def list_runs(job_id: int, limit: int = 20):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM runs WHERE job_id=? ORDER BY started_at DESC LIMIT ?",
            (job_id, limit),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/runs/{run_id}/logs")
async def get_logs(run_id: str, limit: int = 500):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM logs WHERE run_id=? ORDER BY id DESC LIMIT ?",
            (run_id, limit),
        ) as cur:
            rows = await cur.fetchall()
    return list(reversed([dict(r) for r in rows]))


@app.get("/api/runs/{run_id}/logs/stream")
async def stream_logs(run_id: str):
    """SSE endpoint — streams new log lines in real time."""

    async def event_generator():
        last_id = 0
        # Send existing logs first
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM logs WHERE run_id=? ORDER BY id", (run_id,)
            ) as cur:
                rows = await cur.fetchall()
        for row in rows:
            d = dict(row)
            last_id = d["id"]
            yield f"data: {json.dumps(d)}\n\n"

        # Tail for new logs while process runs
        while True:
            await asyncio.sleep(0.5)
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute(
                    "SELECT * FROM logs WHERE run_id=? AND id>? ORDER BY id",
                    (run_id, last_id),
                ) as cur:
                    rows = await cur.fetchall()
            for row in rows:
                d = dict(row)
                last_id = d["id"]
                yield f"data: {json.dumps(d)}\n\n"

            # Stop streaming once the run is finished (or not found)
            async with aiosqlite.connect(DB_PATH) as db:
                db.row_factory = aiosqlite.Row
                async with db.execute(
                    "SELECT status FROM runs WHERE id=?", (run_id,)
                ) as cur:
                    run = await cur.fetchone()
            if not run or run["status"] not in ("running",):
                status = run["status"] if run else "error"
                yield f"data: {json.dumps({'__done__': True, 'status': status})}\n\n"
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/runs/{run_id}/status")
async def get_run_status(run_id: str):
    needs_2fa = process_manager.check_needs_2fa(run_id)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM runs WHERE id=?", (run_id,)) as cur:
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "Run not found")
    d = dict(row)
    d["needs_2fa"] = needs_2fa
    return d


# ── iCloud album listing (single-phase, supports 2FA) ────────────────────────
#
# Step 1: icloudpd --list-libraries  (silent — auto-detects SharedSync names)
# Step 2: icloudpd --list-albums     (Personal Library, no --library flag)
#
# stdout carries the actual names; stderr carries log messages and 2FA prompts.

_list_sessions: Dict[str, Dict[str, Any]] = {}
_SESSION_TTL = 7200  # seconds — expire listing sessions after 2 hours


def _make_session(username: str, password: str) -> dict:
    return {
        "albums": [],
        "shared_libraries": [],
        "log": [],
        "done": False,
        "status": "running",    # running | success | error
        "needs_2fa": False,
        "proc": None,
        "username": username,
        "password": password,
        "created_at": datetime.now(timezone.utc).timestamp(),
    }


def _purge_expired_sessions():
    """Remove listing sessions older than SESSION_TTL to prevent unbounded growth."""
    now = datetime.now(timezone.utc).timestamp()
    expired = [sid for sid, s in _list_sessions.items()
               if now - s.get("created_at", 0) > _SESSION_TTL]
    for sid in expired:
        _list_sessions.pop(sid, None)


# Matches lines that are icloudpd log output rather than actual names.
# e.g. "2026-04-05 09:29:23 INFO ..." or "2026-04-05 09:29:23 DEBUG ..."
_LOG_LINE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(INFO|DEBUG|WARNING|ERROR|CRITICAL)\b")


async def _run_icloudpd(session: dict, extra_args: list[str]) -> list[str]:
    """
    Runs icloudpd with the given extra args.
    Returns the list of names printed to stdout.
    Handles 2FA/trust via a single merged output stream so that prompts are
    detected regardless of whether icloudpd writes them to stdout or stderr.
    """
    cmd = [
        "icloudpd",
        "--username", session["username"],
        "--password", session["password"],
        "--cookie-directory", COOKIE_DIR,
        "--no-progress-bar",
    ] + extra_args

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,  # merge stderr into stdout so 2FA prompts are always visible
    )
    session["proc"] = proc

    names = []
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            continue
        session["log"].append(text)
        lower = text.lower()
        if any(p in lower for p in TRUST_PATTERNS):
            if proc.stdin:
                try:
                    proc.stdin.write(b"y\n")
                    await proc.stdin.drain()
                    session["log"].append("[auto] Answered trust prompt with 'y'")
                except Exception:
                    pass
        elif any(p in lower for p in TWO_FA_PATTERNS):
            session["needs_2fa"] = True
        elif not _LOG_LINE_RE.match(text):
            # Skip icloudpd section-header lines (e.g. "Albums:", "Libraries:")
            if text.endswith(":"):
                continue
            # Skip smart-album divider lines ("Smart Albums", "Smarta album", …)
            if "smart" in lower and "album" in lower:
                continue
            # Anything else is an actual name (album or library)
            names.append(text)

    await proc.wait()
    session["proc"] = None
    return names


async def _run_session(session_id: str):
    """Single-phase: silently detect shared libs, then list Personal Library albums."""
    session = _list_sessions[session_id]
    try:
        # Step 1 — discover libraries (no user interaction; just find SharedSync names)
        session["log"].append("→ Connecting to iCloud…")
        all_libs = await _run_icloudpd(session, ["--list-libraries"])
        shared = [l for l in all_libs if l.lower().startswith("sharedsync")]
        session["shared_libraries"] = shared
        if shared:
            session["log"].append(
                f"→ Found shared library: {', '.join(shared)}"
            )

        # Reset 2FA flag between steps (cookie is cached; 2FA won't be asked again)
        session["needs_2fa"] = False

        # Step 2 — list albums from Personal Library
        session["log"].append("→ Fetching albums…")
        albums = await _run_icloudpd(session, ["--list-albums"])
        session["albums"] = ["All Photos"] + albums
        session["status"] = "success"
    except Exception as e:
        session["log"].append(f"Error: {e}")
        session["status"] = "error"
    finally:
        session["done"] = True


@app.post("/api/icloud/list-session")
async def start_list_session(body: AlbumListRequest):
    """Start a listing session (discovers shared libs + lists Personal Library albums)."""
    _purge_expired_sessions()
    session_id = str(uuid.uuid4())
    _list_sessions[session_id] = _make_session(body.username, body.password)
    asyncio.create_task(_run_session(session_id))
    return {"session_id": session_id}


@app.get("/api/icloud/sessions/{session_id}")
async def get_list_session(session_id: str):
    session = _list_sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {
        "done":             session["done"],
        "status":           session["status"],
        "needs_2fa":        session["needs_2fa"],
        "albums":           session["albums"],
        "shared_libraries": session["shared_libraries"],
        "log":              session["log"],
    }


@app.post("/api/icloud/sessions/{session_id}/2fa")
async def send_2fa_to_list_session(session_id: str, body: TwoFAInput):
    session = _list_sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    proc = session.get("proc")
    if proc and proc.stdin:
        proc.stdin.write((body.code + "\n").encode())
        await proc.stdin.drain()
        session["needs_2fa"] = False
    return {"status": "sent"}




# ── Stats ─────────────────────────────────────────────────────────────────────

@app.get("/api/stats")
async def get_stats():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT COUNT(*) as c FROM jobs") as cur:
            total_jobs = (await cur.fetchone())["c"]
        async with db.execute("SELECT COUNT(*) as c FROM jobs WHERE enabled=1") as cur:
            active_jobs = (await cur.fetchone())["c"]
        async with db.execute(
            "SELECT COUNT(*) as c FROM runs WHERE status='success'"
        ) as cur:
            successful_runs = (await cur.fetchone())["c"]
        async with db.execute(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT 1"
        ) as cur:
            last_run = await cur.fetchone()

    return {
        "total_jobs": total_jobs,
        "active_jobs": active_jobs,
        "running_jobs": len(process_manager.run_ids),
        "successful_runs": successful_runs,
        "last_run": dict(last_run) if last_run else None,
    }


# ── Scheduled jobs info ───────────────────────────────────────────────────────

@app.get("/api/scheduler/jobs")
async def list_scheduled():
    jobs = []
    for job in scheduler.get_jobs():
        next_run = job.next_run_time
        jobs.append({
            "id": job.id,
            "next_run": next_run.isoformat() if next_run else None,
        })
    return jobs


# ── Serve React frontend ──────────────────────────────────────────────────────

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
