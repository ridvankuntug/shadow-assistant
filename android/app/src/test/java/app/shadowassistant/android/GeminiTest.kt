package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GeminiTest {
    @Test
    fun appComesBeforeTheWebPage() {
        assertEquals(listOf(Gemini.Target.APP, Gemini.Target.WEB), Gemini.targets(appLaunchable = true, webResolvable = true))
        assertEquals(listOf(Gemini.Target.APP), Gemini.targets(appLaunchable = true, webResolvable = false))
        assertEquals(listOf(Gemini.Target.WEB), Gemini.targets(appLaunchable = false, webResolvable = true))
    }

    @Test
    fun nothingToOpenMeansNoButton() {
        assertTrue(Gemini.targets(appLaunchable = false, webResolvable = false).isEmpty())
    }

    @Test
    fun targetsAreFixed() {
        assertEquals("com.google.android.apps.bard", Gemini.PACKAGE)
        assertTrue(Gemini.WEB_URL.startsWith("https://gemini.google.com/"))
    }
}
