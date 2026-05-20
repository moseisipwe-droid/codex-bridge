#!/bin/bash
set -e

APP_NAME="Codex Bridge"
BUILD_DIR="build"

echo "==> 编译..."
mkdir -p "$BUILD_DIR"
swiftc -o "$BUILD_DIR/CodexBridge" \
    main.swift AppDelegate.swift ProxyManager.swift DashboardWindowController.swift \
    -framework AppKit \
    -O

echo "==> 创建 .app..."
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"
cp "$BUILD_DIR/CodexBridge" "$APP_BUNDLE/Contents/MacOS/"
cp Info.plist "$APP_BUNDLE/Contents/"
if [ -d AppIcon.iconset ]; then
    iconutil -c icns AppIcon.iconset \
        -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns" 2>/dev/null || true
fi

echo "==> 安装到 /Applications..."
rm -rf "/Applications/$APP_NAME.app"
cp -R "$APP_BUNDLE" "/Applications/"
rm -rf "/Users/mac/Desktop/$APP_NAME.app"
cp -R "$APP_BUNDLE" "/Users/mac/Desktop/"

echo ""
echo "  ✅ 安装完成"
