import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing comes from apps/android/keystore.properties (gitignored). Without it,
// assembleRelease still builds, unsigned.
val keystoreProps = Properties().apply {
    rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

android {
    namespace = "com.wika.wicaby.tv"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.wika.wicaby.tv"
        minSdk = libs.versions.minSdkTv.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 41
        versionName = "0.13.0"
        // Photos spec PH-05/PH-06/PH-07: Compose tests on an emulator against the mock (tools/checks/photos-android-check.mjs).
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (!keystoreProps.isEmpty) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    // French is the default (values), English in values-en (as mobile): library translations for other
    // languages are dropped, so the app's own labels never mix with a third one.
    androidResources {
        localeFilters += listOf("fr", "en")
    }

    // One APK per CPU type: the embedded mesh library is ~45 MB of native code per ABI.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        // Shared rules (apps/android/lint.xml), e.g. ignore the generated local.properties.
        lintConfig = rootProject.file("lint.xml")
        // Media3 marks most of ExoPlayer's tuning API @UnstableApi; we use it on purpose.
        disable += "UnsafeOptInUsageError"
        // values/ (French, the default) and values-en/ must stay in step.
        error += "MissingTranslation"
        checkReleaseBuilds = false
    }

    testOptions.unitTests.isReturnDefaultValues = true
    // Robolectric reads the merged debug manifest (the Compose test host activity).
    testOptions.unitTests.isIncludeAndroidResources = true

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":mesh-ui"))
    implementation(project(":livetv-ui"))

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.tv.material)
    implementation(libs.androidx.activity.compose)
    // collectAsStateWithLifecycle (Torrents polling) and LocalLifecycleOwner (screensaver).
    implementation(libs.androidx.lifecycle.runtime.compose)
    // AppCompatDelegate.setApplicationLocales: the in-app language below API 33.
    implementation(libs.androidx.appcompat)

    implementation(libs.bundles.media3.app)
    // FFmpeg audio (GPL-3.0); :core only compiles against it (cast spec CA-10).
    implementation(libs.jellyfin.media3.ffmpeg.decoder)

    implementation(libs.bundles.coil)

    // Installs src/main/baseline-prof.txt on sideloads (no Play cloud profiles): the guide, the live
    // overlay and the player are AOT-compiled instead of interpreted on 32-bit TVs (spec §21.3).
    implementation(libs.androidx.profileinstaller)
    // The mock server draws its artwork as SVG; real servers send JPEG/WebP.
    debugImplementation(libs.coil.svg)

    testImplementation(libs.junit)
    // TP-10: the PIN-lock gates on the real entry points (deep links, remote play).
    testImplementation(libs.robolectric)
    // MusicTvTest (music spec MU-09): the album and its tracks served by a fake server.
    testImplementation(libs.okhttp.mockwebserver3)
    // D-pad focus rules (row edges) driven through a real Compose tree under Robolectric.
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    // The empty host activity Compose tests launch (debug manifest only; never in release builds).
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    // The emulator photo tests (src/androidTest): the same Compose test rule; androidx.test comes with it.
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
