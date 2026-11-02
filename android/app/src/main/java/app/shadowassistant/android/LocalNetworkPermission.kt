package app.shadowassistant.android

/**
 * Android 17 (API 37) local network protection: an app targeting 37 cannot
 * open connections to LAN addresses (the Core at `192.168.1.2`, reached on
 * Wi-Fi at home and through the Tailscale subnet route outside) unless it
 * holds the runtime permission `ACCESS_LOCAL_NETWORK`. Below API 37 the
 * permission does not exist and nothing is required.
 *
 * Pure decisions only; MainActivity does the platform calls. Nothing here
 * looks at the network type: the same permission covers Wi-Fi and VPN routes.
 */
object LocalNetworkPermission {
    /** Literal instead of `Manifest.permission.ACCESS_LOCAL_NETWORK` (API 37 constant) so callers need no version guard. */
    const val PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    const val SINCE_SDK = 37

    private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"
    private const val POST_NOTIFICATIONS_SINCE_SDK = 33

    /** True when the Core cannot be reached until the permission is granted. */
    fun missing(sdk: Int, granted: Boolean): Boolean = sdk >= SINCE_SDK && !granted

    /**
     * Permissions to ask for in one dialog sequence at startup. Android runs only
     * one permission request at a time (a second concurrent request is answered
     * with an empty result at once), so the local network permission and the
     * one-time notification prompt go out together.
     */
    fun startupRequest(sdk: Int, localNetworkGranted: Boolean, askNotifications: Boolean): List<String> = buildList {
        if (missing(sdk, localNetworkGranted)) add(PERMISSION)
        if (askNotifications && sdk >= POST_NOTIFICATIONS_SINCE_SDK) add(POST_NOTIFICATIONS)
    }
}
