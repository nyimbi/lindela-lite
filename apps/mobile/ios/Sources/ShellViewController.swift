import UIKit
import WebKit

/// The shell: a web view, a bridge, and nothing else.
///
/// Deliberately thin. The app being served has just been proven end to end by
/// `scripts/check-offline-roundtrip.mjs` — filed offline, stored, surviving a
/// restart, delivered when the server returns, exactly once — and every line
/// added here is a line that is not covered by that proof.
final class ShellViewController: UIViewController {
    private let url: URL
    private let bridgeName: String
    private var webView: WKWebView!
    /// Held so the message handler stays registered for the view's life. A
    /// `WKUserContentController` holds its handlers weakly, and a deallocated
    /// bridge answers nothing — which the page reads as "no shell", silently.
    private var bridgeReference: NativeBridge?

    init(url: URL, bridgeName: String) {
        self.url = url
        self.bridgeName = bridgeName
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        // The bridge is the one piece of native code the page may call, and it is
        // added *before* any script runs, so a page that calls it during boot
        // finds it rather than racing it.
        let bridge = NativeBridge()
        bridgeReference = bridge
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NativeBridge.handlerName)
        configuration.userContentController.addUserScript(
            WKUserScript(source: bridge.installationScript(named: bridgeName),
                         injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )
        // The offline queue is IndexedDB on the web side, so the data store must
        // be persistent: the default configuration evicts it under pressure,
        // which is the one behaviour this product cannot have.
        configuration.websiteDataStore = .default()

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        load(url)
    }

    /// Reload, and tell the web side the network is back.
    ///
    /// `navigator.onLine` does not move when a server comes back — it never left
    /// — so the page needs the nudge or its own queue sits full on a device with
    /// a perfectly good connection.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        webView.evaluateJavaScript("window.dispatchEvent(new Event('online'))") { _, _ in }
    }

    private func load(_ target: URL) {
        var request = URLRequest(url: target)
        // The shell must never serve a stale build: a fix that reached the server
        // and not the handset is the failure this product has already had once,
        // on the service worker's side of it.
        request.cachePolicy = .reloadRevalidatingCacheData
        webView.load(request)
    }

    /// Ask the page to drain its own queue, and report what it sent.
    ///
    /// The drain runs in the page because the queue lives in the page's
    /// IndexedDB and the records carry their own idempotency keys — which is what
    /// makes it safe for this to happen without the page open: a claim on each
    /// record, and a repeat POST the server replays rather than writes twice.
    @discardableResult
    func flushQueueInPage(completion: (( [String: Any] ) -> Void)? = nil) -> [String: Any] {
        webView.evaluateJavaScript("""
            (async () => {
                const queue = window.lindelaQueue
                if (!queue?.flush) return { sent: 0, failed: 0, reason: 'no queue in this build' }
                await queue.flush()
                return (queue.lastFlush) || { sent: 0, failed: 0 }
            })()
        """) { value, error in
            let result = (value as? [String: Any]) ?? ["sent": 0, "failed": 0]
            completion?(result)
        }
        return ["sent": 0, "failed": 0]
    }
}

extension ShellViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // A shell that finished loading with a cached page and a server that is
        // back is the moment to drain. This is the same nudge the browser gets
        // from its own `online` event, arriving from the side that can tell.
        flushQueueInPage()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // A failed navigation while offline is expected, and the shell must not
        // treat it as a failure to report: the service worker serves the shell
        // from cache, so the page that matters is already running.
        let offline = (error as NSError).code == NSURLErrorNotConnectedToInternet
            || (error as NSError).code == NSURLErrorCannotConnectToHost
            || (error as NSError).code == NSURLErrorTimedOut
        if !offline {
            NSLog("navigation failed: \(error.localizedDescription)")
        }
    }
}
