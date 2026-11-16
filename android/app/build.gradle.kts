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
 * docs/12 D2: the wake endpoint (wake-svc on the always-on box) is plain HTTP
 * on the LAN like the Core, so its host needs a cleartext entry in the network
 * security config. The address must not be committed to this public repository,
 * so it comes from the build: Gradle property `shadowWakeHost` (`-P…`,
 * `~/.gradle/gradle.properties`) or the environment variable SHADOW_WAKE_HOST
 * (CI). Unset means no cleartext wake host: the app then accepts only an
 * `https://` wake address. An IPv4 address or a plain DNS name only (it goes
 * into XML and Kotlin source, so nothing else is let through).
 */
val shadowWakeHost: String = (
    providers.gradleProperty("shadowWakeHost").orNull
        ?: providers.environmentVariable("SHADOW_WAKE_HOST").orNull
    )?.trim().orEmpty().also { host ->
    val ipv4 = Regex("""^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$""")
    val dnsName = Regex("""^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$""")
    val numeric = host.all { it.isDigit() || it == '.' }
    if (host.isNotEmpty() && !(if (numeric) ipv4.matches(host) else dnsName.matches(host))) {
        throw GradleException("shadowWakeHost / SHADOW_WAKE_HOST must be an IPv4 address or a DNS name")
    }
}

/**
 * Writes res/xml/network_security_config.xml from the template in
 * src/main/nsc/, replacing the `<!-- WAKE_HOST -->` marker with the wake host's
 * `<domain>` (or dropping it when there is none). The output is a generated
 * resource folder of every variant; the unit tests read it back.
 */
abstract class GenerateNetworkSecurityConfig : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val template: RegularFileProperty

    @get:Input
    abstract val wakeHost: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val text = template.get().asFile.readText()
        val marker = "<!-- WAKE_HOST -->"
        if (text.split(marker).size != 2) throw GradleException("NSC template must contain $marker exactly once")
        val host = wakeHost.get()
        val entry = if (host.isEmpty()) "" else """<domain includeSubdomains="false">$host</domain>"""
        val out = outputDir.get().asFile.resolve("xml")
        out.deleteRecursively()
        out.mkdirs()
        out.resolve("network_security_config.xml").writeText(text.replace(marker, entry))
    }
}

val generateNetworkSecurityConfig = tasks.register<GenerateNetworkSecurityConfig>("generateNetworkSecurityConfig") {
    template.set(layout.projectDirectory.file("src/main/nsc/network_security_config.xml"))
    wakeHost.set(shadowWakeHost)
}

/** Tells the unit tests where the generated NSC is (checked against Core/WakeAddress). */
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
        // docs/12 D2: WakeAddress.CLEARTEXT_HOST; "" when no wake host is configured (see shadowWakeHost).
        buildConfigField("String", "WAKE_CLEARTEXT_HOST", "\"$shadowWakeHost\"")
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

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
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
        variant.sources.res?.addGeneratedSourceDirectory(generateNetworkSecurityConfig, GenerateNetworkSecurityConfig::outputDir)
    }
}

tasks.withType<Test>().configureEach {
    // An input (not only an ordering): a changed NSC re-runs the allowlist test.
    inputs.dir(generateNetworkSecurityConfig.flatMap { it.outputDir })
        .withPathSensitivity(PathSensitivity.RELATIVE)
        .withPropertyName("generatedNsc")
    jvmArgumentProviders.add(GeneratedNscArgument(generateNetworkSecurityConfig.flatMap { it.outputDir }))
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
