package dev.whamp.p2w;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.ForegroundServiceStartNotAllowedException;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.PowerManager;
import android.os.ResultReceiver;
import android.provider.Settings;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.window.OnBackInvokedDispatcher;
import java.net.HttpURLConnection;
import java.net.URL;

public final class MainActivity extends Activity {
    static final String ORIGIN = "http://127.0.0.1:18787";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private LinearLayout layout;
    private TextView status;
    private boolean destroyed;
    private boolean loaded;
    private boolean restartRuntime;
    private boolean runtimeRequested;
    private int runtimeRequest;
    private ValueCallback<Uri[]> fileChoice;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        restartRuntime = applyDebugIntent(getIntent());
        layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        status = new TextView(this);
        status.setText("p2w · Starting the on-device runtime…\nFirst launch unpacks the app. This can take a moment.");
        status.setPadding(24, 32, 24, 24);
        status.setOnClickListener(view -> requestRuntime());
        layout.addView(status);
        setContentView(layout);
        if (Build.VERSION.SDK_INT >= 30) layout.setOnApplyWindowInsetsListener((view, insets) -> {
            var bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            var keyboard = insets.getInsets(WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            return WindowInsets.CONSUMED;
        });
        pollHealth();
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            () -> { if (web != null && web.canGoBack()) web.goBack(); else finish(); });
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) requestRuntime();
    }

    @Override protected void onResume() {
        super.onResume();
        requestRuntime();
    }

    private boolean applyDebugIntent(Intent intent) {
        if (!BuildConfig.DEBUG || !intent.hasExtra("fake")) return false;
        boolean fake = intent.getBooleanExtra("fake", false);
        boolean changed = getSharedPreferences("p2w", MODE_PRIVATE).getBoolean("fake", false) != fake;
        getSharedPreferences("p2w", MODE_PRIVATE).edit().putBoolean("fake", fake).apply();
        return changed;
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (applyDebugIntent(intent)) {
            runtimeRequest++;
            restartRuntime = true;
            runtimeRequested = false;
            loaded = false;
            handler.postDelayed(this::pollHealth, 1800);
        }
        requestRuntime();
    }

    private void requestRuntime() {
        if (runtimeRequested || destroyed || !hasWindowFocus()) return;
        try {
            int request = ++runtimeRequest;
            Intent service = new Intent(this, RuntimeService.class).putExtra("restart", restartRuntime);
            service.putExtra("status", new ResultReceiver(handler) {
                @Override protected void onReceiveResult(int result, Bundle data) {
                    if (destroyed || request != runtimeRequest) return;
                    if (result == 0) { restartRuntime = false; return; }
                    runtimeRequested = false;
                    status.setVisibility(TextView.VISIBLE);
                    status.setText("Android delayed the agent service. Keep p2w open and tap here to retry.");
                }
            });
            startForegroundService(service);
            runtimeRequested = true;
        } catch (ForegroundServiceStartNotAllowedException error) {
            status.setVisibility(TextView.VISIBLE);
            status.setText("Android is waiting for p2w to be visible. Tap here to start the on-device agent.");
        }
    }

    private void createWebView() {
        web = new WebView(this);
        layout.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setSupportMultipleWindows(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return navigate(request.getUrl()); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override @SuppressWarnings("deprecation") public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams parameters) {
                if (fileChoice != null) fileChoice.onReceiveValue(null);
                fileChoice = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(pick, 2); }
                catch (ActivityNotFoundException error) { fileChoice.onReceiveValue(null); fileChoice = null; }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message result) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        navigate(request.getUrl());
                        handler.post(popup::destroy);
                        return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup);
                result.sendToTarget();
                return true;
            }
        });
    }

    private boolean navigate(Uri uri) {
        boolean local = "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == 18787;
        if (local) {
            if ("/android/notifications".equals(uri.getPath())) { notifications(); return true; }
            if ("/android/battery".equals(uri.getPath())) { battery(); return true; }
            if ("/android/debug".equals(uri.getPath()) && BuildConfig.DEBUG) { debugMode(); return true; }
            return false;
        }
        if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
            catch (ActivityNotFoundException error) { new AlertDialog.Builder(this).setMessage("Install a browser to sign in to providers.").setPositiveButton("OK", null).show(); }
        }
        return true;
    }

    private void notifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
    }

    private void battery() {
        PowerManager power = getSystemService(PowerManager.class);
        Intent intent = power.isIgnoringBatteryOptimizations(getPackageName())
            ? new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))
            : new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }

    private void debugMode() {
        boolean fake = getSharedPreferences("p2w", MODE_PRIVATE).getBoolean("fake", false);
        new AlertDialog.Builder(this).setTitle("Debug provider")
            .setMessage(fake ? "Switch back to real provider sign-in?" : "Use the deterministic fake provider? Its tools still run on this phone.")
            .setNegativeButton("Cancel", null).setPositiveButton("Switch", (dialog, which) -> {
                getSharedPreferences("p2w", MODE_PRIVATE).edit().putBoolean("fake", !fake).apply();
                runtimeRequest++;
                restartRuntime = true;
                runtimeRequested = false;
                requestRuntime();
                loaded = false;
                handler.postDelayed(this::pollHealth, 1800);
            }).show();
    }

    private void pollHealth() {
        if (destroyed || loaded) return;
        new Thread(() -> {
            boolean ready = false;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(ORIGIN + "/health").openConnection();
                connection.setConnectTimeout(700); connection.setReadTimeout(700);
                ready = connection.getResponseCode() == 200;
                connection.disconnect();
            } catch (Exception ignored) { }
            boolean healthy = ready;
            handler.post(() -> {
                if (destroyed || loaded) return;
                if (healthy) {
                    loaded = true;
                    if (web == null) createWebView();
                    status.setVisibility(TextView.GONE);
                    web.loadUrl(ORIGIN + "/");
                }
                else handler.postDelayed(this::pollHealth, 700);
            });
        }, "p2w-health").start();
    }

    @Override @SuppressWarnings("deprecation") protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 2 && fileChoice != null) {
            Uri[] selected = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    selected = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < selected.length; i++) selected[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) selected = new Uri[]{data.getData()};
            }
            fileChoice.onReceiveValue(selected);
            fileChoice = null;
        }
    }

    @Override public void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        if (fileChoice != null) { fileChoice.onReceiveValue(null); fileChoice = null; }
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
