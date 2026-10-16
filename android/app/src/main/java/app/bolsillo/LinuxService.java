package app.bolsillo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

/**
 * Keeps the phone's Linux alive: prepares it on first run (download Ubuntu Base, install Node and
 * Claude Code), then runs the Bolsillo server and restarts it if it stops. Runs as a
 * foreground service so Android doesn't kill it while Claude is working.
 */
public class LinuxService extends Service {
    static final String ACTION_STOP = "app.bolsillo.STOP";
    static final String ACTION_RETRY = "app.bolsillo.RETRY";
    private static final String CHANNEL = "linux";
    private static final String PACKAGES_MARK = ".bolsillo-packages-1";
    private static final String NODE_VERSION = "v24.21.0";
    private static final String INSTALL_SCRIPT = String.join("\n",
            "set -e",
            "export DEBIAN_FRONTEND=noninteractive",
            "echo '» Descargando la lista de programas'",
            "apt-get update -q -o Acquire::Retries=4",
            "echo '» Instalando git y herramientas'",
            "apt-get install -y -q -o Acquire::Retries=4 --no-install-recommends ca-certificates curl git ripgrep bsdutils",
            "echo '» Instalando Node.js'",
            "A=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/'); V=" + NODE_VERSION + "; F=node-$V-linux-$A.tar.gz",
            "cd /tmp && curl -fsSLO --retry 4 --retry-all-errors -C - https://nodejs.org/dist/$V/$F",
            "curl -fsSL --retry 4 --retry-all-errors https://nodejs.org/dist/$V/SHASUMS256.txt | grep \" $F$\" | sha256sum -c -",
            "tar xzf $F -C /usr/local --strip-components=1 --no-same-owner && rm $F && cd /",
            "echo '» Instalando Claude Code'",
            "npm install -g --no-fund --no-audit --fetch-retries=4 @anthropic-ai/claude-code || npm install -g --no-fund --no-audit --fetch-retries=4 @anthropic-ai/claude-code",
            "git config --global init.defaultBranch main",
            "claude --version",
            "touch /" + PACKAGES_MARK,
            "echo '» Listo'");

    // Shared state read by the setup screen.
    static volatile String stage = "idle"; // download, extract, packages, starting, ready, error
    static volatile String message = "";
    static volatile double progress = -1;
    static volatile String error;
    static volatile String bridgeToken;
    private static final ArrayDeque<String> LOG = new ArrayDeque<>();

    private volatile boolean running;
    private volatile Process server;
    private Thread worker;
    private DeviceBridge bridge;
    private PowerManager.WakeLock wakeLock;

