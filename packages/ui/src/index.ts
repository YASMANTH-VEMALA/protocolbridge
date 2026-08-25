import type { CheckoutAction } from "@protocolbridge/types";

export interface RazorpayCheckoutSuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayCheckoutSuccess) => void;
  modal: { ondismiss: () => void };
}

interface RazorpayCheckoutInstance {
  open(): void;
}

type RazorpayConstructor = new (options: RazorpayCheckoutOptions) => RazorpayCheckoutInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let checkoutScriptPromise: Promise<void> | null = null;

export function loadRazorpayCheckout(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Checkout requires a browser."));
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;

  checkoutScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay Standard Checkout failed to load."));
    document.head.append(script);
  });
  return checkoutScriptPromise;
}

export async function openRazorpayCheckout(
  action: CheckoutAction,
  onSuccess: (response: RazorpayCheckoutSuccess) => void,
): Promise<void> {
  await loadRazorpayCheckout();
  if (!window.Razorpay) throw new Error("Razorpay Checkout did not initialize.");
  new window.Razorpay({
    key: action.keyId,
    amount: action.amountMinor,
    currency: action.currency,
    name: action.name,
    description: action.description,
    order_id: action.razorpayOrderId,
    handler: onSuccess,
    modal: { ondismiss: () => undefined },
  }).open();
}
