import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const pluginsTab = "src/components/settings/tabs/plugins/";
const coreSettings = "src/plugins/_core/settings.tsx";
const nativeDialog = "src/main/csp/manager.ts";
const nativeEditor = "src/main/ipcMain.ts";
const textProps = new Set([
    "label", "title", "panelTitle", "subtitle", "description", "text", "tooltip", "tooltipText",
    "placeholder", "aria-label", "alt", "buttonTitle", "confirmText", "cancelText",
    "emptyText", "header", "note", "message", "body", "helperText", "errorMessage", "searchPlaceholder",
    "checkboxLabel", "detail"
]);
const textSinks = new Map([
    ["showToast", [0]], ["showNotification", [0]], ["showMessageBox", [0, 1]],
    ["showConfirmationModal", [0, 1, 2]], ["openConfirmModal", [0, 1, 2]],
    ["alert", [0]], ["confirm", [0]], ["wrapTab", [1]], ["notify", [0]], ["buildEntry", [0]],
    ["promptToRestart", [1]]
]);
const dataTags = new Set(["code", "pre", "style", "script", "svg", "kbd"]);
const displayProperty = (name, value) => name + "\u0004" + value;

function jsxText(raw) {
    const lines = raw.split(/\r\n|\n|\r/);
    const lastText = lines.findLastIndex(line => /[^ \t]/.test(line));
    return lines.map((line, index) => {
        let value = line.replaceAll("\t", " ");
        if (index > 0) value = value.trimStart();
        if (index < lines.length - 1) value = value.trimEnd();
        return value && index < lastText ? value + " " : value;
    }).join("");
}

function isText(value) {
    const text = value.trim();
    return /[A-Za-z]{2}/.test(text)
        && !/^(?:https?:|discord:|\/|#|var\(|data:|[.]{1,2}\/)/.test(text)
        && !/^[\w-]+\.(?:png|svg|js|css|json|webp|gif|txt|woff2?|jpg)$/i.test(text)
        && !/^[a-z\d]+(?:[_-][a-z\d]+)+$/.test(text);
}

async function* files(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* files(path);
        else if (/\.(?:tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) yield path;
    }
}

function patchOnce(source, from, to, path) {
    const first = source.indexOf(from);
    if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
        throw new Error(`Изменилась точка подключения в ${path}: ${from}`);
    }
    return source.slice(0, first) + to + source.slice(first + from.length);
}

function moveUpdaterTab(source) {
    const updater = source.match(/^            !IS_UPDATER_DISABLED && UpdaterTab && buildEntry\(\{\n                key: "vencord_updater",\n(?: {16}[^\n]*\n)*            \}\),\n/m)?.[0];
    if (!updater) throw new Error("Не найдена вкладка обновлений в " + coreSettings);
    const patchHelper = "                Icon: PatchHelperIcon\n            }),\n";
    return patchOnce(patchOnce(source, updater, "", coreSettings), patchHelper, patchHelper + updater, coreSettings);
}

