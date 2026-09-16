import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    // The version is supplied by org.jetbrains.intellij.platform.settings in settings.gradle.kts.
    id("org.jetbrains.intellij.platform")
}

group = "com.ymkang"
version = "0.4.7"

kotlin {
    jvmToolchain(21)
}

dependencies {
    intellijPlatform {
        // The plugin only uses IntelliJ Platform and VCS APIs, so it is not
        // coupled to Python-specific APIs. It can therefore run in PyCharm
        // as well as other compatible IntelliJ Platform IDEs.
        intellijIdeaCommunity("2025.2.6.2")
        testFramework(TestFrameworkType.Platform)
    }
}

tasks {
    test {
        useJUnit()
    }
}
