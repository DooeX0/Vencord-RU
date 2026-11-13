import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const context = "Vencord is a client modification for Discord. These texts are plugin descriptions, settings, buttons and tooltips. Use concise, natural Russian software UI wording and consistent Discord terminology: server — сервер, channel — канал, user settings — настройки пользователя, direct messages — личные сообщения, plugin — плагин, context menu — контекстное меню. Keep product names and technical tokens unchanged.";
const protectedText = /<[^>\n]+>|<:[^>\n]+>|\[[^\]\n]+\]\([^\s)]+\)|\x60[^\x60\n]*\x60|(?:https?:\/\/|discord\.gg\/)[^\s<>"'\])]+(?<![.,;:!?])|\{\d+\}|%[sdif]|(?<![\w/])\/[a-z][a-z\d_-]*\b|@[a-z\d_.]+|\b(?:Ctrl|Alt|Shift|Cmd)(?:[+-][\w]+)+\b|\b(?:Discord|Vencord|Vesktop|QuickCSS|Spotify|YouTube|DeepL|GitHub|Nitro|WebSocket|API|CSS|HTML|JSON|URL|GIF|NSFW)\b/g;
const xml = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const entities = Object.fromEntries(Object.entries(xml).map(([key, value]) => [value, key]));
const escape = text => text.replace(/[&<>"']/g, char => xml[char]);

function mask(source) {
    const tokens = [];
    let cursor = 0;
    let tagged = "";
    for (const { 0: token, index } of source.matchAll(protectedText)) {
        tagged += escape(source.slice(cursor, index)) + '<keep id="' + tokens.length + '">' + escape(token) + "</keep>";
        tokens.push(token);
        cursor = index + token.length;
    }
    tagged += escape(source.slice(cursor));
    return { source, tokens, tagged: "<s>" + tagged + "</s>" };
}

function restore(result, tokens) {
    if (typeof result !== "string" || !result.startsWith("<s>") || !result.endsWith("</s>")) return;
    const seen = new Set();
    const markup = /<keep id="(\d+)">[^<]*<\/keep>|[<>]|&(?:amp|lt|gt|quot|apos);|&#(?:\d+|x[\da-f]+);/gi;
    let invalid = false;
    const text = result.slice(3, -4).replace(markup, (match, id) => {
        if (id !== undefined) {
            const index = Number(id);
            if (!Object.hasOwn(tokens, index) || seen.has(index)) invalid = true;
            seen.add(index);
            return tokens[index] ?? "";
        }
        if (Object.hasOwn(entities, match)) return entities[match];
        if (match.startsWith("&#")) {
            const code = match[2] === "x" ? Number.parseInt(match.slice(3, -1), 16) : Number(match.slice(2, -1));
            if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
        }
        invalid = true;
        return match;
    });
    if (!invalid && seen.size === tokens.length && text.trim()) return text;
}

async function translate(batch, key) {
    const host = key.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
    const body = JSON.stringify({
        text: batch.map(entry => entry.tagged),
        source_lang: "EN", target_lang: "RU", context,
        model_type: "prefer_quality_optimized", tag_handling: "xml", ignore_tags: ["keep"]
    });
    if (Buffer.byteLength(body) > 128 * 1024) throw new Error("Пакет перевода превышает лимит размера запроса DeepL.");
    for (let attempt = 0; ; attempt++) {
        const response = await fetch("https://" + host + "/v2/translate", {
            method: "POST",
            headers: { Authorization: "DeepL-Auth-Key " + key, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(45_000)
        });
        if (response.ok) {
            const { translations } = await response.json();
            if (!Array.isArray(translations) || translations.length !== batch.length) {
                throw new Error("DeepL вернул неполный пакет перевода.");
            }
            return translations;
        }
        await response.body?.cancel();
        if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
            throw new Error("DeepL API вернул HTTP " + response.status);
        }
        await delay(1000 * 2 ** attempt);
    }
}

async function main() {
    const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, limit: { type: "string" } } });
    const limit = values.limit === undefined ? Infinity : Number(values.limit);
    if (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new Error("--limit должен быть положительным целым числом.");
    }
    const catalog = JSON.parse(await readFile(new URL("../ru.json", import.meta.url), "utf8"));
    const sources = JSON.parse(await readFile(new URL("./deepl-sources.json", import.meta.url), "utf8"));
    const work = sources.filter(source => Object.hasOwn(catalog.strings, source)).slice(0, limit).map(mask);
    const chars = work.reduce((sum, { source }) => sum + [...source].length, 0);
    console.log("Строки для DeepL: " + work.length + ". Исходных символов: " + chars + ".");
    if (values["dry-run"] || !work.length) return;

    const key = process.env.DEEPL_AUTH_KEY?.trim();
    if (!key) throw new Error("Укажите ключ DeepL в переменной среды DEEPL_AUTH_KEY.");

    const batches = [];
    for (let i = 0; i < work.length; i += 40) batches.push(work.slice(i, i + 40));
    const review = [];
    let processed = 0;
    for (let i = 0; i < batches.length; i += 4) {
        const group = batches.slice(i, i + 4);
        const results = await Promise.all(group.map(batch => translate(batch, key)));
        group.forEach((batch, index) => {
            batch.forEach(({ source, tokens }, item) => {
                const translated = restore(results[index][item]?.text, tokens);
                if (translated && (/[а-яё]/iu.test(translated) || translated === source)) {
                    catalog.strings[source] = translated;
                } else {
                    review.push(source);
                }
            });
            processed += batch.length;
        });
        console.log("Обработано " + processed + " / " + work.length);
    }
    const state = new URL("../.vencord-ru/", import.meta.url);
    await mkdir(state, { recursive: true });
    await writeFile(new URL("deepl-draft.json", state), JSON.stringify(catalog, null, 2) + "\n");
    await writeFile(new URL("deepl-review.json", state), JSON.stringify(review, null, 2) + "\n");
    console.log("Черновик: .vencord-ru/deepl-draft.json. Проверить вручную: " + review.length + ".");
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