const hooks = new Map([
    ["src/shared/IpcEvents.ts", [
        ['    BUILD = "VencordBuild",', '    BUILD = "VencordBuild",\n    USER_PLUGINS = "VencordRuUserPlugins",']
    ]],
    ["src/VencordNative.ts", [
        ["    updater: {", '    updater: {\n        userPlugins: (action: "open" | "build") => invoke<IpcRes<boolean>>(IpcEvents.USER_PLUGINS, action),']
    ]],
    ["browser/VencordNativeStub.ts", [
        ["    updater: {", "    updater: {\n        userPlugins: async () => ({ ok: true, value: false }),"]
    ]],
    ["src/api/Settings.ts", [
        ["    autoUpdate: boolean;", '    vencordRuLocale: "en" | "ru";\n    autoUpdate: boolean;'],
        ["    autoUpdate: true,", '    vencordRuLocale: "ru",\n    autoUpdate: true,']
    ]],
    [coreSettings, [
        ['UpdaterIcon, VesktopSettingsIcon } from "@components/Icons";', 'UpdaterIcon, VesktopSettingsIcon, WebsiteIcon } from "@components/Icons";'],
        ['import { isTruthy } from "@utils/guards";', 'import { isTruthy } from "@utils/guards";\nimport { VencordRuLanguageTab } from "@utils/vencordRuLanguage";'],
        ['useTitle: () => "Vencord Settings"', 'useTitle: () => vencordRu("Vencord Settings")'],
        ["                Icon: UpdaterIcon\n            }),", [
            "                Icon: UpdaterIcon",
            "            }),",
            "            buildEntry({",
            '                key: "vencord_language",',
            '                title: vencordRu("Language"),',
            "                Component: VencordRuLanguageTab,",
            "                Icon: WebsiteIcon",
            "            }),"
        ].join("\n")]
    ]],
    [nativeEditor, [
        ['const title = "Vencord QuickCSS Editor";', 'const title = vencordRu("Vencord QuickCSS Editor");'],
        ['find(w => w.title === title)', 'find(w => w.title === title || w.title === "Vencord QuickCSS Editor" || w.title === vencordRuText("ru", "Vencord QuickCSS Editor"))'],
        ['    await win.loadURL(DESKTOP_MONACO_EDITOR_URL);', '    win.on("page-title-updated", event => event.preventDefault());\n    await win.loadURL(DESKTOP_MONACO_EDITOR_URL);']
    ]],
    [pluginsTab + "PluginCard.tsx", [
        ["name={plugin.name}", "name={vencordRuPluginName(plugin.name)}"],
        ["description={plugin.description}", "description={vencordRu(plugin.description)}"]
    ]],
    [pluginsTab + "PluginModal.tsx", [
        [">{plugin.name}</Heading>", ">{vencordRuPluginName(plugin.name)}</Heading>"],
        ["<Paragraph>{plugin.description}</Paragraph>", "<Paragraph>{vencordRu(plugin.description)}</Paragraph>"],
        [">{tag}</div>", ">{vencordRu(tag)}</div>"]
    ]],
    [pluginsTab + "index.tsx", [
        ['import { promptToRestart } from "@utils/promptToRestart";', 'import { promptToRestart } from "@utils/promptToRestart";\nimport { VencordRuUserPlugins } from "@utils/vencordRuUserPlugins";'],
        ["<UIElementsButton />", "<UIElementsButton />\n            {!IS_WEB && !IS_STANDALONE && !IS_UPDATER_DISABLED && <VencordRuUserPlugins />}"],
        ["a.name.localeCompare(b.name)", "vencordRuPluginName(a.name).localeCompare(vencordRuPluginName(b.name))"],
        ["plugin.name.toLowerCase().includes(search) ||", "plugin.name.toLowerCase().includes(search) ||\n            vencordRuPluginName(plugin.name).toLowerCase().includes(search) ||\n            vencordRu(plugin.description).toLowerCase().includes(search) ||"],
        ["label: tag, value: tag", "label: vencordRu(tag), value: tag"],
        ['? "This plugin is required for Vencord to function."', '? vencordRu("This plugin is required for Vencord to function.")']
    ]],
    [pluginsTab + "components/Common.tsx", [
        ["{name ?? wordsToTitle(wordsFromCamel(id))}", "{name ? vencordRu(name) : vencordRu(wordsToTitle(wordsFromCamel(id)))}"],
        ["{description}</Paragraph>", "{vencordRu(description)}</Paragraph>"]
    ]],
    [pluginsTab + "components/SelectSetting.tsx", [
        ["options={setting.options}", "options={setting.options.map(option => ({ ...option, label: vencordRu(option.label) }))}"]
    ]]
]);

function propertyName(ts, node) {
    return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
}

function argumentName(ts, expression) {
    return propertyName(ts, ts.isPropertyAccessExpression(expression) ? expression.name : expression);
}

