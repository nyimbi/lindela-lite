package lindela.mobile.work

import android.content.Context
import android.util.Log
import android.webkit.WebView
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * The OS scheduler, for the one thing the browser cannot promise.
 *
 * Background Sync is Chrome-only and best-effort; WorkManager is the platform.
 * It survives a reboot and an app update without the app asking, which is the
 * property that matters: a report queued on Friday has to reach the server even
 * if the health worker does not open the app until Monday.
 *
 * The drain runs in the *page*, because the queue is in the page's IndexedDB
 * and each record carries its own idempotency key — which is what makes it safe
 * for this to run with no person present. A worker with no WebView (the app was
 * launched in the background) records nothing and reschedules: the records stay
 * in IndexedDB and the next window picks them up. Dropping them would be the one
 * unrecoverable outcome available here.
 */
/**
 * The WebView a background drain can reach through, if there is one.
 *
 * Top level rather than nested in the worker's companion: nested, it shadowed
 * itself inside its own file and would not resolve from the activity at all.
 */
object ActiveWebView {
    @Volatile
    var current: WebView? = null
}

class QueueDrainWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val view: WebView? = ActiveWebView.current
        if (view == null) {
            // No page to drain through. Not a failure: the queue is durable, and
            // the next window — or the app's own 30-second poll — will get it.
            Log.d(TAG, "no web view attached; the queue stays queued")
            schedule(applicationContext)
            return Result.success()
        }
        val outcome = flushNow(applicationContext, view)
        val sent = (outcome?.get("sent") as? Int) ?: 0
        val failed = (outcome?.get("failed") as? Int) ?: 0
        Log.i(TAG, "queue drain: sent=$sent failed=$failed")
        // A failure here means "could not talk to the server", which is what the
        // constraint already prevents; anything else is a real error and
        // retrying it is cheaper than losing the window.
        return if (failed > 0 && sent == 0) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "LindelaQueueDrain"
        const val PERIODIC_NAME = "lindela-queue-drain"
        const val ONCE_NAME = "lindela-queue-drain-now"

        /** The WebView a background drain can reach through, if there is one. */
        /**
         * Ask the OS for a window.
         *
         * Every fifteen minutes is the *request*; the system decides when it
         * actually runs, which may be hours later and only with power and a
         * network. A tighter interval is a request the OS ignores, not a faster
         * delivery.
         */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<QueueDrainWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .setRequiresBatteryNotLow(true)
                        .build()
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                // KEEP, not UPDATE: an existing schedule already has the
                // system's backoff state, and replacing it on every foreground
                // would reset the very backoff a failing network earned.
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }

        /** Drain now, if there is a page to drain through. */
        fun flushNow(context: Context, view: WebView?): Map<String, Any?>? {
            val target = view ?: ActiveWebView.current ?: return null
            var result: Map<String, Any?>? = null
            val latch = java.util.concurrent.CountDownLatch(1)
            target.evaluateJavascript(DRAIN_SCRIPT) { value ->
                result = parseCounts(value)
                latch.countDown()
            }
            // Bounded, and then it is someone else's problem: a page that never
            // answers must not hold an OS worker slot open.
            latch.await(20, TimeUnit.SECONDS)
            return result
        }

        /** Ask for a one-off window as well — a person pressed "send now". */
        fun flushSoon(context: Context) {
            val request = OneTimeWorkRequestBuilder<QueueDrainWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(ONCE_NAME, ExistingWorkPolicy.REPLACE, request)
        }

        /**
         * The drain, run in the page.
         *
         * `awaitPromise` is not available on this overload, so the page resolves
         * the value into a string when it is done — the queue's own
         * `lastFlush` is the answer, and it names what was sent and what gave up.
         */
        private const val DRAIN_SCRIPT = """
            (async () => {
                const queue = window.lindelaQueue
                if (!queue || !queue.flush) return JSON.stringify({ sent: 0, failed: 0, reason: 'no queue in this build' })
                await queue.flush()
                const last = queue.lastFlush || { sent: 0, failed: 0 }
                return JSON.stringify({ sent: last.sent || 0, failed: last.gaveUp || 0 })
            })().catch((error) => JSON.stringify({ sent: 0, failed: 0, reason: String(error) }))
        """

        private fun parseCounts(value: String?): Map<String, Any?>? {
            if (value.isNullOrBlank()) return null
            return try {
                val cleaned = value.replace("\"", "").trim()
                val parts = cleaned.split(",").associate { pair ->
                    val kv = pair.split("=", limit = 2)
                    kv[0].trim() to (kv.getOrNull(1)?.trim()?.toIntOrNull() ?: 0)
                }
                parts
            } catch (error: Exception) {
                Log.w(TAG, "could not read the drain result", error)
                null
            }
        }
    }
}
