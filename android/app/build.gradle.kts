import javax.inject.Inject

plugins {
    id("com.android.application")
}

/**
 * Copies the browser build of the UI (`ui/dist`, made by `npm run build` in
 * `ui/`) into the APK assets under `ui/`. The bundle is used unchanged; the
 * WebView serves it from https://appassets.androidplatform.net/assets/ui/.
 */
abstract class CopyUiBundle : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val uiDist: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        val src = uiDist.get().asFile
        if (!src.resolve("index.html").isFile) {
            throw GradleException(
                "UI bundle not found at ${src.path}. Build it first: cd ui && npm ci && npm run build",
            )
        }
        fs.sync {
            from(src) { into("ui") }
            into(outputDir)
        }
    }
}

val copyUiBundle = tasks.register<CopyUiBundle>("copyUiBundle") {
    uiDist.set(rootProject.layout.projectDirectory.dir("../ui/dist"))
}

/**
 * docs/12 D2 / T21.3.3: the app reaches the Core (`wss://`) and the wake
 * endpoint (`https://`) only over TLS; a released APK allows no cleartext.
 * For local development a build may add one plain-text host per endpoint:
 *
 * - `shadowCoreHost` (Gradle property, `-P…` or `~/.gradle/gradle.properties`)
 *   or the environment variable SHADOW_CORE_HOST: the Core's host for `ws://`.
 * - `shadowWakeHost` / SHADOW_WAKE_HOST: wake-svc's host for `http://`.
 *
 * Both default to empty (no cleartext at all); no address lives in this public
 * repository and CI sets neither. An IPv4 address or a plain DNS name only (it
 * goes into XML and Kotlin source, so nothing else is let through).
 */
fun cleartextHost(property: String, env: String): String = (
    providers.gradleProperty(property).orNull
        ?: providers.environmentVariable(env).orNull
    )?.trim().orEmpty().also { host ->
    val ipv4 = Regex("""^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$""")
    val dnsName = Regex("""^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$""")
    val numeric = host.all { it.isDigit() || it == '.' }
    if (host.isNotEmpty() && !(if (numeric) ipv4.matches(host) else dnsName.matches(host))) {
        throw GradleException("$property / $env must be an IPv4 address or a DNS name")
    }
}

val shadowCoreHost: String = cleartextHost("shadowCoreHost", "SHADOW_CORE_HOST")
val shadowWakeHost: String = cleartextHost("shadowWakeHost", "SHADOW_WAKE_HOST")

/**
 * Writes res/xml/network_security_config.xml from the template in
 * src/main/nsc/, replacing the `<!-- CLEARTEXT_HOSTS -->` marker with a
 * cleartext `<domain-config>` for the build's development hosts, or dropping
 * it when there are none (a `<domain-config>` needs at least one `<domain>`).
 * The output is a generated resource folder of every variant; the unit tests
 * read it back.
 */
abstract class GenerateNetworkSecurityConfig : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val template: RegularFileProperty

    @get:Input
    abstract val coreHost: Property<String>

    @get:Input
    abstract val wakeHost: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val text = template.get().asFile.readText()
        val marker = "<!-- CLEARTEXT_HOSTS -->"
        if (text.split(marker).size != 2) throw GradleException("NSC template must contain $marker exactly once")
        val hosts = listOf(coreHost.get(), wakeHost.get()).filter { it.isNotEmpty() }.distinctBy { it.lowercase() }
        val entry = if (hosts.isEmpty()) {
            ""
        } else {
            hosts.joinToString(
                separator = "\n",
                prefix = "<domain-config cleartextTrafficPermitted=\"true\">\n",
                postfix = "\n    </domain-config>",
            ) { "        <domain includeSubdomains=\"false\">$it</domain>" }
        }
        val out = outputDir.get().asFile.resolve("xml")
        out.deleteRecursively()
        out.mkdirs()
        out.resolve("network_security_config.xml").writeText(text.replace(marker, entry))
    }
}

/**
 * One NSC per build type: debug gets the development hosts (if any), release
 * never does, whatever properties the build machine has set, so a release APK
 * can never allow cleartext. [nscFor] picks the task of a build type.
 */
val generateNetworkSecurityConfigDebug = tasks.register<GenerateNetworkSecurityConfig>("generateNetworkSecurityConfigDebug") {
    template.set(layout.projectDirectory.file("src/main/nsc/network_security_config.xml"))
    coreHost.set(shadowCoreHost)
    wakeHost.set(shadowWakeHost)
}

