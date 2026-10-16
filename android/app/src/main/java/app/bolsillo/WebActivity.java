package app.bolsillo;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

/**
 * A full-screen WebView pointed at the Bolsillo server running in the phone's Linux.
 * While Linux is getting ready it shows the setup screen (assets/setup.html).
 */
public abstract class WebActivity extends Activity {
    private static final int REQ_FILE = 10;
    private static final int REQ_MEDIA = 11;
    private static final int REQ_GEO = 12;
    static final String SERVER = "http://127.0.0.1:" + Linux.SERVER_PORT;

    protected WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest mediaRequest;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;

    /** Path on the Bolsillo server this screen shows once Linux is ready. */
    protected abstract String target();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinuxService.start(this);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f4efe6"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setTextZoom(100);
        s.setGeolocationEnabled(true);
        web.addJavascriptInterface(new Bridge(), "BolsilloApp");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (state == null) open();
        else web.restoreState(state);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    /**
     * Goes straight to the server if it's up, otherwise to the setup screen that waits for it.
     * (If it turns out to be down, onReceivedError sends us to the setup screen too.)
     */
    protected void open() {
        if ("ready".equals(LinuxService.stage)) web.loadUrl(SERVER + target());
        else web.loadUrl("file:///android_asset/setup.html#" + target());
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    /** What the setup page can ask the app. */
    final class Bridge {
        @JavascriptInterface public String status() { return LinuxService.statusJson(); }
        @JavascriptInterface public void retry() {
            startService(new Intent(WebActivity.this, LinuxService.class).setAction(LinuxService.ACTION_RETRY));
        }
    }

    private static boolean isLocal(Uri u) {
        return "file".equals(u.getScheme()) || "127.0.0.1".equals(u.getHost()) || "localhost".equals(u.getHost());
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (isLocal(u)) return false;
            // Anything else (Claude's sign-in page, links in apps) opens in the phone's browser.
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            // The server is restarting (or not up yet): wait for it on the setup screen.
            if (req.isForMainFrame() && isLocal(req.getUrl()) && !"file".equals(req.getUrl().getScheme())) {
                view.loadUrl("file:///android_asset/setup.html#" + target());
            }
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            List<String> need = new ArrayList<>();
            for (String r : request.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) need.add(Manifest.permission.CAMERA);
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) need.add(Manifest.permission.RECORD_AUDIO);
            }
            List<String> missing = new ArrayList<>();
            for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
            if (missing.isEmpty()) { request.grant(request.getResources()); return; }
            mediaRequest = request;
            requestPermissions(missing.toArray(new String[0]), REQ_MEDIA);
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                callback.invoke(origin, true, false);
                return;
            }
            geoOrigin = origin;
            geoCallback = callback;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_GEO);
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        boolean all = results.length > 0;
        for (int r : results) all &= r == PackageManager.PERMISSION_GRANTED;
        if (request == REQ_MEDIA && mediaRequest != null) {
            if (all) mediaRequest.grant(mediaRequest.getResources()); else mediaRequest.deny();
            mediaRequest = null;
        } else if (request == REQ_GEO && geoCallback != null) {
            boolean any = false;
            for (int r : results) any |= r == PackageManager.PERMISSION_GRANTED;
            geoCallback.invoke(geoOrigin, any, false);
            geoCallback = null;
        }
    }
}
