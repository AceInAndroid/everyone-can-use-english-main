import path from "path";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import type { ConfigEnv, UserConfig } from "vite";
import { defineConfig } from "vite";
import { pluginExposeRenderer } from "./vite.base.config";

// https://vitejs.dev/config
export default defineConfig((env) => {
  const forgeEnv = env as ConfigEnv<"renderer">;
  const { root, mode, forgeConfigSelf } = forgeEnv;
  const name = forgeConfigSelf.name ?? "";

  return {
    root,
    mode,
    base: "./",
    build: {
      sourcemap: true,
      outDir: `.vite/renderer/${name}`,
      target: "esnext",
    },
    plugins: [
      pluginExposeRenderer(name),
      react(),
      viteStaticCopy({
        targets: [
          {
            src: "assets/**/*",
            dest: "assets",
          },
          {
            src: [
              "node_modules/onnxruntime-web/dist/*.wasm",
              "node_modules/onnxruntime-web/dist/*.mjs",
              "node_modules/onnxruntime-web/dist/*.js",
              "node_modules/onnxruntime-web/dist/*.worker.js",
            ],
            dest: "assets/ort",
          },
        ],
      }),
    ],
    resolve: {
      preserveSymlinks: true,
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@renderer": path.resolve(__dirname, "./src/renderer"),
        "@commands": path.resolve(__dirname, "./src/commands"),
        "vendor/pdfjs": path.resolve(
          __dirname,
          "./node_modules/foliate-js/vendor/pdfjs"
        ),
      },
    },
    optimizeDeps: {
      exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
      esbuildOptions: {
        target: "esnext",
      },
    },
    clearScreen: false,
  } as UserConfig;
});
