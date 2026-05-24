# Storage backends — S3 vs HDD

Furan ships two storage backends behind the same `@furan/storage` interface:
**S3** (the default, bundled MinIO or a real cloud bucket) and **HDD** (the
local filesystem on a shared volume). This runbook explains when to pick each
and how to switch.

**TL;DR:**

- Default install → leave it on **S3** (MinIO bundled in compose).
- Single-host install where MinIO is overhead you do not want → **HDD**.
- Production-grade multi-node or cloud install → **S3** (AWS S3, GCS via
  S3 API, or self-hosted MinIO).

## 1. Backend comparison

| Property            | S3 (MinIO bundled)                                                                            | HDD (filesystem)                                                           |
| ------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Compose services    | postgres, redis, minio, minio-init, api, capture-worker, diff-worker, integrations, dashboard | postgres, redis, api, capture-worker, diff-worker, integrations, dashboard |
| RAM at idle         | ~100 MB extra for MinIO                                                                       | none                                                                       |
| Disk usage          | `minio_data` volume                                                                           | `furan_hdd_data` volume                                                    |
| Multi-host scale    | yes (point all apps at one MinIO or AWS bucket)                                               | no (single host only)                                                      |
| Backup story        | MinIO mirror to off-host S3                                                                   | volume snapshot or rsync                                                   |
| Object versioning   | yes (MinIO/S3 native)                                                                         | no                                                                         |
| Network ops         | every read/write is a HTTP call                                                               | direct fs read/write                                                       |
| Path-traversal risk | n/a (key-space is flat)                                                                       | guarded by `safeJoin` in `hdd.ts`                                          |

## 2. How the toggle works

`STORAGE_KIND` in `.env` selects the implementation; `COMPOSE_PROFILES`
controls whether the MinIO service is started.

```
# .env
STORAGE_KIND=s3              # or `hdd`
HDD_ROOT=/var/lib/furan/storage   # only consulted when STORAGE_KIND=hdd
COMPOSE_PROFILES=s3          # or `hdd` (skips minio + minio-init)
```

The `@furan/storage` factory (`packages/storage/src/client.ts`) reads
`STORAGE_KIND` at boot and dispatches to `createS3Storage` or
`createHddStorage`. Unused env fields are ignored — you can leave the S3
credentials in `.env` even when running HDD mode.

## 3. Switch an install from S3 to HDD

1. Schedule downtime — there is no live-migration of bytes between
   backends in v1.0.
2. Export your MinIO data to a directory on the host:

   ```
   docker compose exec minio mc cp -r local/$MINIO_BUCKET /export
   docker cp $(docker compose ps -q minio):/export ./minio-export
   ```

3. Stop the stack:

   ```
   docker compose down
   ```

4. Update `.env`:

   ```
   STORAGE_KIND=hdd
   HDD_ROOT=/var/lib/furan/storage
   COMPOSE_PROFILES=hdd
   ```

5. Find the `furan_hdd_data` volume's host path and seed it with the
   exported bytes (key layout is preserved — the keys are the same
   strings the S3 backend used):

   ```
   docker volume inspect docker_furan_hdd_data --format '{{ .Mountpoint }}'
   # → e.g. /var/lib/docker/volumes/docker_furan_hdd_data/_data
   sudo cp -r ./minio-export/* /var/lib/docker/volumes/docker_furan_hdd_data/_data/
   ```

6. Bring the stack up:

   ```
   docker compose up -d
   ```

   The MinIO and minio-init services are NOT started because
   `COMPOSE_PROFILES=hdd`. The api/capture/diff containers mount
   `furan_hdd_data` at `/var/lib/furan/storage` and read/write the
   bytes you copied in step 5.

## 4. Switch an install from HDD to S3

Mirror of §3 with MinIO as the destination:

1. Stop the stack.
2. Update `.env` (`STORAGE_KIND=s3`, `COMPOSE_PROFILES=s3`).
3. `docker compose up -d minio minio-init` — wait for the bucket to exist.
4. `mc cp -r /var/lib/docker/volumes/docker_furan_hdd_data/_data
local/$MINIO_BUCKET` from a sidecar with `mc` installed and access
   to the host volume mount.
5. `docker compose up -d`.

## 5. Backup considerations

**S3 mode:** the canonical backup story is `mc mirror` to an off-host S3
bucket (AWS, Backblaze B2, R2). Volume-level snapshots of `minio_data`
also work but recover slower because MinIO has to rescan keys at boot.

**HDD mode:** snapshot `furan_hdd_data` directly. The directory is
content-addressed at the key level (screenshots use the SHA-256 of the
PNG bytes as the key suffix), so deduplicated backups (`borg`, `restic`)
are very efficient — the same screenshot taken from N runs is one file.
A nightly `rsync -a` of the volume's host path to a separate disk is
the minimum acceptable backup; combine with the Postgres dump in
[`restore-from-backup.md`](./restore-from-backup.md) for a complete
metadata + bytes pair.

## 6. Retention

The retention CLI lives in `apps/diff-worker/src/cli/retention.ts` and
deletes objects via `storage.delete()` — so it works under both
backends without modification. The CLI's TTL configuration is in the
existing operator docs; no HDD-specific tuning is needed.

## 7. Common pitfalls

- **Mixed-mode containers.** If the api is on HDD but the capture-worker
  is still on S3, you will get phantom missing screenshots because they
  are written to MinIO but the api looks on disk. The compose file
  forces all three apps to share `STORAGE_KIND` from the same `.env`,
  so this only bites if you hand-edit a container's env.
- **Volume not seeded after switching from S3.** The api boots fine,
  but every existing run's screenshots return 404 because the bytes
  never made it into the volume. Always do the export+copy in §3 step
  5 before the first `docker compose up -d`.
- **`COMPOSE_PROFILES` unset.** With no profile selected, MinIO does
  not start — but if you also forgot `STORAGE_KIND=hdd`, the api will
  try to dial `minio:9000` and fail. The fix is one line: add
  `COMPOSE_PROFILES=s3` (or `=hdd`) to `.env`. New installs ship the
  line in `.env.example`; old installs need a manual edit.
- **Path traversal**. The HDD backend rejects any key containing `..`
  or absolute prefixes. If you see `storage_hdd_invalid_key` in the
  logs, something upstream is constructing keys badly — the safe-key
  guard is doing its job. Do not work around it by relaxing the check;
  fix the caller.
