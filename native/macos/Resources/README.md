# Signed native bundle layout

The release packager installs one outer signed launcher bundle with a fixed
Node runtime and self-contained engine entrypoint, plus one nested,
independently signed broker bundle:

```text
RecursLauncher.app/
  Contents/MacOS/recurs-native-launcher
  Contents/Resources/runtime/bin/node
  Contents/Resources/engine/main.js
  Contents/Library/LaunchAgents/com.recurs.cli.broker.plist
  Contents/Helpers/RecursBroker.app/
    Contents/Info.plist
    Contents/MacOS/recurs-native-broker
```

The launcher resolves only those two `Contents/Resources` files. Every path
component from the standardized bundle root through either leaf must be real
and nonsymlinked; ancestors must be directories, both leaves must be regular
files, and only the Node runtime must be executable.

`BundleProgram` is relative to the outer app bundle. The nested bundle is
required so `Bundle.main` and the sealed broker Info.plist identify the broker
executable itself during code-signature validation. Package and sign the nested
broker first, then sign the outer launcher. Release packaging must expand the
team and application-identifier-prefix build settings in the Info and
entitlements plists; unresolved placeholders fail closed.
