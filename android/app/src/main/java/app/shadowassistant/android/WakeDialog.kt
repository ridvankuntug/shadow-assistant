package app.shadowassistant.android

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * "Adresler" (docs/12 D2, T21.3.3): the Core's home address, the wake
 * endpoint's home and away addresses, and the wake token. Every address is
 * optional (the Core's away address is the one in the UI's connect screen). The
 * token field is a password field that is never filled in: the stored token is
 * never shown back; leaving it empty keeps it. [onChanged] runs after every save
 * or delete (the shell then checks the Core again and picks the address).
 */
class WakeDialog(
    private val activity: Activity,
    private val store: WakeStore,
    private val core: BridgeStorage,
    private val onChanged: () -> Unit,
) {
    private var dialog: AlertDialog? = null

    /** [onSaved] runs after a successful save (the first press then sends the wake right away). */
    fun show(onSaved: () -> Unit = {}) {
        dismiss()
        val hasToken = store.hasToken()
        val hasAnything = hasToken || store.home() != null || store.away() != null || core.homeCoreUrl() != null
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        val message = TextView(activity).apply {
            text = activity.getString(R.string.wake_dialog_message)
        }
        val coreHome = addressField(R.string.wake_dialog_core_home_hint, core.homeCoreUrl())
        val wakeHome = addressField(R.string.wake_dialog_wake_home_hint, store.home() ?: WakeAddress.defaultUrl())
        val wakeAway = addressField(R.string.wake_dialog_address_hint, store.away())
        val token = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            hint = activity.getString(if (hasToken) R.string.wake_dialog_token_keep_hint else R.string.wake_dialog_token_hint)
            isSingleLine = true
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val fields = Fields(coreHome, wakeHome, wakeAway, token)
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(message)
            addView(coreHome)
            addView(wakeHome)
            addView(wakeAway)
            addView(token)
        }
        val builder = AlertDialog.Builder(activity, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(R.string.wake_dialog_title)
            .setView(content)
            .setPositiveButton(R.string.wake_dialog_save, null) // replaced below: stays open on errors
            .setNegativeButton(R.string.wake_dialog_cancel, null)
        if (hasAnything) {
            builder.setNeutralButton(R.string.wake_dialog_delete) { _, _ ->
                store.clear()
                core.setHomeCoreUrl(null)
                onChanged()
            }
        }
        val d = builder.create()
        d.setOnShowListener {
            d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                save(d, fields, hasToken, onSaved)
            }
        }
        d.setOnDismissListener { if (dialog === d) dialog = null }
        dialog = d
        d.show()
    }

    private class Fields(val coreHome: EditText, val wakeHome: EditText, val wakeAway: EditText, val token: EditText) {
        fun of(field: WakeSettingsForm.Field) = when (field) {
            WakeSettingsForm.Field.CORE_HOME -> coreHome
            WakeSettingsForm.Field.WAKE_HOME -> wakeHome
            WakeSettingsForm.Field.WAKE_AWAY -> wakeAway
            WakeSettingsForm.Field.TOKEN -> token
        }

        val all get() = listOf(coreHome, wakeHome, wakeAway, token)
    }

    private fun addressField(hint: Int, value: String?) = EditText(activity).apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        this.hint = activity.getString(hint)
        setText(value.orEmpty())
        isSingleLine = true
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
    }

    private fun save(d: AlertDialog, f: Fields, hasToken: Boolean, onSaved: () -> Unit) {
        f.all.forEach { it.error = null }
        val r = WakeSettingsForm.validate(
            f.coreHome.text?.toString(),
            f.wakeHome.text?.toString(),
            f.wakeAway.text?.toString(),
            f.token.text?.toString(),
            hasToken,
        )
        when (r) {
            is WakeSettingsForm.Result.Invalid -> f.of(r.field).error = activity.getString(
                when (r.problem) {
                    WakeSettingsForm.Problem.ADDRESS_INVALID ->
                        if (r.field == WakeSettingsForm.Field.CORE_HOME) R.string.wake_dialog_core_invalid else R.string.wake_dialog_address_invalid
                    WakeSettingsForm.Problem.ADDRESS_CLEARTEXT -> R.string.wake_dialog_address_cleartext
                    WakeSettingsForm.Problem.ADDRESS_MISSING -> R.string.wake_dialog_address_missing
                    WakeSettingsForm.Problem.TOKEN_MISSING -> R.string.wake_dialog_token_missing
                    WakeSettingsForm.Problem.TOKEN_INVALID -> R.string.wake_dialog_token_invalid
                },
            )
            is WakeSettingsForm.Result.Ok -> {
                val wakeSaved = if (r.wakeHome == null && r.wakeAway == null) {
                    store.clear()
                    true
                } else {
                    store.save(r.wakeHome, r.wakeAway, r.token)
                }
                if (!wakeSaved) {
                    f.token.error = activity.getString(R.string.wake_dialog_save_failed)
                    return
                }
                core.setHomeCoreUrl(r.coreHome)
                f.token.text?.clear()
                d.dismiss()
                onChanged()
                onSaved()
            }
        }
    }

    fun dismiss() {
        dialog?.dismiss()
        dialog = null
    }
}
