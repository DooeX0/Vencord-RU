/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strings } from "./vencordRuCatalog";

export type VencordRuLocale = "en" | "ru";

export function vencordRuText(language: VencordRuLocale, source: string, values?: readonly string[]): string {
    let result = source;
    if (language === "ru") {
        const trimmed = source.trim();
        if (Object.hasOwn(strings, trimmed)) result = source.replace(trimmed, () => strings[trimmed]);
    }
    return values ? result.replace(/\{(\d+)\}/g, (token, index) => values[Number(index)] ?? token) : result;
}
