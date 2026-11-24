#!/bin/sh
set -eu
cd "$(nice -n 19 dirname "$0")/.."

# Preserve caller ownership and affinity; no login account or ambient state.
fixture=$(nice -n 19 mktemp -d /tmp/flowcrew-isolation.XXXXXX)
trap 'nice -n 19 rm -rf "$fixture"' EXIT
passwd_file="$fixture/passwd"
nice -n 19 touch "$passwd_file"
nice -n 19 chmod 644 "$passwd_file"
# A worktree's Git pointer is not portable across a container mount. Export the
# same index primitive used by package acceptance, with independent Git context.
nice -n 19 git checkout-index --all --prefix="$fixture/project/"
nice -n 19 git -C "$fixture/project" init -q
nice -n 19 git -C "$fixture/project" -c core.excludesfile=/dev/null add --force --all
nice -n 19 cp -a "$PWD/node_modules" "$fixture/project/node_modules"
cpuset=$(nice -n 19 awk '/^Cpus_allowed_list:/ { print $2 }' /proc/self/status)
nice -n 19 test -n "$cpuset"
nice -n 19 docker run --rm \
  --cpuset-cpus "$cpuset" \
  --user "$(nice -n 19 id -u):$(nice -n 19 id -g)" \
  --network none \
  --tmpfs /tmp/flowcrew-home:rw,nosuid,nodev \
  --env HOME=/tmp/flowcrew-home \
  --env PATH=/usr/local/bin:/usr/bin:/bin \
  --workdir /workspace \
  --mount "type=bind,source=$fixture/project,target=/workspace" \
  --mount "type=bind,source=$passwd_file,target=/etc/passwd,readonly" \
  node:22.22.2-bookworm \
  nice -n 19 sh -ceu '
    nice -n 19 test ! -e "$HOME/.fc"
    ! nice -n 19 sh -c "command -v codex"
    ! nice -n 19 sh -c "command -v claude"
    nice -n 19 node -e '\''const assert = require("node:assert/strict");
      const os = require("node:os");
      assert.throws(() => os.userInfo(), { code: "ERR_SYSTEM_ERROR" });
      assert.equal(os.homedir(), process.env.HOME);'\''
    nice -n 19 npm run build
    nice -n 19 npm run test:portable
  '
