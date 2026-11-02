package app.shadowassistant.android

import java.net.URI
import java.net.URISyntaxException

/**
 * The Core's address. At home and outside it is the same LAN address: away
 * from home the phone reaches 192.168.1.2 through the Tailscale subnet router
 * (decision #15), so there is no second URL to switch to.
 *
 * [CLEARTEXT_HOST] must match res/xml/network_security_config.xml (a unit
 * test checks this).
 */
object CoreAddress {
    const val CLEARTEXT_HOST = "192.168.1.2"
    const val DEFAULT_PORT = 8700 // core/src/config.ts CORE_PORT default
    const val DEFAULT_URL = "ws://$CLEARTEXT_HOST:$DEFAULT_PORT/ws"

    data class Endpoint(val secure: Boolean, val host: String, val port: Int) {
        override fun toString() = "$host:$port"
    }

    /** Parses a `ws://` / `wss://` URL as stored by the UI; null for anything else. */
    fun parse(url: String?): Endpoint? {
        if (url.isNullOrBlank()) return null
        val uri = try {
            URI(url.trim())
        } catch (_: URISyntaxException) {
            return null
        }
        val secure = when (uri.scheme?.lowercase()) {
            "ws" -> false
            "wss" -> true
            else -> return null
        }
        val host = uri.host?.removePrefix("[")?.removeSuffix("]")?.takeIf { it.isNotEmpty() } ?: return null
        val port = if (uri.port in 1..65535) uri.port else if (secure) 443 else 80
        return Endpoint(secure, host, port)
    }

    /** Mirrors the network security config: plain `ws://` only to [CLEARTEXT_HOST]. */
    fun cleartextAllowed(endpoint: Endpoint): Boolean = endpoint.secure || endpoint.host == CLEARTEXT_HOST
}

/** Only the bundled UI may use the bridge or be navigated to. */
object UiOrigin {
    /** androidx.webkit.WebViewAssetLoader.DEFAULT_DOMAIN */
    const val HOST = "appassets.androidplatform.net"
    const val START_URL = "https://$HOST/assets/ui/index.html"
    const val ASSET_INDEX = "ui/index.html"

    /**
     * Sent with every bundle response. `style-src 'unsafe-inline'` is needed for
     * React style attributes; no inline/eval scripts, no frames, no plugins.
     * Plain WebSockets only to the Core's home address (any port), TLS ones anywhere.
     */
    const val CONTENT_SECURITY_POLICY =
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; " +
            "connect-src 'self' ws://${CoreAddress.CLEARTEXT_HOST}:* wss:; " +
            "frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

    fun isTrusted(scheme: String?, host: String?): Boolean =
        scheme.equals("https", ignoreCase = true) && host.equals(HOST, ignoreCase = true)

    fun isTrustedUrl(url: String?): Boolean {
        if (url == null) return false
        return try {
            val uri = URI(url)
            isTrusted(uri.scheme, uri.host)
        } catch (_: URISyntaxException) {
            false
        }
    }
}
