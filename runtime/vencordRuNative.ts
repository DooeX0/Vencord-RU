/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { RendererSettings } from "@main/settings";

import { vencordRuText } from "./vencordRuText";

export { vencordRuText } from "./vencordRuText";

export function vencordRu(source: string, values?: readonly string[]): string {
    return vencordRuText(RendererSettings.plain.vencordRuLocale === "en" ? "en" : "ru", source, values);
}
