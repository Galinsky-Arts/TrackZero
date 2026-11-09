# TZ-11 Android listening slice

The draft Activity and controller expose explicit play/stop, an accessible status, fail-closed adapter absence and late-join cancellation. The controller accepts only a station ID and an injected endpoint-encrypted DAE/DRE session adapter; it has no raw media URL, track selection, seek, contribution or reward interface. A failed session close is reported as an interruption and blocks further joins because the old audio may still be active. Late session closure failure also interrupts the controller and closes any newer session.

This isolated runtime has Java 17 runtime and compiler modules, though no `javac` executable, Gradle, Android SDK or JUnit dependency. The pure Java controller and its JUnit test source compiled using `java --module jdk.compiler/com.sun.tools.javac.Main`; six test methods passed in an isolated local JUnit-compatible harness. This does not establish a Gradle/JUnit run or an Android build. The real DAE-09 SDK, DRE live catalog and guest stream, foreground media service, route recovery, background playback, permissions and device/battery tests remain unintegrated. PR #16 stays draft; no working listener or field evidence is claimed.

November 9 review adds a pinned Gradle application build and hosted Android
compile/lint/JUnit job. Seven real JUnit 4.13.2 controller tests pass locally
on Java 21 through its compiler module. Completion callbacks use an explicit
dispatcher; the Activity supplies its main thread, and pause stops playback.
The source still requires a host-supplied DAE/DRE encrypted endpoint adapter.
A compiled UI shell is not a working encrypted listener or device acceptance.
