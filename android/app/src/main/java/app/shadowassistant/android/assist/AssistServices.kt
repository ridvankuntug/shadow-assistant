package app.shadowassistant.android.assist

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.RemoteException
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import app.shadowassistant.android.MainActivity

/**
 * Makes Shadow selectable as the default digital assistant (Settings → Apps →
 * Default apps → Digital assistant app). The system then starts a session on
 * the assist gesture (power/side key long press where the device maps it to
 * the assistant, home long press, corner swipe); the session just opens
 * [MainActivity]. No hotword: nothing listens in the background.
 */
class ShadowVoiceInteractionService : VoiceInteractionService()

class ShadowSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = ShadowSession(this)
}

class ShadowSession(context: Context) : VoiceInteractionSession(context) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_FROM_ASSIST, true)
        if (Build.VERSION.SDK_INT >= 34) {
            startAssistantActivity(intent, Bundle())
        } else {
            @Suppress("DEPRECATION")
            startAssistantActivity(intent)
        }
        hide() // no overlay UI of our own; the app is the UI
    }

    companion object {
        const val EXTRA_FROM_ASSIST = "app.shadowassistant.android.FROM_ASSIST"
    }
}

/**
 * A voice interaction service must name a recognition service. Shadow does not
 * offer speech recognition to other apps (speech-to-text runs on the Core), so
 * every request is refused.
 */
class ShadowRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
        try {
            listener?.error(SpeechRecognizer.ERROR_CLIENT)
        } catch (_: RemoteException) {
            // caller went away
        }
    }

    override fun onCancel(listener: Callback?) = Unit

    override fun onStopListening(listener: Callback?) = Unit
}
