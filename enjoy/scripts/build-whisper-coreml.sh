#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Building whisper.cpp with Core ML support ===${NC}"

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}Error: This script must be run on macOS${NC}"
    exit 1
fi

# Check if running on Apple Silicon
if [[ $(uname -m) != "arm64" ]]; then
    echo -e "${YELLOW}Warning: This script is designed for Apple Silicon (arm64). Current architecture: $(uname -m)${NC}"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check for Xcode command line tools
if ! xcode-select -p &> /dev/null; then
    echo -e "${RED}Error: Xcode command line tools not found${NC}"
    echo "Please install with: xcode-select --install"
    exit 1
fi

# Check for CMake
if ! command -v cmake &> /dev/null; then
    echo -e "${YELLOW}CMake not found. Installing via Homebrew...${NC}"
    if ! command -v brew &> /dev/null; then
        echo -e "${RED}Error: Homebrew not found. Please install CMake manually or install Homebrew first.${NC}"
        exit 1
    fi
    brew install cmake
fi

# Set up directories
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEMP_DIR=$(mktemp -d)
WHISPER_REPO="$TEMP_DIR/whisper.cpp"
TARGET_DIR="$PROJECT_ROOT/lib/whisper.cpp/arm64/darwin"

echo -e "${GREEN}Cloning whisper.cpp repository...${NC}"
cd "$TEMP_DIR"
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp

echo -e "${GREEN}Configuring build with Core ML support...${NC}"
cmake -B build \
    -DWHISPER_COREML=1 \
    -DWHISPER_METAL=1 \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES=arm64

echo -e "${GREEN}Building whisper.cpp...${NC}"
cmake --build build --config Release -j$(sysctl -n hw.ncpu)

# Verify the binary
BUILT_BINARY="$WHISPER_REPO/build/bin/whisper-cli"
WHISPER_LIB="$WHISPER_REPO/build/src/libwhisper.dylib"
WHISPER_COREML_LIB="$WHISPER_REPO/build/src/libwhisper.coreml.dylib"

if [ ! -f "$BUILT_BINARY" ]; then
    echo -e "${RED}Error: Build failed. Binary not found at $BUILT_BINARY${NC}"
    exit 1
fi

echo -e "${GREEN}Verifying Core ML support...${NC}"

# Check if libwhisper.dylib links to libwhisper.coreml.dylib
if otool -L "$WHISPER_LIB" | grep -q "libwhisper.coreml.dylib"; then
    echo -e "${GREEN}✓ libwhisper.dylib links to libwhisper.coreml.dylib${NC}"
else
    echo -e "${RED}✗ libwhisper.dylib does NOT link to libwhisper.coreml.dylib${NC}"
    exit 1
fi

# Check if libwhisper.coreml.dylib links to CoreML.framework
if otool -L "$WHISPER_COREML_LIB" | grep -q "CoreML.framework"; then
    echo -e "${GREEN}✓ libwhisper.coreml.dylib links to CoreML.framework${NC}"
else
    echo -e "${RED}✗ CoreML.framework NOT found in libwhisper.coreml.dylib${NC}"
    exit 1
fi

if otool -L "$WHISPER_LIB" | grep -q "Metal.framework\|libggml-metal"; then
    echo -e "${GREEN}✓ Metal support detected${NC}"
else
    echo -e "${YELLOW}⚠ Metal support NOT found (this is okay but not optimal)${NC}"
fi

# Backup existing binary
if [ -f "$TARGET_DIR/main" ]; then
    BACKUP_PATH="$TARGET_DIR/main.backup.$(date +%Y%m%d_%H%M%S)"
    echo -e "${YELLOW}Backing up existing binary to: $BACKUP_PATH${NC}"
    cp "$TARGET_DIR/main" "$BACKUP_PATH"
fi

# Create lib directory for dynamic libraries if it doesn't exist
LIB_DIR="$PROJECT_ROOT/lib/whisper.cpp/arm64/darwin/lib"
mkdir -p "$LIB_DIR"

# Copy new binary
echo -e "${GREEN}Installing new binary...${NC}"
cp "$BUILT_BINARY" "$TARGET_DIR/main"
chmod +x "$TARGET_DIR/main"

# Copy all required dynamic libraries
echo -e "${GREEN}Installing Core ML libraries...${NC}"
cp "$WHISPER_LIB" "$LIB_DIR/"
cp "$WHISPER_COREML_LIB" "$LIB_DIR/"


# Copy all ggml libraries (find recursively in build directory)
echo -e "${GREEN}Installing ggml libraries...${NC}"
find "$WHISPER_REPO/build" -name "libggml*.dylib" -exec cp -R {} "$LIB_DIR/" \;

# Create versioned symlinks if missing
cd "$LIB_DIR"
for lib in *.dylib; do
    # specific fix for versioned libs if they are missing
    name=$(basename "$lib" .dylib)
    
    # If file is libfoo.dylib, create libfoo.1.dylib or libfoo.0.dylib if needed
    # Check if the binary asks for .1 or .0
    # For now, blindly create .0 and .1 for everything to be safe if they don't exist
    
    if [[ ! "$lib" =~ \.[0-9]+\.dylib$ ]] && [[ ! "$lib" =~ \.[0-9]+\.[0-9]+\.dylib$ ]]; then
        # This is a base .dylib (e.g. libwhisper.dylib)
        # Create .1.dylib
        if [ ! -f "${name}.1.dylib" ]; then
             ln -sf "$lib" "${name}.1.dylib"
        fi
        # Create .0.dylib
        if [ ! -f "${name}.0.dylib" ]; then
             ln -sf "$lib" "${name}.0.dylib"
        fi
    fi
done
cd "$PROJECT_ROOT"

# List what was copied
echo -e "${GREEN}Installed libraries:${NC}"
ls -lh "$LIB_DIR/"

# Update library paths in the binary to use relative paths

# Update library paths in the binary to use relative paths
echo -e "${GREEN}Updating library paths...${NC}"
install_name_tool -add_rpath "@executable_path/lib" "$TARGET_DIR/main" 2>/dev/null || true

# Copy metal shader if exists
if [ -f "$WHISPER_REPO/build/bin/ggml-metal.metal" ]; then
    echo -e "${GREEN}Copying Metal shader...${NC}"
    cp "$WHISPER_REPO/build/bin/ggml-metal.metal" "$TARGET_DIR/"
fi

# Cleanup
echo -e "${GREEN}Cleaning up temporary files...${NC}"
rm -rf "$TEMP_DIR"

echo -e "${GREEN}=== Build complete! ===${NC}"
echo -e "${GREEN}Binary installed at: $TARGET_DIR/main${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Restart the application"
echo "2. Enable Core ML in Settings > AI > STT > Whisper.cpp"
echo "3. Download the Core ML model (if not already done)"
echo "4. Test transcription and monitor ANE usage with:"
echo "   sudo powermetrics --samplers ane_power -i 1000"
