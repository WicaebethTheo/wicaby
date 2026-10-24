import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Same key as the TV app (apps/android/keystore.properties, gitignored). Without it the release is unsigned.
val keystoreProps = Properties().apply {
    rootProject.file("keystore.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

android {
    namespace = "com.wika.wicaby.mobile"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "com.wika.wicaby"
        minSdk = libs.versions.minSdkMobile.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 38
        versionName = "0.13.0"
        // Photos spec PH-05/PH-06/PH-07: Compose tests on an emulator against the mock (tools/checks/photos-android-check.mjs).
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Cast spec CA-10. foss (the default, F-Droid): FFmpeg audio, no Google code. gplay: Google Cast through Play
    // services (GPL-3.0 §7 permission, LICENSE-EXCEPTION.md) and no FFmpeg decoder (its authors gave no such
    // permission; the server transcodes those codecs). Same applicationId and versionCode: switching keeps user data.
    flavorDimensions += "distribution"
    productFlavors {
        create("foss") {
            dimension = "distribution"
            isDefault = true
            buildConfigField("boolean", "CAST_SDK", "false")
        }
        create("gplay") {
            dimension = "distribution"
            buildConfigField("boolean", "CAST_SDK", "true")
        }
    }

    // French is the default (values), English in values-en; res/xml/locales_config.xml lists both
    // for Android 13's per-app language setting. Library translations for other languages are dropped.
    androidResources {
        localeFilters += listOf("fr", "en")
    }

    // The language can change in-app: every bundle install carries both.
    bundle {
        language { enableSplit = false }
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

    // One APK per CPU type: the embedded mesh library is ~45 MB of native code per ABI.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a")
            isUniversalApk = false
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
        disable += "UnsafeOptInUsageError"
        // French (values) and English (values-en) must stay complete.
        error += "MissingTranslation"
        checkReleaseBuilds = false
    }

    // Robolectric reads the merged resources (strings, the status icon).
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

dependencies {
    implementation(project(":core"))
    // "Accès à distance": the Tailscale/NetBird sign-in panel over core's mesh transport.
    implementation(project(":mesh-ui"))
    implementation(project(":livetv-ui"))

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material3.navigation.suite)
    implementation(libs.androidx.compose.material3.adaptive)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.activity.compose)
    // In-app language (AppCompatDelegate.setApplicationLocales), also below Android 13.
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.navigation.compose)
    // TorrentsViewModel (core) polls only while collected: collectAsStateWithLifecycle stops it in the background.
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.profileinstaller)

    implementation(libs.bundles.media3.app)
    // FFmpeg audio (GPL-3.0) in foss only; :core compiles against it and probes it at run time.
    "fossImplementation"(libs.jellyfin.media3.ffmpeg.decoder)
    // Google Cast (CastPlayer, play-services-cast-framework, mediarouter): gplay only.
    "gplayImplementation"(libs.androidx.media3.cast)

    implementation(libs.bundles.coil)
    // Reads the TV's pairing QR code from a camera photo (already in the APK through :mesh-ui).
    implementation(libs.zxing.core)
    // The mock server draws its artwork as SVG; real servers send JPEG/WebP.
    debugImplementation(libs.coil.svg)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    // Onboarding wizard and Remote access screen tests (Compose under Robolectric).
    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    // The emulator photo tests (src/androidTest): the same Compose test rule; androidx.test comes with it.
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
