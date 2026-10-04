#!/usr/bin/env bash
# Install or update Caddy, the deployment user, and release directories.
# Rerun after changing deploy/Caddyfile to apply the server configuration.
#
#   deploy/setup-server.sh [root@host]
set -euo pipefail

host=${1:-root@thirty-phantom.com}
cd "$(dirname "$0")"

ssh "$host" 'cat > /tmp/Caddyfile' < Caddyfile
ssh "$host" bash -s <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

# Create a deployment account that owns the site and uses root's authorized SSH keys.
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
install -d -m 755 -o deploy -g deploy /srv/thirty-phantom /srv/thirty-phantom/releases

caddy validate --adapter caddyfile --config /tmp/Caddyfile
install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile
rm /tmp/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
echo "caddy $(caddy version | cut -d' ' -f1) running"
EOF
