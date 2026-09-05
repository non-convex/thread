import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { BunPlugin } from "bun";

const root = path.resolve(import.meta.dir, "..");

/** Bundle the pinned SDK loaders without relying on runtime node_modules discovery. */
export function recallNativePlugin(target: string): BunPlugin {
  const [, os, arch] = target.split("-");
  const platform = os === "windows" ? "win32" : os;
  const platformId = `${platform}-${arch}`;
  const helper = path.join(root, "src/session-recall/native-assets.ts");

  async function prelude(version: string, directory: string, names: string[]): Promise<string> {
    const imports: string[] = [];
    const assets: string[] = [];
    for (const [index, name] of names.entries()) {
      const file = path.join(directory, name);
      const bytes = await readFile(file);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      imports.push(`import asset${index} from ${JSON.stringify(file)} with {type:'file'};`);
      assets.push(`{name:${JSON.stringify(name)},source:asset${index},sha256:${JSON.stringify(sha256)}}`);
    }
    return `${imports.join("\n")}\nimport {createRequire as nativeRequire} from 'node:module';
      import {join as nativeJoin} from 'node:path';
      import {materializeNativeAssets} from ${JSON.stringify(helper)};
      const nativeDirectory = materializeNativeAssets(${JSON.stringify(`${version}-${platformId}`)},[${assets.join(",")}]);\n`;
  }

  return {
    name: "thread-recall-native",
    setup(build) {
      build.onLoad({ filter: /[\\/]@zvec[\\/]zvec[\\/]src[\\/]index\.mjs$/ }, async ({ path: file }) => {
        const source = await readFile(file, "utf8");
        return { contents: `import cjs from './index.js';\n${source.slice(source.indexOf("export const"))}`, loader: "js" };
      });
      build.onLoad({ filter: /[\\/]@zvec[\\/]zvec[\\/]src[\\/]index\.js$/ }, async ({ path: file }) => {
        const directory = path.join(root, "node_modules/@zvec", `bindings-${platformId}`);
        const source = await readFile(file, "utf8");
        const head = await prelude("zvec-0.7.1", directory, [
          "zvec_node_binding.node", "jieba_dict/jieba.dict.utf8", "jieba_dict/hmm_model.utf8",
        ]);
        return { contents: `${head}
          const binding = nativeRequire(import.meta.url)(nativeJoin(nativeDirectory,'zvec_node_binding.node'));
          binding.setDefaultJiebaDictDir(nativeJoin(nativeDirectory,'jieba_dict'));
          ${source.slice(source.indexOf("function isZVecError"))}`, loader: "js" };
      });
      build.onLoad({ filter: /[\\/]onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, async ({ path: file }) => {
        const directory = path.join(root, "node_modules/onnxruntime-node/bin/napi-v6", platform!, arch!);
        const names = (await readdir(directory)).filter((name) => /\.(node|dll|dylib)$|\.so(\.|$)/.test(name));
        const head = await prelude("onnxruntime-1.24.3", directory, names);
        const source = await readFile(file, "utf8");
        const replaced = source.replace(/require\(`\.\.\/bin\/napi-v6\/\$\{process\.platform\}\/\$\{process\.arch\}\/onnxruntime_binding\.node`\)/,
          "nativeRequire(import.meta.url)(nativeJoin(nativeDirectory,'onnxruntime_binding.node'))");
        if (replaced === source) throw new Error("Pinned ONNX loader changed; update the standalone adapter");
        return { contents: `${head}\n${replaced}`, loader: "js" };
      });
      build.onLoad({ filter: /[\\/]session-recall[\\/]worker-path\.ts$/ }, () => ({
        contents: `export function embeddingWorkerArgs() { return ['--internal-embedding-worker']; }`, loader: "js",
      }));
    },
  };
}
