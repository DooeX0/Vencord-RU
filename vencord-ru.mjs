import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import {
    cp, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { linkUpdater, overlay } from "./overlay.mjs";

const project = fileURLToPath(new URL(".", import.meta.url));
const state = join(project, ".vencord-ru");
const upstream = join(state, "upstream");
const current = join(state, "current");
const previous = join(state, "previous");
const packageBuild = join(state, "package");
const previousPackage = join(state, "previous-package");
const official = "https://github.com/Vendicated/Vencord.git";
const tools = join(project, "tools");
const bundledPnpm = join(tools, "pnpm.exe");
const bundledGit = join(tools, "git", "cmd", "git.exe");
const portable = process.platform === "win32" && existsSync(bundledPnpm) && existsSync(bundledGit);
const userPlugins = portable ? join(project, "..", "..", "userplugins") : join(project, "src", "userplugins");
if (portable) {
    process.env.PATH = [tools, join(tools, "git", "cmd"), process.env.PATH].filter(Boolean).join(delimiter);
}
const fingerprintFiles = [
    "overlay.mjs", "vencord-ru.mjs", "ru.json",
    "runtime/vencordRu.ts", "runtime/vencordRuLanguage.tsx", "runtime/vencordRuNative.ts", "runtime/vencordRuText.ts",
    "runtime/vencordRuUserPlugins.tsx"
];

function command(program, args, cwd, capture = false, env = process.env) {
    // Windows pnpm is commonly a .cmd shim. Its arguments below are fixed by this script.
    const shell = !portable && process.platform === "win32" && program === "pnpm";
    const executable = portable && program === "pnpm" ? bundledPnpm : portable && program === "git" ? bundledGit : program;
    const result = spawnSync(shell ? [executable, ...args].join(" ") : executable, shell ? [] : args, {
        cwd, env, shell, windowsHide: true,
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${program} ${args.join(" ")}: код ${result.status ?? result.signal}`);
    return result.stdout?.trim();
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

async function removeStage(path, prefix = join(state, "stage-")) {
    if (!path.startsWith(prefix)) throw new Error("Неверный путь временной сборки");
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
}

async function sourceCheckout(local) {
    if (local) return resolve(local);
    if (await exists(join(upstream, ".git"))) {
        command("git", ["pull", "--ff-only", "origin", "main"], upstream);
    } else {
        const stage = await mkdtemp(join(state, "stage-"));
        try {
            const clone = join(stage, "upstream");
            command("git", ["clone", "--depth", "1", "--branch", "main", official, clone], state);
            await rename(clone, upstream);
        } finally {
            await removeStage(stage);
        }
    }
    return upstream;
}

async function fingerprintPlugins(hash, directory, base = directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        hash.update(JSON.stringify(path.slice(base.length)));
        if (entry.isDirectory()) {
            await fingerprintPlugins(hash, path, base);
        } else if (entry.isFile()) {
            hash.update(createHash("sha256").update(await readFile(path)).digest());
        } else {
            throw new Error(`Неподдерживаемый файл плагина: ${path}`);
        }
    }
}

async function build(checkout, { check, inventory, package: forInstaller, source: localSource, "plugins-only": pluginsOnly }) {
    const commit = pluginsOnly
        ? (await readFile(join(current, "revision.txt"), "utf8")).trim()
        : command("git", ["rev-parse", "HEAD"], checkout, true);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Неверный идентификатор сборки Vencord");
    const destination = forInstaller ? packageBuild : current;
    const hash = createHash("sha256").update(commit).update(localSource ? "local" : "managed");
    for (const file of fingerprintFiles) hash.update(await readFile(join(project, file)));
    const installedFingerprint = join(destination, "fingerprint.txt");
    const stage = await mkdtemp(join(state, "stage-"));
    const portableBuildPrefix = join(tmpdir(), "vcr-");
    let portableBuild;
    try {
        // Keep paths to native dependencies short enough for Windows process creation.
        if (portable) portableBuild = await mkdtemp(portableBuildPrefix);
        const source = join(portableBuild ?? stage, "source");
        const snapshot = join(portableBuild ?? stage, "userplugins");
        if (!forInstaller && await exists(userPlugins)) {
            await cp(userPlugins, snapshot, {
                recursive: true,
                filter: path => ![".git", "node_modules"].includes(path.split(/[\\/]/).pop())
            });
            await fingerprintPlugins(hash, snapshot);
        }
        const fingerprint = hash.digest("hex");
        if (!check && !inventory && await exists(installedFingerprint)
            && await exists(join(destination, "dist", "patcher.js"))
            && (await readFile(installedFingerprint, "utf8")).trim() === fingerprint) {
            console.log(`Сборка ${commit.slice(0, 7)} уже готова.`);
            return;
        }
        command("git", ["clone", "--shared", "--no-checkout", "--config", "core.longpaths=true", checkout, source], state);
        command("git", ["checkout", "--detach", commit], source);
        if (await exists(snapshot)) await rename(snapshot, join(source, "src", "userplugins"));
        command("pnpm", ["install", "--frozen-lockfile"], source);

        const { strings, pluginNames } = JSON.parse(await readFile(join(project, "ru.json"), "utf8"));
        const require = createRequire(join(source, "package.json"));
        const ts = require("typescript");
        const entries = await overlay(source, ts, { strings, apply: !inventory });
        const missing = entries.filter(({ kind, key }) => !Object.hasOwn(kind === "plugin" ? pluginNames : strings, key));
        const report = {
            commit,
            catalogEntries: entries.length,
            translatedEntries: entries.length - missing.length,
            missing
        };
        await writeFile(join(state, "coverage.json"), JSON.stringify(report, null, 2) + "\n");
        console.log(`Словарь: ${report.translatedEntries} / ${entries.length}. Отчёт: ${join(state, "coverage.json")}`);
        if (inventory) return;

        const utils = join(source, "src", "utils");
        await cp(join(project, "runtime"), utils, { recursive: true });
        await writeFile(join(utils, "vencordRuCatalog.ts"), [
            `export const strings: Record<string, string> = ${JSON.stringify(strings)};`,
            `export const pluginNames: Record<string, string> = ${JSON.stringify(pluginNames)};`,
            ""
        ].join("\n"));

        if (!localSource) await linkUpdater(source, ts);
        command("pnpm", ["test:ts"], source);
        const shortCommit = command("git", ["rev-parse", "--short", commit], checkout, true);
        const env = { ...process.env, VENCORD_REMOTE: "Vendicated/Vencord", VENCORD_HASH: shortCommit };
        const buildArgs = ["build", "--dev"];
        if (localSource) buildArgs.push("--disable-updater");
        command("pnpm", buildArgs, source, false, env);
        if (check) return;

        const candidate = join(stage, "candidate");
        await mkdir(candidate);
        if (portableBuild) {
            await cp(join(source, "dist"), join(candidate, "dist"), { recursive: true });
        } else {
            await rename(join(source, "dist"), join(candidate, "dist"));
        }
        await mkdir(join(candidate, "scripts"));
        for (const file of ["runInstaller.mjs", "checkNodeVersion.js"]) {
            await cp(join(source, "scripts", file), join(candidate, "scripts", file));
        }
        await cp(join(source, "package.json"), join(candidate, "package.json"));
        await writeFile(join(candidate, "revision.txt"), commit + "\n");
        await writeFile(join(candidate, "fingerprint.txt"), fingerprint + "\n");
        await promote(candidate, stage, destination, forInstaller ? previousPackage : previous);
        console.log(forInstaller
            ? `Сборка ${commit.slice(0, 7)} готова к упаковке: ${destination}`
            : `Готова сборка ${commit.slice(0, 7)}. Установленная локализованная версия загрузит её при следующем запуске Discord.`);
    } finally {
        try {
            if (portableBuild) await removeStage(portableBuild, portableBuildPrefix);
        } finally {
            await removeStage(stage);
        }
    }
}

async function promote(candidate, stage, active = current, backup = previous) {
    const oldPrevious = join(stage, "old-previous");
    const hadPrevious = await exists(backup);
    const hadCurrent = await exists(active);
    if (hadPrevious) await rename(backup, oldPrevious);
    try {
        if (hadCurrent) await rename(active, backup);
        try {
            await rename(candidate, active);
        } catch (error) {
            if (hadCurrent) await rename(backup, active);
            throw error;
        }
    } catch (error) {
        if (hadPrevious) await rename(oldPrevious, backup);
        throw error;
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            source: { type: "string" },
            check: { type: "boolean" },
            inventory: { type: "boolean" },
            package: { type: "boolean" },
            "plugins-only": { type: "boolean" },
            install: { type: "boolean" },
            rollback: { type: "boolean" }
        }
    });
    if ([values.check, values.inventory, values.package, values.install, values.rollback, values["plugins-only"]].filter(Boolean).length > 1
        || (values.source && (values.install || values.rollback || values["plugins-only"]))) {
        throw new Error("Эти параметры нельзя использовать вместе");
    }
    await mkdir(state, { recursive: true });
    const lockPath = join(state, "build.lock");
    const lock = await open(lockPath, "wx").catch(error => {
        if (error.code === "EEXIST") throw new Error(`Другая операция уже запущена: ${lockPath}`);
        throw error;
    });
    try {
        await lock.writeFile(String(process.pid));
        if (values.install) {
            if (!await exists(join(current, "dist", "patcher.js"))) throw new Error("Сначала запустите сборку русификатора");
            command(process.execPath, [join(current, "scripts", "runInstaller.mjs"), "--", "--install"], current);
        } else if (values.rollback) {
            if (!await exists(previous)) throw new Error("Нет предыдущей сборки");
            const stage = await mkdtemp(join(state, "stage-"));
            const candidate = join(stage, "candidate");
            try {
                await cp(previous, candidate, { recursive: true });
                await promote(candidate, stage);
            } finally {
                await removeStage(stage);
            }
            console.log("Предыдущая сборка восстановлена. Перезапустите Discord.");
        } else {
            await build(values["plugins-only"] ? upstream : await sourceCheckout(values.source), values);
        }
    } finally {
        await lock.close();
        await rm(lockPath);
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
