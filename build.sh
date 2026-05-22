#!/bin/bash
set -euo pipefail

APP_NAME="Codex Bridge"
BUILD_DIR="${BUILD_DIR:-build}"
DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"
ARCHS=(${ARCHS:-arm64 x86_64})
SOURCE_FILES=(
    main.swift
    AppDelegate.swift
    ProxyManager.swift
    DashboardWindowController.swift
    CodexConfigManager.swift
)

echo "==> 编译 macOS ${DEPLOYMENT_TARGET}+ (${ARCHS[*]})..."
mkdir -p "$BUILD_DIR"
rm -f "$BUILD_DIR"/CodexBridge-*

for arch in "${ARCHS[@]}"; do
    swiftc -target "${arch}-apple-macosx${DEPLOYMENT_TARGET}" \
        -o "$BUILD_DIR/CodexBridge-$arch" \
        "${SOURCE_FILES[@]}" \
        -framework AppKit \
        -O
done

if [ "${#ARCHS[@]}" -eq 1 ]; then
    cp "$BUILD_DIR/CodexBridge-${ARCHS[0]}" "$BUILD_DIR/CodexBridge"
else
    lipo -create -output "$BUILD_DIR/CodexBridge" "${ARCHS[@]/#/$BUILD_DIR/CodexBridge-}"
fi

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

if [ "${INSTALL:-1}" = "1" ]; then
    echo "==> 安装到 /Applications..."
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "$APP_BUNDLE" "/Applications/"
    rm -rf "$HOME/Desktop/$APP_NAME.app"
    cp -R "$APP_BUNDLE" "$HOME/Desktop/"
fi

echo ""
echo "  ✅ 构建完成"
echo "     应用: $APP_BUNDLE"
if [ "${INSTALL:-1}" = "1" ]; then
    echo "     已安装: /Applications/$APP_NAME.app"
    echo "     桌面副本: $HOME/Desktop/$APP_NAME.app"
fi
