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
cp proxy.mjs "$APP_BUNDLE/Contents/Resources/"
cp env.example "$APP_BUNDLE/Contents/Resources/"
cp package.json "$APP_BUNDLE/Contents/Resources/"
if [ -d AppIcon.iconset ]; then
    iconutil -c icns AppIcon.iconset \
        -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns" 2>/dev/null || true
fi

echo "==> 签名..."
codesign -s - -f --deep "$APP_BUNDLE" 2>/dev/null || true

echo "==> 安装到 /Applications..."
rm -rf "/Applications/$APP_NAME.app"
cp -R "$APP_BUNDLE" "/Applications/"
cp -R "$APP_BUNDLE" "$HOME/Desktop/"

echo ""
echo "  ✅ 安装完成"
echo "     应用: $HOME/Desktop/$APP_NAME.app"
