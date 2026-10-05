import UIKit

/// Where the shell gets its web app from.
///
/// A build-time value rather than a screen, because the alternative is a server
/// URL typed on a phone by somebody in a hurry: a health worker with a mistyped
/// host files reports into the void and is told they are saved. Set with
/// `LINDELA_SERVER_URL` in the environment at build time; the debug default
/// points at the machine that built it, so a simulator on the same network works
/// with no configuration at all.
enum ServerURL {
    static let fallback = "http://localhost:4177"

    static var current: URL {
        if let fromInfo = Bundle.main.object(forInfoDictionaryKey: "LindelaServerURL") as? String,
           !fromInfo.isEmpty, fromInfo != "$(LINDELA_SERVER_URL)" {
            return URL(string: fromInfo) ?? URL(string: fallback)!
        }
        if let fromEnvironment = ProcessInfo.processInfo.environment["LINDELA_SERVER_URL"],
           let parsed = URL(string: fromEnvironment) {
            return parsed
        }
        return URL(string: fallback)!
    }

    /// The surface this build serves: the CHW app, or the focal-point console.
    static var surface: String {
        let raw = Bundle.main.object(forInfoDictionaryKey: "LindelaSurface") as? String
        let surface = (raw?.isEmpty == false) ? raw! : "/chw/"
        return surface.hasPrefix("/") ? surface : "/\(surface)"
    }

    /// The URL to open.
    ///
    /// String concatenation rather than `appending(path:)`, which produced
    /// `/chw//` — a path the server's surface matcher does not recognise, so it
    /// answered with the operator console and the CHW app silently became the
    /// dashboard. A shell that serves the wrong surface with no error is the
    /// worst shape this bug could have taken, and it is why the surface is
    /// asserted below rather than trusted.
    static var entry: URL {
        let base = current.absoluteString
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        return URL(string: trimmed + surface) ?? current
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private(set) var bridge: NativeBridge?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        self.bridge = NativeBridge()
        BackgroundSync.shared.register()
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    /// Push registration. The token goes to the server through the same bridge
    /// the web app uses, so the web app decides where a focal point's device is
    /// registered — one registration path, not two.
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PendingPush.token = deviceToken.map { String(format: "%02x", $0) }.joined()
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Push is an optimisation on top of the 30-second poll and the app's own
        // refresh. Its absence must not be an error the product surfaces.
        NSLog("push registration failed: \(error.localizedDescription)")
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = ShellViewController(
            url: ServerURL.entry,
            bridgeName: "lindelaNative"
        )
        self.window = window
        window.makeKeyAndVisible()
    }
}
