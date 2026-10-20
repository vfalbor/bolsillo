#!/usr/bin/env python3
# Instantánea de Bolsillo con Linux y Claude Code ya cargados, para que Safari no tenga que arrancarlos.
#
# Arranca el disco publicado en QEMU nativo (la misma versión de QEMU que la de Safari, imagen
# bolsillo-qsys) con los mismos dispositivos que la página, y con la misma red: un c2w-net propio y un
# puente TCP→WebSocket (ws-bridge.mjs), como hace la página. Hace de página en el modo chat: espera a
# «chat listo», abre Claude sin sesión (el token llega después, ver preload.mjs), espera a que conteste a
# «initialize», vacía la caché de disco del Linux (con init_on_free=1 lo liberado queda a ceros y no ocupa
# en la instantánea) y la guarda con «migrate file:». La página la carga con -incoming y manda @@HOLA.
#
#   python3 safari/make-snapshot.py [--probar] <carpeta con bzImage, edk2-aarch64-code.fd, efi-virtio.rom, rootfs.bin> <vm.state> [mem MB] [cpus]
#
# Con --probar no la hace: arranca desde ella como la página (@@HOLA), y comprueba que el Linux contesta,
# que hay red (recupera las apps de una clave de prueba del servidor) y que Claude responde.
import os, re, select, subprocess, sys, time, json, shutil

PROBAR = "--probar" in sys.argv
if PROBAR: sys.argv.remove("--probar")
pack, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
mem = int(sys.argv[3]) if len(sys.argv) > 3 else 768
cpus = int(sys.argv[4]) if len(sys.argv) > 4 else 2
here = os.path.dirname(os.path.abspath(__file__))
TCP, WS = 18888, 8899
work = os.path.join(os.path.dirname(out), "snap-work")
shutil.rmtree(work, ignore_errors=True)
os.makedirs(f"{work}/wasi0"); os.makedirs(f"{work}/wasi1")
# wasi1 es /pack en la página: el init de container2wasm lee de ahí «info» (hora y MAC de la red).
with open(f"{work}/wasi1/info", "w") as f: f.write(f"t:{int(time.time())}\nn:02:00:00:00:00:01\n")
if os.path.exists(out) and not PROBAR: os.remove(out)

t0 = time.time()
def T(): return f"{time.time() - t0:6.1f}s"
helpers = [
  subprocess.Popen([os.path.expanduser("~/tools/c2w/c2w-net"), "-mac", "02:00:00:00:00:01", "-debug", "--listen-ws", f"127.0.0.1:{WS}"], stdout=open(out + ".net.log", "w"), stderr=subprocess.STDOUT),
  subprocess.Popen(["node", f"{here}/ws-bridge.mjs", str(TCP), f"ws://127.0.0.1:{WS}"], stdout=open(out + ".bridge.log", "w"), stderr=subprocess.STDOUT),
]
time.sleep(1.5)
name = "bolsillo-snapshot"
subprocess.run(["docker", "rm", "-f", name], capture_output=True)
args = ["docker", "run", "--rm", "-i", "--network", "host", "--memory", "1200m", "--memory-swap", "1200m", "--name", name,
  "-v", f"{pack}:/pack:ro", "-v", f"{work}:/work", "-v", f"{os.path.dirname(out)}:/out",
  "bolsillo-qsys", "qemu-system-aarch64",
  # Igual que build/base/htdocs/arg-module.js (dispositivos y memoria tienen que coincidir con la página).
  "-cpu", "cortex-a53", "-machine", "virt", "-bios", "/pack/edk2-aarch64-code.fd", "-nographic",
  "-m", f"{mem}M", "-accel", "tcg,tb-size=128,thread=multi", "-smp", f"{cpus},sockets=1", "-L", "/pack/",
  "-drive", "if=virtio,format=raw,readonly=on,file=/pack/rootfs.bin", "-kernel", "/pack/bzImage",
  "-append", "earlyprintk=ttyS0 console=ttyS0 root=/dev/vda rootwait no_console_suspend ro loglevel=0 QEMU_MODE=1 "
             "init_on_free=1 bolsillo.cols=53 bolsillo.rows=38 bolsillo.mode=chat init=/sbin/tini -- /sbin/init",
  "-virtfs", "local,path=/work/wasi0,mount_tag=wasi0,security_model=none,id=wasi0",
  "-virtfs", "local,path=/work/wasi1,mount_tag=wasi1,security_model=none,id=wasi1",
  "-netdev", f"socket,id=vmnic,connect=127.0.0.1:{TCP}", "-device", "virtio-net-pci,netdev=vmnic"]
