package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalNetworkPermissionTest {
    private val notifications = "android.permission.POST_NOTIFICATIONS"

    @Test
    fun permissionNameMatchesThePlatform() {
        assertEquals("android.permission.ACCESS_LOCAL_NETWORK", LocalNetworkPermission.PERMISSION)
        assertEquals(37, LocalNetworkPermission.SINCE_SDK)
    }

    @Test
    fun missingOnlyFromApi37WhenNotGranted() {
        assertFalse(LocalNetworkPermission.missing(sdk = 36, granted = false))
        assertFalse(LocalNetworkPermission.missing(sdk = 29, granted = false))
        assertTrue(LocalNetworkPermission.missing(sdk = 37, granted = false))
        assertTrue(LocalNetworkPermission.missing(sdk = 38, granted = false))
        assertFalse(LocalNetworkPermission.missing(sdk = 37, granted = true))
    }

    @Test
    fun startupRequestAsksBothInOneCall() {
        assertEquals(
            listOf(LocalNetworkPermission.PERMISSION, notifications),
            LocalNetworkPermission.startupRequest(sdk = 37, localNetworkGranted = false, askNotifications = true),
        )
    }

    @Test
    fun startupRequestSkipsWhatIsNotNeeded() {
        assertEquals(
            listOf(notifications),
            LocalNetworkPermission.startupRequest(sdk = 37, localNetworkGranted = true, askNotifications = true),
        )
        assertEquals(
            listOf(LocalNetworkPermission.PERMISSION),
            LocalNetworkPermission.startupRequest(sdk = 37, localNetworkGranted = false, askNotifications = false),
        )
        // Android 13-16: notifications only; the local network permission does not exist there.
        assertEquals(
            listOf(notifications),
            LocalNetworkPermission.startupRequest(sdk = 33, localNetworkGranted = false, askNotifications = true),
        )
        // Android 10-12: nothing to ask at startup.
        assertEquals(
            emptyList<String>(),
            LocalNetworkPermission.startupRequest(sdk = 32, localNetworkGranted = false, askNotifications = true),
        )
        assertEquals(
            emptyList<String>(),
            LocalNetworkPermission.startupRequest(sdk = 37, localNetworkGranted = true, askNotifications = false),
        )
    }

    @Test
    fun startupRequestAtTheApi36And37Boundary() {
        // API 36: local network permission does not exist yet, only notifications.
        assertEquals(
            listOf(notifications),
            LocalNetworkPermission.startupRequest(sdk = 36, localNetworkGranted = false, askNotifications = true),
        )
        assertEquals(
            emptyList<String>(),
            LocalNetworkPermission.startupRequest(sdk = 36, localNetworkGranted = false, askNotifications = false),
        )
        // Notification boundary: API 33 asks, API 32 does not.
        assertEquals(
            listOf(notifications),
            LocalNetworkPermission.startupRequest(sdk = 33, localNetworkGranted = true, askNotifications = true),
        )
        assertEquals(
            emptyList<String>(),
            LocalNetworkPermission.startupRequest(sdk = 32, localNetworkGranted = true, askNotifications = true),
        )
    }
}
