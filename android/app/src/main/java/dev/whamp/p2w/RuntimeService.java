package dev.whamp.p2w;

import android.app.Notification;
import android.app.ForegroundServiceStartNotAllowedException;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.ResultReceiver;
import android.util.Log;

public final class RuntimeService extends Service {
    private final Object lifecycle = new Object();
    private volatile boolean stopping;
    private volatile Process server;
    private Thread supervisor;
    private PowerManager.WakeLock wakeLock;
    private Notification notification;

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("agent", "On-device agent", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        notification = new Notification.Builder(this, "agent")
            .setSmallIcon(R.drawable.ic_p2w).setContentTitle("p2w is running on this phone")
            .setContentText("Durable sessions and local tools are available. Tap to open.")
            .setContentIntent(open).setOngoing(true).build();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        ResultReceiver status = intent == null ? null : intent.getParcelableExtra("status", ResultReceiver.class);
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(1, notification);
        } catch (ForegroundServiceStartNotAllowedException error) {
            Log.w("p2w", "Android denied foreground promotion; waiting for a visible Activity retry", error);
            if (status != null) status.send(1, null);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (status != null) status.send(0, null);
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "p2w:agent");
            wakeLock.acquire();
        }
        if (intent != null && intent.getBooleanExtra("restart", false)) {
            synchronized (lifecycle) {
                Process child = server;
                if (child != null) child.destroy();
            }
        }
        if (supervisor == null) {
            supervisor = new Thread(this::supervise, "p2w-runtime");
            supervisor.start();
        }
        return START_STICKY;
    }

    private void supervise() {
        int failures = 0;
        while (!stopping) {
            try {
                RuntimeInstaller layout = RuntimeInstaller.install(this);
                boolean fake = BuildConfig.DEBUG && getSharedPreferences("p2w", MODE_PRIVATE).getBoolean("fake", false);
                Process child;
                synchronized (lifecycle) {
                    if (stopping) return;
                    child = layout.start(fake);
                    server = child;
                }
                long started = System.currentTimeMillis();
                Log.i("p2w", "Node server started fake=" + fake);
                int code = child.waitFor();
                synchronized (lifecycle) { if (server == child) server = null; }
                Log.i("p2w", "Node server exited code=" + code);
                failures = System.currentTimeMillis() - started > 30000 ? 0 : failures + 1;
            } catch (Exception error) {
                Log.e("p2w", "Runtime startup failed", error);
                failures++;
            }
            if (!stopping) try { Thread.sleep(Math.min(1000L * Math.max(1, failures), 10000)); }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return; }
        }
    }

    @Override public void onDestroy() {
        synchronized (lifecycle) {
            stopping = true;
            Process child = server;
            if (child != null) child.destroy();
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