function scan(ts, source, path, catalog, record, settingsTitles) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const edits = new Map();
    const raw = node => node.getText(file);
    const isSettingsFile = path.startsWith("src/components/settings/") || path === coreSettings;
    const isNativeDialog = path === nativeDialog;

    function add(node, key, kind = "text", replacement) {
        const text = key.trim();
        if (!isText(text)) return;
        record(kind, text, path);
        if (!replacement || !Object.hasOwn(catalog, text)) return;
        const start = ts.isJsxText(node) ? node.pos : node.getStart(file);
        edits.set(start, [node.end, replacement(text, key.slice(0, key.indexOf(text)), key.slice(key.indexOf(text) + text.length))]);
    }

    function literal(node, mode, kind = "text") {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            if (mode === "jsx-attribute" && /&(?:#\w+|\w+);/.test(node.text)) return;
            add(node, node.text, kind, mode === "catalog" ? undefined : (text, prefix, suffix) => {
                const call = `vencordRu(${JSON.stringify(prefix + text + suffix)})`;
                return mode === "jsx-attribute" ? `{${call}}` : call;
            });
        } else if (ts.isTemplateExpression(node)) {
            const parts = [node.head.text, ...node.templateSpans.map(span => span.literal.text)];
            const key = parts.reduce((value, part, index) => index ? `${value}{${index - 1}}${part}` : part, "");
            if (mode === "catalog") {
                add(node, key, kind);
            } else {
                add(node, key, kind, () => {
                    const values = node.templateSpans.map(span => "`\${" + raw(span.expression) + "}`");
                    return `vencordRu(${JSON.stringify(key)}, [${values.join(", ")}])`;
                });
            }
        } else if (ts.isConditionalExpression(node)) {
            literal(node.whenTrue, mode, kind);
            literal(node.whenFalse, mode, kind);
        } else if (ts.isParenthesizedExpression(node)) {
            literal(node.expression, mode, kind);
        } else if (ts.isBinaryExpression(node) && [
            ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken
        ].includes(node.operatorToken.kind)) {
            literal(node.right, mode, kind);
        } else if (isNativeDialog && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
            literal(node.left, mode, kind);
            literal(node.right, mode, kind);
        }
    }

    function objectText(node, mode) {
        if (!ts.isObjectLiteralExpression(node)) return;
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = propertyName(ts, property.name);
            if (textProps.has(name)) {
                literal(property.initializer, mode);
            }
            if (isNativeDialog && name === "buttons" && ts.isArrayLiteralExpression(property.initializer)) {
                for (const button of property.initializer.elements) literal(button, mode);
            }
        }
    }

    function pluginMetadata(node) {
        if (!node || !ts.isObjectLiteralExpression(node)) return;
        for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const name = propertyName(ts, property.name);
            const value = property.initializer;
            if (name === "name" && ts.isStringLiteral(value)) record("plugin", value.text, path);
            if (name === "description") literal(value, "catalog");
        }
    }

    function settingMetadata(node) {
        if (!node || !ts.isObjectLiteralExpression(node)) return;
        for (const setting of node.properties) {
            if (!ts.isPropertyAssignment(setting) || !ts.isObjectLiteralExpression(setting.initializer)) continue;
            const id = propertyName(ts, setting.name);
            if (id) settingsTitles.add(id);
            objectText(setting.initializer, "catalog");
            for (const property of setting.initializer.properties) {
                if (!ts.isPropertyAssignment(property)) continue;
                const name = propertyName(ts, property.name);
                if (name === "displayName") literal(property.initializer, "catalog");
                if (name === "placeholder") literal(property.initializer, "expression");
                if (name === "options" && ts.isArrayLiteralExpression(property.initializer)) {
                    for (const option of property.initializer.elements) objectText(option, "catalog");
                }
            }
        }
    }

    function visit(node) {
        if (ts.isJsxElement(node) && dataTags.has(raw(node.openingElement.tagName))) return;
        if (ts.isJsxText(node)) {
            const rawText = jsxText(node.getFullText(file));
            if (!/&(?:#\w+|\w+);/.test(rawText)) {
                add(node, rawText, "text", (text, prefix, suffix) =>
                    `{vencordRu(${JSON.stringify(prefix + text + suffix)})}`);
            }
        } else if (ts.isJsxAttribute(node) && node.initializer && textProps.has(raw(node.name))) {
            if (ts.isJsxExpression(node.initializer)) {
                if (node.initializer.expression) literal(node.initializer.expression, "expression");
            } else {
                literal(node.initializer, "jsx-attribute");
            }
        } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
            literal(node.expression, "expression");
        } else if (ts.isCallExpression(node)) {
            const name = argumentName(ts, node.expression);
            if (name === "definePlugin") pluginMetadata(node.arguments[0]);
            if (name === "definePluginSettings") settingMetadata(node.arguments[0]);
            for (const index of textSinks.get(name) ?? []) {
                const arg = node.arguments[index];
                if (!arg) continue;
                objectText(arg, "expression");
                literal(arg, "expression");
            }
        } else if (ts.isObjectLiteralExpression(node) && isSettingsFile) {
            const parent = node.parent;
            const isSettingData = ts.isArrayLiteralExpression(parent)
                || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken);
            if (isSettingData) objectText(node, "expression");
        } else if (ts.isVariableDeclaration(node) && node.initializer) {
            const name = propertyName(ts, node.name);
            if (isNativeDialog && (name === "message" || name === "detail")) literal(node.initializer, "expression");
            if (path === nativeEditor && name === "title") literal(node.initializer, "catalog");
            if (path === pluginsTab + "index.tsx" && name === "ExcludedReasons" && ts.isObjectLiteralExpression(node.initializer)) {
                for (const property of node.initializer.properties) {
                    if (ts.isPropertyAssignment(property)) literal(property.initializer, "expression");
                }
            }
            if (path === "src/utils/types.ts" && name === "PluginTags") {
                const list = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
                if (ts.isArrayLiteralExpression(list)) for (const item of list.elements) literal(item, "catalog");
            }
        } else if (path === "src/utils/promptToRestart.tsx" && ts.isBindingElement(node)
            && node.initializer && textProps.has(propertyName(ts, node.name))) {
            literal(node.initializer, "expression");
        } else if (isNativeDialog && ts.isBinaryExpression(node) && raw(node.left) === "detail"
            && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            literal(node.right, "expression");
        } else if (isNativeDialog && ts.isReturnStatement(node) && node.expression && ts.isCaseClause(node.parent)) {
            literal(node.expression, "expression");
        }
        ts.forEachChild(node, visit);
    }

    visit(file);
    let output = source;
    let lastStart = source.length;
    for (const [start, [end, value]] of [...edits].sort(([a], [b]) => b - a)) {
        if (end > lastStart) continue;
        output = output.slice(0, start) + value + output.slice(end);
        lastStart = start;
    }
    return output;
}

