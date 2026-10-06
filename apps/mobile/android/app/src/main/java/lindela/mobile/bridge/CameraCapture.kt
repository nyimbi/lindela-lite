package lindela.mobile.bridge

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * A camera capture that answers with a JPEG the page can attach to a report.
 *
 * Uses the system camera app by intent rather than CameraX: one more dependency
 * and an APK measured in megabytes, for a picture a village handset's own
 * camera app takes perfectly well. What is missing is a report with no photo, and
 * the page says so rather than leaving an empty attachment.
 */
object CameraCapture {

    private const val REQUEST = 0x1AD0
    private var pending: ((String?) -> Unit)? = null

    fun capture(activity: Activity, completion: (String?) -> Unit) {
        val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
        if (intent.resolveActivity(activity.packageManager) == null) {
            completion(null)
            return
        }
        pending = completion
        try {
            activity.startActivityForResult(intent, REQUEST)
        } catch (_: Exception) {
            // A device in kiosk mode with no camera app. `null` is the answer.
            pending = null
            completion(null)
        }
    }

    /** Called from the activity's `onActivityResult`. */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST) return
        val completion = pending ?: return
        pending = null
        if (resultCode != Activity.RESULT_OK) { completion(null); return }

        val bitmap = data?.extras?.get("data") as? Bitmap
        if (bitmap == null) { completion(null); return }
        val stream = ByteArrayOutputStream()
        // 0.7 rather than lossless: a report's photo is evidence, and a 4 MB
        // upload over a 2G link is a report that never arrives.
        bitmap.compress(Bitmap.CompressFormat.JPEG, 70, stream)
        val encoded = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        completion("""{"dataUrl":"data:image/jpeg;base64,$encoded"}""")
    }
}
