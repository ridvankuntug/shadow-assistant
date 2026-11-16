package app.shadowassistant.android

import java.net.URI
import java.net.URISyntaxException

/**
 * Address of the wake endpoint (wake-svc on the always-on box, docs/12 D1/D2)
 * and the Core's `/health` URL that the waking flow polls.
 *
 * [CLEARTEXT_HOST] comes from the build (Gradle property `shadowWakeHost` /
 * environment SHADOW_WAKE_HOST, see app/build.gradle.kts), never from the
 * repository; it is "" when the build has none. It must match the generated
 * network security config (a unit test checks this). Plain `http://` is
 * accepted only to that host; `https://` to any host (a later TLS setup).
 */
object WakeAddress {
    val CLEARTEXT_HOST: String = BuildConfig.WAKE_CLEARTEXT_HOST
    const val DEFAULT_PORT = 8704 // services/wake-svc DEFAULT_PORT

    /** The dialog's prefill: `http://<wake host>:8704`, or "" when the build has no wake host. */
    fun defaultUrl(cleartextHost: String = CLEARTEXT_HOST): String =
        if (cleartextHost.isEmpty()) "" else "http://$cleartextHost:$DEFAULT_PORT"

    /** A validated wake endpoint; [baseUrl] is normalized (`scheme://host:port`, no path). */
    data class Endpoint(val secure: Boolean, val host: String, val port: Int) {
        val baseUrl: String get() = "${if (secure) "https" else "http"}://${hostForUrl(host)}:$port"
        val wakeUrl: String get() = "$baseUrl/wake"
    }

    sealed interface Check {
        data class Ok(val endpoint: Endpoint) : Check
        /** Not an `http(s)://host[:port][/]` address. */
        data object Invalid : Check
        /** Plain HTTP to a host other than [CLEARTEXT_HOST] (the network security config would refuse it). */
        data object CleartextNotAllowed : Check
    }

    /**
     * Validates what the user typed. Only a scheme, host and optional port are
     * accepted: no user info, path (other than "/"), query or fragment, so the
     * stored value is exactly the box's base address.
     */
    fun check(input: String?, cleartextHost: String = CLEARTEXT_HOST): Check {
        val text = input?.trim().orEmpty()
        if (text.isEmpty()) return Check.Invalid
        val uri = try {
            URI(text)
        } catch (_: URISyntaxException) {
            return Check.Invalid
        }
        val secure = when (uri.scheme?.lowercase()) {
            "http" -> false
            "https" -> true
            else -> return Check.Invalid
        }
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return Check.Invalid
        if (!(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) return Check.Invalid
        val host = uri.host?.removePrefix("[")?.removeSuffix("]")?.takeIf { it.isNotEmpty() } ?: return Check.Invalid
        val port = when {
            uri.port == -1 -> if (secure) 443 else 80
            uri.port in 1..65535 -> uri.port
            else -> return Check.Invalid
        }
        if (!secure && (cleartextHost.isEmpty() || !host.equals(cleartextHost, ignoreCase = true))) {
            return Check.CleartextNotAllowed
        }
        return Check.Ok(Endpoint(secure, host.lowercase(), port))
    }

    /** `ws://host:port/ws` → `http://host:port/health` (`wss` → `https`); null for an unusable Core address. */
    fun coreHealthUrl(coreUrl: String?): String? {
        val core = CoreAddress.parse(coreUrl) ?: return null
        val scheme = if (core.secure) "https" else "http"
        return "$scheme://${hostForUrl(core.host)}:${core.port}/health"
    }

    private fun hostForUrl(host: String) = if (host.contains(':')) "[$host]" else host
}

/** The settings dialog's checks (docs/12 D2), kept free of Android for unit tests. */
object WakeSettingsForm {
    enum class Problem { ADDRESS_INVALID, ADDRESS_CLEARTEXT, ADDRESS_NO_CLEARTEXT_HOST, TOKEN_MISSING, TOKEN_INVALID }

    sealed interface Result {
        /** [token] null: keep the stored token (the field was left empty). */
        data class Ok(val address: String, val token: String?) : Result {
            override fun toString() = "Ok(address=$address, token=${if (token == null) "<kept>" else "<redacted>"})"
        }

        data class Invalid(val problem: Problem) : Result
    }

    fun validate(
        address: String?,
        token: String?,
        hasStoredToken: Boolean,
        cleartextHost: String = WakeAddress.CLEARTEXT_HOST,
    ): Result {
        val endpoint = when (val c = WakeAddress.check(address, cleartextHost)) {
            is WakeAddress.Check.Ok -> c.endpoint
            WakeAddress.Check.Invalid -> return Result.Invalid(Problem.ADDRESS_INVALID)
            WakeAddress.Check.CleartextNotAllowed -> return Result.Invalid(
                if (cleartextHost.isEmpty()) Problem.ADDRESS_NO_CLEARTEXT_HOST else Problem.ADDRESS_CLEARTEXT,
            )
        }
        val pasted = token?.trim().orEmpty()
        if (pasted.isEmpty()) {
            return if (hasStoredToken) Result.Ok(endpoint.baseUrl, null) else Result.Invalid(Problem.TOKEN_MISSING)
        }
        if (!WakeStore.validToken(pasted)) return Result.Invalid(Problem.TOKEN_INVALID)
        return Result.Ok(endpoint.baseUrl, pasted)
    }
}
