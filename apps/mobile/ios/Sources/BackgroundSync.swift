import Foundation
import BackgroundTasks
import UIKit

/// The OS scheduler, for the one thing the browser cannot promise.
///
/// Background Sync is Chrome-only and best-effort; a shell can ask the platform.
/// On iOS that is `BGProcessingTask`, which the system runs when it decides the
/// device has power, network and time — typically in a window, not at the moment
/// signal returns. So the drain is *also* still driven by the page's own
/// `online` listener and its 30-second poll, and this is the third path, not the
/// only one.
///
/// Every run records what it sent. A drain that reports nothing cannot be
/// distinguished from one that never ran, which is how a week of queued reports
/// became a week of silence in the first place.
final class BackgroundSync {
    static let shared = BackgroundSync()

    /// Matches `BGTaskSchedulerPermittedIdentifiers` in Info.plist. iOS refuses
    /// to schedule an identifier that is not declared there, which is why the
    /// string appears in both files.
    static let tag = "lindela-queue"

    private var lastResult: [String: Any] = ["sent": 0, "failed": 0]

    /// The identifier this app registered, from its own Info.plist. Per app: the
    /// CHW build and the focal-point build declare different ones, and a
    /// constant here would be wrong in exactly one of them.
    private var taskIdentifier = "org.lindela.chw.queue-drain"

    func register(identifier: String) {
        taskIdentifier = identifier
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: identifier,
            using: nil
        ) { [weak self] task in
            guard let self, let processing = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handle(processing)
        }
    }

    /// Ask for the next window. Returns whether the request was *accepted* —
    /// the OS may decline, and the caller keeps the page's own listeners either
    /// way, so a `false` here is not a failure.
    @discardableResult
    func register(tag: String = BackgroundSync.tag) -> Bool {
        let request = BGProcessingTaskRequest(identifier: taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
            NSLog("background drain scheduled")
            return true
        } catch {
            // The usual cause is a duplicate identifier, which happens when the
            // page asks twice in a minute. Not worth surfacing.
            NSLog("background drain not scheduled: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    func registerForRemoteNotifications() -> Bool {
        DispatchQueue.main.async {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return true
    }

    func complete(_ result: [String: Any]) {
        lastResult = result
        setTaskCompleted(result)
        // Ask for the next window straight away: one drain is not a habit.
        register()
    }

    private func handle(_ task: BGProcessingTask) {
        // Held so `complete()` can finish the task the platform handed us; a
        // completion with no task is a no-op, which would leave iOS believing
        // the job is still running.
        activeTask = task
        // Re-arm before the work. If the process dies mid-drain the next window
        // is already requested, so a crash cannot end background delivery for
        // good.
        register()
        // The expiration handler is what iOS gives us to stop work when it needs
        // the power back; ignoring it is how a background job gets killed and
        // never runs again.
        task.expirationHandler = { [weak self] in
            self?.setTaskCompleted(["sent": 0, "failed": 0])
        }

        NotificationCenter.default.post(name: Notification.Name("lindela.flushNow"), object: nil)

        // iOS gives a processing task minutes, not hours. Nothing here waits on
        // the network — the flush in the page does, with its own timeouts — so
        // this returns and the page carries on.
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            self?.setTaskCompleted(self?.lastResult ?? ["sent": 0, "failed": 0])
        }
    }

    private var activeTask: BGTask?

    private func setTaskCompleted(_ result: [String: Any]) {
        guard let task = activeTask else { return }
        activeTask = nil
        let sent = (result["sent"] as? Int) ?? 0
        task.setTaskCompleted(success: sent >= 0)
    }
}
