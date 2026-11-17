package app.shadowassistant.android

import java.net.URI
import java.net.URISyntaxException

/**
 * Address of the wake endpoint (wake-svc on the always-on box, docs/12 D1/D2)
 * and the Core's `/health` URL that the waking flow polls.
 *
 * There is a home and an away address (T21.3.3), tried in that order: e.g.
 * `http://<box's LAN IPv4>:8704` at home and `https://<box>.<tailnet>.ts.net:8443`
 * (Tailscale HTTPS, docs/05 §5) away. `https://` is accepted to any host;
 * plain `http://` only to a private IPv4 literal (the same gate as the Core,
 * [CoreAddress.isPrivateIpv4Literal]) or to [CLEARTEXT_HOST], a
 * development-only host from the build (Gradle property `shadowWakeHost` /
 * environment SHADOW_WAKE_HOST, see app/build.gradle.kts), "" in every
 * CI/release build.
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
        /** Plain HTTP to a host that is neither a private IPv4 literal nor [CLEARTEXT_HOST]. */
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
        val devHost = cleartextHost.isNotEmpty() && host.equals(cleartextHost, ignoreCase = true)
        if (!secure && !devHost && !CoreAddress.isPrivateIpv4Literal(host)) return Check.CleartextNotAllowed
        return Check.Ok(Endpoint(secure, host.lowercase(), port))
    }

    /** `wss://host:port/ws` → `https://host:port/health` (`ws` → `http`); null for an unusable Core address. */
    fun coreHealthUrl(coreUrl: String?): String? {
        val core = CoreAddress.parse(coreUrl) ?: return null
        val scheme = if (core.secure) "https" else "http"
        return "$scheme://${hostForUrl(core.host)}:${core.port}/health"
    }

    private fun hostForUrl(host: String) = if (host.contains(':')) "[$host]" else host
}

/**
 * The "Adresler" dialog's checks (docs/12 D2, T21.3.3), kept free of Android for
 * unit tests: the Core's home address and the wake endpoint's home and away
 * addresses (each optional) plus the wake token.
 */
object WakeSettingsForm {
    enum class Field { CORE_HOME, WAKE_HOME, WAKE_AWAY, TOKEN }
    enum class Problem { ADDRESS_INVALID, ADDRESS_CLEARTEXT, ADDRESS_MISSING, TOKEN_MISSING, TOKEN_INVALID }

    sealed interface Result {
        /**
         * Addresses normalized, null when left empty. No wake address at all
         * means "no wake settings" ([token] then null). [token] null otherwise:
         * keep the stored token (the field was left empty).
         */
        data class Ok(val coreHome: String?, val wakeHome: String?, val wakeAway: String?, val token: String?) : Result {
            override fun toString() =
                "Ok(coreHome=$coreHome, wakeHome=$wakeHome, wakeAway=$wakeAway, token=${if (token == null) "<kept>" else "<redacted>"})"
        }

        data class Invalid(val field: Field, val problem: Problem) : Result
    }

    fun validate(
        coreHome: String?,
        wakeHome: String?,
        wakeAway: String?,
        token: String?,
        hasStoredToken: Boolean,
        coreCleartextHost: String = CoreAddress.CLEARTEXT_HOST,
        wakeCleartextHost: String = WakeAddress.CLEARTEXT_HOST,
    ): Result {
        var core = coreHome?.trim().orEmpty()
        if (core.isNotEmpty()) {
            val endpoint = CoreAddress.parse(core) ?: return Result.Invalid(Field.CORE_HOME, Problem.ADDRESS_INVALID)
            if (!CoreAddress.cleartextAllowed(endpoint, coreCleartextHost)) {
                return Result.Invalid(Field.CORE_HOME, Problem.ADDRESS_CLEARTEXT)
            }
            core = CoreAddress.normalizeHome(core) ?: return Result.Invalid(Field.CORE_HOME, Problem.ADDRESS_INVALID)
        }
        val (homeUrl, homeProblem) = wakeBaseUrl(wakeHome, Field.WAKE_HOME, wakeCleartextHost)
        if (homeProblem != null) return homeProblem
        val (awayUrl, awayProblem) = wakeBaseUrl(wakeAway, Field.WAKE_AWAY, wakeCleartextHost)
        if (awayProblem != null) return awayProblem
        val pasted = token?.trim().orEmpty()
        val coreOut = core.ifEmpty { null }
        if (homeUrl == null && awayUrl == null) {
            // No wake endpoint: fine (the wake is optional), but a pasted token needs one.
            return if (pasted.isEmpty()) Result.Ok(coreOut, null, null, null) else Result.Invalid(Field.WAKE_AWAY, Problem.ADDRESS_MISSING)
        }
        if (pasted.isEmpty()) {
            return if (hasStoredToken) Result.Ok(coreOut, homeUrl, awayUrl, null) else Result.Invalid(Field.TOKEN, Problem.TOKEN_MISSING)
        }
        if (!WakeStore.validToken(pasted)) return Result.Invalid(Field.TOKEN, Problem.TOKEN_INVALID)
        return Result.Ok(coreOut, homeUrl, awayUrl, pasted)
    }

    /** (normalized base URL or null for an empty field, problem or null). */
    private fun wakeBaseUrl(input: String?, field: Field, cleartextHost: String): Pair<String?, Result.Invalid?> {
        if (input.isNullOrBlank()) return null to null
        return when (val c = WakeAddress.check(input, cleartextHost)) {
            is WakeAddress.Check.Ok -> c.endpoint.baseUrl to null
            WakeAddress.Check.Invalid -> null to Result.Invalid(field, Problem.ADDRESS_INVALID)
            WakeAddress.Check.CleartextNotAllowed -> null to Result.Invalid(field, Problem.ADDRESS_CLEARTEXT)
        }
    }
}
