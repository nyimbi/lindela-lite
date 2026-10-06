package lindela.mobile.bridge

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * One position fix, then released.
 *
 * A listener that stayed registered would keep the GPS warm for an app that
 * asked for one reading — the battery cost of a background location session on a
 * shared field handset, for a form that was submitted two minutes ago.
 *
 * And the answer for "the person said no" is `null`, never `{0, 0}`. That pair is
 * Null Island in the Gulf of Guinea: a symptom report placed there reads as a
 * disease signal pointing at open water, which is the exact defect the CHW report
 * flow already had once.
 */
object LocationOnce {

    private const val REQUEST = 0x10CA7

    fun request(activity: Activity, completion: (String?) -> Unit) {
        val granted = ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

        if (!granted) {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION),
                REQUEST
            )
            return
        }
        completion(lastKnown(activity))
    }

    /**
     * The cached fix, if there is a recent one.
     *
     * "Last known" rather than a live request on purpose: this is an
     * *attribution* on a report, not a survey, and a stale position that says so
     * is worth more than a fresh one that keeps the radio on for ten seconds on a
     * handset somebody is also using to make a call.
     */
    private fun lastKnown(context: Context): String? {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return null
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        val best: Location? = providers.mapNotNull { provider ->
            try { manager.getLastKnownLocation(provider) } catch (_: SecurityException) { null }
        }.maxByOrNull { it.time }
        return best?.let {
            """{"latitude":${it.latitude},"longitude":${it.longitude},"accuracy":${it.accuracy}}"""
        }
    }

    /** Called from the activity after a permission answer. */
    fun onPermissionResult(activity: Activity, grantResults: IntArray): String? {
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (!granted) return null
        return lastKnown(activity)
    }
}
