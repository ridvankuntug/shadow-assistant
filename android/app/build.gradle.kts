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
        versionCode = (findProperty("shadowVersionCode") as String?)?.toInt() ?: 1
        versionName = "0.1.0"
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
    }
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
