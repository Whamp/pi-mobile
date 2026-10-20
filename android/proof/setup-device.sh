#!/system/bin/sh
# Dedicated proof AVD only: these mirror the phone settings in onboarding.
wm dismiss-keyguard
input keyevent 82
locksettings set-disabled true
settings put secure lockscreen.disabled 1
settings put global window_animation_scale 0
settings put global transition_animation_scale 0
settings put global animator_duration_scale 0
settings put global hide_error_dialogs 1
svc power stayon true
wm density 420
cmd deviceidle whitelist +dev.whamp.p2w
am set-standby-bucket dev.whamp.p2w active
pm grant dev.whamp.p2w android.permission.POST_NOTIFICATIONS
