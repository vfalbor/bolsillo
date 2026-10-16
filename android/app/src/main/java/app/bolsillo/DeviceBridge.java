package app.bolsillo;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.Icon;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * The phone's hardware, offered to the Linux side over a tiny HTTP server on 127.0.0.1.
 * Bolsillo's Node server calls POST /<capability> with a JSON body and a bearer token.
 */
final class DeviceBridge {
    private final Context ctx;
    private final int port;
    private final String token;
    private final Handler main = new Handler(Looper.getMainLooper());
    private ServerSocket socket;
    private TextToSpeech tts;
    private boolean ttsReady;

    DeviceBridge(Context ctx, int port, String token) {
        this.ctx = ctx;
        this.port = port;
        this.token = token;
    }

    void start() {
        new Thread(() -> {
            try {
                socket = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
                while (!socket.isClosed()) {
                    Socket s = socket.accept();
                    new Thread(() -> handle(s), "bolsillo-bridge-req").start();
                }
            } catch (IOException e) {
                LinuxService.log("[puente del móvil: " + e.getMessage() + "]");
            }
        }, "bolsillo-bridge").start();
        main.post(() -> tts = new TextToSpeech(ctx, status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) tts.setLanguage(Locale.getDefault());
        }));
    }

    void stop() {
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
        main.post(() -> { if (tts != null) tts.shutdown(); });
    }

    // ------------------------------------------------------------------ HTTP

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            String request = readLine(in);
            if (request == null) return;
            String[] parts = request.split(" ");
            int length = 0;
            String auth = "";
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c < 0) continue;
                String k = line.substring(0, c).trim().toLowerCase(Locale.ROOT);
                String v = line.substring(c + 1).trim();
                if (k.equals("content-length")) length = Integer.parseInt(v);
                if (k.equals("authorization")) auth = v;
            }
            // Content-Length counts bytes, not characters ("móvil" is 6 bytes).
            byte[] body = new byte[Math.min(length, 1 << 20)];
            int read = 0;
            while (read < body.length) {
                int n = in.read(body, read, body.length - read);
                if (n < 0) break;
                read += n;
            }
            int status = 200;
            JSONObject result;
            if (!("Bearer " + token).equals(auth)) {
                status = 401;
                result = error("Sin permiso");
            } else {
                try {
                    String name = parts.length > 1 ? parts[1].replaceFirst("^/", "") : "";
                    JSONObject args = read > 0 ? new JSONObject(new String(body, 0, read, StandardCharsets.UTF_8)) : new JSONObject();
                    result = call(name, args);
                } catch (BridgeError e) {
                    status = e.status;
                    result = error(e.getMessage());
                } catch (Exception e) {
                    status = 500;
                    result = error(e.getMessage() != null ? e.getMessage() : e.toString());
                }
            }
            byte[] out = result.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream os = sock.getOutputStream();
            os.write(("HTTP/1.1 " + status + " OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "
                    + out.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            os.write(out);
            os.flush();
        } catch (Exception e) {
            LinuxService.log("[puente del móvil: " + e + "]");
        }
    }

    /** Reads one header line (ASCII, CRLF-terminated) straight from the byte stream. */
    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) >= 0) {
            if (c == '\n') return sb.toString();
            if (c != '\r') sb.append((char) c);
        }
        return sb.length() > 0 ? sb.toString() : null;
    }

    private static JSONObject error(String msg) {
        try { return new JSONObject().put("error", msg); } catch (Exception e) { return new JSONObject(); }
    }

    private static final class BridgeError extends Exception {
        final int status;
        BridgeError(int status, String msg) { super(msg); this.status = status; }
    }

    // ------------------------------------------------------------------ capabilities

    private JSONObject call(String name, JSONObject a) throws Exception {
        switch (name) {
            case "caps": return caps();
            case "speak": return speak(a.optString("text"));
            case "vibrate": return vibrate(a.optInt("ms", 300));
            case "torch": return torch(a.optBoolean("on"));
            case "notify": return notify(a.optString("title", "Bolsillo"), a.optString("text"));
            case "battery": return battery();
            case "clipboard": return clipboard();
            case "location": return location();
            case "shortcut": return shortcut(a.optString("id"), a.optString("name"), a.optString("emoji", "📱"));
            case "open": return open(a.optString("url"));
            default: throw new BridgeError(404, "Este móvil no sabe hacer «" + name + "»");
        }
    }

    private JSONObject caps() throws Exception {
        JSONArray list = new JSONArray();
        for (String c : new String[]{"speak", "vibrate", "notify", "battery", "clipboard", "open"}) list.put(c);
        if (flashCamera() != null) list.put("torch");
        if (granted(Manifest.permission.ACCESS_COARSE_LOCATION)) list.put("location");
        if (ctx.getSystemService(ShortcutManager.class).isRequestPinShortcutSupported()) list.put("shortcut");
        return new JSONObject().put("caps", list);
    }

    private JSONObject ok() throws Exception {
        return new JSONObject().put("ok", true);
    }

    private JSONObject speak(String text) throws Exception {
        if (!ttsReady) throw new BridgeError(503, "La voz del móvil aún no está lista");
        tts.speak(text, TextToSpeech.QUEUE_ADD, null, "bolsillo-" + System.nanoTime());
        return ok();
    }

    private JSONObject vibrate(int ms) throws Exception {
        Vibrator v = ctx.getSystemService(Vibrator.class);
        v.vibrate(VibrationEffect.createOneShot(Math.max(1, Math.min(ms, 5000)), VibrationEffect.DEFAULT_AMPLITUDE));
        return ok();
    }

    private String flashCamera() {
        try {
            CameraManager cm = ctx.getSystemService(CameraManager.class);
            for (String id : cm.getCameraIdList()) {
                Boolean flash = cm.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                if (Boolean.TRUE.equals(flash)) return id;
            }
        } catch (Exception ignored) { }
        return null;
    }

    private JSONObject torch(boolean on) throws Exception {
        String id = flashCamera();
        if (id == null) throw new BridgeError(501, "Este móvil no tiene linterna");
        ctx.getSystemService(CameraManager.class).setTorchMode(id, on);
        return ok();
    }

    private JSONObject notify(String title, String text) throws Exception {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("apps", "Avisos de tus apps", NotificationManager.IMPORTANCE_DEFAULT));
        Notification n = new Notification.Builder(ctx, "apps")
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .build();
        nm.notify((int) (System.currentTimeMillis() % 100000) + 10, n);
        return ok();
    }

    private JSONObject battery() throws Exception {
        Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
        int plugged = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0);
        int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        return new JSONObject()
                .put("percentage", Math.round(level * 100f / scale))
                .put("plugged", plugged != 0)
                .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING)
                .put("temperature", b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
    }

    private JSONObject clipboard() throws Exception {
        String text = onMain(() -> {
            ClipData clip = ctx.getSystemService(ClipboardManager.class).getPrimaryClip();
            return clip != null && clip.getItemCount() > 0 ? String.valueOf(clip.getItemAt(0).coerceToText(ctx)) : "";
        });
        return new JSONObject().put("text", text);
    }

    private JSONObject location() throws Exception {
        if (!granted(Manifest.permission.ACCESS_COARSE_LOCATION)) throw new BridgeError(403, "Da permiso de ubicación a Bolsillo en los ajustes del móvil");
        LocationManager lm = ctx.getSystemService(LocationManager.class);
        Location best = null;
        for (String p : lm.getProviders(true)) {
            @SuppressWarnings("MissingPermission") Location l = lm.getLastKnownLocation(p);
            if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
        }
        if (best == null) throw new BridgeError(503, "El móvil aún no sabe dónde está; abre un mapa un momento");
        return new JSONObject().put("latitude", best.getLatitude()).put("longitude", best.getLongitude())
                .put("accuracy", best.getAccuracy()).put("time", best.getTime());
    }

    private JSONObject shortcut(String id, String name, String emoji) throws Exception {
        if (!id.matches("[a-z0-9-]+")) throw new BridgeError(400, "id de app inválido");
        ShortcutManager sm = ctx.getSystemService(ShortcutManager.class);
        if (!sm.isRequestPinShortcutSupported()) throw new BridgeError(501, "Tu pantalla de inicio no admite accesos directos");
        Intent launch = new Intent(Intent.ACTION_VIEW, Uri.parse("bolsillo://app/" + id), ctx, AppActivity.class)
                .putExtra("name", name);
        ShortcutInfo info = new ShortcutInfo.Builder(ctx, "app-" + id)
                .setShortLabel(name.isEmpty() ? id : name)
                .setIcon(Icon.createWithAdaptiveBitmap(emojiIcon(emoji, id)))
                .setIntent(launch)
                .build();
        boolean asked = onMain(() -> sm.requestPinShortcut(info, null));
        if (!asked) throw new BridgeError(500, "El móvil no dejó crear el acceso directo");
        return ok();
    }

    /** An adaptive icon: the app's emoji on a soft color picked from its id (same idea as the web UI). */
    private static Bitmap emojiIcon(String emoji, String id) {
        int size = 432; // adaptive icons: 108dp at 4x, the visible circle is the middle 72dp
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        int h = 0;
        for (char ch : id.toCharArray()) h = (h * 31 + ch) % 360;
        c.drawColor(Color.HSVToColor(new float[]{h, 0.22f, 0.97f}));
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTextSize(size * 0.36f);
        p.setTextAlign(Paint.Align.CENTER);
        Paint.FontMetrics fm = p.getFontMetrics();
        c.drawText(emoji, size / 2f, size / 2f - (fm.ascent + fm.descent) / 2, p);
        return bmp;
    }

    private JSONObject open(String url) throws Exception {
        if (!url.startsWith("https://") && !url.startsWith("http://")) throw new BridgeError(400, "Solo enlaces web");
        ctx.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        return ok();
    }

    // ------------------------------------------------------------------ helpers

    private boolean granted(String permission) {
        return ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private <T> T onMain(Callable<T> fn) throws Exception {
        FutureTask<T> task = new FutureTask<>(fn);
        main.post(task);
        return task.get(5, TimeUnit.SECONDS);
    }
}
