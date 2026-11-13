/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import { Margins } from "@utils/margins";
import { promptToRestart } from "@utils/promptToRestart";
import { React, useState } from "@webpack/common";

import { vencordRu } from "./vencordRu";

function UserPlugins() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function run(action: "open" | "build") {
        if (busy) return;
        setBusy(true);
        setError("");
        try {
            const result = await VencordNative.updater.userPlugins(action);
            if (!result.ok) throw result.error;
            if (action === "build") {
                promptToRestart("relaunch", {
                    title: vencordRu("User plugins built"),
                    subtitle: vencordRu("Restart Discord to apply the plugin changes.")
                });
            }
        } catch (err) {
            setError((err as { stderr?: string; message?: string })?.stderr?.trim()
                || (err as { message?: string })?.message || String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={Margins.top16}>
            <Flex>
                <Button variant="secondary" disabled={busy} onClick={() => run("open")}>
                    {vencordRu("Open user plugins folder")}
                </Button>
                <Button disabled={busy} onClick={() => run("build")}>
                    {vencordRu(busy ? "Please wait…" : "Build user plugins")}
                </Button>
            </Flex>
            {error && <div role="alert" className={Margins.top8}>
                <Paragraph>{vencordRu("Could not apply user plugin changes.")}</Paragraph>
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 180, overflow: "auto" }}>{error}</pre>
            </div>}
        </div>
    );
}

export const VencordRuUserPlugins = ErrorBoundary.wrap(UserPlugins, { noop: true });
