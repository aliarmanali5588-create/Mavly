"use client";

import * as React from "react";
import Link from "next/link";
import { CreditCardIcon } from "lucide-react";
import { Modal } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { INSUFFICIENT_CREDITS_EVENT } from "@/lib/vcaas";

/**
 * ═══⭐⭐ "YOU ARE OUT OF CREDITS" — ONE MODAL, EVERY ENDPOINT ═══════════════
 *
 * ⚠️⚠️ IT LISTENS RATHER THAN BEING CALLED, and that is the only version of this that
 * stays correct. Roughly forty `vcaasApi` methods can come back `INSUFFICIENT_CREDITS` —
 * a prompt, a publish, a rebuild, a file write, an export, an import, a visual edit — and
 * answering it at forty call sites means the forty-first forgets. `proxyRequest` is the
 * single chokepoint every one of them passes through, so it raises
 * `INSUFFICIENT_CREDITS_EVENT` once and this component answers it once.
 *
 * ⚠️ THE EVENT NEVER SWALLOWS THE RESPONSE. The caller still receives its refusal and
 * still handles it however it did before; this only adds the explanation on top.
 */

/** Where credits are topped up in Mavly. */
const BUY_CREDITS_URL = "/credit-topup";

export function InsufficientCreditsModal() {
    const [open, setOpen] = React.useState(false);

    React.useEffect(() => {
        const onEmpty = () => setOpen(true);
        window.addEventListener(INSUFFICIENT_CREDITS_EVENT, onEmpty);
        return () => window.removeEventListener(INSUFFICIENT_CREDITS_EVENT, onEmpty);
    }, []);

    return (
        <Modal
            open={open}
            onOpenChange={setOpen}
            size="sm"
            title="You're out of credits"
            description="This action needs AI credits. Top up your balance or upgrade your plan to keep building — nothing you've built is lost."
            footer={
                <>
                    <Button variant="outline" onClick={() => setOpen(false)}>
                        Close
                    </Button>
                    <Button asChild className="gap-2">
                        <Link href={BUY_CREDITS_URL} onClick={() => setOpen(false)}>
                            <CreditCardIcon className="size-4" aria-hidden />
                            Top up credits
                        </Link>
                    </Button>
                </>
            }
        >
            {/*
              ⭐ A NOTE FOR WHOEVER IS BUILDING WITH THIS APP, NOT FOR THEIR VISITORS.
              This modal talks about the operator's own Totalum balance, which is nobody
              else's business once the project is published — so it says, in the one place
              the reader is already looking, how to get rid of it.
            */}
            <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-xs leading-relaxed">
                Before you publish your project, tell the AI to remove this modal.
            </p>
        </Modal>
    );
}