if PROBAR: args += ["-incoming", "file:/out/" + os.path.basename(out)]
p = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
buf = b""; log = open(out + ".log", "wb")
def wait(pat, timeout):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], 0.5)
        if r:
            d = os.read(p.stdout.fileno(), 65536)
            if not d: return None
            buf += d; log.write(d); log.flush()
            m = re.search(pat, buf)
            if m: buf = buf[m.end():]; return m
    return None
def send(s): p.stdin.write(s); p.stdin.flush()
def fail(msg):
    print("FALLO:", msg, flush=True)
    subprocess.run(["docker", "kill", name], capture_output=True)
    for h in helpers: h.kill()
    sys.exit(1)

if PROBAR:
    ok = None
    for _ in range(60):
        send(f"@@HOLA {int(time.time())}\n".encode())
        ok = wait(rb"@@BOLSILLO chat listo@@", 3)
        if ok: break
    if not ok: fail("el Linux no contesta tras recuperar la instantánea")
    print(T(), "Linux despierto (chat listo)", flush=True)
    send(b'{"type":"control_request","request_id":"vuelta","request":{"subtype":"initialize"}}\n')
    if not wait(rb'"control_response".{0,200}"vuelta"', 300): fail("Claude no contesta tras recuperar la instantánea")
    print(T(), "Claude contesta", flush=True)
    # En el servidor hay una copia de prueba con una app (safari/datos/prueba-instantanea-….tgz): si llega, hay red.
    send(b"@@DATOS https://tokenstree.es:8443/vm/datos/prueba-instantanea-00000000000000000000000000\n")
    m = wait(rb"@@BOLSILLO datos recuperados 1@@", 120)
    print(T(), "red:", "sí (recuperó la app de prueba del servidor)" if m else "NO", flush=True)
    subprocess.run(["docker", "kill", name], capture_output=True)
    for h in helpers: h.kill()
    sys.exit(0 if m else 1)

if not wait(rb"@@BOLSILLO chat listo@@", int(os.environ.get("SNAP_BOOT_TIMEOUT", 300))): fail("el Linux no llegó a «chat listo»")
print(T(), "Linux listo", flush=True)
send(b"@@TOKEN -\n")
if not wait(rb"@@BOLSILLO claude arranca@@", 60): fail("Claude no arrancó")
send(b'{"type":"control_request","request_id":"foto","request":{"subtype":"initialize"}}\n')
if not wait(rb'"control_response".{0,200}"foto"', 600): fail("Claude no contestó a initialize")
print(T(), "Claude listo", flush=True)
time.sleep(15) # que el panel (node server.js, con nice) termine de arrancar y todo quede quieto
send(b"@@FOTO\n")
if not wait(rb"@@BOLSILLO foto lista[^@]*@@", 120): fail("no se vació la caché")
print(T(), "caché vaciada; guardando la instantánea", flush=True)
send(b"\x01c"); time.sleep(0.5)
send(b"migrate file:/out/" + os.path.basename(out).encode() + b"\n")
for _ in range(600):
    time.sleep(1)
    send(b"info migrate\n")
    m = wait(rb"Migration status: (\w+)|[Mm]igration is disabled[^\r\n]*|Error[^\r\n]*", 5)
    if m and m.group(1) == b"completed": break
    if m and m.group(1) != b"active" and m.group(1) is not None: fail(m.group(0).decode(errors="replace"))
    if m and m.group(1) is None: fail(m.group(0).decode(errors="replace"))
else: fail("la instantánea no terminó")
send(b"quit\n"); p.wait(30)
for h in helpers: h.kill()
print(T(), f"instantánea: {out} ({os.path.getsize(out) / 1e6:.0f} MB)", flush=True)
