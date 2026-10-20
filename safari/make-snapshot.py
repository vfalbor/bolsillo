#!/usr/bin/env python3
# Bolsillo snapshot with Linux and Claude Code already loaded, so Safari doesn't have to boot them.
#
# Boots the published disk in native QEMU (the same QEMU version as Safari's, image bolsillo-qsys) with
# the same devices as the page, and the same network: its own c2w-net and a TCP→WebSocket bridge
# (ws-bridge.mjs), like the page does. It plays the page in chat mode: waits for "chat ready", opens
# Claude without a session (the token arrives later, see preload.mjs), waits for it to answer
# "initialize", drops Linux's disk cache (with init_on_free=1 freed memory is left as zeros and takes no
# room in the snapshot) and saves it with "migrate file:". The page loads it with -incoming and sends @@HELLO.
#
#   python3 safari/make-snapshot.py [--test] <folder with bzImage, edk2-aarch64-code.fd, efi-virtio.rom, rootfs.bin> <vm.state> [mem MB] [cpus]
#
# With --test it doesn't make one: it boots from it like the page (@@HELLO) and checks that Linux answers,
# that there's network (it restores the apps of a test key from the server) and that Claude responds.
import os, re, select, subprocess, sys, time, json, shutil

TEST = "--test" in sys.argv
if TEST: sys.argv.remove("--test")
pack, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
mem = int(sys.argv[3]) if len(sys.argv) > 3 else 768
cpus = int(sys.argv[4]) if len(sys.argv) > 4 else 2
here = os.path.dirname(os.path.abspath(__file__))
TCP, WS = 18888, 8899
work = os.path.join(os.path.dirname(out), "snap-work")
shutil.rmtree(work, ignore_errors=True)
os.makedirs(f"{work}/wasi0"); os.makedirs(f"{work}/wasi1")
# wasi1 is /pack in the page: container2wasm's init reads "info" from there (time and network MAC).
with open(f"{work}/wasi1/info", "w") as f: f.write(f"t:{int(time.time())}\nn:02:00:00:00:00:01\n")
if os.path.exists(out) and not TEST: os.remove(out)

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
  # Same as build/base/htdocs/arg-module.js (devices and memory must match the page).
  "-cpu", "cortex-a53", "-machine", "virt", "-bios", "/pack/edk2-aarch64-code.fd", "-nographic",
  "-m", f"{mem}M", "-accel", "tcg,tb-size=128,thread=multi", "-smp", f"{cpus},sockets=1", "-L", "/pack/",
  "-drive", "if=virtio,format=raw,readonly=on,file=/pack/rootfs.bin", "-kernel", "/pack/bzImage",
  "-append", "earlyprintk=ttyS0 console=ttyS0 root=/dev/vda rootwait no_console_suspend ro loglevel=0 QEMU_MODE=1 "
             "init_on_free=1 bolsillo.cols=53 bolsillo.rows=38 bolsillo.mode=chat init=/sbin/tini -- /sbin/init",
  "-virtfs", "local,path=/work/wasi0,mount_tag=wasi0,security_model=none,id=wasi0",
  "-virtfs", "local,path=/work/wasi1,mount_tag=wasi1,security_model=none,id=wasi1",
  "-netdev", f"socket,id=vmnic,connect=127.0.0.1:{TCP}", "-device", "virtio-net-pci,netdev=vmnic"]
if TEST: args += ["-incoming", "file:/out/" + os.path.basename(out)]
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
    print("FAILED:", msg, flush=True)
    subprocess.run(["docker", "kill", name], capture_output=True)
    for h in helpers: h.kill()
    sys.exit(1)

if TEST:
    ok = None
    for _ in range(60):
        send(f"@@HELLO {int(time.time())}\n".encode())
        ok = wait(rb"@@BOLSILLO chat ready@@", 3)
        if ok: break
    if not ok: fail("Linux doesn't answer after restoring the snapshot")
    print(T(), "Linux awake (chat ready)", flush=True)
    send(b'{"type":"control_request","request_id":"back","request":{"subtype":"initialize"}}\n')
    if not wait(rb'"control_response".{0,200}"back"', 300): fail("Claude doesn't answer after restoring the snapshot")
    print(T(), "Claude answers", flush=True)
    # The server has a test backup with one app (safari/data/snapshot-test-….tgz): if it arrives, there's network.
    send(f"@@DATA {os.environ.get('SNAP_SERVER', 'https://tokenstree.es:8443')}/vm/data/snapshot-test-00000000000000000000000000\n".encode())
    m = wait(rb"@@BOLSILLO data restored 1@@", 120)
    print(T(), "network:", "yes (restored the test app from the server)" if m else "NO", flush=True)
    subprocess.run(["docker", "kill", name], capture_output=True)
    for h in helpers: h.kill()
    sys.exit(0 if m else 1)

if not wait(rb"@@BOLSILLO chat ready@@", int(os.environ.get("SNAP_BOOT_TIMEOUT", 300))): fail("Linux never reached \"chat ready\"")
print(T(), "Linux ready", flush=True)
send(b"@@TOKEN -\n")
if not wait(rb"@@BOLSILLO claude starting@@", 60): fail("Claude didn't start")
send(b'{"type":"control_request","request_id":"snap","request":{"subtype":"initialize"}}\n')
if not wait(rb'"control_response".{0,200}"snap"', 600): fail("Claude didn't answer initialize")
print(T(), "Claude ready", flush=True)
time.sleep(15) # let the panel (node server.js, niced) finish starting and everything settle
send(b"@@SNAPSHOT\n")
if not wait(rb"@@BOLSILLO snapshot ready[^@]*@@", 120): fail("the cache wasn't dropped")
print(T(), "cache dropped; saving the snapshot", flush=True)
send(b"\x01c"); time.sleep(0.5)
send(b"migrate file:/out/" + os.path.basename(out).encode() + b"\n")
for _ in range(600):
    time.sleep(1)
    send(b"info migrate\n")
    m = wait(rb"Migration status: (\w+)|[Mm]igration is disabled[^\r\n]*|Error[^\r\n]*", 5)
    if m and m.group(1) == b"completed": break
    if m and m.group(1) != b"active" and m.group(1) is not None: fail(m.group(0).decode(errors="replace"))
    if m and m.group(1) is None: fail(m.group(0).decode(errors="replace"))
else: fail("the snapshot didn't finish")
send(b"quit\n"); p.wait(30)
for h in helpers: h.kill()
print(T(), f"snapshot: {out} ({os.path.getsize(out) / 1e6:.0f} MB)", flush=True)
