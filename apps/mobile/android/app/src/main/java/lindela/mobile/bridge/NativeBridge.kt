package lindela.mobile.bridge

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.work.WorkManager
import lindela.mobile.work.QueueDrainWorker

/**
 * The Android half of `apps/mobile/shared/bridge-contract.md`.
 *
 * Two rules the web side relies on, and both were learned the hard way on the
 * other half of this contract:
 *
 *  - **Never reject across the bridge.** `@JavascriptInterface` methods run on a
 *    background thread, so an exception thrown here becomes an unhandled
 *    rejection in a click handler, in the middle of a form a health worker is
 *    filling in. Everything resolves; failures come back as `null` or `false`.
 *  - **Never invent a value.** A declined location permission is `null`, not
 *    `{0, 0}` — that pair is Null Island, and a symptom report placed there reads
 *    as a disease signal pointing at open water.
 */
class NativeBridge(private val activity: Activity) {

    companion object {
        /** The name on the JavaScript side: `window.lindelaNative`. */
        const val NAME = "lindelaNative"

        /**
         * The raw interface, before the shim wraps it.
         *
         * `addJavascriptInterface` installs the object under `NAME`, and the
         * document-start script replaces it with a promise-shaped wrapper — so the
         * wrapper has to be able to reach the original, or every call lands on
         * itself.
         */
        const val RAW_NAME = "lindelaNativeRaw"
    }

    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null

    fun attach(view: WebView) { webView = view }
    fun detach() { webView = null }

    private fun context(): Context = activity.applicationContext

    /* ------------------------------------------------------------ capabilities */

    /**
     * What this build can actually do.
     *
     * Checked against the real device rather than assumed from the build
     * variant: an emulator has no camera, and a shell that claims one produces a
     * button that opens nothing.
     */
    private fun capabilities(): Map<String, Boolean> {
        val coarse = ContextCompat.checkSelfPermission(
            context(), android.Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val fine = ContextCompat.checkSelfPermission(
            context(), android.Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return mapOf(
            "secureStore" to true,
            "backgroundSync" to true,
            "camera" to activity.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY),
            "location" to (coarse || fine),
            "notifications" to true,
        )
    }

    @JavascriptInterface
    fun platform(): String = "android"

    @JavascriptInterface
    fun version(): String = "1"

    @JavascriptInterface
    fun capabilitiesJson(): String {
        val caps = capabilities()
        fun flag(key: String) = if (caps[key] == true) "true" else "false"
        return "{" +
            "\"secureStore\":${flag("secureStore")}," +
            "\"backgroundSync\":${flag("backgroundSync")}," +
            "\"camera\":${flag("camera")}," +
            "\"location\":${flag("location")}," +
            "\"notifications\":${flag("notifications")}" +
            "}"
    }

    /* ------------------------------------------------------------- secure store */

    @JavascriptInterface
    fun secureGet(key: String): String? = SecureStore.read(context(), key)

    @JavascriptInterface
    fun secureSet(key: String, value: String): Boolean =
        SecureStore.write(context(), key, value)

    @JavascriptInterface
    fun secureRemove(key: String): Boolean = SecureStore.remove(context(), key)

    /* ---------------------------------------------------------- background sync */

    @JavascriptInterface
    fun backgroundSyncRegister(tag: String): Boolean {
        QueueDrainWorker.schedule(context())
        return true
    }

    @JavascriptInterface
    fun backgroundSyncFlush(tag: String): String {
        // The drain runs in the page, because the queue is in the page's
        // IndexedDB and each record carries its own idempotency key. Returns a
        // pending result rather than blocking this thread for a network round
        // trip, which a `@JavascriptInterface` call must never do.
        main.post { QueueDrainWorker.flushNow(context(), webView) }
        return """{"sent":0,"failed":0,"pending":true}"""
    }

    /* ------------------------------------------------------------ camera, place */

    @JavascriptInterface
    fun cameraCapture(): String? {
        // Returns a JSON string synchronously; the asynchronous answer is posted
        // back into the page by the capture callback.
        main.post { CameraCapture.capture(activity) { json -> deliver(json) } }
        return null
    }

    @JavascriptInterface
    fun locationOnce(): String? {
        main.post { LocationOnce.request(activity) { json -> deliver(json) } }
        return null
    }

    /* ------------------------------------------------------------ notifications */

    @JavascriptInterface
    fun notificationsRequest(): String = "denied"

    @JavascriptInterface
    fun notificationsRegister(token: String): Boolean {
        DeviceToken.value = token
        return true
    }

    /* --------------------------------------------------------------- delivery */

    /**
     * Hand an answer back to the page.
     *
     * The web side's `call()` resolves on the first reply and ignores the rest,
     * so a double delivery — two callbacks for one request, which a camera and
     * a location fix can both produce — is harmless. That is why this exists
     * rather than a rejected call.
     */
    fun deliver(json: String?) {
        val view = webView ?: return
        val payload = json ?: "null"
        main.post {
            view.evaluateJavascript(
                "window.__lindelaDeliver && window.__lindelaDeliver($payload)", null
            )
        }
    }
}
