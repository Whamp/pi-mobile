#!/system/bin/sh
# Dedicated slow TCG proof AVD only. Never run this on a user's phone.
# Android 15 Settings.Global.WATCHDOG_TIMEOUT_MILLIS uses this string key.
attempt=0
until settings put global system_server_watchdog_timeout_ms 600000; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 120 ] || exit 1
    sleep 5
done
settings get global system_server_watchdog_timeout_ms
# Reduce software rendering during bootstrap; UI proof resets the requested sizes.
wm size 480x800
wm density 160