function toSettingTitle(id) {
    return id.split(/(?=[A-Z][a-z])|(?<=[a-z])(?=[A-Z])/)
        .map(word => /^[A-Z]{2,}$/.test(word) ? word : word[0].toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
}

function checkCatalog(catalog) {
    for (const [key, translation] of Object.entries(catalog)) {
        const tokens = value => (value.match(/\{\d+\}/g) ?? []).sort().join();
        if (typeof translation !== "string" || !translation.trim() || tokens(key) !== tokens(translation)) {
            throw new Error(`Проверьте перевод и подстановки для ${JSON.stringify(key)}`);
        }
    }
}

export async function overlay(root, ts, { strings = {}, apply = false } = {}) {
    checkCatalog(strings);
    const inventory = new Map();
    const seen = new Set();
    const settingsTitles = new Set();
    const pending = [];

    function record(kind, key, path) {
        if (!key) return;
        const id = displayProperty(kind, key);
        const entry = inventory.get(id) ?? { kind, key, files: [] };
        if (!entry.files.includes(path)) entry.files.push(path);
        inventory.set(id, entry);
    }

    for (const dir of [
        "src/components", "src/plugins", "src/api", "src/utils", "browser", "src/Vencord.ts",
        "src/VencordNative.ts", "src/shared/IpcEvents.ts", nativeDialog, nativeEditor
    ]) {
        const targets = dir.endsWith(".ts") ? [join(root, dir)] : files(join(root, dir));
        for await (const file of targets) {
            const path = relative(root, file).split(sep).join("/");
            const original = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
            let updated = scan(ts, original, path, apply ? strings : {}, record, settingsTitles);
            if (hooks.has(path)) {
                seen.add(path);
                if (apply) {
                    if (path === coreSettings) updated = moveUpdaterTab(updated);
                    for (const [from, to] of hooks.get(path)) updated = patchOnce(updated, from, to, path);
                }
            }
            if (apply && updated !== original) {
                const imports = ["vencordRu", "vencordRuPluginName", "vencordRuText"]
                    .filter(name => new RegExp(`\\b${name}\\b`).test(updated));
                const location = path.startsWith("src/main/") ? "@utils/vencordRuNative" : "@utils/vencordRu";
                const headerEnd = updated.startsWith("/*") ? updated.indexOf("*/") + 2 : 0;
                const statement = imports.length ? `import { ${imports.join(", ")} } from "${location}";\n` : "";
                pending.push([file, updated.slice(0, headerEnd) + "\n" + statement + updated.slice(headerEnd)]);
            }
        }
    }
    for (const id of settingsTitles) record("setting", toSettingTitle(id), pluginsTab + "components/Common.tsx");
    for (const path of hooks.keys()) {
        if (!seen.has(path)) throw new Error(`В исходниках отсутствует ${path}`);
    }
    await Promise.all(pending.map(([file, output]) => writeFile(file, output)));
    return [...inventory.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

export async function linkUpdater(root, ts) {
    const path = "src/main/updater/git.ts";
    const file = join(root, path);
    let source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
    for (const [from, to] of [
        ['import { serializeErrors } from "./common";', 'import gitHash from "~git-hash";\n\nimport { serializeErrors } from "./common";'],
        ['import { ipcMain } from "electron";', 'import { ipcMain, shell } from "electron";\nimport { existsSync } from "fs";\nimport { mkdir } from "fs/promises";'],
        ['const VENCORD_SRC_DIR = join(__dirname, "..");', [
            'const VENCORD_SRC_DIR = join(__dirname, "..", "..", "upstream");',
            'const PROJECT = join(__dirname, "..", "..", "..");',
            'const LOCALIZER = join(PROJECT, "vencord-ru.mjs");',
            'const BUNDLED_GIT = join(PROJECT, "tools", "git", "cmd", "git.exe");',
            'const BUNDLED_NODE = join(PROJECT, "tools", "node.exe");'
        ].join("\n")],
        ['const opts = { cwd: VENCORD_SRC_DIR };\n\n    if (isFlatpak)', 'const opts = { cwd: VENCORD_SRC_DIR, windowsHide: true };\n\n    if (isFlatpak)'],
        ['else return execFile("git", args, opts);', 'else return execFile(existsSync(BUNDLED_GIT) ? BUNDLED_GIT : "git", args, opts);'],
        ['const branch = (await git("branch", "--show-current")).stdout.trim();', 'const branch = "main";'],
        ['`HEAD...origin/${branch}`', '`${gitHash}...origin/${branch}`'],
        ['async function pull() {\n    const res = await git("pull");\n    return res.stdout.includes("Fast-forward");\n}', [
            'async function runLocalizer(...flags: string[]) {',
            '    const node = existsSync(BUNDLED_NODE) ? BUNDLED_NODE : "node";',
            '    const command = isFlatpak ? "flatpak-spawn" : node;',
            '    const args = isFlatpak ? ["--host", node, LOCALIZER] : [LOCALIZER];',
            '    await execFile(command, [...args, ...flags], { cwd: PROJECT, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });',
            '    return true;',
            '}',
            '',
            'const pull = () => runLocalizer();',
            '',
            'ipcMain.handle(IpcEvents.USER_PLUGINS, serializeErrors(async (_event, action: unknown) => {',
            '    if (action === "build") return runLocalizer("--plugins-only");',
            '    if (action !== "open") throw new Error("Invalid user plugins action");',
            '    const folder = existsSync(BUNDLED_NODE)',
            '        ? join(PROJECT, "..", "..", "userplugins")',
            '        : join(PROJECT, "src", "userplugins");',
            '    await mkdir(folder, { recursive: true });',
            '    const error = await shell.openPath(folder);',
            '    if (error) throw new Error(error);',
            '    return true;',
            '}));'
        ].join("\n")]
    ]) {
        source = patchOnce(source, from, to, path);
    }
    const fileAst = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const build = fileAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "build");
    const body = build?.body?.getText(fileAst);
    if (!body?.includes("scripts/build/build.mjs")) throw new Error(`Изменилась команда сборки в ${path}`);
    const replacement = "{\n    // The update operation has already compiled and published the localized build.\n    return true;\n}";
    source = source.slice(0, build.body.getStart(fileAst)) + replacement + source.slice(build.body.end);
    await writeFile(file, source);

    const ipcFile = join(root, nativeEditor);
    let ipc = (await readFile(ipcFile, "utf8")).replaceAll("\r\n", "\n");
    ipc = patchOnce(ipc, 'import { FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "fs";',
        'import { existsSync, FSWatcher, mkdirSync, readFileSync, watch, writeFileSync } from "fs";', nativeEditor);
    ipc = patchOnce(ipc, "    if (IS_DEV) {\n        rendererCssWatcher = watch", [
        "    // On Windows the build directory must be movable while Discord is running.",
        '    const localizedInstall = process.platform === "win32" && existsSync(join(__dirname, "..", "..", "..", "vencord-ru.mjs"));',
        "    if (IS_DEV && !localizedInstall) {",
        "        rendererCssWatcher = watch"
    ].join("\n"), nativeEditor);
    await writeFile(ipcFile, ipc);
}
