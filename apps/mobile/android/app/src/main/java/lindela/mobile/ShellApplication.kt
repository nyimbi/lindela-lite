package lindela.mobile

import android.app.Application
import androidx.work.Configuration
import lindela.mobile.work.QueueDrainWorker

/**
 * Re-arms the queue drain on every process start.
 *
 * WorkManager persists its schedule across reboots and app updates, but not
 * across an *uninstall* — and a district deployment that gets reinstalled after a
 * phone reset is exactly the case where a week of queued reports would otherwise
 * sit undelivered with nothing scheduled to move them.
 */
class ShellApplication : Application(), Configuration.Provider {

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        QueueDrainWorker.schedule(this)
    }
}
