# The native bridge contract

One contract, implemented twice — `apps/mobile/ios` in Swift and
`apps/mobile/android` in Kotlin — and consumed once, by
`public/shared/native.js`. The web side never imports a native symbol and never
assumes one exists; it asks `capabilities()` and reads the answer.

## Why the app is a shell, not a rewrite

The web app at `/chw/` and `/focal-point/` has just been proven end to end by
`scripts/check-offline-roundtrip.mjs`: cold start with no server, a report filed
and acknowledged, surviving the app being killed, delivered on the server's
return, exactly once. A native rewrite would discard all of that and would need
its own offline proof, its own queue, its own precache logic — re-implemented,
and therefore unproven, on the one path where a mistake costs a health worker a
report.

So the shell adds what a web page genuinely cannot do, and leaves everything else
where it is tested:

| Capability | Web app alone | With the shell |
| --- | --- | --- |
| Offline queue, delivery, dead letter | works, proven | same code, unchanged |
| Deliver with the app closed | Background Sync (Chrome only) | OS scheduler on both platforms |
| API key storage | `localStorage`, readable by any script on the origin | Keychain / Android Keystore |
| Push to a focal point | unreliable on iOS | APNs / FCM |
| Camera in a village | `getUserMedia`, often blocked | native capture |
| Location while backgrounded | stops when the tab is hidden | background location |

## The surface

```js
window.lindelaNative = {
  platform: 'ios' | 'android' | null,   // null in a plain browser
  version: '1',

  // What this shell can actually do. Never assume: a shell two releases old is
  // still installed on a phone that has not been updated, and a call to a method
  // it does not have must degrade rather than throw.
  capabilities(): {
    secureStore: boolean,
    backgroundSync: boolean,
    camera: boolean,
    location: boolean,
    notifications: boolean,
  },

  // Keychain / Keystore. Resolves the value, or null when absent. Never throws
  // across the bridge: a rejection here would be an unhandled rejection in a
  // click handler.
  secureGet(key: string): Promise<string | null>,
  secureSet(key: string, value: string): Promise<boolean>,
  secureRemove(key: string): Promise<boolean>,

  // Ask the OS to run the queue's drain when it decides the network is back.
  // Resolves whether the request was accepted — the OS may decline, and the
  // caller must still have the in-page drain as its fallback.
  backgroundSyncRegister(tag: string): Promise<boolean>,
  backgroundSyncFlush(tag: string): Promise<{ sent: number, failed: number }>,

  // Native capture. Resolves { dataUrl } or null when cancelled.
  cameraCapture(): Promise<{ dataUrl: string } | null>,

  // One fix, or a background series. `once` resolves { latitude, longitude,
  // accuracy } or null when the person declines — never a fabricated 0,0.
  locationOnce(): Promise<{ latitude: number, longitude: number, accuracy: number } | null>,

  notificationsRequest(): Promise<'granted' | 'denied'>,
  notificationsRegister(deviceToken: string): Promise<boolean>,
}
```

## Rules

1. **Every method returns a promise and never rejects across the bridge.** A
   rejection crossing into JS becomes an unhandled rejection in a click handler,
   which is the one place the product cannot afford one. Errors come back as
   `null` or `false`, and the web side has a fallback for each.
2. **No method may block.** Native calls are dispatched off the main thread on
   both platforms; a bridge call that blocks the UI thread freezes a form a
   health worker is in the middle of filling in.
3. **Absent means absent, not zero.** A declined location permission is `null`.
   The web app has its own "no location" path (`location_source: "not_answered"`),
   and a fabricated `0,0` is the Null Island bug the drill caught.
4. **`capabilities()` is the only version negotiation.** The shell reports what it
   has; the web asks before it uses it. No feature detection by poking.
