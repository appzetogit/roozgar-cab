#!/usr/bin/env bash
# Roozgar Cab: isolated install and deploy for roozgarcab.com.
#
# Run as root ON THE SERVER. It is built to share a box with other projects:
#   - own Linux user (roozgarcab), own directory (/opt/roozgarcab)
#   - own Node + PM2, downloaded under /opt/roozgarcab (the system node, root's
#     PM2 and the other apps' processes are never touched)
#   - own PM2 home and its own systemd unit (pm2-roozgarcab)
#   - own nginx files, all named roozgarcab-*; no other nginx file is edited
#   - own free port block, chosen after checking what is already listening
#   - Mongo/Redis are never installed or changed
# Nothing is restarted except this app's own processes. nginx is only reloaded
# (graceful), and only after `nginx -t` passes both before and after our files.
#
# Usage:
#   ./deploy.sh preflight   read-only report; changes nothing
#   ./deploy.sh install     first-time setup (re-runnable)
#   ./deploy.sh update      pull latest code, rebuild, restart this app only
#   ./deploy.sh ssl         issue the Let's Encrypt cert (after DNS is live)
#   ./deploy.sh status
#
# Optional env: REPO_URL BRANCH NODE_VERSION LE_EMAIL ROOZGAR_PORTS
set -euo pipefail

DOMAIN="roozgarcab.com"
APP_USER="roozgarcab"
BASE="/opt/roozgarcab"
APP_DIR="$BASE/app"
NODE_DIR="$BASE/node"
PM2_HOME_DIR="$BASE/.pm2"
WEB_ROOT="/var/www/roozgarcab"
PORTS_FILE="$BASE/ports.env"
REPO_URL="${REPO_URL:-https://github.com/appzetogit/roozgar-cab.git}"
BRANCH="${BRANCH:-main}"
NODE_VERSION="${NODE_VERSION:-22.11.0}"
LE_EMAIL="${LE_EMAIL:-}"

NGX_SITE="/etc/nginx/sites-available/roozgarcab.conf"
NGX_ENABLED="/etc/nginx/sites-enabled/roozgarcab.conf"

log()  { printf '\033[1;32m[roozgarcab]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[roozgarcab] WARN:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[roozgarcab] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "run as root"; }
as_app() { runuser -u "$APP_USER" -- env HOME="$BASE" PATH="$NODE_DIR/bin:/usr/bin:/bin" PM2_HOME="$PM2_HOME_DIR" "$@"; }
port_in_use() { ss -ltn "( sport = :$1 )" 2>/dev/null | tail -n +2 | grep -q .; }

# ---------------------------------------------------------------- preflight
preflight() {
  log "preflight (read-only)"
  echo "OS:        $(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "Memory:    $(free -m | awk '/Mem:/ {print $2" MB total, "$7" MB available"}')"
  echo "Disk /:    $(df -h / | awk 'NR==2 {print $4" free"}')"
  echo "System node: $(command -v node >/dev/null && node -v || echo none) (left untouched)"
  command -v nginx >/dev/null || die "nginx is not installed"
  echo "nginx:     $(nginx -v 2>&1)"
  nginx -t >/dev/null 2>&1 || die "nginx -t already fails BEFORE our changes; fix that first. Nothing was modified."
  log "nginx config is valid right now"

  echo; echo "Sites already served by nginx:"
  grep -rhE '^\s*server_name' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | sort -u | sed 's/^/  /'
  if grep -rlE "server_name[^;]*\b${DOMAIN//./\\.}\b" /etc/nginx 2>/dev/null | grep -vE 'roozgarcab' | grep -q .; then
    die "$DOMAIN is already defined in another nginx file; refusing to continue (it would clash)."
  fi

  echo; echo "Listening ports:"; ss -ltnH | awk '{print "  "$4}' | sort -u | head -40
  echo; echo "Existing PM2 apps (root) — only listed, never touched:"
  command -v pm2 >/dev/null && pm2 jlist 2>/dev/null | grep -o '"name":"[^"]*"' | sort -u | sed 's/^/  /' || echo "  (none / pm2 not on PATH)"
  [ -d "$BASE" ] && log "$BASE already exists (re-run is fine)"
  getent passwd "$APP_USER" >/dev/null && log "user $APP_USER already exists"
  echo; echo "DNS: $DOMAIN -> $(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)   this server: $(curl -fsS4 https://ifconfig.me 2>/dev/null || echo unknown)"
}

# ----------------------------------------------------------------- helpers
# One instance by default. Socket.IO needs the Redis adapter to share rooms
# between processes; without Redis, two instances would split riders and drivers.
# Set INSTANCES=2+ only together with REDIS_ENABLED=true and REDIS_URL in .env.
choose_ports() {
  local n="${INSTANCES:-1}"
  if [ -n "${ROOZGAR_PORTS:-}" ]; then echo "ROOZGAR_PORTS=$ROOZGAR_PORTS" > "$PORTS_FILE"; fi
  if [ -f "$PORTS_FILE" ]; then . "$PORTS_FILE"; return; fi
  local start=5100 i ok
  while [ "$start" -lt 5900 ]; do
    ok=1
    for ((i = 0; i < n; i++)); do port_in_use $((start+i)) && ok=0; done
    if [ "$ok" -eq 1 ]; then
      ROOZGAR_PORTS="$start"
      for ((i = 1; i < n; i++)); do ROOZGAR_PORTS="$ROOZGAR_PORTS,$((start+i))"; done
      echo "ROOZGAR_PORTS=$ROOZGAR_PORTS" > "$PORTS_FILE"
      log "using ports $ROOZGAR_PORTS"
      return
    fi
    start=$((start+10))
  done
  die "could not find $n free ports in 5100-5900"
}

install_node() {
  [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -v)" = "v$NODE_VERSION" ] && return
  log "installing private Node $NODE_VERSION into $NODE_DIR"
  local arch; case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) die "unsupported arch";; esac
  local tgz="node-v$NODE_VERSION-linux-$arch.tar.xz" tmp; tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tgz" -o "$tmp/$tgz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tgz\$" SHASUMS256.txt | sha256sum -c -) || die "Node checksum mismatch"
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$tgz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  "$NODE_DIR/bin/npm" install -g pm2 --prefix "$NODE_DIR" >/dev/null
  chown -R "$APP_USER":"$APP_USER" "$NODE_DIR"
}

