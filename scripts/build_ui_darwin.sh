#!/bin/sh

VOL_NAME=${VOL_NAME:-"Ollama"}
export VERSION=${VERSION:-$(git describe --tags --first-parent --abbrev=7 --long --dirty --always | sed -e "s/^v//g")}

set -e

_build_macapp() {
    if ! command -v npm &> /dev/null; then
        echo "npm is not installed. Please install Node.js and npm first:"
        echo "   Visit: https://nodejs.org/"
        exit 1
    fi

    if ! command -v tsc &> /dev/null; then
        echo "Installing TypeScript compiler..."
        npm install -g typescript
    fi

    echo "Installing required Go tools..."

    cd app/ui/app
    npm install
    npm run build
    cd ../../..

    # Build the Ollama.app bundle
    rm -rf dist/Ollama.app
    cp -a ./app/darwin/Ollama.app dist/Ollama.app

    # update the modified date of the app bundle to now
    touch dist/Ollama.app

    go clean -cache
    GOARCH=amd64 CGO_ENABLED=1 GOOS=darwin go build -o dist/darwin-app-amd64 -ldflags="-s -w -X=github.com/ollama/ollama/app/version.Version=${VERSION}" ./app/cmd/app
    GOARCH=arm64 CGO_ENABLED=1 GOOS=darwin go build -o dist/darwin-app-arm64 -ldflags="-s -w -X=github.com/ollama/ollama/app/version.Version=${VERSION}" ./app/cmd/app
    mkdir -p dist/Ollama.app/Contents/MacOS
    lipo -create -output dist/Ollama.app/Contents/MacOS/Ollama dist/darwin-app-amd64 dist/darwin-app-arm64
    rm -f dist/darwin-app-amd64 dist/darwin-app-arm64

    # Create a mock Squirrel.framework bundle
    mkdir -p dist/Ollama.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/
    cp -a dist/Ollama.app/Contents/MacOS/Ollama dist/Ollama.app/Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel
    ln -s ../Squirrel dist/Ollama.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt
    cp -a ./app/cmd/squirrel/Info.plist dist/Ollama.app/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/Info.plist
    ln -s A dist/Ollama.app/Contents/Frameworks/Squirrel.framework/Versions/Current
    ln -s Versions/Current/Resources dist/Ollama.app/Contents/Frameworks/Squirrel.framework/Resources
    ln -s Versions/Current/Squirrel dist/Ollama.app/Contents/Frameworks/Squirrel.framework/Squirrel

    # Update the version in the Info.plist
    plutil -replace CFBundleShortVersionString -string "$VERSION" dist/Ollama.app/Contents/Info.plist
    plutil -replace CFBundleVersion -string "$VERSION" dist/Ollama.app/Contents/Info.plist

    # Setup the ollama binaries
    mkdir -p dist/Ollama.app/Contents/Resources
    if [ -d dist/darwin-amd64 ]; then
        lipo -create -output dist/Ollama.app/Contents/Resources/ollama dist/darwin-amd64/ollama dist/darwin-arm64/ollama

        cp dist/darwin-arm64/lib/ollama/*.so dist/Ollama.app/Contents/Resources/ 2>/dev/null || true
        cp dist/darwin-amd64/lib/ollama/*.so dist/Ollama.app/Contents/Resources/ 2>/dev/null || true
        for F in dist/darwin-amd64/lib/ollama/*.dylib; do
            [ -f "$F" ] && [ ! -L "$F" ] || continue
            BASE=$(basename "$F")
            case "$BASE" in libmlx*) continue ;; esac
            if [ -f "dist/darwin-arm64/lib/ollama/$BASE" ]; then
                lipo -create -output "dist/Ollama.app/Contents/Resources/$BASE" "$F" "dist/darwin-arm64/lib/ollama/$BASE"
            else
                cp "$F" dist/Ollama.app/Contents/Resources/
            fi
        done
        (cd dist/Ollama.app/Contents/Resources && ln -sf libggml-base.0.0.0.dylib libggml-base.0.dylib && ln -sf libggml-base.0.dylib libggml-base.dylib) 2>/dev/null || true

        for VARIANT in dist/darwin-arm64/lib/ollama/mlx_metal_v*/; do
            [ -d "$VARIANT" ] || continue
            VNAME=$(basename "$VARIANT")
            DEST=dist/Ollama.app/Contents/Resources/$VNAME
            mkdir -p "$DEST"
            if [ "$VNAME" = "mlx_metal_v3" ]; then
                for LIB in libmlx.dylib libmlxc.dylib; do
                    if [ -f "dist/darwin-amd64/lib/ollama/$LIB" ] && [ -f "$VARIANT$LIB" ]; then
                        lipo -create -output "$DEST/$LIB" "dist/darwin-amd64/lib/ollama/$LIB" "$VARIANT$LIB"
                    elif [ -f "$VARIANT$LIB" ]; then
                        cp "$VARIANT$LIB" "$DEST/"
                    fi
                done
                for F in "$VARIANT"*; do
                    case "$(basename "$F")" in libmlx.dylib|libmlxc.dylib) continue ;; esac
                    [ -f "$F" ] && [ ! -L "$F" ] || continue
                    cp "$F" "$DEST/"
                done
            else
                for F in "$VARIANT"*; do
                    [ -f "$F" ] && [ ! -L "$F" ] || continue
                    cp "$F" "$DEST/"
                done
            fi
        done
    else
        cp -a dist/darwin/ollama dist/Ollama.app/Contents/Resources/ollama
        for VARIANT in dist/darwin-arm64/lib/ollama/mlx_metal_v*/; do
            [ -d "$VARIANT" ] || continue
            VNAME=$(basename "$VARIANT")
            mkdir -p dist/Ollama.app/Contents/Resources/$VNAME
            cp "$VARIANT"* dist/Ollama.app/Contents/Resources/$VNAME/ 2>/dev/null || true
        done
        cp dist/darwin-arm64/lib/ollama/*.so dist/Ollama.app/Contents/Resources/ 2>/dev/null || true
        for F in dist/darwin-arm64/lib/ollama/*.dylib; do
            [ -f "$F" ] && [ ! -L "$F" ] || continue
            cp "$F" dist/Ollama.app/Contents/Resources/
        done
        (cd dist/Ollama.app/Contents/Resources && ln -sf libggml-base.0.0.0.dylib libggml-base.0.dylib && ln -sf libggml-base.0.dylib libggml-base.dylib) 2>/dev/null || true
    fi
    chmod a+x dist/Ollama.app/Contents/Resources/ollama

    # Sign
    if [ -n "$APPLE_IDENTITY" ]; then
        codesign -f --timestamp -s "$APPLE_IDENTITY" --identifier ai.ollama.ollama --options=runtime dist/Ollama.app/Contents/Resources/ollama
        for lib in dist/Ollama.app/Contents/Resources/*.so dist/Ollama.app/Contents/Resources/*.dylib dist/Ollama.app/Contents/Resources/*.metallib dist/Ollama.app/Contents/Resources/mlx_metal_v*/*.dylib dist/Ollama.app/Contents/Resources/mlx_metal_v*/*.metallib dist/Ollama.app/Contents/Resources/mlx_metal_v*/*.so; do
            [ -f "$lib" ] || continue
            codesign -f --timestamp -s "$APPLE_IDENTITY" --identifier ai.ollama.ollama --options=runtime "$lib"
        done
        codesign -f --timestamp -s "$APPLE_IDENTITY" --identifier com.electron.ollama --deep --options=runtime dist/Ollama.app
    fi

    rm -f dist/Ollama-darwin.zip
    ditto -c -k --norsrc --keepParent dist/Ollama.app dist/Ollama-darwin.zip
    (cd dist/Ollama.app/Contents/Resources/; tar -cf - ollama *.so *.dylib *.metallib mlx_metal_v*/ 2>/dev/null) | gzip -9vc > dist/ollama-darwin.tgz

    # Notarize and Staple
    if [ -n "$APPLE_IDENTITY" ]; then
        $(xcrun -f notarytool) submit dist/Ollama-darwin.zip --wait --timeout 20m --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
        rm -f dist/Ollama-darwin.zip
        $(xcrun -f stapler) staple dist/Ollama.app
        ditto -c -k --norsrc --keepParent dist/Ollama.app dist/Ollama-darwin.zip

        rm -f dist/Ollama.dmg

        (cd dist && ../scripts/create-dmg.sh \
            --volname "${VOL_NAME}" \
            --volicon ../app/darwin/Ollama.app/Contents/Resources/icon.icns \
            --background ../app/assets/background.png \
            --window-pos 200 120 \
            --window-size 800 400 \
            --icon-size 128 \
            --icon "Ollama.app" 200 190 \
            --hide-extension "Ollama.app" \
            --app-drop-link 600 190 \
            --text-size 12 \
            "Ollama.dmg" \
            "Ollama.app" \
        ; )
        rm -f dist/rw*.dmg

        codesign -f --timestamp -s "$APPLE_IDENTITY" --identifier ai.ollama.ollama --options=runtime dist/Ollama.dmg
        $(xcrun -f notarytool) submit dist/Ollama.dmg --wait --timeout 20m --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
        $(xcrun -f stapler) staple dist/Ollama.dmg
    else
        echo "WARNING: Code signing disabled, this bundle will not work for upgrade testing"
    fi
}

_build_macapp
