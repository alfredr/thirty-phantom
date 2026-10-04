#!/usr/bin/env bash
# Upload dist/ to a timestamped release directory on thirty-phantom.com.
# Reuse unchanged files through hard links to the current release, then
# atomically switch the `current` symlink served by Caddy. Keep recent
# releases available for rollback.
#
#   deploy/deploy.sh                 upload dist/ and make it live
#   deploy/deploy.sh releases        list releases, * marks the live one
#   deploy/deploy.sh rollback [rel]  make rel live (default: the one before live)
#
# Uploads the existing dist/; `mise run deploy` and `npm run deploy` build first.
set -euo pipefail

domain=${DEPLOY_DOMAIN:-thirty-phantom.com}
host=${DEPLOY_HOST:-deploy@$domain}
root=/srv/thirty-phantom
keep=${DEPLOY_KEEP:-10}

cd "$(dirname "$0")/.."

# Runs on the server: remote <activate rel | releases | rollback [rel]>
remote() {
  ssh "$host" bash -s -- "$root" "$keep" "$@" <<'EOF'
set -euo pipefail
root=$1 keep=$2 cmd=$3
shift 3
cd "$root"
live=$(basename "$(readlink current || true)")
go_live() {
  test -d "releases/$1" || { echo "no release $1" >&2; exit 1; }
  ln -sfn "releases/$1" current.new
  mv -T current.new current
  echo "live: $1"
}
case $cmd in
  activate)
    # Some build outputs are 0600 locally; Caddy runs as its own user.
    chmod -R u=rwX,go=rX "releases/$1"
    go_live "$1"
    ls -1 releases | head -n -"$keep" | while read -r old; do rm -rf "releases/$old"; done
    ;;
  releases)
    for r in $(ls -1 releases); do
      if [ "$r" = "$live" ]; then echo "* $r"; else echo "  $r"; fi
    done
    ;;
  rollback)
    target=${1:-$(ls -1 releases | grep -B1 -x "$live" | head -n1)}
    [ -n "$target" ] && [ "$target" != "$live" ] || { echo "nothing to roll back to" >&2; exit 1; }
    go_live "$target"
    ;;
esac
EOF
}

case ${1:-deploy} in
  deploy)
    [ -f dist/index.html ] || { echo "dist/index.html missing; build first" >&2; exit 1; }
    rel=$(date -u +%Y%m%d-%H%M%S)
    echo "uploading release $rel to $host"
    rsync -azc --link-dest="$root/current/" dist/ "$host:$root/releases/$rel/"
    remote activate "$rel"
    want=$(shasum -a 256 < dist/index.html)
    got=$(curl -fsS "https://$domain/" | shasum -a 256)
    if [ "$want" != "$got" ]; then
      echo "https://$domain/ is not serving this build's index.html" >&2
      exit 1
    fi
    echo "verified https://$domain/"
    ;;
  releases) remote releases ;;
  rollback) remote rollback "${2:-}" ;;
  *) sed -n '2,11p' "$0" >&2; exit 2 ;;
esac
