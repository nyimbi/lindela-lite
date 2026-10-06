// No plugins applied here on purpose. The app module declares its own, so the
// build has one place where a version is written rather than two that can
// disagree — which is the ordinary way a build stops being reproducible.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