    static void start(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, LinuxService.class));
    }

    static void log(String line) {
        android.util.Log.i("Bolsillo", line);
        synchronized (LOG) {
            LOG.addLast(line);
            while (LOG.size() > 300) LOG.removeFirst();
        }
    }

    static String statusJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("stage", stage);
            o.put("message", message);
            o.put("progress", progress);
            o.put("error", error == null ? JSONObject.NULL : error);
            JSONArray lines = new JSONArray();
            synchronized (LOG) {
                int skip = Math.max(0, LOG.size() - 40);
                for (String l : LOG) if (skip-- <= 0) lines.put(l);
            }
            o.put("log", lines);
            o.put("url", "http://127.0.0.1:" + Linux.SERVER_PORT + "/");
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private static void set(String newStage, String msg, double prog) {
        stage = newStage;
        message = msg;
        progress = prog;
        if (msg != null && !msg.isEmpty()) log("» " + msg);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Bolsillo en marcha", NotificationManager.IMPORTANCE_LOW));
        startForeground(1, notification());
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "bolsillo:linux");
        wakeLock.acquire();
        byte[] rnd = new byte[16];
        new SecureRandom().nextBytes(rnd);
        StringBuilder sb = new StringBuilder();
        for (byte b : rnd) sb.append(String.format("%02x", b));
        bridgeToken = sb.toString();
        bridge = new DeviceBridge(this, Linux.BRIDGE_PORT, bridgeToken);
        bridge.start();
        startWorker();
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Intent stop = new Intent(this, LinuxService.class).setAction(ACTION_STOP);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Bolsillo está en marcha")
                .setContentText("Tu Linux y tus apps están funcionando en el móvil")
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
                .addAction(new Notification.Action.Builder(null, "Parar",
                        PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE)).build())
                .setOngoing(true)
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Every startForegroundService() call must be answered, not only the first one.
        startForeground(1, notification());
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_RETRY.equals(action) && "error".equals(stage)) startWorker();
        return START_STICKY;
    }

    private void startWorker() {
        running = true;
        error = null;
        worker = new Thread(this::work, "bolsillo-linux");
        worker.start();
    }

    @Override
    public void onDestroy() {
        running = false;
        Process p = server;
        if (p != null) p.destroy();
        if (worker != null) worker.interrupt();
        bridge.stop();
        if (wakeLock.isHeld()) wakeLock.release();
        stage = "idle";
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------------

    private void work() {
        try {
            Linux.checkKernel();
            Linux linux = new Linux(this);
            if (!linux.hasRootfs()) installRootfs(linux);
            linux.prepare();
            copyServer(linux);
            if (!new File(linux.rootfs, PACKAGES_MARK).exists()) installPackages(linux);
            serve(linux);
        } catch (Throwable t) {
            if (!running) return;
            error = t.getMessage() != null ? t.getMessage() : t.toString();
            set("error", "Algo falló al preparar tu Linux", -1);
            log(error);
        }
    }

    private void installRootfs(Linux linux) throws Exception {
        File archive = new File(getCacheDir(), "rootfs.tar.gz");
        String file = Linux.rootfsFile();
        waitForInternet("cdimage.ubuntu.com");
        set("download", "Descargando Linux (unos 30 MB)", 0);
        download(Linux.UBUNTU_RELEASES + file, archive);
        String expected = "";
        for (String line : fetchText(Linux.UBUNTU_RELEASES + "SHA256SUMS").split("\n")) {
            if (line.endsWith(" *" + file) || line.endsWith("  " + file)) expected = line.split("\\s+")[0];
        }
        if (!expected.equalsIgnoreCase(sha256(archive))) throw new IOException("La descarga de Linux llegó dañada; vuelve a intentarlo");
        set("extract", "Descomprimiendo Linux", -1);
        File tmp = new File(linux.files, "linux.partial");
        deleteTree(tmp);
        TarGz.extract(archive, tmp);
        deleteTree(linux.rootfs);
        if (!tmp.renameTo(linux.rootfs)) throw new IOException("No se pudo colocar Linux en su sitio");
        archive.delete();
    }

    /** The phone may have just been switched on or be between networks: wait a bit instead of failing. */
    private void waitForInternet(String host) throws Exception {
        for (int i = 0; ; i++) {
            try {
                java.net.InetAddress.getByName(host);
                return;
            } catch (java.net.UnknownHostException e) {
                if (i >= 60 || !running) throw new IOException("No hay conexión a internet. Conéctate a una red y pulsa Reintentar");
                if (i == 0) set(stage, "Esperando conexión a internet…", -1);
                Thread.sleep(3000);
            }
        }
    }

    private void installPackages(Linux linux) throws Exception {
        waitForInternet("nodejs.org");
        set("packages", "Instalando Node.js y Claude Code (unos minutos, una sola vez)", -1);
        Process p = linux.command(INSTALL_SCRIPT, new HashMap<>()).start();
        String last = "";
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.startsWith("» ")) message = line.substring(2);
                else if (!line.trim().isEmpty()) last = line;
                log(line);
            }
        }
        int code = p.waitFor();
        if (code != 0) throw new IOException("La instalación de programas falló (código " + code + "): " + last);
    }

    /** Copies the Bolsillo server from the APK into Linux when the APK changed. */
    private void copyServer(Linux linux) throws Exception {
        PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
        String version = info.versionName + "/" + info.lastUpdateTime;
        File dest = new File(linux.rootfs, "opt/bolsillo");
        File mark = new File(dest, ".apk-version");
        if (mark.exists() && version.equals(readText(mark))) return;
        set("starting", "Actualizando Bolsillo", -1);
        deleteTree(dest);
        copyAssets(getAssets(), "bolsillo", dest);
        Linux.write(mark, version);
    }

    private void serve(Linux linux) throws Exception {
        Map<String, String> env = new HashMap<>();
        env.put("BOLSILLO_DATA", "/root/bolsillo");
        env.put("PORT", String.valueOf(Linux.SERVER_PORT));
        env.put("HOST", "127.0.0.1");
        env.put("BOLSILLO_BRIDGE", "http://127.0.0.1:" + Linux.BRIDGE_PORT);
        env.put("BOLSILLO_BRIDGE_TOKEN", bridgeToken);
        env.put("USE_BUILTIN_RIPGREP", "0");
        while (running) {
            set("starting", "Arrancando Bolsillo", -1);
            Process p = linux.command("cd /opt/bolsillo && exec node server.js", env).start();
            server = p;
            Thread pump = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) log(line);
                } catch (IOException ignored) { }
            }, "bolsillo-log");
            pump.start();
            for (int i = 0; i < 240 && running && p.isAlive(); i++) {
                if (portOpen(Linux.SERVER_PORT)) { set("ready", "Listo", 1); break; }
                Thread.sleep(250);
            }
            int code = p.waitFor();
            server = null;
            if (!running) return;
            log("[Bolsillo se detuvo con código " + code + "; reiniciando]");
            Thread.sleep(2000);
        }
    }

    // ------------------------------------------------------------------ helpers

    static boolean portOpen(int port) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress("127.0.0.1", port), 300);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    /** Downloads with a few retries, resuming where the connection dropped (Wi-Fi to mobile data, etc.). */
    private void download(String url, File dest) throws Exception {
        dest.delete();
        for (int attempt = 1; ; attempt++) {
            try {
                downloadOnce(url, dest);
                return;
            } catch (IOException e) {
                if (attempt >= 5 || !running) throw e;
                log("La descarga se cortó (" + e.getMessage() + "); reintentando…");
                Thread.sleep(3000L * attempt);
                waitForInternet(new URL(url).getHost());
            }
        }
    }

    private static void downloadOnce(String url, File dest) throws IOException {
        long have = dest.length();
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        int code = c.getResponseCode();
        if (code == 200) have = 0; // the server ignored the range: start over
        else if (code != 206) throw new IOException("No se pudo descargar Linux (" + code + ")");
        long total = have + c.getContentLengthLong();
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(dest, have > 0)) {
            byte[] buf = new byte[1 << 16];
            long done = have;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (total > 0) progress = (double) done / total;
            }
        }
    }

    private static String fetchText(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        try (InputStream in = c.getInputStream()) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static void copyAssets(AssetManager am, String path, File dest) throws IOException {
        String[] children = am.list(path);
        if (children == null || children.length == 0) {
            dest.getParentFile().mkdirs();
            try (InputStream in = am.open(path); OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return;
        }
        dest.mkdirs();
        for (String c : children) copyAssets(am, path + "/" + c, new File(dest, c));
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String readText(File f) {
        try (InputStream in = new FileInputStream(f)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    /** Deletes a folder without following symlinks (the Linux tree is full of them). */
    static void deleteTree(File f) {
        if (!f.exists() && !isSymlink(f)) return;
        if (f.isDirectory() && !isSymlink(f)) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    private static boolean isSymlink(File f) {
        try {
            return android.system.Os.lstat(f.getPath()) != null
                    && android.system.OsConstants.S_ISLNK(android.system.Os.lstat(f.getPath()).st_mode);
        } catch (Exception e) {
            return false;
        }
    }
}
