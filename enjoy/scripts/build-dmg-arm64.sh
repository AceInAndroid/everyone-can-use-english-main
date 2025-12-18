#!/bin/bash
set -e

# Ensure we are in the project root
cd "$(dirname "$0")/.."
echo "Working directory: $(pwd)"

# Set memory limit to prevent OOM
export NODE_OPTIONS='--max-old-space-size=8192'

# Fix for missing C++ headers on some macOS environments
export CXXFLAGS="-I$(xcrun --show-sdk-path)/usr/include/c++/v1"

echo "Starting build for macOS arm64..."

# Clean previous build artifacts
if [ -d ".vite" ]; then
    echo "Cleaning .vite directory..."
    rm -rf .vite
fi

# Download required resources (dictionaries)
echo "Downloading resources..."
yarn run download

# Run electron-forge make
echo "Packaging DMG for darwin/arm64..."
# Using yarn run to ensure we use the local electron-forge
yarn run electron-forge make --platform=darwin --arch=arm64

echo "Build complete!"
