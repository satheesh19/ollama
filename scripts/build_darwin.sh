#!/bin/sh

# Note: 
#  While testing, if you double-click on the Ollama.app 
#  some state is left on MacOS and subsequent attempts
#  to build again will fail with:
#
#    hdiutil: create failed - Operation not permitted
#
#  To work around, specify another volume name with:
#
#    VOL_NAME="$(date)" ./scripts/build_darwin.sh
#
VOL_NAME=${VOL_NAME:-"Ollama"}
export VERSION=${VERSION:-$(git describe --tags --first-parent --abbrev=7 --long --dirty --always | sed -e "s/^v//g")}
export GOFLAGS="'-ldflags=-w -s \"-X=github.com/ollama/ollama/version.Version=${VERSION#v}\" \"-X=github.com/ollama/ollama/server.mode=release\"'"
export CGO_CFLAGS="-O3 -mmacosx-version-min=14.0"
export CGO_CXXFLAGS="-O3 -mmacosx-version-min=14.0"
export CGO_LDFLAGS="-mmacosx-version-min=14.0"

set -e

status() { echo >&2 ">>> $@"; }
usage() {
    echo "usage: $(basename $0) [build app [sign]]"
    exit 1
}

mkdir -p dist

# Work around MLX's v3 metallib link leaking the macOS 26 deployment target.
_relink_mlx_metallib() {
    BUILD_DIR="$1"
    KERNEL_DIR="$BUILD_DIR/_deps/mlx-build/mlx/backend/metal/kernels"
    AIR_LIST="$BUILD_DIR/mlx-air-files.txt"
    METALLIB="$KERNEL_DIR/mlx.metallib"

    find "$KERNEL_DIR" -type f -name '*.air' | sort > "$AIR_LIST"
    if [ ! -s "$AIR_LIST" ]; then
        echo "error: could not find MLX AIR files in $KERNEL_DIR" >&2
        exit 1
    fi

    status "Relinking MLX metallib"
    rm -f "$METALLIB"
    xargs xcrun -sdk macosx metallib -o "$METALLIB" < "$AIR_LIST"
}


ARCHS="arm64 amd64"
while getopts "a:h" OPTION; do
    case $OPTION in
        a) ARCHS=$OPTARG ;;
        h) usage ;;
    esac
done

shift $(( $OPTIND - 1 ))

