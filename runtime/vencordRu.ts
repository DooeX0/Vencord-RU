/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { pluginNames } from "./vencordRuCatalog";
import { type VencordRuLocale, vencordRuText } from "./vencordRuText";

let language: VencordRuLocale | undefined;

export function getVencordRuLocale(): VencordRuLocale {
    if (IS_REPORTER) return "en";
    if (language) return language;
    try {
        return language = VencordNative.settings.get().vencordRuLocale === "en" ? "en" : "ru";
    } catch {
        return "ru";
    }
}

export function vencordRu(source: string, values?: readonly string[]): string {
    return vencordRuText(getVencordRuLocale(), source, values);
}

export function vencordRuPluginName(name: string): string {
    return getVencordRuLocale() === "ru" && Object.hasOwn(pluginNames, name) ? pluginNames[name] : name;
}
