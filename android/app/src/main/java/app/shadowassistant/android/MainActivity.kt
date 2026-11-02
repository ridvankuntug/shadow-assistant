package app.shadowassistant.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
 *   ([UiOrigin.CONTENT_SECURITY_POLICY]): scripts only from the bundle (no
 *   inline/eval, so no injected or `srcdoc` script can reach the bridge), no
 *   frames, and `connect-src` limited to the bundle, `ws://192.168.1.2` and
 *   `wss:`. WebSocket handshakes bypass shouldInterceptRequest, so the CSP is
 *   what actually keeps a plain `ws://` (and the token in `hello`) from going
 *   to any other host.
 * - Mixed content: the Core speaks plain `ws://` on the LAN/Tailscale address,
 *   and Chromium only lets an https page open `ws://` with
 *   MIXED_CONTENT_ALWAYS_ALLOW. Since all non-asset HTTP(S) requests are
 *   refused above, in practice that setting only admits WebSockets, which the
 *   CSP limits to 192.168.1.2 (plain) or TLS; the network security config
 *   limits cleartext to 192.168.1.2 as well.
 */
class MainActivity : Activity() {
    private lateinit var main: Handler
    private lateinit var webView: WebView
    private lateinit var errorPanel: View
    private lateinit var errorTitle: TextView
    private lateinit var errorMessage: TextView
    private lateinit var retryButton: Button
    private lateinit var secondaryButton: Button

    private lateinit var storage: BridgeStorage
    private lateinit var focus: AudioFocus
    private lateinit var recorder: AudioRecordRecorder
    private lateinit var capture: CaptureController
    private lateinit var player: AudioPlayer
    private lateinit var speaker: Speaker
    private lateinit var notifier: Notifier
    private lateinit var probe: CoreProbe

    @Volatile
    private var trustedPage = false
    private var destroyed = false
    private var pageLoaded = false
    private var shownError: ErrorKind? = null

    private enum class ErrorKind { MISSING_UI, LOAD_FAILED, CORE }

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
        applyInsets()

        storage = BridgeStorage(
            plain = SharedPrefsStore(getSharedPreferences(PREFS_PLAIN, Context.MODE_PRIVATE)),
            secret = SharedPrefsStore(getSharedPreferences(PREFS_SECRET, Context.MODE_PRIVATE)),
            cipher = AesGcmTokenCipher({ AndroidKeystoreKey.getOrCreate(KEY_ALIAS) }, BridgeStorage.TOKEN_KEY.toByteArray()),
            log = { Log.w(TAG, it) },
        )
        val flags = SharedPrefsStore(getSharedPreferences(PREFS_FLAGS, Context.MODE_PRIVATE))
        storage.seedDefaults(flags)

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

        configureWebView()
        loadUi()

        if (flags.get(FLAG_NOTIFY_ASKED) == null) {
            flags.put(FLAG_NOTIFY_ASKED, "1")
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
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
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW // see class comment
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
            notify = notifier::notify,
            onStorageChanged = { key ->
                if (key == BridgeStorage.CORE_URL_KEY || key == BridgeStorage.TOKEN_KEY) checkCore()
            },
        )
        // Injected before the first load so selectAdapter() finds it (docs/03 §2).
        webView.addJavascriptInterface(bridge, "ShadowAndroid")
    }

    /** Adds [UiOrigin.CONTENT_SECURITY_POLICY] to a bundle response (see class comment). */
    private fun withCsp(response: WebResourceResponse): WebResourceResponse {
        response.responseHeaders = (response.responseHeaders.orEmpty()) + ("Content-Security-Policy" to UiOrigin.CONTENT_SECURITY_POLICY)
        return response
    }

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
        webView.loadUrl(UiOrigin.START_URL)
    }

    /** Shows a native error when the configured Core cannot be reached (only once a token is set). */
    private fun checkCore() {
        if (!pageLoaded || destroyed) return
        if (!storage.hasToken()) {
            if (shownError == ErrorKind.CORE) hideError()
            return
        }
        probe.check(storage.get(BridgeStorage.CORE_URL_KEY)) { status ->
            if (destroyed) return@check
            when (status) {
                CoreStatus.Fine -> if (shownError == ErrorKind.CORE) hideError()
                is CoreStatus.Unreachable -> showCoreError(
                    getString(R.string.error_core_title),
                    getString(R.string.error_core_message, status.endpoint.toString()),
                )
                is CoreStatus.CleartextBlocked -> showCoreError(
                    getString(R.string.error_cleartext_title),
                    getString(R.string.error_cleartext_message, status.endpoint.host, CoreAddress.CLEARTEXT_HOST),
                )
            }
        }
    }

    private fun showError(kind: ErrorKind) {
        when (kind) {
            ErrorKind.MISSING_UI -> showPanel(kind, getString(R.string.error_ui_title), getString(R.string.error_ui_message), false)
            ErrorKind.LOAD_FAILED -> showPanel(kind, getString(R.string.error_load_title), getString(R.string.error_load_message), false)
            ErrorKind.CORE -> Unit
        }
    }

    private fun showCoreError(title: String, message: String) = showPanel(ErrorKind.CORE, title, message, true)

    private fun showPanel(kind: ErrorKind, title: String, message: String, canContinue: Boolean) {
        shownError = kind
        errorTitle.text = title
        errorMessage.text = message
        retryButton.setOnClickListener {
            if (kind == ErrorKind.CORE) checkCore() else loadUi()
        }
        secondaryButton.visibility = if (canContinue) View.VISIBLE else View.GONE
        // "Adresi değiştir": back to the UI, whose settings/connect screen edits the address.
        secondaryButton.setOnClickListener { hideError() }
        errorPanel.visibility = View.VISIBLE
        retryButton.requestFocus()
    }

    private fun hideError() {
        shownError = null
        errorPanel.visibility = View.GONE
    }

    /** Answers a bridge request exactly as docs/03 §4.2 shows. */
    private fun reply(requestId: String, payload: JSONObject) {
        if (destroyed) return
        val js = BridgeJs.callbackScript(requestId, payload)
        main.post { if (!destroyed) webView.evaluateJavascript(js, null) }
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
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        capture.onResume()
        sendEvent("visibility", BridgeJs.visibility(true))
        checkCore()
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
        focus.releaseAll()
        webView.removeJavascriptInterface("ShadowAndroid")
        webView.destroy()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "Shadow"
        const val REQ_MIC = 1
        const val REQ_NOTIFY = 2
        const val PREFS_PLAIN = "shadow_storage"
        const val PREFS_SECRET = "shadow_secure"
        const val PREFS_FLAGS = "shadow_native"
        const val FLAG_NOTIFY_ASKED = "notifyPermissionAsked"
        const val KEY_ALIAS = "shadow.deviceToken.v1"
    }
}
