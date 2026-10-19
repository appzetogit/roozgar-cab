# Database backups

Nightly backup of every MongoDB database on the production server, with a
weekly test that the backup actually restores.

| File | Installed at |
|---|---|
| `roozgarcab-db-backup` | `/usr/local/bin/roozgarcab-db-backup` (700, root) |
| `roozgarcab-db-restore-test` | `/usr/local/bin/roozgarcab-db-restore-test` (700, root) |
| `roozgarcab-db-backup.cron` | `/etc/cron.d/roozgarcab-db-backup` (644) |

Logs go to `/var/log/roozgarcab-db-backup.log` (rotated monthly, 6 kept).
Archives go to `/var/backups/roozgarcab-mongo/` (root only), newest 14 kept.
`/var/backups/roozgarcab-mongo/LAST_RUN` holds the result of the latest night.

## Check it is working

```
cat /var/backups/roozgarcab-mongo/LAST_RUN
tail -20 /var/log/roozgarcab-db-backup.log
```

`LAST_RUN` should say `OK` and be less than a day old.

## Restore

Restoring over production replaces live data - stop the API first
(`pm2 stop all`) and be sure.

```
# side by side, safe: restores the newest archive into roozgarcab_restore_test,
# compares counts with production and drops the copy
/usr/local/bin/roozgarcab-db-restore-test

# over production, from a chosen archive
mongorestore --uri "mongodb://127.0.0.1:27017" --gzip --oplogReplay --drop \
  --archive=/var/backups/roozgarcab-mongo/roozgarcab-mongo-YYYYMMDD-HHMMSS.archive.gz
```

## Not done yet

The archives live on the same disk as the database. Losing the server loses
both. They need copying off the server - see the open item in the ops notes.
