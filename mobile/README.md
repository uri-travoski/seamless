# Seamless for Android (v1.0.0)

Kotlin + Jetpack Compose app for a Seamless server. Min SDK 26, target 36, arm64-v8a only, no native libraries. Release APK ≈ 2 MB.

## Build
```bash
cd mobile
./gradlew testDebugUnitTest          # JVM unit tests
./gradlew assembleDebug              # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease bundleRelease lintRelease
```
`local.properties` must contain `sdk.dir=/path/to/android-sdk`.

## Run on the emulator
```bash
$ANDROID_SDK/emulator/emulator -avd <avd-name> &      # e.g. timeline-phone
mobile/tools/smoke.sh                                  # install, log in, list, search, open, send, simulated push
```
The emulator reaches the host at `10.0.2.2`; a dev server on `:4901` is `http://10.0.2.2:4901` (plain http is allowed only for private addresses).

## Release
1. Create an upload key: `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000`.
2. Create the git-ignored `mobile/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`). Without it the release build is debug-signed (fine for sideloading).
3. `./gradlew assembleRelease` (APK for sideload) and `./gradlew bundleRelease` (AAB for Play). Check with `apksigner verify --print-certs app-release.apk`.
4. Bump `versionCode` / `versionName` in `app/build.gradle.kts` for every upload.

## Sideload / LAN download
`adb install -r seamless-1.0.0.apk`, or set `SEAMLESS_APK_PATH=/path/to/seamless.apk` on the server and open `http://<server>:<port>/downloads/seamless.apk` on the phone.

## Firebase push (optional)
Without Firebase the app checks for mail every 15 minutes. For push:
1. Create a Firebase project, add an Android app with package `au.sam.seamless` (see `applicationId` in `app/build.gradle.kts`), download `google-services.json` into `mobile/app/` (git-ignored) and rebuild.
2. Project settings → Service accounts → generate a private key (JSON). An administrator pastes it in the web app under Settings → Integrations → Mobile push (Firebase) and presses "Send test push to my phone".

## Play Store
Listing text, data-safety answers, privacy policy, reviewer notes and a checklist are in `mobile/play/`. The privacy policy URL is `https://<your server>/privacy`.
