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
