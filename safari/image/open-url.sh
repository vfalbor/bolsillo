#!/bin/sh
# Bolsillo's "browser" in Safari: Claude Code opens links (the sign-in one) with $BROWSER. There's no browser
# here, so the link is handed to the page over the terminal and the page opens it in Safari.
printf '\n@@BOLSILLO open %s@@\n' "$1" > "${BOLSILLO_TTY:-/dev/tty}"
exit 0
