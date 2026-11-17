package app.shadowassistant.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebResourceErrorCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * Hosts the UI bundle (`ui/dist`, copied into the APK assets under `ui/`) in a
 * WebView and exposes the `ShadowAndroid` bridge (docs/03-platform-adapter.md §4).
 *
 * WebView hardening:
 * - The bundle is served by [WebViewAssetLoader] from
 *   https://appassets.androidplatform.net/assets/ui/ (a secure origin); file
 *   and content access are off.
 * - Every other request the page makes (subresources, navigations, popups) is
 *   refused, so no foreign page can ever run next to the bridge, and the
 *   bridge itself answers only while the main frame is the bundle.
 * - Every bundle response carries a strict Content-Security-Policy
 *   ([UiOrigin.pagePolicy], fixed per page load): scripts only from the bundle
 *   (no inline/eval, so no injected or `srcdoc` script can reach the bridge),
 *   no frames, and `connect-src` limited to the bundle, `wss:` and plain
 *   `ws://` only to the exact `host:port` of a configured Core address that
 *   passes the cleartext gate (a private IPv4 address, T21.3.3; plus a
 *   development build's Core host, [CoreAddress.CLEARTEXT_HOST]). WebSocket
 *   handshakes bypass shouldInterceptRequest, so the CSP is what actually keeps
 *   a plain `ws://` (and the token in `hello`) from going to any other host.
 * - Mixed content: forbidden (MIXED_CONTENT_NEVER_ALLOW) unless a Core address
 *   is a plain `ws://` one that passes the gate; only then
 *   MIXED_CONTENT_ALWAYS_ALLOW, because Chromium lets an https page open
 *   `ws://` only with it. All non-asset HTTP(S) requests are refused above, so
 *   in practice it admits only WebSockets, which the CSP limits as described.
 * - Home / away (T21.3.3): [checkCore] asks the Core's home address first
 *   ([CoreProbe]) and records the choice ([BridgeStorage.selectHome]); the page
 *   reads the address in use once, at load, so a different address or policy
 *   reloads it ([reloadIfStale]).
 */
class MainActivity : Activity() {
    private lateinit var main: Handler
    private lateinit var webView: WebView
    private lateinit var errorPanel: View
    private lateinit var errorTitle: TextView
    private lateinit var errorMessage: TextView
    private lateinit var retryButton: Button
    private lateinit var secondaryButton: Button
    private lateinit var wakeButton: Button
    private lateinit var wakeSettingsButton: Button

    private lateinit var storage: BridgeStorage
    private lateinit var focus: AudioFocus
    private lateinit var recorder: AudioRecordRecorder
    private lateinit var capture: CaptureController
    private lateinit var player: AudioPlayer
    private lateinit var speaker: Speaker
    private lateinit var notifier: Notifier
    private lateinit var probe: CoreProbe
    private lateinit var gemini: GeminiLauncher
    private lateinit var wakeStore: WakeStore
    private lateinit var wakeScheduler: ExecutorWakeScheduler
    private lateinit var wake: WakeFlow
    private lateinit var wakeDialog: WakeDialog

    /** The last "Core unreachable" result while its panel is shown: the only place the wake button appears. */
    private var unreachable: CoreStatus.Unreachable? = null
    private val wakeTicker = Runnable { renderCorePanel() }

    @Volatile
    private var trustedPage = false
    private var destroyed = false
    private var pageLoaded = false
    private var shownError: ErrorKind? = null

    /** What the current page load was given: the Core address it reads and its policy. */
    private var loadedCoreUrl: String? = null
    private var loadedPolicy: UiOrigin.PagePolicy? = null

    /** The CSP sent with bundle responses (read on WebView threads). */
    @Volatile
    private var pageCsp: String = UiOrigin.CONTENT_SECURITY_POLICY

    /** The UI was not loaded because the local network permission is missing (API 37+). */
    private var uiDeferred = false

    private enum class ErrorKind { MISSING_UI, LOAD_FAILED, CORE, LOCAL_NETWORK }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        main = Handler(Looper.getMainLooper())
        webView = findViewById(R.id.web)
        errorPanel = findViewById(R.id.error_panel)
        errorTitle = findViewById(R.id.error_title)
        errorMessage = findViewById(R.id.error_message)
        retryButton = findViewById(R.id.error_retry)
        secondaryButton = findViewById(R.id.error_secondary)
        wakeButton = findViewById(R.id.error_wake)
        wakeSettingsButton = findViewById(R.id.error_wake_settings)
        applyInsets()

        storage = AppStorage.bridge(this) { Log.w(TAG, it) }
        val flags = AppStorage.flags(this)
        // No built-in Core address (T21.3.3); a plain ws:// one the gate refuses is dropped so the UI asks again.
        storage.forgetUnusableCoreUrl()

        focus = AudioFocus(getSystemService(AudioManager::class.java), main)
        recorder = AudioRecordRecorder(main, focus)
        capture = CaptureController(
            recorder = recorder,
            permission = object : MicPermission {
                override fun granted() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                override fun request() = requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
            },
            hasMicrophone = { packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE) },
            reply = ::reply,
        )
        player = AudioPlayer(this, main, focus, ::reply)
        speaker = Speaker(this, main, focus, ::reply)
        notifier = Notifier(this)
        probe = CoreProbe(main)
        gemini = GeminiLauncher(this)
        wakeStore = AppStorage.wake(this) { Log.w(TAG, it) }
        wakeStore.migrate()
        wakeScheduler = ExecutorWakeScheduler()
        // States arrive on the wake thread; the panel always renders the flow's current state.
        wake = WakeFlow(UrlConnectionWakeHttp(), wakeScheduler, SystemClock::elapsedRealtime) {
            main.post { if (!destroyed) onWakeState() }
        }
        // Changed addresses: a running wake waits for the old ones, so it stops (the first-press
        // flow starts its wake only after this); then check and pick again.
        wakeDialog = WakeDialog(this, wakeStore, storage) {
            wake.cancel()
            checkCore()
        }

        configureWebView()

        val askNotify = flags.get(FLAG_NOTIFY_ASKED) == null
        if (askNotify) flags.put(FLAG_NOTIFY_ASKED, "1")
        // Buds case battery (T11): asked once, only if Buds Case Widget is installed; a refusal turns off only this feature.
        val askCase = CaseBattery.shouldAsk(
            installed = CaseBatterySync.installed(this),
            granted = CaseBatterySync.granted(this),
            askedBefore = flags.get(FLAG_CASE_BATTERY_ASKED) != null,
        )
        if (askCase) flags.put(FLAG_CASE_BATTERY_ASKED, "1")
        val startup = LocalNetworkPermission.startupRequest(Build.VERSION.SDK_INT, localNetworkGranted(), askNotify, askCase)
        // Without the local network permission the UI's first WebSocket would fail; load it
        // once the request is answered (onRequestPermissionsResult) instead.
        uiDeferred = localNetworkMissing()
        if (startup.isNotEmpty()) requestPermissions(startup.toTypedArray(), REQ_STARTUP)
        if (!uiDeferred) loadUi()
    }

    private fun localNetworkGranted(): Boolean =
        checkSelfPermission(LocalNetworkPermission.PERMISSION) == PackageManager.PERMISSION_GRANTED

    private fun localNetworkMissing(): Boolean =
        LocalNetworkPermission.missing(Build.VERSION.SDK_INT, localNetworkGranted())

    /** After a request or a return from Settings: load the deferred UI, or explain why it cannot be. */
    private fun resumeDeferredUi(explain: Boolean) {
        if (!uiDeferred || destroyed) return
        if (!localNetworkMissing()) {
            uiDeferred = false
            loadUi()
        } else if (explain) {
            showError(ErrorKind.LOCAL_NETWORK)
        }
    }

    private fun openAppSettings() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "No app settings screen", e)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false // storage goes through the bridge
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = false
            // Set per load in loadUi (see class comment); forbidden until then.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        val assets = WebViewAssetLoader.Builder()
            .setDomain(UiOrigin.HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                if (UiOrigin.isTrusted(url.scheme, url.host)) {
                    assets.shouldInterceptRequest(url)?.let { return withCsp(it) }
                    return blocked(404, "Not Found")
                }
                return blocked(403, "Forbidden")
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !UiOrigin.isTrusted(request.url.scheme, request.url.host)

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                trustedPage = UiOrigin.isTrustedUrl(url)
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                trustedPage = UiOrigin.isTrustedUrl(url)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                if (!UiOrigin.isTrustedUrl(url)) return
                pageLoaded = true
                checkCore()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceErrorCompat) {
                if (request.isForMainFrame) showError(ErrorKind.LOAD_FAILED)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (request.isForMainFrame) showError(ErrorKind.MISSING_UI)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The WebView is unusable now; start over with a fresh activity.
                Log.w(TAG, "WebView renderer gone (crash=${detail.didCrash()})")
                trustedPage = false
                recreate()
                return true
            }
        }
        val info = BridgeJs.info(
            appVersion = BuildConfig.VERSION_NAME,
            appVersionCode = BuildConfig.VERSION_CODE,
            deviceClass = BridgeJs.deviceClass(resources.configuration.smallestScreenWidthDp),
            reducedMotion = if (animationsOff()) true else null,
        )
        val bridge = ShadowBridge(
            main = main,
            trusted = { trustedPage },
            info = info,
            capture = capture,
            player = player,
            speaker = speaker,
            storage = storage,
            vibrate = ::vibrate,
            postNotify = notifier::notify,
            postNotifyItem = notifier::notifyItem,
            onStorageChanged = { key ->
                if (key == BridgeStorage.CORE_URL_KEY) {
                    val url = storage.get(BridgeStorage.CORE_URL_KEY)
                    // The page already uses the address it just saved: no reload just for that.
                    loadedCoreUrl = url
                    // A waking flow waits for one Core; another address stops it (docs/12 D2).
                    wake.coreAddressChanged(url)
                }
                if (key == BridgeStorage.CORE_URL_KEY || key == BridgeStorage.TOKEN_KEY) checkCore()
                // Connecting: the UI writes the address first and the token last, so trigger on the
                // token only (the job then finds a matching address/token pair).
                if (key == BridgeStorage.TOKEN_KEY) CaseBatterySync.syncIfAllowed(this)
            },
            geminiAvailable = gemini::available,
            // Leaving pauses this activity: onPause stops playback/speech and cuts a running recording.
            // Nothing started (T16.3): tell the page, which shows a short hint.
            launchGemini = { if (!destroyed && !gemini.open()) sendEvent(BridgeJs.GEMINI_FAILED, JSONObject()) },
            launchUpdates = { if (!destroyed) openUpdateScreen() },
            showAddresses = { if (!destroyed) wakeDialog.show() },
        )
        // Injected before the first load so selectAdapter() finds it (docs/03 §2).
        webView.addJavascriptInterface(bridge, "ShadowAndroid")
    }

    /** Adds the current load's CSP ([pageCsp]) to a bundle response (see class comment). */
    private fun withCsp(response: WebResourceResponse): WebResourceResponse {
        response.responseHeaders = (response.responseHeaders.orEmpty()) + ("Content-Security-Policy" to pageCsp)
        return response
    }

    /** The policy for the stored Core addresses (home and away). */
    private fun currentPolicy() = UiOrigin.pagePolicy(listOf(storage.homeCoreUrl(), storage.awayCoreUrl()))

    private fun blocked(status: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", status, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun uiBundlePresent(): Boolean = try {
        assets.open(UiOrigin.ASSET_INDEX).close()
        true
    } catch (_: Exception) {
        false
    }

    private fun loadUi() {
        hideError()
        if (!uiBundlePresent()) {
            showError(ErrorKind.MISSING_UI)
            return
        }
        pageLoaded = false
        val policy = currentPolicy()
        loadedPolicy = policy
        loadedCoreUrl = storage.get(BridgeStorage.CORE_URL_KEY)
        pageCsp = policy.csp
        webView.settings.mixedContentMode =
            if (policy.mixedContent) WebSettings.MIXED_CONTENT_ALWAYS_ALLOW else WebSettings.MIXED_CONTENT_NEVER_ALLOW
        webView.loadUrl(UiOrigin.START_URL)
    }

    /**
     * Reloads the page if the Core address it uses or its policy is out of date
     * (another address was selected, or the addresses changed). Not while a wake
     * is running: its Done state checks again and reloads then. True if reloaded.
     */
    private fun reloadIfStale(): Boolean {
        if (wake.active) return false
        if (storage.get(BridgeStorage.CORE_URL_KEY) == loadedCoreUrl && currentPolicy() == loadedPolicy) return false
        loadUi()
        return true
    }

    /** Shows a native error when the configured Core cannot be reached (only once a token is set). */
    private fun checkCore() {
        if (!pageLoaded || destroyed) return
        if (!storage.hasToken()) {
            if (shownError == ErrorKind.CORE) hideError()
            return
        }
        probe.check(storage.homeCoreUrl(), storage.awayCoreUrl()) { selection ->
            if (destroyed) return@check
            selection.useHome?.let(storage::selectHome)
            if (reloadIfStale()) return@check // onPageFinished checks again with the new page
            when (val status = selection.status) {
                // While waking, only the flow's /health poll decides (docs/12 D2: an open TCP port is not
                // a usable Core yet); the flow closes the panel itself once the Core answers.
                CoreStatus.Fine -> if (shownError == ErrorKind.CORE && !wake.active) hideError()
                is CoreStatus.Unreachable -> {
                    // A finished wake result is replaced by the fresh check; a running one keeps its panel.
                    if (wake.state is WakeState.Stopped) wake.cancel()
                    unreachable = status
                    renderCorePanel()
                }
                is CoreStatus.CleartextBlocked -> showCoreError(
                    getString(R.string.error_cleartext_title),
                    getString(R.string.error_cleartext_message, status.endpoint.host),
                )
            }
        }
    }

    private fun showError(kind: ErrorKind) {
        when (kind) {
            ErrorKind.MISSING_UI -> showPanel(kind, getString(R.string.error_ui_title), getString(R.string.error_ui_message), null)
            ErrorKind.LOAD_FAILED -> showPanel(kind, getString(R.string.error_load_title), getString(R.string.error_load_message), null)
            // Not the Core's fault: Android blocks LAN connections until the user allows "Yerel ağ".
            ErrorKind.LOCAL_NETWORK -> showPanel(
                kind,
                getString(R.string.error_local_network_title),
                getString(R.string.error_local_network_message),
                getString(R.string.error_open_settings),
            )
            ErrorKind.CORE -> Unit
        }
    }

    // "Adresi değiştir": back to the UI, whose settings/connect screen edits the address.
    private fun showCoreError(title: String, message: String) =
        showPanel(ErrorKind.CORE, title, message, getString(R.string.error_change_address))

    /** [secondary] is the label of the second button (null: hidden); its action depends on [kind]. */
    private fun showPanel(kind: ErrorKind, title: String, message: String, secondary: String?) {
        // Another panel replaces the Core-unreachable one: a running wake flow ends with it.
        unreachable = null
        main.removeCallbacks(wakeTicker)
        wake.cancel()
        setPanel(
            kind,
            title,
            message,
            primary = getString(R.string.error_retry) to {
                when (kind) {
                    ErrorKind.CORE -> checkCore()
                    // Asks again; once permanently denied Android answers at once without a dialog.
                    ErrorKind.LOCAL_NETWORK -> requestPermissions(arrayOf(LocalNetworkPermission.PERMISSION), REQ_LOCAL_NETWORK)
                    else -> loadUi()
                }
            },
            // Settings → Permissions; onResume re-checks when the user comes back.
            secondary = secondary?.let { label -> label to { if (kind == ErrorKind.LOCAL_NETWORK) openAppSettings() else hideError() } },
        )
    }

    /** Fills the panel; [wake] / [wakeSettings] show the wake buttons (Core-unreachable panel only). */
    private fun setPanel(
        kind: ErrorKind,
        title: String,
        message: String,
        primary: Pair<String, () -> Unit>,
        secondary: Pair<String, () -> Unit>?,
        wake: Boolean = false,
        wakeSettings: Boolean = false,
    ) {
        val wasShown = errorPanel.isVisible && shownError == kind
        shownError = kind
        errorTitle.text = title
        errorMessage.text = message
        retryButton.text = primary.first
        retryButton.setOnClickListener { primary.second() }
        secondaryButton.visibility = if (secondary != null) View.VISIBLE else View.GONE
        secondaryButton.text = secondary?.first.orEmpty()
        secondaryButton.setOnClickListener { secondary?.second?.invoke() }
        wakeButton.visibility = if (wake) View.VISIBLE else View.GONE
        wakeButton.setOnClickListener { onWakePressed() }
        wakeSettingsButton.visibility = if (wakeSettings) View.VISIBLE else View.GONE
        wakeSettingsButton.setOnClickListener { wakeDialog.show() }
        errorPanel.visibility = View.VISIBLE
        // Not on every tick of the waking timer: focus only moves when a panel first appears.
        if (!wasShown) retryButton.requestFocus()
    }

    private fun hideError() {
        shownError = null
        unreachable = null
        errorPanel.visibility = View.GONE
        main.removeCallbacks(wakeTicker)
        // Closing the panel ends a running wake flow (docs/12 D2).
        wake.cancel()
    }

    // --- waking the PC (docs/12 D2) ---------------------------------------------------

    /**
     * The "Çekirdeğe ulaşılamıyor" panel in its current wake state. The wake
     * button is offered only here (not for a blocked cleartext address, not on
     * the local network permission panel).
     */
    private fun renderCorePanel() {
        main.removeCallbacks(wakeTicker)
        // Set only while this panel is meant to be up (cleared by showPanel / hideError).
        val status = unreachable ?: return
        if (destroyed) return
        val coreTitle = getString(R.string.error_core_title)
        val backToCore: () -> Unit = {
            wake.cancel()
            renderCorePanel()
        }
        val close = getString(R.string.wake_close) to backToCore
        when (val state = wake.state) {
            WakeState.Idle, WakeState.Done -> setPanel(
                ErrorKind.CORE,
                coreTitle,
                getString(R.string.error_core_message, status.endpoint.toString()),
                primary = getString(R.string.error_retry) to { checkCore() },
                // "Adresi değiştir": back to the UI, whose settings/connect screen edits the address.
                secondary = getString(R.string.error_change_address) to { hideError() },
                wake = true,
                // "Adresler": where the home address (and the wake settings) are entered.
                wakeSettings = true,
            )
            WakeState.Sending -> setPanel(
                ErrorKind.CORE,
                getString(R.string.wake_title),
                getString(R.string.wake_sending),
                primary = getString(R.string.wake_cancel) to backToCore,
                secondary = null,
            )
            is WakeState.Waking -> {
                setPanel(
                    ErrorKind.CORE,
                    getString(R.string.wake_title),
                    getString(R.string.wake_waking, WakeTime.elapsed(SystemClock.elapsedRealtime() - state.sinceMs)),
                    primary = getString(R.string.wake_cancel) to backToCore,
                    secondary = null,
                    wakeSettings = true,
                )
                main.postDelayed(wakeTicker, 1_000)
            }
            is WakeState.Stopped -> renderWakeStop(state.reason, coreTitle, close)
        }
    }

    private fun renderWakeStop(reason: WakeStop, title: String, close: Pair<String, () -> Unit>) {
        val wakeAgain: () -> Unit = { onWakePressed() }
        when (reason) {
            WakeStop.Unauthorized, is WakeStop.AuthLocked -> setPanel(
                ErrorKind.CORE,
                title,
                getString(if (reason == WakeStop.Unauthorized) R.string.wake_unauthorized else R.string.wake_auth_locked),
                primary = getString(R.string.wake_settings_button) to { wakeDialog.show() },
                secondary = close,
            )
            // A new press would only be limited again: the primary button checks whether the Core is up.
            is WakeStop.RateLimited -> setPanel(
                ErrorKind.CORE,
                title,
                reason.retryAfterS?.let { getString(R.string.wake_rate_limited_wait, waitText(it)) }
                    ?: getString(R.string.wake_rate_limited),
                primary = getString(R.string.error_retry) to { checkCore() },
                secondary = close,
                wakeSettings = true,
            )
            WakeStop.SendFailed, WakeStop.Unreachable, is WakeStop.Unexpected -> setPanel(
                ErrorKind.CORE,
                title,
                when (reason) {
                    WakeStop.SendFailed -> getString(R.string.wake_send_failed)
                    is WakeStop.Unexpected -> getString(R.string.wake_unexpected, reason.status)
                    else -> getString(R.string.wake_unreachable)
                },
                primary = getString(R.string.error_retry) to wakeAgain,
                secondary = close,
                wakeSettings = true,
            )
            WakeStop.TimedOut -> setPanel(
                ErrorKind.CORE,
                title,
                getString(R.string.wake_timed_out),
                primary = getString(R.string.wake_again) to wakeAgain,
                secondary = close,
                wakeSettings = true,
            )
        }
    }

    private fun waitText(seconds: Int): String {
        val (value, minutes) = WakeTime.waitParts(seconds)
        return getString(if (minutes) R.string.wake_wait_minutes else R.string.wake_wait_seconds, value)
    }

    /** First press without settings opens the dialog, which sends right after saving. */
    private fun onWakePressed() {
        if (destroyed || unreachable == null) return
        val config = wakeStore.config()
        // Home first, then away; only addresses the gate allows.
        val wakeUrls = config?.let { c ->
            listOf(c.home, c.away).mapNotNull { (WakeAddress.check(it) as? WakeAddress.Check.Ok)?.endpoint?.wakeUrl }
        }.orEmpty()
        // No settings, an unreadable token, or no address this build allows: ask (again).
        if (config == null || wakeUrls.isEmpty()) {
            wakeDialog.show(onSaved = ::onWakePressed)
            return
        }
        // Wait for the Core at either address: the network may change while the PC boots.
        val health = listOf(storage.homeCoreUrl(), storage.awayCoreUrl())
            .filter { CoreAddress.usable(it) }
            .mapNotNull { WakeAddress.coreHealthUrl(it) }
            .distinct()
        if (health.isEmpty()) return
        wake.start(WakeTarget(wakeUrls, config.token, health))
        renderCorePanel()
    }

    private fun onWakeState() {
        // A reload held back while the wake ran (reloadIfStale) happens as soon as it ends.
        if (wake.state != WakeState.Done && !wake.active && reloadIfStale()) return
        if (wake.state == WakeState.Done) {
            // The Core answers /health: do what a return to the foreground does, so the UI reconnects now.
            hideError()
            sendEvent("visibility", BridgeJs.visibility(true))
            checkCore()
            return
        }
        renderCorePanel()
    }

    /** Answers a bridge request exactly as docs/03 §4.2 shows. */
    private fun reply(requestId: String, payload: JSONObject) {
        if (destroyed) return
        val js = BridgeJs.callbackScript(requestId, payload)
        main.post { if (!destroyed) webView.evaluateJavascript(js, null) }
    }

    /**
     * The update screen (T16.2), started like the launcher shortcut starts it: in its own task
     * (UpdateActivity's affinity, where the install-status PendingIntent also lands) and fresh,
     * so it always begins with a new check.
     */
    private fun openUpdateScreen() {
        try {
            startActivity(
                Intent(this, UpdateActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
            )
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "Update screen did not start", e)
        }
    }

    private fun sendEvent(name: String, payload: JSONObject) {
        if (destroyed) return
        webView.evaluateJavascript(BridgeJs.eventScript(name, payload), null)
    }

    private fun vibrate(timings: LongArray) {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Vibrator::class.java)
        }
        if (vibrator?.hasVibrator() == true) vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
    }

    private fun animationsOff(): Boolean =
        Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

    private fun applyInsets() {
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC) {
            // Read the actual state: an interrupted request (e.g. another permission dialog
            // was open) returns empty results even though nothing was denied.
            capture.onPermissionResult(
                checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
            )
        }
        // Same here: decide from checkSelfPermission, not grantResults.
        if (requestCode == REQ_STARTUP || requestCode == REQ_LOCAL_NETWORK) resumeDeferredUi(explain = true)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        capture.onResume()
        sendEvent("visibility", BridgeJs.visibility(true))
        // Back from Settings with "Yerel ağ" allowed: load without restarting the app. Silent
        // otherwise, so the resume after the permission dialog cannot ask again in a loop.
        resumeDeferredUi(explain = false)
        checkCore()
        // Opening the app (also a return from Settings or a permission dialog): send the provider's
        // current value, catching up on a missed broadcast. No-op without the permission; REPLACE keeps one job.
        CaseBatterySync.syncIfAllowed(this)
    }

    override fun onPause() {
        sendEvent("visibility", BridgeJs.visibility(false))
        // docs/03 §4.5: stop playback/speech (answering them), cut a running recording.
        player.stop()
        speaker.stop()
        capture.onPause()
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        destroyed = true
        trustedPage = false
        capture.release()
        player.release()
        speaker.shutdown()
        recorder.shutdown()
        probe.shutdown()
        main.removeCallbacks(wakeTicker)
        wake.cancel()
        wakeScheduler.shutdown()
        wakeDialog.dismiss()
        focus.releaseAll()
        webView.removeJavascriptInterface("ShadowAndroid")
        webView.destroy()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "Shadow"
        const val REQ_MIC = 1
        const val REQ_STARTUP = 2 // local network (API 37+) and/or the one-time notification prompt
        const val REQ_LOCAL_NETWORK = 3
        const val FLAG_NOTIFY_ASKED = "notifyPermissionAsked"
        const val FLAG_CASE_BATTERY_ASKED = "caseBatteryPermissionAsked"
    }
}
