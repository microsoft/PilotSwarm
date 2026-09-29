#!/bin/bash
# The NFS server of the repo pod (docs/proposals/session-workspaces.md, section 5.2).
#
# It runs in a privileged container. The kernel NFS server (nfsd) of the node
# serves the exports, in this pod's network namespace, so the pod IP answers on
# port 2049. NFS 4.1 and 4.2 only: no rpcbind, no port 111.
#
# The exports come from /etc/exports.d/*.exports, for example:
#
#   /ws/a       *(rw,sync,no_subtree_check,root_squash,fsid=1)
#   /ws/shared  *(rw,sync,no_subtree_check,root_squash,fsid=2)
#
# Export paths are relative to NFS_ROOT (the nfs-utils `rootdir` setting). The
# NFSv4 root must be on a file system the kernel can export, and a container's
# own root is overlayfs, which it cannot export: a client then gets "No such
# file or directory". So the pod mounts a tmpfs at NFS_ROOT and the volume under
# it (NFS_ROOT/ws), and clients mount <server>:/ws/a, the same path the repo
# service and the workers use.
#
# A fixed fsid keeps file handles valid after a restart. nfsdcld keeps the list
# of clients; put its folder on the same volume as the exports, so that after a
# restart the server knows who may reclaim state.
#
# Environment:
#   NFS_ROOT           the folder export paths are relative to (default /srv/nfs)
#   NFSDCLD_DIR        the nfsdcld folder (default /var/lib/nfs/nfsdcld)
#   NFS_GRACE_SECONDS  how long clients may reclaim state after a start (default 30)
#   NFS_LEASE_SECONDS  the NFSv4 lease time (default 30)
#   NFS_THREADS        nfsd threads (default 16)
#
# On SIGTERM it stops nfsd and unexports. The container exits when any of its
# daemons exits, so Kubernetes restarts it.
set -euo pipefail

nfs_root=${NFS_ROOT:-/srv/nfs}
cld_dir=${NFSDCLD_DIR:-/var/lib/nfs/nfsdcld}
grace=${NFS_GRACE_SECONDS:-30}
lease=${NFS_LEASE_SECONDS:-30}
threads=${NFS_THREADS:-16}
# Debian's /etc/nfs.conf names this folder (pipefs-directory); nfsdcld talks to the kernel through it.
pipefs=/run/rpc_pipefs

log() { echo "[nfs-server] $*"; }

# Mounting the nfsd file system loads the nfsd module on the node if needed.
if ! mountpoint -q /proc/fs/nfsd; then
    if ! mount -t nfsd nfsd /proc/fs/nfsd; then
        log "cannot mount the nfsd file system: the container must be privileged, and the node kernel needs the nfsd module"
        exit 1
    fi
fi
mkdir -p "$pipefs" "$cld_dir"
mountpoint -q "$pipefs" || mount -t rpc_pipefs rpc_pipefs "$pipefs"

stop() {
    log "stopping"
    rpc.nfsd 0 || true
    exportfs -au || true
    # shellcheck disable=SC2046
    kill $(jobs -p) 2>/dev/null || true
    exit 0
}
trap stop TERM INT

if ! mountpoint -q "$nfs_root"; then
    log "$nfs_root is not a mount point: mount a tmpfs there (an emptyDir with medium Memory)"
    exit 1
fi
nfsconf --set exports rootdir "$nfs_root"

# The kernel asks nfsdcld, when nfsd starts, which clients may reclaim; so start it first.
nfsdcld -F -s "$cld_dir" &
exportfs -r
exportfs -v
rpc.mountd -F -N 2 -N 3 &
# Version 2 is gone from nfs-utils; 3 and 4.0 are switched off. -G and -L must
# be set before nfsd starts, and are.
rpc.nfsd -N 3 -N 4.0 -V 4.1 -V 4.2 -G "$grace" -L "$lease" "$threads"
log "serving on $(tr '\n' ' ' < /proc/fs/nfsd/portlist)"

# Any daemon that exits ends the container.
set +e
wait -n
log "a daemon exited; stopping"
rpc.nfsd 0
exportfs -au
exit 1
