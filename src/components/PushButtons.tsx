"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  addPushDeviceAction,
  answerApprovalAction,
  forgetThisPushDeviceAction,
  pushDeviceKnownAction,
  pushPublicKeyAction,
  sendSignInPushAction,
  sendTestPushAction,
  signInPushStatusAction,
  type ApproveState,
} from "@/app/actions/push";
import { Field, FormMessage } from "@/components/ui/forms";

/** The browser half of sign-in approvals: subscribing a phone, asking it, answering on it. */

function pushSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iPhone or iPad Safari outside a Home Screen app: push exists only once it's added. */
function needsHomeScreen(): boolean {
  if (typeof navigator === "undefined") return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
}

const button =
  "rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-muted-dim disabled:opacity-60";

type DeviceState = "checking" | "unsupported" | "home-screen" | "off" | "on" | "blocked";

/** Settings: turn sign-in requests on or off for the browser this is open in. */
export function PushDeviceSetup() {
  const [state, setState] = useState<DeviceState>("checking");
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: DeviceState;
      if (needsHomeScreen()) next = "home-screen";
      else if (!pushSupported()) next = "unsupported";
      else if (Notification.permission === "denied") next = "blocked";
      else {
        const sub = await (await registration()).pushManager.getSubscription();
        next = sub && (await pushDeviceKnownAction(sub.endpoint)) ? "on" : "off";
      }
      if (!cancelled) setState(next);
    })().catch(() => !cancelled && setState("unsupported"));
    return () => {
      cancelled = true;
    };
  }, []);

  function turnOn() {
    setMessage(null);
    startTransition(async () => {
      try {
        if ((await Notification.requestPermission()) !== "granted") {
          setState(Notification.permission === "denied" ? "blocked" : "off");
          setMessage({ ok: false, text: "Notifications weren't allowed." });
          return;
        }
        const reg = await registration();
        const key = await pushPublicKeyAction();
        let sub = await reg.pushManager.getSubscription();
        // One made against another server key can't be used; start over.
        if (sub && sub.options.applicationServerKey) {
          const current = new Uint8Array(sub.options.applicationServerKey);
          const wanted = urlBase64ToUint8Array(key);
          if (current.length !== wanted.length || current.some((b, i) => b !== wanted[i])) {
            await sub.unsubscribe();
            sub = null;
          }
        }
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
        const json = sub.toJSON();
        const result = await addPushDeviceAction(
          { endpoint: sub.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } },
          name,
        );
        if (!result.ok) {
          setMessage({ ok: false, text: result.error });
          return;
        }
        setState("on");
        setName("");
        setMessage({ ok: true, text: "This device will get sign-in requests." });
      } catch {
        setMessage({ ok: false, text: "This browser couldn't turn on notifications." });
      }
    });
  }

  function turnOff() {
    setMessage(null);
    startTransition(async () => {
      const sub = await (await registration()).pushManager.getSubscription();
      if (sub) {
        await forgetThisPushDeviceAction(sub.endpoint);
        await sub.unsubscribe().catch(() => false);
      }
      setState("off");
    });
  }

  function test() {
    setMessage(null);
    startTransition(async () => {
      const result = await sendTestPushAction();
      setMessage(result.ok ? { ok: true, text: result.message ?? "Sent." } : { ok: false, text: result.error });
    });
  }

  return (
    <div className="space-y-3 text-sm">
      {state === "checking" && <p className="text-muted">Checking this browser…</p>}
      {state === "home-screen" && (
        <p className="rounded-lg border border-dashed border-line p-3 text-muted">
          On iPhone, notifications only reach Home Screen apps. In Safari, tap <strong>Share → Add to Home Screen</strong>, open
          MoneyRight from there, sign in, and come back to this page.
        </p>
      )}
      {state === "unsupported" && (
        <p className="text-muted">
          This browser can&apos;t get push notifications{typeof window !== "undefined" && !window.isSecureContext ? " (it needs the https:// address)" : ""}.
          Open this page on your phone to turn them on there.
        </p>
      )}
      {state === "blocked" && (
        <p className="text-muted">Notifications are blocked for MoneyRight in this browser&apos;s settings. Allow them, then reload.</p>
      )}
      {state === "off" && (
        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="Name, e.g. iPhone"
            aria-label="Device name"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-base outline-none focus:border-accent"
          />
          <button type="button" onClick={turnOn} disabled={pending} className={button}>
            {pending ? "Waiting…" : "Get requests on this device"}
          </button>
        </div>
      )}
      {state === "on" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-good">This device gets sign-in requests.</p>
          <button type="button" onClick={test} disabled={pending} className={button}>
            Send a test
          </button>
          <button type="button" onClick={turnOff} disabled={pending} className={button}>
            Turn off here
          </button>
        </div>
      )}
      {message && <p className={message.ok ? "text-good" : "text-danger"}>{message.text}</p>}
    </div>
  );
}

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "waiting"; number: string; until: number }
  | { kind: "done"; text: string };

