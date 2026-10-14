#!/bin/sh
# Container entrypoint.
#
# The image runs as the unprivileged "node" user (UID 1000) by default. Mounted data and log
# directories must be writable by that user; this script checks them up front and explains how to
# fix a mount that isn't, instead of letting the app fail later with a bare EACCES.
#
# Opt-in: if the container is started as root (--user root / user: root), the directories are
# given to node automatically and the app is then started as node.
set -e

data_dir="$(dirname "${SQLITE_PATH:-/app/data/messaging-db.sqlite}")"
log_dir="${LOG_DIR:-/app/logs}"
uses_sqlite=false
case "${DB_TYPE:-sqlite}" in sqlite | SQLITE | "") uses_sqlite=true ;; esac

if [ "$(id -u)" = "0" ]; then
    node_uid="$(id -u node)"
    for dir in "$data_dir" "$log_dir"; do
        mkdir -p "$dir"
        # Only walk the directory when its owner is wrong, so restarts stay fast
        if [ "$(stat -c %u "$dir")" != "$node_uid" ]; then
            echo "docker-entrypoint: giving node (UID $node_uid) ownership of $dir"
            chown -R node:node "$dir"
        fi
    done
    exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

# Running as a regular user: check the directories and say exactly how to fix them
explain() {
    dir="$1"
    owner="$(stat -c '%u:%g' "$dir" 2>/dev/null || echo unknown)"
    echo "docker-entrypoint: $dir is not writable by UID $(id -u) (directory owner: $owner)."
    echo "  Fix it on the host (one time):  sudo chown -R $(id -u):$(id -g) <host folder mounted at $dir>"
    echo "  Or use a named volume instead of a bind mount, or start the container once with --user root"
    echo "  (user: root in Compose) to fix ownership automatically."
}

if [ ! -w "$log_dir" ]; then
    explain "$log_dir"
    echo "  Continuing with logs on stdout only."
fi

if [ "$uses_sqlite" = true ] && [ ! -w "$data_dir" ]; then
    explain "$data_dir"
    echo "  The SQLite database can't be stored, so the app can't start."
    exit 1
fi

exec "$@"