apt_missing() {
  local missing=()
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    log "installing missing packages: ${missing[*]} (nothing else is upgraded)"
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  fi
}

sync_code() {
  if [ -d "$APP_DIR/.git" ]; then
    as_app git -C "$APP_DIR" fetch --prune origin "$BRANCH"
    as_app git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  else
    rm -rf "$APP_DIR"
    as_app git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR" \
      || die "git clone failed. If the repo is private, add a read-only deploy key for $APP_USER and set REPO_URL to the ssh URL."
  fi
}

ensure_env_files() {
  local benv="$APP_DIR/Backend/.env" fenv="$APP_DIR/frontend/.env.production"
  if [ ! -f "$benv" ]; then
    install -o "$APP_USER" -g "$APP_USER" -m 600 "$APP_DIR/deploy/backend.env.template" "$benv"
    local secret; secret="$(openssl rand -hex 48)"
    sed -i "s|__GENERATED__|$secret|" "$benv"
    log "created $benv with a random JWT_SECRET"
  fi
  if grep -q 'CHANGE_ME' "$benv"; then
    die "edit $benv (set MONGODB_URI and the SMS values), then run: $0 ${1:-install} again"
  fi
  if [ ! -f "$fenv" ]; then
    install -o "$APP_USER" -g "$APP_USER" -m 640 "$APP_DIR/frontend/.env.production.example" "$fenv"
    log "created $fenv — fill VITE_FIREBASE_* / VITE_GOOGLE_MAPS_API_KEY if you use them, then run update"
  fi
}

build_and_start() {
  log "backend dependencies"
  as_app npm ci --omit=dev --prefix "$APP_DIR/Backend"
  local dist="$APP_DIR/frontend/dist"
  if [ "${SKIP_FRONTEND_BUILD:-0}" = "1" ]; then
    # Low-memory servers: build locally, upload the dist folder to $BASE/frontend-dist.
    dist="$BASE/frontend-dist"
    [ -f "$dist/index.html" ] || die "SKIP_FRONTEND_BUILD=1 but $dist/index.html is missing"
    log "using prebuilt frontend from $dist"
  else
    log "frontend build"
    as_app npm ci --prefix "$APP_DIR/frontend"
    as_app npm run build --prefix "$APP_DIR/frontend"
  fi
  mkdir -p "$WEB_ROOT"
  rsync -a --delete "$dist/" "$WEB_ROOT/"
  chown -R root:root "$WEB_ROOT"; find "$WEB_ROOT" -type d -exec chmod 755 {} +; find "$WEB_ROOT" -type f -exec chmod 644 {} +

  . "$PORTS_FILE"
  log "database indexes"
  ( cd "$APP_DIR/Backend" && as_app env ROOZGAR_PORTS="$ROOZGAR_PORTS" node scripts/ensureIndexes.js ) || warn "ensureIndexes failed — check MONGODB_URI"

  log "starting this app's PM2 processes (own PM2 home, own ports)"
  ( cd "$APP_DIR/Backend" && as_app env ROOZGAR_PORTS="$ROOZGAR_PORTS" pm2 startOrReload ecosystem.config.cjs --update-env )
  as_app pm2 save >/dev/null
}

