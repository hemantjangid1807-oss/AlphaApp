package com.brainsim.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * BrainSim host activity.
 *
 * The simulator UI and engine are plain HTML/JS in assets/www and run fully offline.
 * They are served from https://appassets.androidplatform.net/ (intercepted locally, never
 * hits the network) so the page gets a stable secure origin for storage.
 *
 * A small JavaScript bridge ("AndroidBridge") adds what a web page can't do on its own:
 * durable file storage, cross-origin HTTP for market-data downloads, saving exports through
 * the system file picker, and the share sheet.
 */
public class MainActivity extends Activity {

    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + ASSET_HOST + "/www/index.html";
    private static final int REQ_PICK_FILE = 41;
    private static final int REQ_SAVE_FILE = 42;
    private static final int PAPER = 0xFFF3F6F8;
    private static final int MAX_HTTP_BYTES = 16 * 1024 * 1024;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private String pendingSaveId;
    private String pendingSaveContent;
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @SuppressWarnings("deprecation")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setupEdgeToEdge();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(PAPER);
        webView = new WebView(this);
        webView.setBackgroundColor(PAPER);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Pad the content for status/navigation bars, display cutouts and the keyboard.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                l = bars.left;
                t = bars.top;
                r = bars.right;
                b = Math.max(bars.bottom, ime.bottom);
            } else {
                l = insets.getSystemWindowInsetLeft();
                t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight();
                b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.setWebViewClient(new AssetClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "text/csv", "text/comma-separated-values", "text/plain", "application/csv",
                        "application/vnd.ms-excel", "application/octet-stream"});
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a CSV file"), REQ_PICK_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl(START_URL);
    }

    @SuppressWarnings("deprecation")
    private void setupEdgeToEdge() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(light, light);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        if (Build.VERSION.SDK_INT < 35) {
            w.setStatusBarColor(Color.TRANSPARENT);
            w.setNavigationBarColor(Color.TRANSPARENT);
        }
    }

    // ------------------------------------------------------------------ assets

    /** Serves assets/ at https://appassets.androidplatform.net/ and keeps navigation in-app. */
    private final class AssetClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!ASSET_HOST.equals(url.getHost())) return null;
            String path = url.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) path = "/www/index.html";
            path = path.substring(1);
            if (path.contains("..")) return notFound();
            try {
                InputStream in = getAssets().open(path);
                String mime = mimeFor(path);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                headers.put("Access-Control-Allow-Origin", "*");
                return new WebResourceResponse(mime, mime.startsWith("font/") || mime.startsWith("image/png") ? null : "utf-8",
                        200, "OK", headers, in);
            } catch (IOException e) {
                return notFound();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (ASSET_HOST.equals(url.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, url));
            } catch (ActivityNotFoundException ignored) {
                // nothing can open it
            }
            return true;
        }

        private WebResourceResponse notFound() {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null,
                    new ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".otf")) return "font/otf";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        return "text/plain";
    }

    // ------------------------------------------------------------------ bridge

    /** Methods callable from JavaScript as window.AndroidBridge.*. They run on a binder thread. */
    private final class Bridge {

        @JavascriptInterface
        public String readFile(String name) {
            File f = safeFile(name);
            if (f == null || !f.exists()) return "";
            try (InputStream in = new FileInputStream(f)) {
                return new String(readAll(in, Integer.MAX_VALUE), StandardCharsets.UTF_8);
            } catch (IOException e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean writeFile(String name, String content) {
            File f = safeFile(name);
            if (f == null) return false;
            File tmp = new File(f.getParentFile(), f.getName() + ".tmp");
            try (OutputStream out = new FileOutputStream(tmp)) {
                out.write(content.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                return false;
            }
            return tmp.renameTo(f);
        }

        @JavascriptInterface
        public boolean deleteFile(String name) {
            File f = safeFile(name);
            return f != null && (!f.exists() || f.delete());
        }

        @JavascriptInterface
        public void httpGet(final String id, final String url) {
            io.execute(() -> {
                int status = 0;
                String body;
                HttpURLConnection c = null;
                try {
                    URL u = new URL(url);
                    if (!"https".equals(u.getProtocol())) throw new IOException("Only https is allowed");
                    c = (HttpURLConnection) u.openConnection();
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(25000);
                    c.setInstanceFollowRedirects(true);
                    c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE
                            + ") AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36");
                    c.setRequestProperty("Accept", "application/json,text/csv,text/plain,*/*");
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    body = in == null ? "" : new String(readAll(in, MAX_HTTP_BYTES), StandardCharsets.UTF_8);
                } catch (Exception e) {
                    body = String.valueOf(e.getMessage());
                } finally {
                    if (c != null) c.disconnect();
                }
                callJs("window.__brainNative.onHttp(" + JSONObject.quote(id) + "," + status + ","
                        + JSONObject.quote(body) + ")");
            });
        }

        @JavascriptInterface
        public void saveDocument(final String id, final String filename, final String mime, final String content) {
            mainHandler.post(() -> {
                pendingSaveId = id;
                pendingSaveContent = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime);
                i.putExtra(Intent.EXTRA_TITLE, filename);
                try {
                    startActivityForResult(i, REQ_SAVE_FILE);
                } catch (ActivityNotFoundException e) {
                    finishSave(false, "No app is available to save files");
                }
            });
        }

        @JavascriptInterface
        public void shareText(final String subject, final String text) {
            mainHandler.post(() -> {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_SUBJECT, subject);
                i.putExtra(Intent.EXTRA_TEXT, text);
                try {
                    startActivity(Intent.createChooser(i, "Share alpha"));
                } catch (ActivityNotFoundException ignored) {
                    // no share targets
                }
            });
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
                return p.versionName;
            } catch (Exception e) {
                return "";
            }
        }
    }

    private File safeFile(String name) {
        if (name == null || !name.matches("[A-Za-z0-9._-]{1,64}") || name.startsWith(".")) return null;
        return new File(getFilesDir(), name);
    }

    private static byte[] readAll(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n, total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > limit) throw new IOException("Response too large");
            out.write(buf, 0, n);
        }
        in.close();
        return out.toByteArray();
    }

    private void callJs(final String js) {
        mainHandler.post(() -> {
            if (webView != null) webView.evaluateJavascript(js, null);
        });
    }

    private void finishSave(boolean ok, String message) {
        String id = pendingSaveId;
        pendingSaveId = null;
        pendingSaveContent = null;
        if (id == null) return;
        callJs("window.__brainNative.onSaved(" + JSONObject.quote(id) + "," + ok + ","
                + (message == null ? "null" : JSONObject.quote(message)) + ")");
    }

    // --------------------------------------------------------------- lifecycle

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        if (requestCode == REQ_SAVE_FILE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                final Uri uri = data.getData();
                final String content = pendingSaveContent == null ? "" : pendingSaveContent;
                io.execute(() -> {
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) throw new IOException("Could not open the file");
                        os.write(content.getBytes(StandardCharsets.UTF_8));
                        mainHandler.post(() -> finishSave(true, null));
                    } catch (Exception e) {
                        final String msg = "Could not save: " + e.getMessage();
                        mainHandler.post(() -> finishSave(false, msg));
                    }
                });
            } else {
                finishSave(false, "Export cancelled");
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript("(window.handleBack && window.handleBack()) ? 'y' : 'n'", value -> {
            if (value == null || !value.contains("y")) defaultBack();
        });
    }

    @SuppressWarnings("deprecation")
    private void defaultBack() {
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
