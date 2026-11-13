/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PlainSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { Margins } from "@utils/margins";
import { React, Select, useState } from "@webpack/common";

import { getVencordRuLocale, vencordRu } from "./vencordRu";

const languages = [
    { label: "Русский", value: "ru" },
    { label: "English", value: "en" }
];

function VencordRuLanguage() {
    const locale = getVencordRuLocale();
    const [selected, setSelected] = useState(locale);
    const [failed, setFailed] = useState(false);
    const [saving, setSaving] = useState(false);
    const title = vencordRu("Vencord language");

    async function applyLanguage() {
        if (saving || selected === locale) return;
        setSaving(true);
        setFailed(false);
        try {
            await VencordNative.settings.set({ ...PlainSettings, vencordRuLocale: selected }, "vencordRuLocale");
        } catch {
            setSaving(false);
            setFailed(true);
            return;
        }
        window.location.reload();
    }

    return (
        <SettingsTab>
            <Heading id="vc-language-heading" className={Margins.bottom8}>{title}</Heading>
            <Paragraph className={Margins.bottom16}>
                {vencordRu("Applying the language reloads the interface. Discord keeps its own language setting.")}
            </Paragraph>
            <div style={{ maxWidth: 360 }} role="group" aria-labelledby="vc-language-heading">
                <Select
                    placeholder={title}
                    options={languages}
                    isSelected={value => value === selected}
                    select={value => {
                        if (value !== "en" && value !== "ru") return;
                        setSelected(value);
                        setFailed(false);
                    }}
                    serialize={String}
                    isDisabled={saving}
                    closeOnSelect
                />
            </div>
            <Button className={Margins.top16} disabled={saving || selected === locale} onClick={applyLanguage}>
                {vencordRu("Apply")}
            </Button>
            {failed && <div role="alert" className={Margins.top8}>
                <Paragraph>{vencordRu("Could not save the Vencord language.")}</Paragraph>
            </div>}
        </SettingsTab>
    );
}

export const VencordRuLanguageTab = wrapTab(VencordRuLanguage, "Language");
