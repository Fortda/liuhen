plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.omnitrace.android"
    compileSdk = 34

    val omniVersion = (findProperty("omniVersion") as String?)?.trim().orEmpty()
        .ifEmpty { "0.1.4" }
    val omniVersionCode = (findProperty("omniVersionCode") as String?)?.toIntOrNull()
        ?: 14

    defaultConfig {
        applicationId = "com.omnitrace.android"
        minSdk = 26
        targetSdk = 34
        versionCode = omniVersionCode
        versionName = omniVersion
    }

    // No Play upload keystore. Sideload uses the machine debug keystore so
    // phones will install it; say so in the Release notes. A real store
    // file can be injected with OMNI_ANDROID_STORE_FILE (+ password/alias).
    signingConfigs {
        create("sideload") {
            val envStore = System.getenv("OMNI_ANDROID_STORE_FILE")
            val store = if (!envStore.isNullOrBlank()) {
                file(envStore)
            } else {
                file("${System.getProperty("user.home")}/.android/debug.keystore")
            }
            storeFile = store
            storePassword = System.getenv("OMNI_ANDROID_STORE_PASSWORD") ?: "android"
            keyAlias = System.getenv("OMNI_ANDROID_KEY_ALIAS") ?: "androiddebugkey"
            keyPassword = System.getenv("OMNI_ANDROID_KEY_PASSWORD") ?: "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.documentfile:documentfile:1.0.1")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
