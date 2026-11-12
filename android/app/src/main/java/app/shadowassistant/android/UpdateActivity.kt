package app.shadowassistant.android

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.net.toUri

/**
 * "Güncellemeleri denetle" (launcher shortcut, docs/10 D5): check → confirm →
 * "install unknown apps" access if needed → download + verify → system install
 * dialog. Only on user action; nothing runs in the background on its own.
 *
 * Not exported; started by the static shortcut and by the install-status
 * PendingIntent of [Updater.install] ([ACTION_INSTALL_STATUS], delivered to
 * [onNewIntent] while open, or to a fresh instance after process death). Own
 * task affinity: the shortcut starts it with CLEAR_TASK, which must never clear
 * the main task (the WebView in [MainActivity]).
 */
class UpdateActivity : Activity() {
    private lateinit var message: TextView
    private lateinit var progress: ProgressBar
    private lateinit var primary: Button
    private lateinit var secondary: Button

    private var available: Updater.Check.Available? = null
    private var waitingForInstallAccess = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTitle(R.string.update_title)
        setFinishOnTouchOutside(false)
        buildViews()
        if (intent?.action == ACTION_INSTALL_STATUS) handleStatus(intent) else startCheck()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_INSTALL_STATUS) handleStatus(intent)
    }

    override fun onResume() {
        super.onResume()
        // Back from the "install unknown apps" screen: continue if access was granted.
        if (waitingForInstallAccess && packageManager.canRequestPackageInstalls()) {
            waitingForInstallAccess = false
            available?.let { startDownload(it) }
        }
    }

    private fun buildViews() {
        val pad = (20 * resources.displayMetrics.density).toInt()
        message = TextView(this).apply { setPadding(0, 0, 0, pad / 2) }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        primary = Button(this)
        secondary = Button(this)
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(secondary, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(primary, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad / 2, pad, pad / 2)
                addView(message)
                addView(progress)
                addView(buttons)
            },
        )
    }

    /** One screen state: message, optional progress (null = hidden, -1 = indeterminate), up to two buttons. */
    private fun show(
        text: CharSequence,
        progressPercent: Int? = null,
        primaryLabel: Int? = null,
        onPrimary: (() -> Unit)? = null,
        secondaryLabel: Int? = null,
        onSecondary: (() -> Unit)? = null,
    ) {
        message.text = text
        progress.visibility = if (progressPercent == null) View.GONE else View.VISIBLE
        progress.isIndeterminate = progressPercent == -1
        if (progressPercent != null && progressPercent >= 0) progress.progress = progressPercent
        bind(primary, primaryLabel, onPrimary)
        bind(secondary, secondaryLabel, onSecondary)
    }

    private fun bind(button: Button, label: Int?, action: (() -> Unit)?) {
        if (label == null || action == null) {
            button.visibility = View.GONE
            button.setOnClickListener(null)
        } else {
            button.visibility = View.VISIBLE
            button.setText(label)
            button.setOnClickListener { action() }
        }
    }

    private fun closeButton() = R.string.update_button_close

    private fun startCheck() {
        if (!Updater.inFlight.compareAndSet(false, true)) {
            show(getString(R.string.update_busy), primaryLabel = closeButton(), onPrimary = ::finish)
            return
        }
        show(getString(R.string.update_checking), progressPercent = -1)
        val updater = Updater(this)
        Thread {
            val result = runCatching { updater.check() }
            Updater.inFlight.set(false)
            onUi {
                result.fold(
                    onSuccess = { check ->
                        when (check) {
                            is Updater.Check.UpToDate -> show(
                                getString(R.string.update_up_to_date, check.installedName),
                                primaryLabel = closeButton(), onPrimary = ::finish,
                            )
                            is Updater.Check.Available -> {
                                available = check
                                show(
                                    getString(R.string.update_available, check.release.versionName, check.installedName),
                                    primaryLabel = R.string.update_button_install, onPrimary = { startDownload(check) },
                                    secondaryLabel = R.string.update_button_cancel, onSecondary = ::finish,
                                )
                            }
                        }
                    },
                    onFailure = { showError(it, retry = ::startCheck) },
                )
            }
        }.start()
    }

    private fun startDownload(check: Updater.Check.Available) {
        if (!packageManager.canRequestPackageInstalls()) {
            waitingForInstallAccess = true
            show(
                getString(R.string.update_need_install_access),
                primaryLabel = R.string.update_button_settings, onPrimary = ::openInstallAccessSettings,
                secondaryLabel = R.string.update_button_cancel, onSecondary = ::finish,
            )
            return
        }
        if (!Updater.inFlight.compareAndSet(false, true)) {
            show(getString(R.string.update_busy), primaryLabel = closeButton(), onPrimary = ::finish)
            return
        }
        show(getString(R.string.update_downloading, 0), progressPercent = 0)
        val updater = Updater(this)
        Thread {
            var lastPercent = -1
            val result = runCatching {
                val apk = updater.download(check.release, check.manifest) { done, total ->
                    val percent = if (total > 0) ((done * 100) / total).toInt().coerceIn(0, 100) else 0
                    if (percent != lastPercent) {
                        lastPercent = percent
                        onUi { show(getString(R.string.update_downloading, percent), progressPercent = percent) }
                    }
                }
                onUi { show(getString(R.string.update_installing), progressPercent = -1) }
                updater.install(apk)
            }
            Updater.inFlight.set(false)
            onUi {
                result.fold(
                    onSuccess = { show(getString(R.string.update_waiting_confirm), progressPercent = -1) },
                    onFailure = { showError(it, retry = { startDownload(check) }) },
                )
            }
        }.start()
    }

    private fun openInstallAccessSettings() {
        try {
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:$packageName".toUri()))
        } catch (e: Exception) {
            Log.w(TAG, "update: no unknown-sources settings screen (${e.javaClass.simpleName})")
            show(getString(R.string.update_need_install_access_manual), primaryLabel = closeButton(), onPrimary = ::finish)
        }
    }

    /** Result of the install session (see [Updater.install]). */
    private fun handleStatus(intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, Updater.NO_SESSION)
        val active = Updater.activeSessionId.get()
        if (active != Updater.NO_SESSION && sessionId != active) {
            // A late result of a session that a newer flow replaced: not this screen's business.
            Log.i(TAG, "update: ignoring status of a replaced session")
            if (intent === this.intent && available == null) finish()
            return
        }
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) Updater.activeSessionId.compareAndSet(sessionId, Updater.NO_SESSION)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = confirmIntent(intent)
                if (confirm == null) {
                    show(getString(R.string.update_failed_install, status), primaryLabel = closeButton(), onPrimary = ::finish)
                    return
                }
                show(getString(R.string.update_waiting_confirm), progressPercent = -1)
                try {
                    startActivity(confirm)
                } catch (e: Exception) {
                    Log.w(TAG, "update: confirmation could not be shown (${e.javaClass.simpleName})")
                    show(getString(R.string.update_failed_install, status), primaryLabel = closeButton(), onPrimary = ::finish)
                }
            }
            PackageInstaller.STATUS_SUCCESS ->
                show(getString(R.string.update_done), primaryLabel = closeButton(), onPrimary = ::finish)
            PackageInstaller.STATUS_FAILURE_ABORTED ->
                show(getString(R.string.update_aborted), primaryLabel = closeButton(), onPrimary = ::finish)
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                show(getString(R.string.update_failed_conflict), primaryLabel = closeButton(), onPrimary = ::finish)
            PackageInstaller.STATUS_FAILURE_STORAGE ->
                show(getString(R.string.update_failed_storage), primaryLabel = closeButton(), onPrimary = ::finish)
            else -> {
                Log.w(TAG, "update: install status=$status")
                show(getString(R.string.update_failed_install, status), primaryLabel = closeButton(), onPrimary = ::finish)
            }
        }
    }

    /**
     * The installer's confirmation screen. Launched only if it resolves to a system app (the
     * package installer), without any URI grant flags: the extra is never trusted blindly.
     */
    private fun confirmIntent(intent: Intent): Intent? {
        val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        } ?: return null
        confirm.removeFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        val target = confirm.resolveActivity(packageManager) ?: return null
        val info = try {
            packageManager.getApplicationInfo(target.packageName, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            return null
        }
        return if (info.flags and ApplicationInfo.FLAG_SYSTEM != 0) confirm else null
    }

    private fun showError(error: Throwable, retry: () -> Unit) {
        val failure = (error as? UpdateRules.UpdateException)?.failure
        Log.w(TAG, "update failed: ${failure ?: error.javaClass.simpleName}")
        val text = when (failure) {
            UpdateRules.Failure.NETWORK -> R.string.update_failed_network
            UpdateRules.Failure.NO_RELEASE -> R.string.update_failed_no_release
            UpdateRules.Failure.BAD_RELEASE -> R.string.update_failed_bad_release
            UpdateRules.Failure.BLOCKED_URL -> R.string.update_failed_blocked
            UpdateRules.Failure.TOO_LARGE -> R.string.update_failed_too_large
            UpdateRules.Failure.HASH_MISMATCH -> R.string.update_failed_hash
            UpdateRules.Failure.WRONG_PACKAGE -> R.string.update_failed_package
            UpdateRules.Failure.NOT_NEWER -> R.string.update_failed_not_newer
            UpdateRules.Failure.SIGNER_MISMATCH -> R.string.update_failed_signer
            UpdateRules.Failure.INSTALL, null -> R.string.update_failed_generic
        }
        val canRetry = failure == UpdateRules.Failure.NETWORK || failure == UpdateRules.Failure.INSTALL || failure == null
        if (canRetry) {
            show(
                getString(text),
                primaryLabel = R.string.update_button_retry, onPrimary = retry,
                secondaryLabel = closeButton(), onSecondary = ::finish,
            )
        } else {
            show(getString(text), primaryLabel = closeButton(), onPrimary = ::finish)
        }
    }

    private fun onUi(block: () -> Unit) = runOnUiThread {
        if (!isFinishing && !isDestroyed) block()
    }

    companion object {
        const val ACTION_INSTALL_STATUS = "app.shadowassistant.android.action.UPDATE_INSTALL_STATUS"
        private const val TAG = "Shadow"
    }
}
