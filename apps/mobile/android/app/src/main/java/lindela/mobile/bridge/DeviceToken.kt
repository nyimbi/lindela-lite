package lindela.mobile.bridge

/**
 * The FCM registration token, between the SDK handing it over and the server
 * being told about it.
 *
 * A holder rather than a field on the bridge because the token arrives on a
 * Firebase callback, long after the call that asked for it has returned.
 */
object DeviceToken {
    @Volatile
    var value: String? = null
}
