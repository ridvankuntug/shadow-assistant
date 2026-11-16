package app.shadowassistant.android

import java.net.URI
import java.net.URISyntaxException

/**
 * The Core's address, as the user enters it in the UI's connect screen. There
 * is no built-in default (T21.3.3): the Core is reached through a `wss://`
 * address (e.g. the always-on box's Tailscale HTTPS name, docs/05 §5), which
 * the app asks for on first launch.
 *
 * [CLEARTEXT_HOST] is a development-only host for plain `ws://`, set by the
 * build (Gradle property `shadowCoreHost` / environment SHADOW_CORE_HOST, see
 * app/build.gradle.kts) and never committed; it is "" otherwise, and then
 * every `ws://` address is refused. It must match the generated network
 * security config (a unit test checks this).
 */
object CoreAddress {
    val CLEARTEXT_HOST: String = BuildConfig.CORE_CLEARTEXT_HOST

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

    /** Mirrors the network security config: plain `ws://` only to the build's [cleartextHost], if any. */
    fun cleartextAllowed(endpoint: Endpoint, cleartextHost: String = CLEARTEXT_HOST): Boolean =
        endpoint.secure || (cleartextHost.isNotEmpty() && endpoint.host.equals(cleartextHost, ignoreCase = true))

    /**
     * A stored address this build can never use: a `ws://` one the network
     * security config refuses (e.g. the LAN default that older versions seeded).
     * Unparsable values are left to the UI's connect screen.
     */
    fun unusable(url: String?, cleartextHost: String = CLEARTEXT_HOST): Boolean {
        val endpoint = parse(url) ?: return false
        return !cleartextAllowed(endpoint, cleartextHost)
    }
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
     * WebSockets over TLS only; a plain `ws://` source is added only for the
     * build's development Core host ([CoreAddress.CLEARTEXT_HOST], any port).
     */
    val CONTENT_SECURITY_POLICY: String = contentSecurityPolicy(CoreAddress.CLEARTEXT_HOST)

    fun contentSecurityPolicy(cleartextHost: String): String {
        val plain = if (cleartextHost.isEmpty()) "" else "ws://$cleartextHost:* "
        return "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; " +
            "connect-src 'self' ${plain}wss:; " +
            "frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    }

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
