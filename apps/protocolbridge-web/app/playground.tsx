"use client";

import type { CheckoutAction } from "@protocolbridge/types";
import { openRazorpayCheckout } from "@protocolbridge/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

const prompt = "Buy black running shoes, size 9, under ₹2,000.";
const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

interface PolicyDecisionView {
  outcome: "ALLOW" | "AWAITING_APPROVAL" | "BLOCK";
  reasons: string[];
}

interface PreparedView {
  universalIntent: { intentId: string; version: string; protocol: string; constraints: Record<string, unknown> };
  status: string;
  quote: { totalMinor: number; currency: string; lines: Array<{ productName: string; variantLabel: string }> };
  policyDecision: PolicyDecisionView;
  amountChargedMinor: number;
}

interface AuditEventView {
  id: string;
  eventType: string;
  actorType: string;
  data: unknown;
  createdAt: string;
}

interface IntentDetailView {
  intent: {
    id: string;
    status: string;
    reasonCode: string | null;
    constraints: Record<string, unknown>;
    items: Array<{
      productName: string;
      color: string;
      size: string;
      quantity: number;
      discoveredUnitAmountMinor: number;
    }>;
    quotes: Array<{ version: number; totalMinor: number; currency: string; status: string }>;
    approvalRequest: null | { status: string; exactAmountMinor: number };
    authorization: null | { type: string; status: string; usesRemaining: number | null };
    order: null | {
      status: string;
      totalMinor: number;
      payments: Array<{ status: string; attempt: number; amountMinor: number }>;
    };
  } | null;
  amountChargedMinor: number;
  auditTimeline: AuditEventView[];
}

interface ExecuteView {
  status: string;
  checkout: CheckoutAction | null;
  policyDecision: PolicyDecisionView;
  amountChargedMinor: number;
}

interface ApiFailure {
  error?: { code?: string; message?: string };
}

async function jsonRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { ...init, cache: "no-store" });
  const body = (await response.json()) as T & ApiFailure;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
  }
  return body;
}

function formatMoney(minor: number, currency = "INR"): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(
    minor / 100,
  );
}

