# Play Console checklist

- [x] Target API 36, min 26 (`mobile/app/build.gradle.kts`); 64-bit arm64-v8a only; no native libs of our own (16 KB page alignment n/a)
- [x] Permissions: INTERNET, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS only; `allowBackup=false`
- [x] Release AAB (`./gradlew bundleRelease`) → `app/build/outputs/bundle/release/app-release.aab`, signed with the upload key from `mobile/keystore.properties`
- [ ] Create the upload key (see below) and enrol in **Play App Signing**
- [ ] Developer account (fee), app created, package `au.sam.seamless`
- [ ] Privacy policy URL: `https://<server>/privacy` (set `privacy_contact` first)
- [ ] App access: login required → give the demo credentials (`review-notes.md`)
- [x] Ads: **No**
- [ ] Data safety form: copy from `data-safety.md`
- [ ] Content rating questionnaire (IARC): category *Utility / Productivity / Communication*; violence No, sexual content No, language No, controlled substances No, gambling No; **user-generated content / users can communicate: Yes** (it is an email client) — expected rating: Everyone / PEGI 3 (with "users interact" note)
- [ ] Target audience: 18+ (not for children); News app: No; Government app: No; Financial features: None; Health: None
- [ ] Store listing: text from `listing.md`; icon `icon-512.png` (512×512, 32-bit PNG); feature graphic `feature-graphic-1024x500.png`; **2–8 phone screenshots** (min 320 px, 16:9–9:16) chosen from `Planning/screens/T9/` — suggested: `T9.2-home-light.png` (list), `t93-scope-sheet.png` (mailbox selector), `t93-search-light.png`, `t95-html.png` (conversation), `t96-compose.png`, `t94-drawer.png`, `t97-shade.png` (notifications), `t93-list-dark.png` (dark)
- [ ] New personal developer accounts: closed test with ≥ 12 testers for 14 days before production

## Create the upload key
```bash
keytool -genkeypair -v -keystore ~/seamless-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000
cat > mobile/keystore.properties <<EOP
storeFile=/home/<you>/seamless-upload.jks
storePassword=…
keyAlias=upload
keyPassword=…
EOP
```
`keystore.properties`, `*.jks`, `*.keystore` are git-ignored; back the key up somewhere safe. In Play Console → Setup → App signing choose **Use Google-generated key (Play App Signing)** and upload the AAB signed with this upload key; if the upload key is lost Google can reset it.

## Build commands
`cd mobile && ./gradlew assembleRelease bundleRelease lintRelease` (5+ minutes; run in the background).