_build_darwin() {
    for ARCH in $ARCHS; do
        status "Building darwin $ARCH"
        INSTALL_PREFIX=dist/darwin-$ARCH/        

        if [ "$ARCH" = "amd64" ]; then
            status "Building darwin $ARCH dynamic backends"
            BUILD_DIR=build/darwin-$ARCH
            cmake -B $BUILD_DIR \
                -DCMAKE_OSX_ARCHITECTURES=x86_64 \
                -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
                -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX \
                -DMLX_ENGINE=ON \
                -DMLX_ENABLE_X64_MAC=ON \
                -DOLLAMA_RUNNER_DIR=./
            cmake --build $BUILD_DIR --target ggml-cpu -j
            cmake --build $BUILD_DIR --target mlx mlxc -j
            cmake --install $BUILD_DIR --component CPU
            cmake --install $BUILD_DIR --component MLX
            cmake --install $BUILD_DIR --component MLX_VENDOR
            # Override CGO flags to point to the amd64 build directory
            MLX_CGO_CFLAGS="-O3 -mmacosx-version-min=14.0"
            MLX_CGO_LDFLAGS="-ldl -lc++ -framework Accelerate -mmacosx-version-min=14.0"
        else
            # CPU backend (ggml-cpu, installed flat to lib/ollama/)
            BUILD_DIR_CPU=build/arm64-cpu
            status "Building arm64 CPU backend"
            cmake -S . -B $BUILD_DIR_CPU \
                -DCMAKE_BUILD_TYPE=Release \
                -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
                -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX
            cmake --build $BUILD_DIR_CPU --target ggml-cpu --parallel
            cmake --install $BUILD_DIR_CPU --component CPU

            # Build MLX twice for arm64
            # Metal 3.x build (backward compatible, macOS 14+)
            BUILD_DIR=build/metal-v3
            status "Building MLX Metal v3 (macOS 14+)"
            cmake -S . -B $BUILD_DIR \
                -DCMAKE_BUILD_TYPE=Release \
                -DMLX_ENGINE=ON \
                -DOLLAMA_RUNNER_DIR=mlx_metal_v3 \
                -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 \
                -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX
            cmake --build $BUILD_DIR --target mlx mlxc --parallel
            _relink_mlx_metallib $BUILD_DIR
            cmake --install $BUILD_DIR --component MLX
            cmake --install $BUILD_DIR --component MLX_VENDOR

            # Metal 4.x build (NAX-enabled, macOS 26+)
            # Only possible with Xcode 26+ SDK; skip on older toolchains.
            SDK_MAJOR=$(xcrun --show-sdk-version 2>/dev/null | cut -d. -f1)
            if [ "${SDK_MAJOR:-0}" -ge 26 ]; then
                V3_DEPS=$BUILD_DIR/_deps
                BUILD_DIR_V4=build/metal-v4
                status "Building MLX Metal v4 (macOS 26+, NAX)"
                cmake -S . -B $BUILD_DIR_V4 \
                    -DCMAKE_BUILD_TYPE=Release \
                    -DMLX_ENGINE=ON \
                    -DOLLAMA_RUNNER_DIR=mlx_metal_v4 \
                    -DCMAKE_OSX_DEPLOYMENT_TARGET=26.0 \
                    -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX \
                    -DFETCHCONTENT_SOURCE_DIR_MLX=$V3_DEPS/mlx-src \
                    -DFETCHCONTENT_SOURCE_DIR_MLX-C=$V3_DEPS/mlx-c-src \
                    -DFETCHCONTENT_SOURCE_DIR_JSON=$V3_DEPS/json-src \
                    -DFETCHCONTENT_SOURCE_DIR_FMT=$V3_DEPS/fmt-src \
                    -DFETCHCONTENT_SOURCE_DIR_METAL_CPP=$V3_DEPS/metal_cpp-src
                cmake --build $BUILD_DIR_V4 --target mlx mlxc --parallel
                cmake --install $BUILD_DIR_V4 --component MLX
                cmake --install $BUILD_DIR_V4 --component MLX_VENDOR
            else
                status "Skipping MLX Metal v4 (SDK $SDK_MAJOR < 26, need Xcode 26+)"
            fi

            # Use the v3 build for CGO linking (compatible with both)
            MLX_CGO_CFLAGS="-O3 -mmacosx-version-min=14.0"
            MLX_CGO_LDFLAGS="-lc++ -framework Metal -framework Foundation -framework Accelerate -mmacosx-version-min=14.0"
        fi
        GOOS=darwin GOARCH=$ARCH CGO_ENABLED=1 CGO_CFLAGS="$MLX_CGO_CFLAGS" CGO_LDFLAGS="$MLX_CGO_LDFLAGS" go build -o $INSTALL_PREFIX .
        # MLX libraries stay in lib/ollama/ (flat or variant subdirs).
        # The runtime discovery in dynamic.go searches lib/ollama/ relative
        # to the executable, including mlx_* subdirectories.
    done
}

_sign_darwin() {
    status "Creating universal binary..."
    mkdir -p dist/darwin
    lipo -create -output dist/darwin/ollama dist/darwin-*/ollama
    chmod +x dist/darwin/ollama

    if [ -n "$APPLE_IDENTITY" ]; then
        for F in dist/darwin/ollama dist/darwin-*/lib/ollama/* dist/darwin-*/lib/ollama/mlx_metal_v*/*; do
            [ -f "$F" ] && [ ! -L "$F" ] || continue
            codesign -f --timestamp -s "$APPLE_IDENTITY" --identifier ai.ollama.ollama --options=runtime "$F"
        done

        # create a temporary zip for notarization
        TEMP=$(mktemp -u).zip
        ditto -c -k --keepParent dist/darwin/ollama "$TEMP"
        xcrun notarytool submit "$TEMP" --wait --timeout 20m --apple-id $APPLE_ID --password $APPLE_PASSWORD --team-id $APPLE_TEAM_ID
        rm -f "$TEMP"
    fi

    status "Creating universal tarball..."
    tar -cf dist/ollama-darwin.tar --strip-components 2 dist/darwin/ollama
    tar -rf dist/ollama-darwin.tar --strip-components 4 dist/darwin-amd64/lib/
    tar -rf dist/ollama-darwin.tar --strip-components 4 dist/darwin-arm64/lib/
    gzip -9vc <dist/ollama-darwin.tar >dist/ollama-darwin.tgz
}



if [ "$#" -eq 0 ]; then
    _build_darwin
    _sign_darwin
    exit 0
fi

for CMD in "$@"; do
    case $CMD in
        build) _build_darwin ;;
        sign) _sign_darwin ;;
        *) usage ;;
    esac
done
