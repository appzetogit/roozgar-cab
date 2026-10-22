# Deployment

Copies of the production server config, so a rebuilt box can be brought back to
the same state. These files are **not** applied automatically — they are a record
of what is running.

Live on `roozgarcab.com`:

| File | Installed at |
|---|---|
| `nginx/roozgarcab.conf` | `/etc/nginx/sites-available/roozgarcab` (symlinked into `sites-enabled`) |
| `nginx/roozgarcab-upstream.conf` | `/etc/nginx/conf.d/roozgarcab-upstream.conf` |

The app itself runs under PM2 as four instances (`roozgarcab-api-5000` … `5003`),
which nginx load-balances via the upstream block.

## Frontend deploys

```
cd Backend/../frontend && npm run build
rsync -a --delete dist/ /var/www/roozgarcab/
```

`--delete` is deliberate: it clears the previous build's hashed asset files so
they do not accumulate.

### Why `index.html` must not be cached

`index.html` names the hashed chunks, and each deploy replaces them and removes
the previous set. If a browser holds a stale `index.html`, it requests chunk
filenames that no longer exist, gets 404s, and renders a **blank page** — the
shell paints but nothing else does.

This happened in production: `index.html` was served with only `Last-Modified`
and `ETag`, so browsers cached it heuristically, and anyone with a page open
across a deploy got a blank screen until they hard-refreshed.

The config therefore splits the two:

- `location = /index.html` → `no-cache, must-revalidate`
- `location /assets/` → `public, immutable`, one year

The entry point is revalidated every visit; the fingerprinted assets it points to
are cached hard. Keep that split if the config is ever rewritten.

## Backend deploys

Backend changes need no build. After editing files under `Backend/`:

```
pm2 restart roozgarcab-api-5000 roozgarcab-api-5001 roozgarcab-api-5002 roozgarcab-api-5003 --update-env
```

`--update-env` matters when `.env` has changed; without it the processes keep
their old environment.

---

# Installing on a shared server (`deploy.sh`)

`deploy/deploy.sh` sets Roozgar Cab up next to other projects without touching
them. It is run **as root on the server**.

What it isolates:

| Thing | Roozgar Cab's own copy |
|---|---|
| Linux user | `roozgarcab` (no login password, home `/opt/roozgarcab`) |
| Code | `/opt/roozgarcab/app` (cloned from GitHub) |
| Node + PM2 | private Node under `/opt/roozgarcab/node`; the system Node is not used or changed |
| PM2 | own `PM2_HOME` and systemd unit `pm2-roozgarcab`; root's PM2 and other apps are not touched |
| Ports | 1 free port picked from 5100 up (more with `INSTANCES=n` plus Redis), saved in `/opt/roozgarcab/ports.env` |
| nginx | only `roozgarcab-*` files; `nginx -t` must pass before and after, and it rolls back if not; only a graceful `reload` |
| Web files | `/var/www/roozgarcab` |
| Database | its own database name (`roozgarcab_taxi`); Mongo/Redis are never installed or changed |

## Steps

1. Log in with an SSH **key** (not the root password in chat), then:
   ```
   git clone https://github.com/appzetogit/roozgar-cab.git /root/roozgar-deploy
   cd /root/roozgar-deploy/deploy && chmod +x deploy.sh
   ./deploy.sh preflight        # read-only; shows what is already on the box
   ```
2. `./deploy.sh install`. On first run it creates `/opt/roozgarcab/app/Backend/.env`
   with a random `JWT_SECRET`, then stops. Edit that file (`MONGODB_URI`, SMS keys),
   fill `frontend/.env.production` if you use Firebase push or Maps, and run
   `./deploy.sh install` again.
3. Point DNS (below), wait until `getent hosts roozgarcab.com` shows the server IP.
4. `LE_EMAIL=you@example.com ./deploy.sh ssl` issues the certificate for
   `roozgarcab.com` and `www.roozgarcab.com` only.
5. Later deploys: `./deploy.sh update` (pulls `main`, rebuilds, restarts only this app).

## DNS records (at the domain registrar / DNS host)

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | `145.223.21.188` | 300 |
| A | `www` | `145.223.21.188` | 300 |
| AAAA | — | add only if the server has an IPv6 address; otherwise do not add one | |

Remove any old A/AAAA/CNAME for `@` or `www` that points elsewhere. If the domain
uses Cloudflare, set the records to "DNS only" (grey cloud) until the certificate
is issued.

## After the first install

- Create the first admin with `node scripts/seedRoozgarCabAdmin.js` (as the
  `roozgarcab` user, from `/opt/roozgarcab/app/Backend`) and change its password.
- Set Razorpay / PhonePe / Cloudinary keys in the admin panel.
- Optional: nightly DB backups, see `ops/backup/`.
