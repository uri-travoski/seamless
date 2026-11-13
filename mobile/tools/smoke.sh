#!/usr/bin/env bash
# Scripted emulator smoke test: install the debug build, sign in, open the list, search, open a message,
# send a mail (via a mailto: intent), simulate a push. Screenshots go to $SHOTS.
# Usage: mobile/tools/smoke.sh [server-url] [email] [password]
# Needs a running emulator (adb device) and a Seamless server reachable from it (host = 10.0.2.2).
set -euo pipefail
export PATH="$PATH:/opt/android-sdk/platform-tools"
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER="${1:-http://10.0.2.2:4901}"
EMAIL="${2:-reallybasic@gmail.com}"
PASS="${3:-t00lk1t1}"
SHOTS="${SHOTS:-$HERE/../../../../Planning/screens/T9}"
SERIAL="${ANDROID_SERIAL:-emulator-5556}"
ADB="adb -s $SERIAL"
PKG=au.sam.seamless
mkdir -p "$SHOTS"

shot() { $ADB exec-out screencap -p > "$SHOTS/smoke-$1.png"; echo "  screenshot smoke-$1.png"; }
dump() { $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; $ADB exec-out cat /sdcard/ui.xml; }
# tap_text "<text or content-desc>"  — waits up to 15 s for a node whose text/desc contains it
tap_text() {
  local want="$1" i xy
  for i in $(seq 1 15); do
    xy=$(dump | python3 -I -c '
import sys,re
want=sys.argv[1].lower(); last=bool(sys.argv[2]); exact=bool(sys.argv[3]); x=sys.stdin.read()
for m in re.finditer(r"<node [^>]*>", x):
    n=m.group(0)
    t=re.search(r" text=\"([^\"]*)\"", n); d=re.search(r"content-desc=\"([^\"]*)\"", n); b=re.search(r"bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"", n)
    if b and ((t and (want==t.group(1).lower() if exact else want in t.group(1).lower())) or (d and (want==d.group(1).lower() if exact else want in d.group(1).lower()))):
        x1,y1,x2,y2=map(int,b.groups()); print((x1+x2)//2,(y1+y2)//2)
        if not last: break
' "$want" "${LAST:-}" "${EXACT:-}") || true
    xy=$(printf '%s\n' "$xy" | tail -1)
    if [ -n "$xy" ]; then $ADB shell input tap $xy; return 0; fi
    sleep 1
  done
  echo "FAIL: '$want' not found on screen"; shot "fail-$(echo "$want" | tr -c 'a-z0-9' _)"; exit 1
}
has_text() { dump | grep -qi -- "$1"; }
wait_text() { for _ in $(seq 1 20); do has_text "$1" && return 0; sleep 1; done; echo "FAIL: '$1' never appeared"; shot "fail-wait"; exit 1; }
type_text() { $ADB shell input text "$(printf %s "$1" | sed 's/ /%s/g')"; }

echo "1. install debug build"
APK="$HERE/../app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || (cd "$HERE/.." && ./gradlew assembleDebug)
$ADB shell pm clear $PKG >/dev/null 2>&1 || true
$ADB install -r "$APK" >/dev/null
$ADB shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
$ADB shell am start -n $PKG/.MainActivity >/dev/null
wait_text "Server address"; shot 1-welcome

echo "2. log in against $SERVER"
tap_text "Server address"; type_text "$SERVER"; $ADB shell input keyevent 4 || true
tap_text "Check"; wait_text "Email"
tap_text "Email"; type_text "$EMAIL"
tap_text "Password"; type_text "$PASS"; $ADB shell input keyevent 4 || true
LAST=1 tap_text "Sign in"
wait_text "Search mail"; shot 2-list

echo "3. list is populated"
has_text "Inbox" || has_text "Compose" || { echo "FAIL: no mailbox UI"; exit 1; }

echo "4. search"
tap_text "Search mail"; sleep 1; type_text "crossword"; $ADB shell input keyevent 66
sleep 3; shot 4-search
$ADB shell input keyevent 4 || true

echo "5. open a message"
sleep 1; $ADB shell input tap 540 700; sleep 3; shot 5-message
$ADB shell input keyevent 4 || true

echo "6. send a mail via mailto: (delivered by the server to GreenMail)"
SUBJ="smoke $(date +%H%M%S)"
$ADB shell am start -a android.intent.action.SENDTO -d "'mailto:smoke@demo.test?subject=${SUBJ// /%20}&body=hello%20from%20the%20smoke%20test'" $PKG >/dev/null
wait_text "Subject"; shot 6-compose
EXACT=1 tap_text "send"; sleep 2; shot 6-sent
echo "  sent: $SUBJ"

echo "7. simulate push (debug build)"
sleep 8   # let the undo-send window pass so the message is really sent
for _ in 1 2 3 4; do has_text "Open menu" && break; $ADB shell input keyevent 4; sleep 1; done   # back out of search to the list
tap_text "Open menu"
for _ in 1 2 3 4 5; do has_text "text=\"Settings\"" && break; $ADB shell input swipe 300 1900 300 600 300; sleep 1; done
EXACT=1 tap_text "settings"; sleep 1
for _ in 1 2 3 4; do has_text "Simulate push: new mail" && break; $ADB shell input swipe 540 1800 540 600 300; done
tap_text "Simulate push: new mail"; sleep 2
$ADB shell cmd statusbar expand-notifications; sleep 2; shot 7-notification
$ADB shell cmd statusbar collapse
$ADB shell dumpsys notification --noredact | grep -c "pkg=$PKG" | sed 's/^/  notifications from app: /'

echo "SMOKE OK"