val generateNetworkSecurityConfigRelease = tasks.register<GenerateNetworkSecurityConfig>("generateNetworkSecurityConfigRelease") {
    template.set(layout.projectDirectory.file("src/main/nsc/network_security_config.xml"))
    coreHost.set("")
    wakeHost.set("")
}

fun nscFor(buildType: String?) =
    if (buildType == "release") generateNetworkSecurityConfigRelease else generateNetworkSecurityConfigDebug

/** Tells the unit tests where the generated NSC is (checked against CoreAddress/WakeAddress). */
class GeneratedNscArgument(@get:Internal val dir: Provider<Directory>) : CommandLineArgumentProvider {
    override fun asArguments() = listOf("-Dshadow.generatedNscDir=${dir.get().asFile.absolutePath}")
}

// Release signing is configured only when the keystore is provided through the
// environment (CI decodes it from a secret at build time; see README). Nothing
// signing-related lives in the repository.
val releaseStoreFile = providers.environmentVariable("SHADOW_KEYSTORE_PATH").orNull

android {
    namespace = "app.shadowassistant.android"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "app.shadowassistant.android"
        minSdk = 29
        targetSdk = 37
        // docs/10 D1/D7: CI passes versionCode = workflow run number (the only "newer" signal
        // of the in-app updater). versionName is derived, never set separately: the one
        // source is `shadowVersionBase` ("X.Y", gradle.properties) plus the versionCode as
        // patch, e.g. 0.1.57; the release tag is "v" + versionName. Local builds: 1 / X.Y.0.
        val ciVersionCode = (findProperty("shadowVersionCode") as String?)?.let {
            it.toIntOrNull()?.takeIf { code -> code > 0 } ?: throw GradleException("shadowVersionCode must be a positive integer")
        }
        val versionBase = (findProperty("shadowVersionBase") as String?).orEmpty()
        if (!Regex("""^\d{1,6}\.\d{1,6}$""").matches(versionBase)) {
            throw GradleException("shadowVersionBase (gradle.properties) must look like X.Y")
        }
        versionCode = ciVersionCode ?: 1
        versionName = "$versionBase.${ciVersionCode ?: 0}"
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = providers.environmentVariable("SHADOW_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("SHADOW_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("SHADOW_KEY_PASSWORD").orNull
            }
        }
    }

    // Development-only cleartext hosts (see cleartextHost above): CoreAddress.CLEARTEXT_HOST and
    // WakeAddress.CLEARTEXT_HOST. Debug only, "" when not configured; release is always "" (and
    // its NSC has no cleartext host, see nscFor).
    buildTypes {
        debug {
            buildConfigField("String", "CORE_CLEARTEXT_HOST", "\"$shadowCoreHost\"")
            buildConfigField("String", "WAKE_CLEARTEXT_HOST", "\"$shadowWakeHost\"")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
            buildConfigField("String", "CORE_CLEARTEXT_HOST", "\"\"")
            buildConfigField("String", "WAKE_CLEARTEXT_HOST", "\"\"")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyUiBundle, CopyUiBundle::outputDir)
        variant.sources.res?.addGeneratedSourceDirectory(nscFor(variant.buildType), GenerateNetworkSecurityConfig::outputDir)
    }
}

tasks.withType<Test>().configureEach {
    // testReleaseUnitTest checks the release NSC against the release BuildConfig, the others debug.
    val nsc = nscFor(if (name.contains("Release")) "release" else "debug")
    // An input (not only an ordering): a changed NSC re-runs the allowlist test.
    inputs.dir(nsc.flatMap { it.outputDir })
        .withPathSensitivity(PathSensitivity.RELATIVE)
        .withPropertyName("generatedNsc")
    jvmArgumentProviders.add(GeneratedNscArgument(nsc.flatMap { it.outputDir }))
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.webkit:webkit:1.18.0")
    // One-off, network-constrained job that forwards the Buds case battery to the Core (T11).
    implementation("androidx.work:work-runtime-ktx:2.12.0")

    testImplementation("junit:junit:4.13.2")
    // Real org.json for JVM unit tests (android.jar only has stubs).
    testImplementation("org.json:json:20260814")
}
