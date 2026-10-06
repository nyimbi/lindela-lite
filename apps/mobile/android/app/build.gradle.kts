plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "lindela.mobile"
    compileSdk = 35

    defaultConfig {
        // The application id is per-flavour below; this is the shared base.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // The server this build talks to, from `-PlindelaServerUrl=…` or
        // LINDELA_SERVER_URL in the environment. A build setting rather than a
        // screen: the alternative is a host typed on a phone by somebody in a
        // hurry, and a health worker with a mistyped host files reports into the
        // void while being told they are saved.
        val serverUrl = (project.findProperty("lindelaServerUrl") as String?)
            ?: System.getenv("LINDELA_SERVER_URL")
            ?: "http://10.0.2.2:4177"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
    }

    // Two roles, one shell.
    //
    // A community health worker files reports in a village with no signal; a
    // focal point approves pre-agreed finance and reviews alerts. They need
    // different things — the worker needs the queue and a camera, the focal point
    // needs to be woken — and they must not be the same install: a handset that
    // holds the approval surface is a different risk from one that holds the
    // report, and a district counts its handsets.
    //
    // Flavours rather than two modules because the shell is one shell. What
    // differs is the id, the surface it opens, and the label on the home screen —
    // and a divergence in any of those is a build-time value, not a fork.
    flavorDimensions += "role"
    productFlavors {
        create("chw") {
            dimension = "role"
            applicationId = "org.lindela.chw"
            resValue("string", "app_name", "Lindela CHW")
            buildConfigField("String", "SURFACE", "\"/chw/\"")
        }
        create("focalPoint") {
            dimension = "role"
            applicationId = "org.lindela.focalpoint"
            resValue("string", "app_name", "Lindela Focal Point")
            buildConfigField("String", "SURFACE", "\"/focal-point/\"")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Debug signing so `assembleRelease` produces an installable artifact
            // on a build machine with no keystore. Replace with a real signing
            // config before anything reaches a district: a debug-signed build on a
            // shared handset is a build anybody can republish.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    // WorkManager is the Android counterpart of BGTaskScheduler: the OS decides
    // when to run the drain, and reschedules it after a reboot or an app update
    // without the app asking. The queue's in-page 30-second poll stays as the
    // fast path; this is the one that works with the app closed.
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
