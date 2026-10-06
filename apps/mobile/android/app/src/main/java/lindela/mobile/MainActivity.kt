package lindela.mobile

import android.annotation.SuppressLint
import android.os.Bundle
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import lindela.mobile.bridge.BridgeBootstrap
import lindela.mobile.bridge.CameraCapture
import lindela.mobile.bridge.LocationOnce
import lindela.mobile.bridge.NativeBridge
import lindela.mobile.work.ActiveWebView
import lindela.mobile.work.QueueDrainWorker

/**
 * The shell: a web view, a bridge, and nothing else.
 *
 * Deliberately thin, for the same reason the iOS shell is: the app being served
 * is covered end to end by `scripts/check-offline-roundtrip.mjs`, and every line
 * added here is a line that is not covered by that proof.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var bridgeInstalledAtStart = false
    private val bridge = NativeBridge(this)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Debug builds only. The bridge is the one piece of native code the page
        // can call, and "the bridge does not answer on this handset" is not a
        // question anybody can answer without a debugger attached.
        if (0 != applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true          // the offline queue lives here
                databaseEnabled = true
                // The queue is unsent reports. A WebView that discards its data
                // on an app upgrade destroys them, and a person cannot tell the
                // difference between "cleared" and "sent".
                cacheMode = WebSettings.LOAD_DEFAULT
                mediaPlaybackRequiresUserGesture = true
                allowFileAccess = false
                allowContentAccess = false
            }
        }

        // The raw interface first, then the shim that wraps it in promises:
        // `@JavascriptInterface` methods are synchronous and cannot hand
        // JavaScript a Promise, so without this the page would receive objects
        // where it expects promises and every await would resolve to the
        // interface object itself.
        webView.addJavascriptInterface(bridge, NativeBridge.RAW_NAME)
        // The origin the shim is scoped to. Built from the same server URL the
        // page is loaded from, so the two cannot disagree about where the app
        // lives — which would scope the injection to nothing.
        bridgeInstalledAtStart = BridgeBootstrap.install(webView, originOf(serverUrl()))
        bridge.attach(webView)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Same-origin navigation stays in the shell. Anything else opens
                // in the browser rather than inside a shell that has no address
                // bar — a person must be able to see where they are before they
                // type a credential into it.
                val url = request.url
                val server = serverUrl()
                return if (url.toString().startsWith(server)) {
                    false
                } else {
                    openInBrowser(url.toString())
                    true
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (!bridgeInstalledAtStart) BridgeBootstrap.installAfterLoad(view)
                // A shell that finished loading with a server that is back is the
                // moment to drain. `navigator.onLine` never left — there was
                // never a network to lose — so the page needs the nudge.
                QueueDrainWorker.flushNow(applicationContext, webView)
            }
        }

        setContentView(webView)
        ActiveWebView.current = webView
        webView.loadUrl(entryUrl())

        // A configuration change (rotation) must not reload the page: the worker
        // may be halfway through a report, and a lost draft is a lost report.
        android.os.Build.VERSION.SDK_INT
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        // Deliberately empty beyond the super call: see above.
    }

    override fun onResume() {
        super.onResume()
        webView.evaluateJavascript("window.dispatchEvent(new Event('online'))", null)
        // Re-arm the OS job every time the app comes forward. It survives a
        // reboot on its own; this covers the case where the OS dropped it.
        QueueDrainWorker.schedule(applicationContext)
    }

    private fun serverUrl() = BuildConfig.SERVER_URL.trimEnd('/')

    /** `http://host:port` — what `addDocumentStartJavaScript` validates. */
    private fun originOf(url: String): String {
        val withoutPath = url.substringBefore("/api").substringBefore("/chw").substringBefore("/focal-point")
        return withoutPath.ifEmpty { "https://localhost" }
    }

    private fun entryUrl(): String {
        val base = serverUrl()
        val surface = BuildConfig.SURFACE
        val normalised = if (surface.startsWith("/")) surface else "/$surface"
        return base + normalised
    }

    private fun openInBrowser(url: String) {
        try {
            startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
        } catch (_: Exception) {
            // No browser installed: a district handset in kiosk mode. The link is
            // lost, which is better than a shell that pretends to have opened it.
        }
    }

    @Deprecated("The system calls this; the annotation silences a lint warning "
        + "that would otherwise fail a release build on a compileSdk of 35.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        CameraCapture.onActivityResult(requestCode, resultCode, data)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // A refusal resolves `null` through the same delivery path as a capture,
        // so the page is never left waiting on a permission dialog.
        bridge.deliver(LocationOnce.onPermissionResult(this, grantResults))
    }

    override fun onDestroy() {
        ActiveWebView.current = null
        bridge.detach()
        super.onDestroy()
    }
}
