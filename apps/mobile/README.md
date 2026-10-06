# Native apps

Two apps, two roles, one shell.

| App | Surface | Bundle id | What it is for |
| --- | --- | --- | --- |
| **CHW** | `/chw/` | `org.lindela.chw` / `org.lindela.chw` | A health worker filing symptom, incident and reply reports from a village with no signal. |
| **Focal point** | `/focal-point/` | `org.lindela.focalpoint` | A focal point reviewing alerts and approving pre-agreed finance. |

## Why a shell and not a rewrite

The web app's offline behaviour is proven end to end by
[`scripts/check-offline-roundtrip.mjs`](../../scripts/check-offline-roundtrip.mjs):
cold start with the server stopped, a report filed and acknowledged, surviving the
app being killed, delivered when the server came back, exactly one copy at the
server. A native rewrite discards all of that and would need its own queue, its
own precache logic and its own round-trip drill — re-implemented, and therefore
unproven, on the one path where a mistake costs a health worker a report.

The shell adds what a web page cannot do and leaves everything else where it is
tested:

| Capability | Browser | With the shell |
| --- | --- | --- |
| Offline queue, delivery, dead letter | works, proven | the same code, unchanged |
| Deliver with the app closed | Background Sync (Chrome only, best effort) | `BGTaskScheduler` / `WorkManager` |
| API key storage | `localStorage`, readable by any script on the origin | Keychain / Android Keystore (AES-GCM) |
| Push to a focal point | unreliable on iOS | APNs / FCM registration |
| Camera | `getUserMedia`, often blocked | native capture |
| Location | stops when the tab is hidden | one-shot fix, released immediately |

## Layout

```
shared/bridge-contract.md   the one contract both platforms implement
ios/                        xcodegen spec (project.yml) + Swift sources
android/                    Gradle + Kotlin, two product flavours
```

The Xcode project is generated: `cd ios && xcodegen generate`. A committed
`.pbxproj` is one nobody edits by hand and one that drifts from its sources.

## Building

```bash
# iOS — the server URL is a build setting, not a screen
cd apps/mobile/ios
xcodegen generate
LINDELA_SERVER_URL=http://192.168.100.52:4177 \
  xcodebuild -project LindelaCHW.xcodeproj -scheme LindelaCHW \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 15 Pro' build
LINDELA_SERVER_URL=http://192.168.100.52:4177 \
  xcodebuild -project LindelaCHW.xcodeproj -scheme LindelaFocalPoint \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 15 Pro' build

# Android — JDK 17 is pinned in gradle.properties; see the comment there
cd apps/mobile/android
./gradlew assembleDebug assembleFocalPointDebug        # or: gradle …
./gradlew installDebug
```

`LINDELA_SERVER_URL` unset leaves the literal `$(LINDELA_SERVER_URL)` in the
Info.plist, which the app recognises and falls back from. A server URL typed on
a phone by somebody in a hurry is a health worker filing reports into the void
while being told they are saved.

## What was verified, and how

Everything below was run, not reasoned about. Screenshots and logs are not
committed; the commands are.

| | iOS (simulator) | Android (emulator) |
| --- | --- | --- |
| Builds | ✅ `xcodebuild`, iOS 17.4 | ✅ `gradle assembleDebug` |
| Installs and launches | ✅ iPhone 15 Pro | ✅ API 34 AVD |
| Serves the right surface | ✅ `/chw/` and `/focal-point/` | ✅ both |
| Bridge answers from the page | ✅ `"This app delivers queued reports with the app closed."` | ✅ same line, plus `capabilities()` read over CDP |
| Capabilities are per-device | — | ✅ `camera: true, location: false` on an emulator that has one and not the other |
| WorkManager drain runs | — | ✅ `Worker result SUCCESS … QueueDrainWorker` in logcat |
| Offline round trip | ✅ `check-offline-roundtrip.mjs` against a stopped server (browser tier; the shell serves the same page) | |

### What is **not** verified

- **Push delivery.** The APNs/FCM *registration* path is implemented and the
  token is held for the server to take, but nothing was delivered: there are no
  APNs or FCM credentials here, and no server endpoint stores a device token.
  That endpoint is deliberately not in this pass — a device token is personal
  data with a retention question attached, and it belongs with the retention work
  (`R-12`/`ENH-18`) rather than inside a shell change.
- **Background delivery actually draining on a locked device.** The scheduler is
  registered and the drain runs when the OS wakes the app (proved on Android via
  logcat), but no observation here covers a full OS-chosen window on a real
  handset with the app closed for days.
- **Real hardware.** Everything above is a simulator and an emulator. Camera
  capture, background location and low-memory behaviour on a two-year-old
  Android handset are unmeasured.
- **Signing and distribution.** Both builds are unsigned (iOS) or debug-signed
  (Android). A release build needs a real keystore and an Apple team id; the
  Gradle release config currently points at the debug signing config and says so.
