package io.lumen.vrplayer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.cert.X509Certificate;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lumen VR Player for Android.
 * The player UI (the same code as the desktop app) runs in a WebView served from the APK's assets
 * at https://appassets.androidplatform.net, which makes it a secure, same-origin page:
 * WebGL upscaling, local video files and AI models all work. The app can also connect to a
 * Lumen server (ZimaOS / NAS) to browse its library and use its format conversion.
 */
public class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String LOCAL_URL = "https://" + ASSET_HOST + "/assets/www/src/index.html";
    private static final int PICK_FILES = 1001;

    private FrameLayout root;
    private WebView web;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private ValueCallback<Uri[]> fileCallback;
    private SharedPreferences prefs;
    private WebViewAssetLoader assetLoader;
    private Chrome chrome;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("lumen", MODE_PRIVATE);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(7, 8, 11));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(7, 8, 11));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        // The bundled player (https) streams from a Lumen server on the home network, usually plain http.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(ASSET_HOST)
                .addPathHandler("/assets/", new AssetHandler(this))
                .build();

        web.setWebViewClient(new Client());
        chrome = new Chrome();
        web.setWebChromeClient(chrome);
        web.addJavascriptInterface(new Bridge(), "LumenAndroid");

        // Always run the player bundled with this app; a connected server is only used for its library,
        // conversion and playlists. That way the phone app's screens never depend on the server's version.
        web.loadUrl(LOCAL_URL);
    }

    // ---------------------------------------------------------------------------------------------
    // Serves the bundled player with correct MIME types (ES modules, WebAssembly) and
    // cross-origin-isolation headers (lets the AI upscaler use several CPU threads).
    private static class AssetHandler implements WebViewAssetLoader.PathHandler {
        private final Context context;

        AssetHandler(Context context) { this.context = context.getApplicationContext(); }

        @Override
        public WebResourceResponse handle(String path) {
            try {
                InputStream in = context.getAssets().open(path);
                String mime = mimeFor(path);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cross-Origin-Opener-Policy", "same-origin");
                headers.put("Cross-Origin-Embedder-Policy", "require-corp");
                headers.put("Cross-Origin-Resource-Policy", "same-origin");
                headers.put("Cache-Control", "no-cache");
                String charset = mime.startsWith("text/") || mime.endsWith("json") ? "utf-8" : null;
                return new WebResourceResponse(mime, charset, 200, "OK", headers, in);
            } catch (IOException e) {
                return null;
            }
        }

        private static String mimeFor(String path) {
            String p = path.toLowerCase(Locale.ROOT);
            if (p.endsWith(".html")) return "text/html";
            if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
            if (p.endsWith(".css")) return "text/css";
            if (p.endsWith(".json")) return "application/json";
            if (p.endsWith(".wasm")) return "application/wasm";
            if (p.endsWith(".png")) return "image/png";
            if (p.endsWith(".svg")) return "image/svg+xml";
            if (p.endsWith(".ico")) return "image/x-icon";
            return "application/octet-stream";
        }
    }

    private String serverHost() {
        String s = prefs.getString("server", "");
        return s.isEmpty() ? null : Uri.parse(s).getHost();
    }


    // ---------------------------------------------------------------------------------------------
    // Server relay: the player asks https://appassets.androidplatform.net/server/<path> and the app
    // fetches http(s)://<your server>/<path> itself. To the WebView everything is then same-origin,
    // so no CORS, mixed-content or local-network restrictions apply, and any Lumen server version works.

    /** "http://192.168.1.50:8095" from whatever address was saved (older versions saved a page URL). */
    private String serverOrigin() {
        String saved = prefs.getString("server", "");
        if (saved.isEmpty()) return null;
        Uri u = Uri.parse(saved);
        if (u.getScheme() == null || u.getHost() == null) return null;
        return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    private HttpURLConnection openServer(String pathAndQuery, String method) throws IOException {
        String origin = serverOrigin();
        if (origin == null) throw new IOException("No server configured");
        HttpURLConnection c = (HttpURLConnection) new URL(origin + pathAndQuery).openConnection();
        if (c instanceof HttpsURLConnection) trustServerCertificate((HttpsURLConnection) c);
        c.setRequestMethod(method);
        c.setConnectTimeout(6000);
        c.setReadTimeout(0);                 // video streams stay open for as long as you watch
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        return c;
    }

    /** Lumen servers use a self-signed certificate; trust it only on connections to your own server. */
    private static void trustServerCertificate(HttpsURLConnection c) {
        try {
            TrustManager[] all = { new X509TrustManager() {
                public void checkClientTrusted(X509Certificate[] chain, String auth) { }
                public void checkServerTrusted(X509Certificate[] chain, String auth) { }
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            } };
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, all, new java.security.SecureRandom());
            c.setSSLSocketFactory(ctx.getSocketFactory());
            c.setHostnameVerifier((h, session) -> true);
        } catch (Exception ignored) {
        }
    }

    private WebResourceResponse proxyToServer(WebResourceRequest request) {
        Uri u = request.getUrl();
        String pathAndQuery = u.getEncodedPath().substring("/server".length()) + (u.getEncodedQuery() != null ? "?" + u.getEncodedQuery() : "");
        Map<String, String> out = new HashMap<>();
        out.put("Cache-Control", "no-store");
        out.put("Cross-Origin-Resource-Policy", "same-origin");
        try {
            HttpURLConnection c = openServer(pathAndQuery, request.getMethod() == null ? "GET" : request.getMethod());
            Map<String, String> in = request.getRequestHeaders();
            if (in != null) {
                for (Map.Entry<String, String> h : in.entrySet()) {
                    String k = h.getKey();
                    if (k.equalsIgnoreCase("Range") || k.equalsIgnoreCase("Accept")) c.setRequestProperty(k, h.getValue());
                }
            }
            int code = c.getResponseCode();
            InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            String type = c.getContentType() == null ? "application/octet-stream" : c.getContentType();
            String mime = type.split(";")[0].trim();
            String charset = type.toLowerCase(Locale.ROOT).contains("charset=utf-8") || mime.startsWith("text/") || mime.endsWith("json") ? "utf-8" : null;
            for (String k : new String[]{"Content-Length", "Content-Range", "Accept-Ranges"}) {
                String v = c.getHeaderField(k);
                if (v != null) out.put(k, v);
            }
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = code == 206 ? "Partial Content" : "OK";
            if (code >= 300 && code < 400) code = 502;      // WebResourceResponse can't carry redirects
            return new WebResourceResponse(mime, charset, code, reason, out, body);
        } catch (IOException e) {
            String msg = "{\"error\":\"unreachable\",\"detail\":" + jsonString(String.valueOf(e.getMessage())) + "}";
            return new WebResourceResponse("application/json", "utf-8", 502, "Bad Gateway", out,
                    new ByteArrayInputStream(msg.getBytes(StandardCharsets.UTF_8)));
        }
    }

    private static String jsonString(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }


    // ---------------------------------------------------------------------------------------------
    // Stream relay for live / network video (used when the app isn't connected to a Lumen server):
    //   /proxy/<name>?url=<stream>  → fetched by the app. HLS playlists are rewritten so every segment
    //   and sub-playlist also comes through this relay, keeping the stream same-origin for the player.
    private static final String STREAM_UA = "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 LumenVRPlayer";
    private static final Pattern URI_ATTR = Pattern.compile("URI=\"([^\"]+)\"");

    private static String relayUrl(String absolute) {
        String p = absolute.toLowerCase(Locale.ROOT);
        String name = p.contains(".m3u8") || p.contains(".m3u") ? "live.m3u8" : "seg";
        return "/proxy/" + name + "?url=" + Uri.encode(absolute);
    }

    private static String absolutize(String base, String ref) {
        try { return new URL(new URL(base), ref).toString(); } catch (Exception e) { return ref; }
    }

    private static String rewriteHls(String text, String base) {
        StringBuilder out = new StringBuilder(text.length() + 1024);
        for (String line : text.split("\r?\n")) {
            String t = line.trim();
            if (t.isEmpty()) { out.append('\n'); continue; }
            if (t.startsWith("#")) {
                Matcher m = URI_ATTR.matcher(t);
                StringBuffer sb = new StringBuffer();
                while (m.find()) m.appendReplacement(sb, Matcher.quoteReplacement("URI=\"" + relayUrl(absolutize(base, m.group(1))) + "\""));
                m.appendTail(sb);
                out.append(sb).append('\n');
            } else {
                out.append(relayUrl(absolutize(base, t))).append('\n');
            }
        }
        return out.toString();
    }

    private WebResourceResponse proxyExternal(WebResourceRequest request) {
        Uri u = request.getUrl();
        String target = u.getQueryParameter("url");
        Map<String, String> out = new HashMap<>();
        out.put("Cache-Control", "no-store");
        if (target == null || !(target.startsWith("http://") || target.startsWith("https://"))) {
            return new WebResourceResponse("text/plain", "utf-8", 400, "Bad Request", out, new ByteArrayInputStream("Only http(s) links".getBytes(StandardCharsets.UTF_8)));
        }
        boolean rawList = u.getPath() != null && u.getPath().endsWith("/list.m3u");
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection();
            c.setRequestProperty("User-Agent", STREAM_UA);
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            Map<String, String> in = request.getRequestHeaders();
            if (in != null) for (Map.Entry<String, String> h : in.entrySet()) if (h.getKey().equalsIgnoreCase("Range")) c.setRequestProperty("Range", h.getValue());
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) code = 502;
            String type = c.getContentType() == null ? "" : c.getContentType().toLowerCase(Locale.ROOT);
            String finalUrl = c.getURL().toString();
            String lowerPath = c.getURL().getPath().toLowerCase(Locale.ROOT);
            boolean looksPlaylist = type.contains("mpegurl") || lowerPath.endsWith(".m3u8") || lowerPath.endsWith(".m3u")
                    || (u.getPath() != null && u.getPath().endsWith(".m3u8"));
            InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (body == null) body = new ByteArrayInputStream(new byte[0]);
            if (code < 400 && (looksPlaylist || rawList)) {
                byte[] data = readAll(body, 20 * 1024 * 1024);
                String text = new String(data, StandardCharsets.UTF_8);
                if (!rawList && text.contains("#EXT-X-")) {
                    byte[] rewritten = rewriteHls(text, finalUrl).getBytes(StandardCharsets.UTF_8);
                    return new WebResourceResponse("application/vnd.apple.mpegurl", "utf-8", 200, "OK", out, new ByteArrayInputStream(rewritten));
                }
                return new WebResourceResponse("text/plain", "utf-8", code, "OK", out, new ByteArrayInputStream(data));
            }
            String mime = type.isEmpty() ? "application/octet-stream" : type.split(";")[0].trim();
            for (String k : new String[]{"Content-Length", "Content-Range", "Accept-Ranges"}) {
                String v = c.getHeaderField(k);
                if (v != null) out.put(k, v);
            }
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = code == 206 ? "Partial Content" : "OK";
            return new WebResourceResponse(mime, null, code, reason, out, body);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", out,
                    new ByteArrayInputStream(String.valueOf(e.getMessage()).getBytes(StandardCharsets.UTF_8)));
        }
    }

    private static byte[] readAll(InputStream in, int limit) throws IOException {
        java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        int n;
        while ((n = in.read(chunk)) > 0) {
            buf.write(chunk, 0, n);
            if (buf.size() > limit) throw new IOException("Too large");
        }
        in.close();
        return buf.toByteArray();
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (ASSET_HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/server/")) {
                return proxyToServer(request);
            }
            if (ASSET_HOST.equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/proxy/")) {
                return proxyExternal(request);
            }
            return assetLoader.shouldInterceptRequest(u);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String host = uri.getHost();
            if (ASSET_HOST.equals(host) || (host != null && host.equals(serverHost()))) return false;
            openExternal(uri.toString());   // anything else (e.g. GitHub) opens in the browser
            return true;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // Lumen servers use their own (self-signed) certificate; accept it only for the server you connected to.
            String host = Uri.parse(error.getUrl()).getHost();
            if (host != null && host.equals(serverHost())) handler.proceed();
            else handler.cancel();
        }

    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            boolean wantsModel = false;
            for (String t : params.getAcceptTypes()) if (t != null && t.contains(".onnx")) wantsModel = true;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(wantsModel ? "*/*" : "video/*");
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(i, PICK_FILES);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customViewCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            setFullscreenUi(true);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            root.removeView(customView);
            customView = null;
            web.setVisibility(View.VISIBLE);
            setFullscreenUi(false);
            if (customViewCallback != null) customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int k = 0; k < clip.getItemCount(); k++) result[k] = clip.getItemAt(k).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @SuppressWarnings("deprecation")
    private void setFullscreenUi(boolean on) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (on) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(on
                    ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    : 0);
        }
    }

    private void openExternal(String url) {
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (customView != null) {
            chrome.onHideCustomView();
            return;
        }
        // Let the player close its own panels / exit zoom first.
        web.evaluateJavascript("(window.__lumenBack && window.__lumenBack()) ? 'y' : 'n'", value -> {
            if (value != null && value.contains("y")) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /** Small, explicit API for the player page (window.LumenAndroid). */
    private class Bridge {
        @JavascriptInterface
        public String getVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "0";
            }
        }

        @JavascriptInterface
        public String getServer() {
            return prefs.getString("server", "");
        }

        @JavascriptInterface
        public void connectServer(String url) {
            if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
            prefs.edit().putString("server", url).apply();
            runOnUiThread(() -> web.loadUrl(LOCAL_URL));
        }

        /** PUT/POST with a JSON body to the server (runs on a background binder thread). Returns the HTTP status. */
        @JavascriptInterface
        public int serverSend(String method, String path, String json) {
            try {
                HttpURLConnection c = openServer(path, "PUT".equals(method) ? "PUT" : "POST");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] data = (json == null ? "" : json).getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(data.length);
                try (OutputStream os = c.getOutputStream()) { os.write(data); }
                int code = c.getResponseCode();
                c.disconnect();
                return code;
            } catch (Exception e) {
                return 0;
            }
        }

        @JavascriptInterface
        public void disconnectServer() {
            prefs.edit().remove("server").apply();
            runOnUiThread(() -> web.loadUrl(LOCAL_URL));
        }

        @JavascriptInterface
        public void openUrl(String url) {
            runOnUiThread(() -> openExternal(url));
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void setLandscape(boolean on) {
            runOnUiThread(() -> setRequestedOrientation(on
                    ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
        }
    }
}
