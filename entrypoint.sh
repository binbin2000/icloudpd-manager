#!/bin/sh
set -e

# PUID / PGID remapping
# Supports PGID or GUID (GUID is an accepted alias for PGID)
PUID="${PUID:-1000}"
PGID="${PGID:-${GUID:-1000}}"

echo "Starting with PUID=${PUID}, PGID=${PGID}"

# Create the group with the requested GID if it does not already exist
if ! getent group "${PGID}" > /dev/null 2>&1; then
    groupadd -g "${PGID}" appgroup
fi
APP_GROUP="$(getent group "${PGID}" | cut -d: -f1)"

# Create the user with the requested UID/GID if it does not already exist
if ! getent passwd "${PUID}" > /dev/null 2>&1; then
    useradd -u "${PUID}" -g "${PGID}" -M -s /bin/sh appuser
fi
APP_USER="$(getent passwd "${PUID}" | cut -d: -f1)"

# Ensure the data and photos directories are owned by the target user/group
chown -R "${PUID}:${PGID}" /app-data /photos

# Drop privileges and run the application as the target user
exec gosu "${APP_USER}" uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
