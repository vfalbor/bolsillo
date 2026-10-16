package app.bolsillo;

import android.content.Context;
import android.os.Build;
import android.system.Os;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The Linux that lives inside the app: an Ubuntu Base root filesystem under files/linux,
 * entered with proot (no root needed). Everything Bolsillo runs — Node, Claude Code,
 * the user's apps — runs through {@link #command}.
 */
final class Linux {
    // glibc on purpose: Alpine's musl calls the fork syscall on x86_64, which Android blocks for apps.
    static final String UBUNTU_VERSION = "24.04.5";
    static final String UBUNTU_RELEASES = "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/";
    static final int SERVER_PORT = 7700;
    static final int BRIDGE_PORT = 7699;

    final File files;
    final File rootfs;
    final File tmp;
    final File libLinks;
    final File fakeProc;
    final String nativeDir;

    Linux(Context ctx) {
        files = ctx.getFilesDir();
        rootfs = new File(files, "linux");
        tmp = new File(files, "tmp");
        libLinks = new File(files, "lib");
        fakeProc = new File(files, "proc");
        nativeDir = ctx.getApplicationInfo().nativeLibraryDir;
    }

    static String ubuntuArch() {
        String abi = Build.SUPPORTED_ABIS[0];
        if (abi.startsWith("arm64")) return "arm64";
        if (abi.equals("x86_64")) return "amd64";
        throw new IllegalStateException("Este móvil (" + abi + ") no es compatible: hace falta un procesador de 64 bits");
    }

    static String rootfsFile() {
        return "ubuntu-base-" + UBUNTU_VERSION + "-base-" + ubuntuArch() + ".tar.gz";
    }

    boolean hasRootfs() {
        return new File(rootfs, "usr/bin/bash").exists() && new File(rootfs, "etc/os-release").exists();
    }

    /** One-time tweaks after extracting the root filesystem, and things proot needs on every start. */
    void prepare() throws IOException {
        mkdirs(tmp, libLinks, fakeProc, new File(rootfs, "root"), new File(rootfs, "tmp"));
        new File(rootfs, "tmp").setWritable(true, false);
        // Ubuntu points these at systemd files that don't exist here.
        new File(rootfs, "etc/resolv.conf").delete();
        write(new File(rootfs, "etc/resolv.conf"), "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");
        write(new File(rootfs, "etc/hosts"), "127.0.0.1 localhost\n::1 localhost ip6-localhost\n");
        // apt drops privileges to a user proot can't emulate.
        write(new File(rootfs, "etc/apt/apt.conf.d/01bolsillo"), "APT::Sandbox::User \"root\";\n");
        // proot asks for libtalloc.so.2; Android only ships files named lib*.so, so link it.
        // Recreated every time: the native library folder moves with each app update.
        File talloc = new File(libLinks, "libtalloc.so.2");
        talloc.delete();
        try { Os.symlink(nativeDir + "/libtalloc.so", talloc.getPath()); }
        catch (Exception e) { throw new IOException("No se pudo preparar proot: " + e.getMessage()); }
        // Android hides some /proc files from apps; give programs harmless stand-ins.
        write(new File(fakeProc, "loadavg"), "0.12 0.07 0.02 2/165 765\n");
        write(new File(fakeProc, "stat"), "cpu  1957 0 2877 93280 262 342 254 87 0 0\ncpu0 31 0 226 12027 82 10 4 9 0 0\n"
                + "intr 0\nctxt 0\nbtime 0\nprocesses 0\nprocs_running 1\nprocs_blocked 0\n");
        write(new File(fakeProc, "uptime"), "124.08 932.80\n");
        write(new File(fakeProc, "version"), "Linux version 6.1.0-bolsillo (proot) #1 SMP PREEMPT\n");
        write(new File(fakeProc, "vmstat"), "nr_free_pages 1743136\n");
    }

    /** Runs a shell script inside Linux. env holds extra variables for the script. */
    ProcessBuilder command(String script, Map<String, String> env) {
        List<String> cmd = new ArrayList<>();
        cmd.add(nativeDir + "/libproot.so");
        cmd.add("--kill-on-exit");
        cmd.add("--link2symlink");
        cmd.add("-0");
        cmd.add("-r"); cmd.add(rootfs.getPath());
        cmd.add("-w"); cmd.add("/root");
        for (String b : new String[]{"/dev", "/proc", "/sys", "/dev/urandom:/dev/random",
                "/proc/self/fd:/dev/fd", "/proc/self/fd/0:/dev/stdin", "/proc/self/fd/1:/dev/stdout",
                "/proc/self/fd/2:/dev/stderr", tmp.getPath() + ":/dev/shm"}) {
            cmd.add("-b"); cmd.add(b);
        }
        for (String f : new String[]{"loadavg", "stat", "uptime", "version", "vmstat"}) {
            if (!new File("/proc/" + f).canRead()) { cmd.add("-b"); cmd.add(new File(fakeProc, f).getPath() + ":/proc/" + f); }
        }
        cmd.add("/usr/bin/env");
        cmd.add("-i");
        cmd.add("HOME=/root");
        cmd.add("USER=root");
        cmd.add("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
        cmd.add("TERM=xterm-256color");
        cmd.add("LANG=C.UTF-8");
        cmd.add("TMPDIR=/tmp");
        cmd.add("ANDROID_ROOT=/system");
        for (Map.Entry<String, String> e : env.entrySet()) cmd.add(e.getKey() + "=" + e.getValue());
        cmd.add("/bin/sh");
        cmd.add("-c");
        cmd.add(script);

        ProcessBuilder pb = new ProcessBuilder(cmd);
        Map<String, String> penv = pb.environment();
        penv.put("PROOT_LOADER", nativeDir + "/libproot-loader.so");
        if (new File(nativeDir, "libproot-loader32.so").exists()) penv.put("PROOT_LOADER_32", nativeDir + "/libproot-loader32.so");
        penv.put("PROOT_TMP_DIR", tmp.getPath());
        penv.put("LD_LIBRARY_PATH", libLinks.getPath() + ":" + nativeDir);
        // Before Linux 4.8 seccomp stopped programs in a different order and proot's seccomp
        // shortcut crashes (assertion IS_IN_SYSENTER). Slower without it, but it works.
        if (oldKernel()) penv.put("PROOT_NO_SECCOMP", "1");
        pb.redirectErrorStream(true);
        return pb;
    }

    static boolean oldKernel() {
        return kernelBelow(4, 8);
    }

    /** Ubuntu 24.04 needs system calls that Linux 3.x lacks and proot can't emulate (apt fails in realpath). */
    static void checkKernel() {
        if (kernelBelow(4, 4)) throw new IllegalStateException("Este móvil es demasiado antiguo para Bolsillo: su sistema (Linux "
                + System.getProperty("os.version") + ") no basta, hace falta Linux 4.4 o más nuevo (casi todos los móviles desde 2018)");
    }

    private static boolean kernelBelow(int wantMajor, int wantMinor) {
        String[] v = System.getProperty("os.version", "").split("[.-]");
        try {
            int major = Integer.parseInt(v[0]), minor = Integer.parseInt(v[1]);
            return major < wantMajor || (major == wantMajor && minor < wantMinor);
        } catch (Exception e) {
            return false;
        }
    }

    static void mkdirs(File... dirs) {
        for (File d : dirs) d.mkdirs();
    }

    static void write(File f, String text) throws IOException {
        f.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(f)) { out.write(text.getBytes(StandardCharsets.UTF_8)); }
    }
}
