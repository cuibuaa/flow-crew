#!/bin/sh
set -eu
# Explicit CI/administrator procedure; never called by installer or doctor.
if nice -n 19 test -f /etc/apparmor.d/bwrap-userns-restrict; then
  nice -n 19 sudo apparmor_parser -R /etc/apparmor.d/bwrap-userns-restrict
  nice -n 19 sudo mkdir -p /etc/apparmor.d/disable
  nice -n 19 sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/disable/bwrap-userns-restrict
fi
nice -n 19 python3 - <<'PYPROFILE'
from pathlib import Path
Path('/tmp/host-bwrap-profile').write_text(
    'abi <abi/4.0>,\ninclude <tunables/global>\n'
    'profile bwrap /usr/bin/bwrap flags=(unconfined) {\n'
    ' userns,\n include if exists <local/bwrap>\n}\n')
PYPROFILE
nice -n 19 sudo install -m 644 /tmp/host-bwrap-profile /etc/apparmor.d/bwrap
nice -n 19 sudo apparmor_parser -r /etc/apparmor.d/bwrap
nice -n 19 sudo aa-status
