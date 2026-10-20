#!/bin/sh
# «Navegador» de Bolsillo en Safari: Claude Code abre los enlaces (el de iniciar sesión) con $BROWSER. Aquí
# no hay navegador, así que el enlace se le pasa a la página por el terminal y ella lo abre en Safari.
printf '\n@@BOLSILLO abrir %s@@\n' "$1" > "${BOLSILLO_TTY:-/dev/tty}"
exit 0
