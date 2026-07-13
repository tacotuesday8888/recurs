# Signed native bundle layout

The release packager installs one outer signed launcher bundle and one nested,
independently signed broker bundle:

```text
RecursLauncher.app/
  Contents/MacOS/recurs-native-launcher
  Contents/Library/LaunchAgents/com.recurs.cli.broker.plist
  Contents/Helpers/RecursBroker.app/
    Contents/Info.plist
    Contents/MacOS/recurs-native-broker
```

`BundleProgram` is relative to the outer app bundle. The nested bundle is
required so `Bundle.main` and the sealed broker Info.plist identify the broker
executable itself during code-signature validation. Package and sign the nested
broker first, then sign the outer launcher. Release packaging must expand the
team and application-identifier-prefix build settings in the Info and
entitlements plists; unresolved placeholders fail closed.
