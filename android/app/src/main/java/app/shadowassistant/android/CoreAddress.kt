package app.shadowassistant.android

import java.net.URI
import java.net.URISyntaxException

/**
 * The Core's addresses (T21.3.3). There is no built-in default:
 * - the **away** address is the one the user enters in the UI's connect screen
 *   (bridge key [BridgeStorage.CORE_URL_KEY]), normally `wss://` (e.g. the
 *   always-on box's Tailscale HTTPS name, docs/05 §5);
 * - the optional **home** address is entered in the native "Adresler" dialog
 *   ([WakeDialog]) and kept native-only ([BridgeStorage.homeCoreUrl]), e.g.
 *   `ws://<PC's LAN IPv4>:8700/ws`. The app uses it while it answers.
 *
 * Cleartext gate: plain `ws://` is allowed only to a private IPv4 literal
 * ([isPrivateIpv4Literal]); every hostname and every public address needs
 * `wss://`. The network security config cannot express address ranges, so it
 * allows cleartext in general and this gate (plus the page's CSP, see
 * [UiOrigin.pagePolicy]) is what actually enforces it.
 *
 * [CLEARTEXT_HOST] is a development-only extra host for plain `ws://`, set by the
 * build (Gradle property `shadowCoreHost` / environment SHADOW_CORE_HOST, see
 * app/build.gradle.kts) and never committed; it is "" otherwise.
 */
object CoreAddress {
    val CLEARTEXT_HOST: String = BuildConfig.CORE_CLEARTEXT_HOST

    /** [userInfo]: the URL carried `user@` (never allowed for cleartext). */
    data class Endpoint(val secure: Boolean, val host: String, val port: Int, val userInfo: Boolean = false) {
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
        return Endpoint(secure, host, port, uri.rawUserInfo != null)
    }

    /**
     * The cleartext gate: TLS always; plain `ws://` only to a private IPv4 literal
     * without user info, or to the build's development [cleartextHost], if any.
     */
    fun cleartextAllowed(endpoint: Endpoint, cleartextHost: String = CLEARTEXT_HOST): Boolean =
        endpoint.secure || (
            !endpoint.userInfo && (
                isPrivateIpv4Literal(endpoint.host) ||
                    (cleartextHost.isNotEmpty() && endpoint.host.equals(cleartextHost, ignoreCase = true))
                )
            )

    /**
     * The Core's home address as the dialog stores it, or null if it is not a
     * WebSocket URL the page can use: `ws(s)://host[:port][/path]`, no user
     * info, query or fragment, a valid explicit port; an empty path or "/"
     * becomes `/ws` (the Core's WebSocket path), as the UI's connect screen does.
     */
    fun normalizeHome(url: String?): String? {
        val text = url?.trim().orEmpty()
        if (text.isEmpty()) return null
        val uri = try {
            URI(text)
        } catch (_: URISyntaxException) {
            return null
        }
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        if (uri.port != -1 && uri.port !in 1..65535) return null
        val endpoint = parse(text) ?: return null
        val path = uri.rawPath.takeUnless { it.isNullOrEmpty() || it == "/" } ?: "/ws"
        val host = if (endpoint.host.contains(':')) "[${endpoint.host}]" else endpoint.host.lowercase()
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "${if (endpoint.secure) "wss" else "ws"}://$host$port$path"
    }

    /** Same scheme, host, effective port, path and query (no user info): the page saving back an address it was shown. */
    fun sameAddress(a: String?, b: String?): Boolean {
        val ea = parse(a) ?: return false
        if (ea != parse(b)) return false
        return try {
            val ua = URI(a!!.trim())
            val ub = URI(b!!.trim())
            ua.rawPath.orEmpty().ifEmpty { "/" } == ub.rawPath.orEmpty().ifEmpty { "/" } &&
                ua.rawQuery == ub.rawQuery && ua.rawFragment == ub.rawFragment
        } catch (_: URISyntaxException) {
            false
        }
    }

    /** Parsable and allowed by [cleartextAllowed]. */
    fun usable(url: String?, cleartextHost: String = CLEARTEXT_HOST): Boolean =
        parse(url)?.let { cleartextAllowed(it, cleartextHost) } ?: false

    /**
     * True only for a private IPv4 address (10.0.0.0/8, 172.16.0.0/12,
     * 192.168/16) written as a plain dotted quad: exactly four decimal
     * octets 0..255 without leading zeros. Anything else (hostnames, IPv6,
     * `10.1`, `010.0.0.1`, `0x0a.0.0.1`, a trailing dot, public or CGNAT
     * addresses) is refused, so no resolver or parser can read it differently.
     */
    fun isPrivateIpv4Literal(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { part ->
            if (part.isEmpty() || part.length > 3 || !part.all { it in '0'..'9' }) return false
            if (part.length > 1 && part[0] == '0') return false
            part.toInt().takeIf { it <= 255 } ?: return false
        }
        return when (octets[0]) {
            10 -> true
            172 -> octets[1] in 16..31
            192 -> octets[1] == 168
            else -> false
        }
    }

    /**
     * A stored address this build can never use: a `ws://` one the cleartext
     * gate refuses (e.g. a hostname). Unparsable values are left to the UI's
     * connect screen.
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
     * WebSockets over TLS to any host; plain `ws://` only to the exact
     * `host:port` of a configured Core address that passes the cleartext gate
     * ([plainCore], see [pagePolicy]) and to the build's development Core host
     * ([CoreAddress.CLEARTEXT_HOST], any port).
     */
    val CONTENT_SECURITY_POLICY: String = contentSecurityPolicy(CoreAddress.CLEARTEXT_HOST)

    /** What a page load needs: its CSP and whether mixed content (plain `ws://` from the https page) is allowed. */
    data class PagePolicy(val csp: String, val mixedContent: Boolean)

    /**
     * The policy for the configured Core addresses (home and away). Only plain
     * `ws://` addresses that pass [CoreAddress.cleartextAllowed] become CSP
     * sources; mixed content is allowed only when there is at least one such
     * source, otherwise it stays forbidden.
     */
    fun pagePolicy(coreUrls: List<String?>, cleartextHost: String = CoreAddress.CLEARTEXT_HOST): PagePolicy {
        val plain = coreUrls.mapNotNull { CoreAddress.parse(it) }
            .filter { !it.secure && CoreAddress.cleartextAllowed(it, cleartextHost) }
            .map { "ws://${it.host.lowercase()}:${it.port}" }
            .distinct()
        return PagePolicy(contentSecurityPolicy(cleartextHost, plain), plain.isNotEmpty() || cleartextHost.isNotEmpty())
    }

    fun contentSecurityPolicy(cleartextHost: String, plainCore: List<String> = emptyList()): String {
        val plain = (if (cleartextHost.isEmpty()) "" else "ws://$cleartextHost:* ") +
            plainCore.joinToString("") { "$it " }
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
