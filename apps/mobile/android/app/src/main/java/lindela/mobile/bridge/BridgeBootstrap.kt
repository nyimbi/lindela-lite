package lindela.mobile.bridge

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The JavaScript side of the bridge, installed before any page script runs.
 *
 * This exists because `@JavascriptInterface` methods are **synchronous** and
 * cannot return a Promise: everything they hand back arrives as a plain value on
 * a background thread. The contract the web side is written against is promise
 * shaped, so this wraps the raw object and settles each call — including the two
 * that cannot answer synchronously at all (the camera and the location fix), which
 * come back later through `__lindelaDeliver`.
 *
 * Installed with `WebViewCompat.addDocumentStartJavaScript`, which runs before
 * the document's own scripts. An `evaluateJavascript` after `onPageStarted` would
 * be a race, and a page that calls the bridge during boot would lose it — which
 * the web side reads as "no shell", silently.
 */
object BridgeBootstrap {

    /**
     * Install the shim.
     *
     * `origin` is the server's origin, and it has to be an origin —
     * `https://host` — because `addDocumentStartJavaScript` validates it and
     * throws `IllegalArgumentException: allowedOriginRules ... is invalid` on
     * anything else. The first version passed `"main"`, and the app died in
     * `onCreate` on every device with a WebView new enough to have the feature.
     *
     * That is why the call is also wrapped: this runs before anything else, so a
     * throw here is a blank screen and no diagnostics. A WebView that refuses the
     * rule falls back to the post-load evaluate and says so, rather than taking
     * the app with it.
     */
    fun install(webView: WebView, origin: String): Boolean {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                WebViewCompat.addDocumentStartJavaScript(webView, SCRIPT, setOf(origin))
                return true
            } catch (error: Exception) {
                android.util.Log.w(
                    "LindelaBridge",
                    "document-start script refused for $origin: ${error.message}"
                )
            }
        } else {
            android.util.Log.w(
                "LindelaBridge",
                "this WebView has no document-start scripts (it predates the feature); " +
                "the bridge will be injected after the first load instead"
            )
        }
        return false
    }

    /**
     * The fallback injection, for a WebView too old for document-start scripts.
     *
     * Called from `onPageFinished` rather than posted once at create: a `post`
     * at create runs before there is a document, evaluates nothing, and leaves
     * the page with no bridge at all — which reads as "the app sometimes works"
     * on one device model. Injecting after the first load is late by definition,
     * and says so.
     */
    fun installAfterLoad(webView: WebView) {
        if (injectedAfterLoad) return
        injectedAfterLoad = true
        webView.evaluateJavascript(SCRIPT, null)
    }

    private var injectedAfterLoad = false

    private val SCRIPT = """
(function () {
  if (window.lindelaNative) return;
  var RAW = window.lindelaNativeRaw;
  if (!RAW) return;

  var pending = Object.create(null);
  var counter = 0;
  var extra = Object.create(null);

  // Every call settles. A bridge method that never answers — a permission
  // dialog the person walked away from, a camera that is busy — would otherwise
  // leave the page waiting forever, and a form that never finishes is worse than
  // a form that says so.
  function call(method, args, timeoutMs) {
    return new Promise(function (resolve) {
      var id = ++counter;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        delete pending[id];
        resolve(null);
      }, timeoutMs || 8000);
      extra[id] = function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        delete pending[id];
        delete extra[id];
        resolve(value);
      };
      try {
        var raw = RAW[method].apply(RAW, args || []);
        // A synchronous answer settles now; the ones that cannot answer
        // synchronously return null and settle later through __lindelaDeliver.
        if (raw !== null && raw !== undefined) {
          settled = true;
          clearTimeout(timer);
          delete pending[id];
          delete extra[id];
          resolve(raw);
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    });
  }

  window.__lindelaDeliver = function (payload) {
    for (var id in extra) {
      if (extra.hasOwnProperty(id)) {
        extra[id](payload);
      }
    }
  };

  var CAPS = (function () {
    var reported = { secureStore: true, backgroundSync: true, camera: false, location: false, notifications: true };
    try {
      var json = RAW.capabilitiesJson();
      var parsed = JSON.parse(json);
      for (var key in reported) {
        if (typeof parsed[key] === 'boolean') reported[key] = parsed[key];
      }
    } catch (error) { /* the pre-load defaults stand */ }
    return reported;
  })();

  window.lindelaNative = {
    platform: 'android',
    version: '1',
    capabilities: function () { return CAPS; },
    secureGet: function (k) { return call('secureGet', [k]); },
    secureSet: function (k, v) { return call('secureSet', [k, v]); },
    secureRemove: function (k) { return call('secureRemove', [k]); },
    backgroundSyncRegister: function (tag) { return call('backgroundSyncRegister', [tag]); },
    backgroundSyncFlush: function (tag) { return call('backgroundSyncFlush', [tag], 20000); },
    cameraCapture: function () { return call('cameraCapture', [], 60000); },
    locationOnce: function () { return call('locationOnce', [], 30000); },
    notificationsRequest: function () { return call('notificationsRequest', []); },
    notificationsRegister: function (t) { return call('notificationsRegister', [t]); }
  };
})();
"""
}
