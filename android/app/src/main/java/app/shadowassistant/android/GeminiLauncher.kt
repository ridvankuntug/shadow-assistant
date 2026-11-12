package app.shadowassistant.android

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.net.toUri

/**
 * Hands the user over to Google's Gemini from Shadow's top bar (T15).
 *
 * The target is fixed here: the page can only ask whether there is one
 * ([available]) and open it ([open]); it never passes an intent, a package or
 * a URL across the bridge.
 *
 * Order ([Gemini.targets]): the Gemini app's launcher activity; without it
 * gemini.google.com in the browser (a working fallback, and the Gemini app
 * claims that address as an app link once installed). Deliberately never
 * `ACTION_ASSIST` / `ACTION_VOICE_COMMAND`: with Shadow as the default digital
 * assistant `ACTION_ASSIST` resolves to Shadow itself (MainActivity has that
 * filter), a loop; which app answers `ACTION_VOICE_COMMAND` depends on the
 * device and is not necessarily Gemini.
 *
 * Package visibility (Android 11+): the manifest's `<queries>` lists the
 * Gemini package and https browsing, so both checks see their target.
 */
class GeminiLauncher(private val context: Context) {
    private fun appIntent(): Intent? = context.packageManager.getLaunchIntentForPackage(Gemini.PACKAGE)

    private fun webIntent(): Intent =
        Intent(Intent.ACTION_VIEW, Gemini.WEB_URL.toUri()).addCategory(Intent.CATEGORY_BROWSABLE)

    private fun intentFor(target: Gemini.Target): Intent? = when (target) {
        Gemini.Target.APP -> appIntent()
        Gemini.Target.WEB -> webIntent()
    }

    private fun targets(): List<Gemini.Target> = Gemini.targets(
        appLaunchable = appIntent() != null,
        webResolvable = webIntent().resolveActivity(context.packageManager) != null,
    )

    /** Whether the Gemini button makes sense on this device (safe off the main thread). */
    fun available(): Boolean = targets().isNotEmpty()

    /** Opens the first target that starts; false when none did. Call on the main thread. */
    fun open(): Boolean {
        for (target in targets()) {
            val intent = intentFor(target) ?: continue
            try {
                context.startActivity(intent)
                return true
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "Gemini target $target did not start", e)
            } catch (e: SecurityException) {
                Log.w(TAG, "Gemini target $target refused", e)
            }
        }
        return false
    }

    private companion object {
        const val TAG = "Shadow"
    }
}

/** The fixed Gemini targets and their order (pure, unit-tested). */
object Gemini {
    const val PACKAGE = "com.google.android.apps.bard"
    const val WEB_URL = "https://gemini.google.com/app"

    enum class Target { APP, WEB }

    /** The app first, then the web page; empty when neither can be opened. */
    fun targets(appLaunchable: Boolean, webResolvable: Boolean): List<Target> = buildList {
        if (appLaunchable) add(Target.APP)
        if (webResolvable) add(Target.WEB)
    }
}