pm2_boot_unit() {
  [ -f /etc/systemd/system/pm2-$APP_USER.service ] && return
  env PATH="$NODE_DIR/bin:$PATH" PM2_HOME="$PM2_HOME_DIR" "$NODE_DIR/bin/pm2" startup systemd -u "$APP_USER" --hp "$BASE" >/dev/null
  log "boot unit pm2-$APP_USER installed (root's own PM2 unit is separate and unchanged)"
}

write_nginx() {
  . "$PORTS_FILE"
  # Once certbot has added TLS to our site file, never regenerate it (that would
  # drop HTTPS); only the upstream block is refreshed in place.
  if [ -f "$NGX_SITE" ] && grep -q 'ssl_certificate' "$NGX_SITE"; then
    log "nginx site already has TLS; leaving it as is"
    return
  fi
  local backup; backup="$(mktemp -d)"
  [ -f "$NGX_SITE" ] && cp "$NGX_SITE" "$backup/site.conf"

  # nginx.conf here only includes sites-enabled/*.conf, so the upstream and the
  # rate-limit zone (both http-level) live at the top of the same .conf file.
  {
    echo "upstream roozgarcab_api {"; echo "    ip_hash;"
    IFS=, read -ra P <<< "$ROOZGAR_PORTS"
    for p in "${P[@]}"; do echo "    server 127.0.0.1:$p max_fails=3 fail_timeout=15s;"; done
    echo "    keepalive 64;"; echo "}"; echo
    cat "$APP_DIR/ops/nginx/roozgarcab-ratelimit.conf"; echo
    # HTTP-only server block first; certbot adds the 443 block and the redirect.
    awk '
      /^server \{/ {inblk=1}
      inblk {
        if ($0 ~ /^\}/) exit
        if ($0 ~ /listen .*443|ssl_certificate|ssl_dhparam|options-ssl-nginx/) next
        print
      }
    ' "$APP_DIR/ops/nginx/site-roozgarcab.conf" | sed 's|^    server_name .*|    listen 80;\n    listen [::]:80;\n&|'
    echo "}"
  } > "$NGX_SITE.new"
  mv "$NGX_SITE.new" "$NGX_SITE"
  ln -sf "$NGX_SITE" "$NGX_ENABLED"

  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    log "nginx reloaded (graceful); only roozgarcab.conf was added"
  else
    warn "nginx -t failed with our file — rolling back"
    rm -f "$NGX_ENABLED" "$NGX_SITE"
    [ -f "$backup/site.conf" ] && cp "$backup/site.conf" "$NGX_SITE" && ln -sf "$NGX_SITE" "$NGX_ENABLED"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    die "nginx config invalid; rolled back. Run: nginx -t"
  fi
}

# ---------------------------------------------------------------- commands
cmd_install() {
  need_root; preflight
  apt_missing git curl rsync openssl ca-certificates xz-utils certbot python3-certbot-nginx
  getent passwd "$APP_USER" >/dev/null || useradd --system --create-home --home-dir "$BASE" --shell /bin/bash "$APP_USER"
  mkdir -p "$BASE" "$PM2_HOME_DIR"; chown -R "$APP_USER":"$APP_USER" "$BASE"
  install_node; choose_ports; sync_code; ensure_env_files install
  build_and_start; pm2_boot_unit; write_nginx
  cmd_status
  cat <<EOF

Next:
  1. Make DNS point $DOMAIN and www.$DOMAIN at this server (see deploy/README.md).
  2. Then run:  LE_EMAIL=you@example.com $0 ssl
EOF
}

cmd_update() {
  need_root; install_node; choose_ports; sync_code; ensure_env_files update
  build_and_start; write_nginx; cmd_status
}

cmd_ssl() {
  need_root
  [ -n "$LE_EMAIL" ] || die "set LE_EMAIL=you@example.com"
  local ip_dns ip_me; ip_dns="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"; ip_me="$(curl -fsS4 https://ifconfig.me || true)"
  [ -n "$ip_dns" ] && [ "$ip_dns" = "$ip_me" ] || die "DNS for $DOMAIN is '$ip_dns' but this server is '$ip_me'. Fix DNS first."
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect
  nginx -t && systemctl reload nginx
  log "HTTPS is live: https://$DOMAIN"
}

cmd_status() {
  . "$PORTS_FILE" 2>/dev/null || true
  as_app pm2 list || true
  local first="${ROOZGAR_PORTS%%,*}"
  [ -n "$first" ] && curl -fsS "http://127.0.0.1:$first/health" && echo || warn "health check failed"
}

case "${1:-}" in
  preflight) need_root; preflight ;;
  install)   cmd_install ;;
  update)    cmd_update ;;
  ssl)       cmd_ssl ;;
  status)    need_root; cmd_status ;;
  *) echo "usage: $0 {preflight|install|update|ssl|status}"; exit 1 ;;
esac
