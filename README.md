# iCloud Sync Manager

A self-hosted web app that syncs photos from your iCloud Photo Library to a local folder using [icloudpd](https://github.com/icloud-photos-downloader/icloud_photos_downloader).

## Quick Start

```bash
# Build and launch
docker compose up -d --build

# Open the web UI
open http://localhost:8080
```

Photos are saved to `./data/photos/` on your host machine.

---

## Features

- **Album / library browsing** — click "Fetch from iCloud" in the job form to load all your albums automatically
- **Flexible folder structure** — organise photos by album name, year, month, or any strftime pattern
- **Date range filtering** — limit a sync job to photos taken between two dates (requires icloudpd ≥ 1.21)
- **Cron scheduling** — each job has its own schedule (e.g. every night at 2 AM)
- **Live log streaming** — watch sync progress in real time in the browser
- **2FA support** — if iCloud asks for a verification code, a prompt appears in the UI

## Configuration

Edit `docker-compose.yml` to change paths and settings:

```yaml
volumes:
  - ./data:/app-data       # ← change left side to move the database & cookies
  - ./photos:/photos       # ← change left side to any folder for your photos

environment:
  PHOTOS_DIR: /photos      # default output_dir pre-filled in new jobs
  DB_PATH: /app-data/jobs.db
  COOKIE_DIR: /app-data/cookies
  TZ: Europe/Stockholm     # timezone for log timestamps
```

### Environment variables

| Variable      | Default                | Description                                      |
|---------------|------------------------|--------------------------------------------------|
| `DB_PATH`     | `/app-data/jobs.db`    | SQLite database file path inside the container   |
| `COOKIE_DIR`  | `/app-data/cookies`    | iCloud session cookie directory                  |
| `PHOTOS_DIR`  | `/photos`              | Default photos output dir (pre-fills new jobs)   |
| `TZ`          | `Europe/Stockholm`     | Timezone for log timestamps                      |

### Volumes

The data and photos directories are **completely separate** — point them wherever you like:

| Purpose              | Container path  | Example host path         |
|----------------------|-----------------|---------------------------|
| Database + cookies   | `/app-data`     | `./data`, `/opt/icloud`   |
| Downloaded photos    | `/photos`       | `./photos`, `/mnt/nas/icloud`, `/Volumes/MyDrive/Photos` |

Example with a NAS mount:
```yaml
volumes:
  - ./data:/app-data
  - /mnt/nas/icloud:/photos
environment:
  PHOTOS_DIR: /photos
```

To change the web port:
```yaml
ports:
  - "9090:8000"
```

## Authentication

1. Enter your regular **Apple ID and password** when creating a sync job — no app-specific password needed.
2. The first sync will trigger a **2FA prompt** on your trusted Apple device. Enter the code in the prompt that appears inline in the live logs.
3. The iCloud session is then saved to `./data/cookies/` and **2FA won't be required again** for that account, even after restarting the container.

## Folder Structure Examples

Year always comes first, then the album name:

| Setting                          | Result path                           |
|----------------------------------|---------------------------------------|
| Year + Album                     | `/photos/2023/Holidays/img.jpg`       |
| Year/Month + Album               | `/photos/2023/06/Holidays/img.jpg`    |
| Year only (no album grouping)    | `/photos/2023/img.jpg`                |
| Album only (no year grouping)    | `/photos/Holidays/img.jpg`            |
| No grouping                      | `/photos/img.jpg`                     |

## Stopping

```bash
docker compose down
```

Data in `./data/` is preserved between restarts.
