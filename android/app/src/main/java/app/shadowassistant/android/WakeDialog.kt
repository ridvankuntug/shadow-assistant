package app.shadowassistant.android

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * "Uyandırma ayarı" (docs/12 D2): wake endpoint address and token. The token
 * field is a password field that is never filled in: the stored token is never
 * shown back; leaving it empty keeps it.
 */
class WakeDialog(
    private val activity: Activity,
    private val store: WakeStore,
) {
    private var dialog: AlertDialog? = null

    /** [onSaved] runs after a successful save (the first press then sends the wake right away). */
    fun show(onSaved: () -> Unit = {}) {
        dismiss()
        val hasToken = store.hasToken()
        val hasAnything = hasToken || store.address() != null
        val pad = (20 * activity.resources.displayMetrics.density).toInt()
        val message = TextView(activity).apply {
            text = activity.getString(R.string.wake_dialog_message)
        }
        val address = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = activity.getString(R.string.wake_dialog_address_hint)
            setText(store.address() ?: WakeAddress.defaultUrl())
            isSingleLine = true
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val token = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            hint = activity.getString(if (hasToken) R.string.wake_dialog_token_keep_hint else R.string.wake_dialog_token_hint)
            isSingleLine = true
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(message)
            addView(address)
            addView(token)
        }
        val builder = AlertDialog.Builder(activity, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(R.string.wake_dialog_title)
            .setView(content)
            .setPositiveButton(R.string.wake_dialog_save, null) // replaced below: stays open on errors
            .setNegativeButton(R.string.wake_dialog_cancel, null)
        if (hasAnything) builder.setNeutralButton(R.string.wake_dialog_delete) { _, _ -> store.clear() }
        val d = builder.create()
        d.setOnShowListener {
            d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                save(d, address, token, hasToken, onSaved)
            }
        }
        d.setOnDismissListener { if (dialog === d) dialog = null }
        dialog = d
        d.show()
    }

    private fun save(d: AlertDialog, address: EditText, token: EditText, hasToken: Boolean, onSaved: () -> Unit) {
        address.error = null
        token.error = null
        when (val r = WakeSettingsForm.validate(address.text?.toString(), token.text?.toString(), hasToken)) {
            is WakeSettingsForm.Result.Invalid -> when (r.problem) {
                WakeSettingsForm.Problem.ADDRESS_INVALID -> address.error = activity.getString(R.string.wake_dialog_address_invalid)
                WakeSettingsForm.Problem.ADDRESS_CLEARTEXT ->
                    address.error = activity.getString(R.string.wake_dialog_address_cleartext, WakeAddress.CLEARTEXT_HOST)
                WakeSettingsForm.Problem.ADDRESS_NO_CLEARTEXT_HOST -> address.error = activity.getString(R.string.wake_dialog_address_no_cleartext)
                WakeSettingsForm.Problem.TOKEN_MISSING -> token.error = activity.getString(R.string.wake_dialog_token_missing)
                WakeSettingsForm.Problem.TOKEN_INVALID -> token.error = activity.getString(R.string.wake_dialog_token_invalid)
            }
            is WakeSettingsForm.Result.Ok -> {
                if (!store.save(r.address, r.token)) {
                    token.error = activity.getString(R.string.wake_dialog_save_failed)
                    return
                }
                token.text?.clear()
                d.dismiss()
                onSaved()
            }
        }
    }

    fun dismiss() {
        dialog?.dismiss()
        dialog = null
    }
}
