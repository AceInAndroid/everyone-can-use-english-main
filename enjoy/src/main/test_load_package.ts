
import { loadPackage, ensureAndGetPackagesDir } from "echogarden/dist/utilities/PackageManager.js";

async function main() {
    const model = "large-v3-turbo";
    const packageName = `whisper.cpp-${model}`;
    const packagesDir = await ensureAndGetPackagesDir();
    console.log("Packages Dir:", packagesDir);
    try {
        const modelDir = await loadPackage(packageName);
        console.log("Model Dir:", modelDir);
    } catch (e) {
        console.error("Failed to load package:", e.message);
    }
}

main();
