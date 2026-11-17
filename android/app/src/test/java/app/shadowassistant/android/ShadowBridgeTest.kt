package app.shadowassistant.android

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ShadowBridge needs a Handler and the audio classes (Android framework), so
 * it is not run here; this guards its shape instead.
 *
 * Regression: the constructor callbacks `notify` / `notifyItem` had the names
 * of the @JavascriptInterface methods. Inside the class `notify(t, b)` resolves
 * to the member function (a function wins over a property's `invoke`), so the
 * posted runnable called the bridge method again instead of the notifier: no
 * notification was ever shown and the main thread kept re-posting.
 */
class ShadowBridgeTest {
    private val methods = ShadowBridge::class.java.declaredMethods.filter { !it.isSynthetic }

    private val jsMethods = methods
        .filter { it.isAnnotationPresent(JavascriptInterface::class.java) }
        .map { it.name }
        .toSet()

    /**
     * `vibrate` is allowed: its callback takes a LongArray and the bridge
     * method a String?, so `vibrate(timings)` can only match the property.
     */
    private val allowed = setOf("vibrate")

    @Test
    fun `no callback field shares a name with a method`() {
        assertTrue("bridge methods found", "notify" in jsMethods && "notifyItem" in jsMethods)
        val callbacks = ShadowBridge::class.java.declaredFields
            .filter { kotlin.Function::class.java.isAssignableFrom(it.type) }
            .map { it.name }
        assertTrue("postNotify" in callbacks && "postNotifyItem" in callbacks)
        val names = methods.map { it.name }.toSet()
        assertEquals(emptySet<String>(), callbacks.filter { it in names && it !in allowed }.toSet())
    }

    @Test
    fun `the vibrate exception still holds`() {
        // The allow-list is only safe while the two signatures cannot match each other.
        val field = ShadowBridge::class.java.getDeclaredField("vibrate")
        assertEquals(Function1::class.java, field.type)
        val method = methods.single { it.name == "vibrate" }
        assertEquals(listOf(String::class.java), method.parameterTypes.toList())
    }
}
