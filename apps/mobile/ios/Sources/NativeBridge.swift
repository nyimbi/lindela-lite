import Foundation
import UIKit
import WebKit
import UserNotifications
import CoreLocation

/// The iOS half of `apps/mobile/shared/bridge-contract.md`.
///
/// Two rules the web side (`public/shared/native.js`) relies on, and both are
/// load-bearing on a phone in the field:
///
///   - **Never reject across the bridge.** A rejection becomes an unhandled
///     rejection in a click handler, in the middle of a form. Everything
///     resolves; failures come back as `null` or `false`.
///   - **Never invent a value.** A declined location is `null`, not `{0, 0}` —
///     that pair is Null Island, and a symptom report placed there reads as a
///     disease signal pointing at open water.
///
/// The JavaScript is injected at document start, so a page that calls the bridge
/// during boot finds it rather than racing it.
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    private var locationDelegate: LocationOnce?
    private var deviceToken: String?

    static let handlerName = "lindelaNative"

    // MARK: - The JavaScript object

    func installationScript(named name: String) -> String {
        """
        (function () {
          var pending = Object.create(null);
          var counter = 0;

          // Every call settles. A message handler that never replies — a shell
          // crash between post and reply, a method that threw before the reply —
          // would otherwise leave the page waiting forever, and a form that never
          // finishes is worse than a form that says so.
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
              pending[id] = function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                delete pending[id];
                resolve(value);
              };
              try {
                window.webkit.messageHandlers.\(Self.handlerName)
                  .postMessage({ id: id, method: method, args: args || [] });
              } catch (error) {
                pending[id](null);
              }
            });
          }

          var CAPS = {
            secureStore: true,
            backgroundSync: true,
            camera: true,
            location: true,
            notifications: true
          };

          window.\(name) = {
            platform: 'ios',
            version: '1',
            capabilities: function () { return CAPS; },
            secureGet: function (k) { return call('secureGet', [k]); },
            secureSet: function (k, v) { return call('secureSet', [k, v]); },
            secureRemove: function (k) { return call('secureRemove', [k]); },
            backgroundSyncRegister: function (tag) { return call('backgroundSyncRegister', [tag]); },
            backgroundSyncFlush: function (tag) { return call('backgroundSyncFlush', [tag]); },
            cameraCapture: function () { return call('cameraCapture', []); },
            locationOnce: function () { return call('locationOnce', [], 20000); },
            notificationsRequest: function () { return call('notificationsRequest', []); },
            notificationsRegister: function (t) { return call('notificationsRegister', [t]); }
          };
        })();
        """
    }

    // MARK: - Messages from the page

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let body = message.body as? [String: Any],
              let method = body["method"] as? String else {
            replyHandler(nil, "malformed bridge call")
            return
        }
        let args = body["args"] as? [Any] ?? []
        handle(method, args, reply: replyHandler)
    }

    private func handle(_ method: String, _ args: [Any], reply: @escaping (Any?, String?) -> Void) {
        switch method {
        case "secureGet":
            let key = args.first as? String ?? ""
            reply(Keychain.read(key), nil)

        case "secureSet":
            let key = args.first as? String ?? ""
            let value = args.count > 1 ? String(describing: args[1]) : ""
            reply(Keychain.write(key, value), nil)

        case "secureRemove":
            reply(Keychain.remove(args.first as? String ?? ""), nil)

        case "backgroundSyncRegister":
            reply(BackgroundSync.shared.register(tag: args.first as? String ?? "lindela-queue"), nil)

        case "backgroundSyncFlush":
            let controller = topViewController() as? ShellViewController
            guard let controller else {
                // No web view — the app was launched in the background. The
                // records stay in IndexedDB and the OS will call us again; a
                // background launch with nothing to drain is not an error.
                reply(["sent": 0, "failed": 0], nil)
                return
            }
            controller.flushQueueInPage { result in reply(result, nil) }

        case "cameraCapture":
            guard let presenter = topViewController() else { reply(nil, nil); return }
            CameraPicker.capture(from: presenter) { result in
                reply(result, nil)
            }

        case "locationOnce":
            let delegate = LocationOnce()
            locationDelegate = delegate
            Task {
                let fix = await delegate.request()
                await MainActor.run { self.locationDelegate = nil }
                reply(fix, nil)
            }

        case "notificationsRequest":
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
                reply(granted ? "granted" : "denied", nil)
            }

        case "notificationsRegister":
            let token = args.first as? String ?? ""
            deviceToken = token
            reply(BackgroundSync.shared.registerForRemoteNotifications(), nil)

        default:
            // An unknown method is a newer page against an older shell. `null` is
            // the answer, and the page falls back to its browser path.
            reply(nil, "unknown method: \(method)")
        }
    }

    private func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let root = scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })?.rootViewController
        var top = root
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

/// The APNs token, between registration and the server accepting it.
enum PendingPush {
    static var token: String?
}

/// One position fix, then released.
///
/// A delegate that stayed alive would keep firing updates for an app that asked
/// for one reading — the battery cost of a background location session on a
/// shared field handset, for a form that is already submitted.
final class LocationOnce: NSObject, CLLocationManagerDelegate {
    private var continuation: CheckedContinuation<[String: Any]?, Never>?
    private let manager = CLLocationManager()
    private var finished = false

    func request() async -> [String: Any]? {
        manager.delegate = self
        guard CLLocationManager.locationServicesEnabled() else {
            return await withCheckedContinuation { continuation in continuation.resume(returning: nil) }
        }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            switch manager.authorizationStatus {
            case .notDetermined:
                manager.requestWhenInUseAuthorization()
            case .authorizedWhenInUse, .authorizedAlways:
                manager.requestLocation()
            default:
                finish(nil)
            }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.requestLocation()
        case .denied, .restricted:
            finish(nil)
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let best = locations.last else { return finish(nil) }
        finish([
            "latitude": best.coordinate.latitude,
            "longitude": best.coordinate.longitude,
            "accuracy": best.horizontalAccuracy,
        ])
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(nil)
    }

    private func finish(_ value: [String: Any]?) {
        guard !finished else { return }
        finished = true
        manager.delegate = nil
        continuation?.resume(returning: value)
        continuation = nil
    }
}
