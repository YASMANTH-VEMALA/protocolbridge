"use client";

import { useEffect, useState } from "react";

const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

interface ApprovalView {
  id: string;
  status: string;
  merchantName: string;
  purchaseIntentId: string;
  productName: string;
  productVariantId: string;
  color: string;
  size: string;
  quantity: number;
  approvedAmountMinor: number;
  currency: string;
  expiresAt: string;
}

interface ApiFailure {
  error?: { message?: string };
}

function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(
    minor / 100,
  );
}

export function BuyerApproval({ token }: { token: string }) {
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`${apiUrl}/v1/approvals/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { approval?: ApprovalView } & ApiFailure;
        if (!response.ok || !body.approval) throw new Error(body.error?.message ?? "Approval link is invalid.");
        setApproval(body.approval);
        if (body.approval.status === "USED") setApproved(true);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Approval link failed."))
      .finally(() => setLoading(false));
  }, [token]);

  async function approve(): Promise<void> {
    if (!approval) return;
    setApproving(true);
    setError(null);
    try {
      const sessionResponse = await fetch("/api/demo/session", { method: "POST" });
      const session = (await sessionResponse.json()) as { accessToken?: string } & ApiFailure;
      if (!sessionResponse.ok || !session.accessToken) {
        throw new Error(session.error?.message ?? "Demo buyer authentication failed.");
      }
      const response = await fetch(`${apiUrl}/v1/approvals/${encodeURIComponent(token)}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Idempotency-Key": `buyer-${crypto.randomUUID()}`,
        },
      });
      const body = (await response.json()) as { status?: string; purchaseIntentId?: string } & ApiFailure;
      if (!response.ok || body.status !== "APPROVED") {
        throw new Error(body.error?.message ?? "Approval could not be completed.");
      }
      setApproved(true);
      localStorage.setItem("protocolbridge-approval-complete", `${approval.purchaseIntentId}:${Date.now()}`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Approval could not be completed.");
    } finally {
      setApproving(false);
    }
  }

  return (
    <main className="approval-shell">
      <a className="brand approval-brand" href="/">
        <span className="brand-mark">PB</span><span>ProtocolBridge</span>
      </a>
      <section className="approval-card">
        <div className="secure-mark">{approved ? "✓" : "⌁"}</div>
        <p className="eyebrow">SIGNED · EXACT · SINGLE USE</p>
        <h1>{approved ? "Purchase approved" : "Review AI purchase"}</h1>
        <p className="approval-intro">
          {approved
            ? "The original intent may now resume. ProtocolBridge will refresh the quote and policy again before checkout."
            : "You are authorizing one product, for one intent, at exactly the amount shown below."}
        </p>

        {loading && <div className="empty-state">Validating signed approval link…</div>}
        {error && <div className="notice error"><span>!</span><p>{error}</p></div>}
        {approval && (
          <>
            <div className="approval-product">
              <div className="shoe-art">↗</div>
              <div><small>{approval.merchantName}</small><h2>{approval.productName}</h2><p>{approval.color} · Size {approval.size} · Qty {approval.quantity}</p></div>
              <strong>{formatMoney(approval.approvedAmountMinor, approval.currency)}</strong>
            </div>
            <dl className="approval-facts">
              <div><dt>Product boundary</dt><dd>{approval.productVariantId}</dd></div>
              <div><dt>Intent boundary</dt><dd>{approval.purchaseIntentId}</dd></div>
              <div><dt>Authorization</dt><dd>ONE_TIME · exact amount</dd></div>
              <div><dt>Expires</dt><dd>{new Date(approval.expiresAt).toLocaleTimeString("en-IN")}</dd></div>
              <div><dt>Charged now</dt><dd className="zero">₹0</dd></div>
            </dl>
            {!approved ? (
              <button className="button primary approval-button" type="button" onClick={() => void approve()} disabled={approving}>
                {approving ? "Revalidating…" : `Approve exactly ${formatMoney(approval.approvedAmountMinor, approval.currency)}`}
              </button>
            ) : (
              <a className="button primary approval-button" href="/">Return to Agent Playground</a>
            )}
            <p className="approval-footnote">This link cannot approve another product, amount, buyer, merchant, or intent—and cannot be reused.</p>
          </>
        )}
      </section>
    </main>
  );
}
