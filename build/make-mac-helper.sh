#!/bin/sh
# Builds build/mac-helper/stagio-mac-helper (Apple silicon + Intel in one file) from
# mac/helper/main.swift. Needs a Mac with Xcode or the Command Line Tools (GitHub's Macs have them).
set -e
cd "$(dirname "$0")/.."
mkdir -p build/mac-helper
for arch in arm64 x86_64; do
  # The Info.plist goes into the binary: macOS stops a program that uses Bluetooth without saying why.
  swiftc -O -target "$arch-apple-macos12.0" -o "build/mac-helper/stagio-mac-helper-$arch" mac/helper/main.swift \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker mac/helper/Info.plist
done
lipo -create -output build/mac-helper/stagio-mac-helper build/mac-helper/stagio-mac-helper-arm64 build/mac-helper/stagio-mac-helper-x86_64
rm build/mac-helper/stagio-mac-helper-arm64 build/mac-helper/stagio-mac-helper-x86_64
codesign --force --sign - build/mac-helper/stagio-mac-helper
echo "built build/mac-helper/stagio-mac-helper"
