// Cross-package unsigned macOS apps on Linux. This does not verify macOS runtime behavior.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";

const root = process.cwd();
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const electronVersion = pkg.devDependencies.electron;
if (!/^\d+\.\d+\.\d+$/.test(electronVersion))
  throw new Error("Pin an exact Electron version before cross-packaging.");
const args = process.argv.slice(2);
const prepareOnly = args.includes("--prepare-only");
const requested = args.filter((x) => x !== "--prepare-only");
const arches = requested.length ? requested : ["arm64", "x64"];
if (arches.some((x) => !["arm64", "x64"].includes(x)))
  throw new Error(
    "Usage: node scripts/package-mac-linux.mjs [--prepare-only] [arm64] [x64]",
  );
const cache = join(root, ".tools", "mac-packaging", electronVersion);
await mkdir(cache, { recursive: true });
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(url, path, { direct = true } = {}) {
  const temp = path + ".partial";
  await rm(temp, { force: true });
  try {
    run("curl", [
      ...(direct ? ["--noproxy", "*"] : []),
      "--fail",
      "--location",
      "--retry",
      direct ? "0" : "2",
      "--connect-timeout",
      "20",
      "--max-time",
      "600",
      "--speed-limit",
      "65536",
      "--speed-time",
      "30",
      "--silent",
      "--show-error",
      "--output",
      temp,
      url,
    ]);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
const sumsPath = join(cache, "SHASUMS256.txt");
if (!(await exists(sumsPath))) {
  try {
    await download(
      `https://github.com/electron/electron/releases/download/v${electronVersion}/SHASUMS256.txt`,
      sumsPath,
    );
  } catch {
    const metadataPath = join(cache, "official-release.json");
    await download(
      `https://api.github.com/repos/electron/electron/releases/tags/v${electronVersion}`,
      metadataPath,
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const lines = metadata.assets
      .filter((x) => /^sha256:[a-f0-9]{64}$/.test(x.digest ?? ""))
      .map((x) => `${x.digest.slice(7)}  ${x.name}`);
    if (!lines.length)
      throw new Error(
        "Official GitHub release provides no verifiable SHA256 digests.",
      );
    await writeFile(sumsPath, lines.join("\n") + "\n");
  }
}
const sums = await readFile(sumsPath, "utf8");
// ICNS supports PNG payloads directly. Avoid a platform icon-converter download.
let macIcon;
if (!prepareOnly && pkg.build?.icon?.endsWith(".png")) {
  const png = await readFile(resolve(root, pkg.build.icon));
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
    throw new Error("App icon is not PNG.");
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  const chunkType = { 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" }[
    width
  ];
  if (width !== height || !chunkType)
    throw new Error("Use a square 128/256/512/1024 PNG app icon.");
  const header = Buffer.alloc(16);
  header.write("icns", 0);
  header.writeUInt32BE(png.length + 16, 4);
  header.write(chunkType, 8);
  header.writeUInt32BE(png.length + 8, 12);
  macIcon = join(cache, "Telldo.icns");
  await writeFile(macIcon, Buffer.concat([header, png]));
}
const manifests = [];
for (const arch of arches) {
  const name = `electron-v${electronVersion}-darwin-${arch}.zip`;
  const expected = sums
    .split("\n")
    .map((x) => x.trim().split(/\s+/))
    .find((x) => x[1]?.replace(/^\*/, "") === name)?.[0];
  if (!expected || !/[a-f0-9]{64}/.test(expected))
    throw new Error(`No official SHA256 for ${name}`);
  const electronZip = join(cache, name);
  if (
    !(await exists(electronZip)) ||
    (await sha256(electronZip)) !== expected
  ) {
    try {
      await download(
        `https://github.com/electron/electron/releases/download/v${electronVersion}/${name}`,
        electronZip,
      );
    } catch {
      console.log(
        `Official download unavailable; trying mirror for ${name}, still checking official SHA256.`,
      );
      await download(
        `https://registry.npmmirror.com/-/binary/electron/${electronVersion}/${name}`,
        electronZip,
        { direct: false },
      );
    }
  }
  if ((await sha256(electronZip)) !== expected)
    throw new Error(`Electron SHA256 mismatch: ${name}`);
  console.log(
    JSON.stringify({
      phase: "runtime-ready",
      arch,
      electronVersion,
      sha256: expected,
    }),
  );
  if (prepareOnly) continue;
  await access(join(root, "out", "main", "index.js"));
  if (pkg.dependencies?.["better-sqlite3"])
    throw new Error(
      "This packaging route expects built-in node:sqlite; remove external better-sqlite3 first.",
    );
  const output = join(root, "release", `mac-${arch}-build`);
  run(
    process.execPath,
    [
      join(root, "node_modules/electron-builder/out/cli/cli.js"),
      "--mac",
      "--dir",
      `--${arch}`,
      "-c.npmRebuild=false",
      `-c.electronDist=${electronZip}`,
      `-c.directories.output=${output}`,
      ...(macIcon ? [`-c.mac.icon=${macIcon}`] : []),
    ],
    {
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        ELECTRON_BUILDER_CACHE: join(root, ".tools", "builder-cache"),
      },
    },
  );
  const app = join(
    output,
    arch === "arm64" ? "mac-arm64" : "mac",
    "Telldo.app",
  );
  const executable = join(app, "Contents", "MacOS", "Telldo");
  const fileDescription = execFileSync("file", [executable], {
    encoding: "utf8",
  }).trim();
  if (
    !fileDescription.includes("Mach-O") ||
    !fileDescription.includes(arch === "arm64" ? "arm64" : "x86_64")
  )
    throw new Error(`Unexpected executable architecture: ${fileDescription}`);
  const nativeList = execFileSync("find", [app, "-name", "*.node", "-print"], {
    encoding: "utf8",
  }).trim();
  if (nativeList)
    throw new Error(
      "Unexpected external native modules in the node:sqlite app: " +
        nativeList,
    );
  const artifact = join(
    root,
    "release",
    `Telldo-${pkg.version}-mac-${arch}-unsigned.zip`,
  );
  await rm(artifact, { force: true });
  // -y stores links as links instead of copying framework targets repeatedly.
  run("zip", ["-q", "-r", "-y", artifact, "Telldo.app"], { cwd: dirname(app) });
  run("unzip", ["-tq", artifact]);
  const manifest = {
    appVersion: pkg.version,
    electronVersion,
    platform: "darwin",
    arch,
    unsigned: true,
    notarized: false,
    runtimeVerified: false,
    electronSha256: expected,
    artifact: artifact.slice(root.length + 1),
    artifactSha256: await sha256(artifact),
    bytes: (await stat(artifact)).size,
    executable: fileDescription,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceDirty: !!execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    builtAt: new Date().toISOString(),
  };
  await writeFile(artifact + ".json", JSON.stringify(manifest, null, 2) + "\n");
  manifests.push(manifest);
  console.log(JSON.stringify({ phase: "packaged", ...manifest }));
}
if (!prepareOnly)
  console.log(
    "Unsigned macOS archives created. macOS launch, notification permissions and Gatekeeper behavior remain unverified on this Linux host.",
  );
