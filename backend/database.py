import aiosqlite
import os

DB_PATH = os.environ.get("DB_PATH", "/app-data/jobs.db")


async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                library TEXT,
                album TEXT DEFAULT 'All Photos',
                output_dir TEXT NOT NULL DEFAULT '/data/photos',
                organize_by_album INTEGER DEFAULT 1,
                organize_by_year INTEGER DEFAULT 1,
                folder_structure TEXT DEFAULT '{:%Y}',
                date_from TEXT,
                date_to TEXT,
                schedule_enabled INTEGER DEFAULT 0,
                cron_expression TEXT DEFAULT '0 2 * * *',
                enabled INTEGER DEFAULT 1,
                last_run_at TEXT,
                last_run_status TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                job_id INTEGER NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL DEFAULT 'running',
                FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                job_id INTEGER NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                level TEXT NOT NULL DEFAULT 'info',
                message TEXT NOT NULL,
                FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_logs_run_id ON logs(run_id);
            CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
        """)

        # ── Migrations ────────────────────────────────────────────────────────
        # Add columns that were introduced after the initial schema.
        # ALTER TABLE … ADD COLUMN is idempotent-safe when wrapped in a try/except.
        migrations = [
            "ALTER TABLE jobs ADD COLUMN library TEXT",
            "ALTER TABLE jobs ADD COLUMN include_shared_library INTEGER DEFAULT 0",
            "ALTER TABLE jobs ADD COLUMN sync_favorites INTEGER DEFAULT 0",
            "ALTER TABLE jobs ADD COLUMN shared_output_dir TEXT",
        ]
        for sql in migrations:
            try:
                await db.execute(sql)
            except Exception:
                pass  # column already exists

        await db.commit()
