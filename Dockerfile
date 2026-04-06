# syntax=docker/dockerfile:1
# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend

# Copy lock files first so this layer is only rebuilt when dependencies change
COPY frontend/package.json frontend/package-lock.json ./

# --mount=type=cache keeps the npm cache across builds (much faster rebuilds)
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY frontend/ .
RUN npm run build


# ── Stage 2: Python backend + icloudpd ───────────────────────────────────────
FROM python:3.12-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (icloudpd binary wheel for the CLI)
COPY backend/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# pyicloud_ipd and foundation are vendored from icloudpd v1.32.2 source.
# The icloudpd PyPI wheel ships only PyInstaller binaries so the library
# source is not otherwise accessible as an importable Python package.
COPY backend/vendor /opt/pyicloud_ipd_src

# Add the extracted source to Python's search path
ENV PYTHONPATH=/opt/pyicloud_ipd_src

# Copy backend source
COPY backend/ .

# Copy built frontend into backend's static folder
# (vite.config outDir is ../backend/static, so the build goes to /app/backend/static in stage 1)
COPY --from=frontend-build /app/backend/static ./static

# Create default mount-point directories so the container starts cleanly
# even before docker-compose volumes are attached
RUN mkdir -p /app-data/cookies /photos

# Copy entrypoint script that handles PUID/PGID remapping
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s \
  CMD curl -f http://localhost:8000/api/stats || exit 1

# Entrypoint remaps UID/GID then drops privileges before starting uvicorn
ENTRYPOINT ["/entrypoint.sh"]