/** At sign-in, after the password: ask the phone, show the number, wait. */
export function PushSignInButton() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const [now, setNow] = useState(0);
  const polling = useRef(false);

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() > phase.until + 5_000) {
        setPhase({ kind: "done", text: "The request expired. Send another, or use a code." });
        return;
      }
      if (polling.current) return;
      polling.current = true;
      startTransition(async () => {
        try {
          // On approval the action signs in and redirects; nothing comes back.
          const status = await signInPushStatusAction();
          if (status === "denied") setPhase({ kind: "done", text: "Denied on your phone." });
          else if (status === "expired" || status === "none") setPhase({ kind: "done", text: "The request expired. Send another, or use a code." });
        } finally {
          polling.current = false;
        }
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [phase]);

  function send() {
    setPhase({ kind: "sending" });
    startTransition(async () => {
      const result = await sendSignInPushAction();
      if (!result.ok) {
        setPhase({ kind: "done", text: result.error });
        return;
      }
      setNow(Date.now());
      setPhase({ kind: "waiting", number: result.number, until: Date.now() + result.expiresInSeconds * 1000 });
    });
  }

  if (phase.kind === "waiting") {
    const left = Math.max(0, Math.ceil((phase.until - now) / 1000));
    return (
      <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-4 text-center" aria-live="polite">
        <p className="text-sm text-muted">Tap the notification on your phone and enter</p>
        <p className="font-mono text-5xl font-bold tracking-widest text-accent">{phase.number}</p>
        <p className="text-xs text-muted">Waiting for your phone… {left}s</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={send} disabled={phase.kind === "sending"} className={`w-full ${button}`}>
        {phase.kind === "sending" ? "Sending…" : phase.kind === "done" ? "Send another request to my phone" : "Send a request to my phone"}
      </button>
      {phase.kind === "done" && <p className="text-sm text-danger">{phase.text}</p>}
    </div>
  );
}

const initialApprove: ApproveState = {};

/** On the phone: the request, the number, approve or deny. */
export function ApproveForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(answerApprovalAction, initialApprove);

  if (state.outcome === "approved") {
    return <FormMessage done="Approved. The other screen is signing in now — you can close this." />;
  }
  if (state.outcome === "denied") {
    return (
      <FormMessage error="Denied. If that wasn't you trying to sign in, someone has your password: change it in Settings." />
    );
  }
  if (state.outcome === "gone") {
    return <FormMessage error="This request has expired or was already answered." />;
  }

  return (
    <form action={action} className="space-y-4">
      <FormMessage error={state.error} />
      <input type="hidden" name="token" value={token} />
      <Field
        label="Number on the sign-in screen"
        name="number"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        autoComplete="off"
        autoFocus
      />
      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className="flex-1 rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink disabled:opacity-60"
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          formNoValidate
          disabled={pending}
          className="flex-1 rounded-full border border-danger/50 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-60"
        >
          Deny — it wasn&apos;t me
        </button>
      </div>
    </form>
  );
}