function readableEvent(eventType: string): string {
  return eventType
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function AgentPlayground() {
  const [prepared, setPrepared] = useState<PreparedView | null>(null);
  const [detail, setDetail] = useState<IntentDetailView | null>(null);
  const [buyerToken, setBuyerToken] = useState<string | null>(null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("Reset the demo, then choose an allow or approval scenario.");
  const [error, setError] = useState<string | null>(null);

  const intentId = prepared?.universalIntent.intentId ?? detail?.intent?.id ?? null;
  const status = detail?.intent?.status ?? prepared?.status ?? "READY";
  const chargedMinor = detail?.amountChargedMinor ?? prepared?.amountChargedMinor ?? 0;
  const currentQuote = detail?.intent?.quotes[0] ?? prepared?.quote ?? null;
  const approvalOverrideActive =
    detail?.intent?.approvalRequest?.status === "USED" &&
    ["APPROVED", "PAYMENT_PROCESSING", "COMPLETED"].includes(status);
  const policy: PolicyDecisionView | undefined = approvalOverrideActive
    ? { outcome: "ALLOW", reasons: [] }
    : prepared?.policyDecision;

  const ensureBuyerSession = useCallback(async (): Promise<string> => {
    if (buyerToken) return buyerToken;
    const session = await jsonRequest<{ accessToken: string }>("/api/demo/session", { method: "POST" });
    setBuyerToken(session.accessToken);
    return session.accessToken;
  }, [buyerToken]);

  const refresh = useCallback(async (targetIntentId?: string): Promise<IntentDetailView | null> => {
    const selected = targetIntentId ?? intentId;
    if (!selected) return null;
    const next = await jsonRequest<IntentDetailView>(`/api/demo/intents/${encodeURIComponent(selected)}`);
    setDetail(next);
    return next;
  }, [intentId]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "protocolbridge-approval-complete" && event.newValue?.startsWith(`${intentId}:`)) {
        void refresh().then(() => setNotice("Buyer approval received. The original intent is ready to resume."));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [intentId, refresh]);

  async function resetDemo(): Promise<void> {
    setBusy("reset");
    setError(null);
    try {
      await jsonRequest("/api/demo/reset", { method: "POST" });
      await ensureBuyerSession();
      setPrepared(null);
      setDetail(null);
      setApprovalUrl(null);
      setNotice("SoleKart restored: Adidas Runfalcon Black / 9 is ₹1,899 with fresh stock.");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Demo reset failed.");
    } finally {
      setBusy(null);
    }
  }

  async function runScenario(scenario: "BASELINE" | "PRICE_INCREASED"): Promise<void> {
    setBusy(scenario);
    setError(null);
    setApprovalUrl(null);
    setDetail(null);
    try {
      await ensureBuyerSession();
      await jsonRequest("/api/demo/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const result = await jsonRequest<PreparedView>("/api/demo/intents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: `judge-${crypto.randomUUID()}`,
          buyerId: "usr_demo_buyer",
          prompt,
          protocol: "INTERNAL",
        }),
      });
      setPrepared(result);
      await refresh(result.universalIntent.intentId);
      setNotice(
        result.status === "APPROVED"
          ? "Fresh quote and deterministic checks returned ALLOW. Ready for Razorpay Test Checkout."
          : "Price exceeds the bounded authorization. Payment creation stopped before Razorpay.",
      );
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The judging scenario failed.");
    } finally {
      setBusy(null);
    }
  }

  async function requestApproval(): Promise<void> {
    if (!intentId) return;
    setBusy("approval");
    setError(null);
    try {
      const result = await jsonRequest<{ approvalUrl: string }>(
        `/api/demo/intents/${encodeURIComponent(intentId)}/approval-link`,
        { method: "POST" },
      );
      setApprovalUrl(result.approvalUrl);
      await refresh();
      setNotice("Signed single-use link created for this exact product and ₹2,299 only.");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Approval link creation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function verifyCheckout(
    checkout: CheckoutAction,
    response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string },
  ): Promise<void> {
    const token = await ensureBuyerSession();
    await jsonRequest(`${apiUrl}/v1/payments/razorpay/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `checkout-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        paymentId: checkout.paymentId,
        razorpayOrderId: response.razorpay_order_id,
        razorpayPaymentId: response.razorpay_payment_id,
        razorpaySignature: response.razorpay_signature,
      }),
    });
    setNotice("Checkout signature verified. Waiting for the independently verified capture webhook…");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await refresh();
      if (next?.intent?.status === "COMPLETED") {
        setNotice("Payment captured by verified webhook. SoleKart order confirmed.");
        return;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
    }
    setNotice("Signature verified; final confirmation is still waiting for the Razorpay webhook.");
  }

  async function execute(): Promise<void> {
    if (!intentId) return;
    setBusy("execute");
    setError(null);
    try {
      const current = await refresh();
      if (current?.intent?.status === "AWAITING_APPROVAL") {
        throw new Error("The matching buyer must approve the signed link before this intent can resume.");
      }
      const result = await jsonRequest<ExecuteView>(
        `/api/demo/intents/${encodeURIComponent(intentId)}/execute`,
        { method: "POST" },
      );
      await refresh();
      if (!result.checkout) {
        setNotice("Execution stopped before payment. ₹0 charged.");
        return;
      }
      setNotice("Razorpay Test order created after a fresh quote, policy check, and inventory reservation.");
      await openRazorpayCheckout(result.checkout, (response) => {
        void verifyCheckout(result.checkout!, response).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Checkout verification failed.");
        });
      });
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "Payment execution failed.");
    } finally {
      setBusy(null);
    }
  }

  const milestones = useMemo(() => {
    const timeline = detail?.auditTimeline ?? [];
    const has = (event: string) => timeline.some((item) => item.eventType === event);
    return [
      ["Intent resolved", has("UNIVERSAL_COMMERCE_INTENT_CREATED")],
      ["Fresh quote", has("QUOTE_CREATED") || has("QUOTE_REFRESHED_BEFORE_EXECUTION")],
      ["Policy verified", has("POLICY_EVALUATED")],
      ["Buyer approved", has("BUYER_APPROVAL_CONSUMED")],
      ["Razorpay order", has("RAZORPAY_ORDER_CREATED")],
      ["Order confirmed", has("PAYMENT_CAPTURED_ORDER_CONFIRMED")],
    ] as const;
  }, [detail]);

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="ProtocolBridge home">
          <span className="brand-mark">PB</span>
          <span>ProtocolBridge</span>
        </a>
        <div className="safety-rule">AI interprets · ProtocolBridge verifies · Razorpay executes</div>
        <span className="mode-pill"><i /> TEST MODE</span>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">P1 · GOLDEN JUDGING EXPERIENCE</p>
          <h1>Agent Playground</h1>
          <p className="hero-copy">
            One buyer request. A database-backed quote. Deterministic authority and policy. Payment only after every
            check passes.
          </p>
        </div>
        <button className="button ghost" type="button" onClick={() => void resetDemo()} disabled={busy !== null}>
          <span>↻</span> {busy === "reset" ? "Resetting…" : "One-click demo reset"}
        </button>
      </section>

      <section className="scenario-grid" aria-label="Golden demo scenarios">
        <button className="scenario-card success" type="button" onClick={() => void runScenario("BASELINE")} disabled={busy !== null}>
          <span className="step-number">01</span>
          <span><strong>Run ₹1,899 allow flow</strong><small>Authorization covers current quote</small></span>
          <span className="scenario-arrow">→</span>
        </button>
        <button className="scenario-card warning" type="button" onClick={() => void runScenario("PRICE_INCREASED")} disabled={busy !== null}>
          <span className="step-number">02</span>
          <span><strong>Raise price to ₹2,299</strong><small>Same request must stop before payment</small></span>
          <span className="scenario-arrow">→</span>
        </button>
        <div className={`scenario-card neutral ${status === "APPROVED" && detail?.intent?.approvalRequest ? "active" : ""}`}>
          <span className="step-number">03</span>
          <span><strong>Approve once & resume</strong><small>Exact, short-lived authority is consumed</small></span>
          <span className="scenario-arrow">✓</span>
        </div>
      </section>

      {(notice || error) && (
        <div className={`notice ${error ? "error" : ""}`} role="status">
          <span>{error ? "!" : "i"}</span>
          <p>{error ?? notice}</p>
        </div>
      )}

      <section className="workspace-grid">
        <div className="panel conversation-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">BUYER → AI AGENT</p><h2>Natural-language intent</h2></div>
            <span className={`status-chip ${status.toLowerCase()}`}>{status.replaceAll("_", " ")}</span>
          </div>
          <div className="chat-row">
            <div className="avatar">Y</div>
            <div className="chat-bubble"><p>{prompt}</p><small>Buyer · just now</small></div>
          </div>

          <div className="verification-strip">
            {milestones.map(([label, complete]) => (
              <div className={complete ? "complete" : ""} key={label}><span>{complete ? "✓" : "·"}</span>{label}</div>
            ))}
          </div>

          {currentQuote ? (
            <div className="quote-card">
              <div className="shoe-art" aria-hidden="true">↗</div>
              <div className="quote-product">
                <p className="eyebrow">SOLEKART · LIVE DATABASE</p>
                <h3>{prepared?.quote.lines[0]?.productName ?? detail?.intent?.items[0]?.productName ?? "Adidas Runfalcon"}</h3>
                <p>{prepared?.quote.lines[0]?.variantLabel ?? `${detail?.intent?.items[0]?.color} / Size ${detail?.intent?.items[0]?.size}`}</p>
              </div>
              <div className="quote-amount"><strong>{formatMoney(currentQuote.totalMinor, currentQuote.currency)}</strong><small>fresh quote</small></div>
            </div>
          ) : (
            <div className="empty-state">Run a scenario to resolve the seeded SoleKart variant.</div>
          )}

          {policy && (
            <div className={`decision ${policy.outcome === "ALLOW" ? "allowed" : "blocked"}`}>
              <div><span>{policy.outcome === "ALLOW" ? "✓" : "!"}</span><strong>{policy.outcome.replaceAll("_", " ")}</strong></div>
              <p>{policy.reasons.length ? policy.reasons.join(" · ") : "All deterministic checks passed"}</p>
            </div>
          )}

          <div className="action-row">
            {status === "AWAITING_APPROVAL" && (
              <button className="button warning-button" type="button" onClick={() => void requestApproval()} disabled={busy !== null}>
                {busy === "approval" ? "Signing link…" : "Generate exact buyer approval"}
              </button>
            )}
            {approvalUrl && (
              <a className="button secondary" href={approvalUrl} target="_blank" rel="noreferrer">Open buyer approval ↗</a>
            )}
            {status === "APPROVED" && (
              <button className="button primary" type="button" onClick={() => void execute()} disabled={busy !== null}>
                {busy === "execute" ? "Re-checking…" : detail?.intent?.approvalRequest ? "Resume original intent & pay" : "Continue to Razorpay Test Checkout"}
              </button>
            )}
            {intentId && (
              <button className="text-button" type="button" onClick={() => void refresh()} disabled={busy !== null}>Refresh state</button>
            )}
          </div>
        </div>

        <aside className="panel guardrail-panel">
          <div className="panel-heading"><div><p className="eyebrow">FINANCIAL GUARDRAIL</p><h2>Charge state</h2></div></div>
          <div className={`charged-amount ${chargedMinor > 0 ? "paid" : ""}`}>
            <strong>{formatMoney(chargedMinor)}</strong><span>{chargedMinor > 0 ? "verified capture" : "charged"}</span>
          </div>
          <p className="guardrail-copy">
            A Razorpay order is not created while policy is waiting for approval. Checkout success is not final until
            both its signature and a verified webhook agree.
          </p>
          <dl className="facts">
            <div><dt>Current quote</dt><dd>{currentQuote ? formatMoney(currentQuote.totalMinor, currentQuote.currency) : "—"}</dd></div>
            <div><dt>Buyer limit</dt><dd>₹2,000</dd></div>
            <div><dt>Policy</dt><dd>{policy?.outcome ?? "NOT RUN"}</dd></div>
            <div><dt>Order</dt><dd>{detail?.intent?.order?.status ?? "NOT CREATED"}</dd></div>
            <div><dt>Authorization</dt><dd>{detail?.intent?.authorization ? `${detail.intent.authorization.type} · ${detail.intent.authorization.status}` : "BOUNDED ₹2,000"}</dd></div>
          </dl>
        </aside>
      </section>

      <section className="panel audit-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">APPEND-ONLY EVIDENCE</p><h2>Transaction audit timeline</h2></div>
          <span className="event-count">{detail?.auditTimeline.length ?? 0} events</span>
        </div>
        {detail?.auditTimeline.length ? (
          <ol className="timeline">
            {detail.auditTimeline.map((event, index) => (
              <li key={event.id}>
                <div className="timeline-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="timeline-line" />
                <div className="timeline-content">
                  <div><strong>{readableEvent(event.eventType)}</strong><span>{event.actorType}</span></div>
                  <time>{new Date(event.createdAt).toLocaleTimeString("en-IN")}</time>
                  <code>{JSON.stringify(event.data)}</code>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="empty-state">The full intent timeline will appear here. Existing audit history is never deleted by demo reset.</div>
        )}
      </section>
    </main>
  );
}
