import { useEffect, useState } from "react";

import type { AuthController, AuthSnapshot, ProfileSyncCoordinator } from "../auth";

export function AuthControls({ auth, coordinator }: { auth: AuthController; coordinator?: ProfileSyncCoordinator }): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => auth.snapshot());
  const [choice, setChoice] = useState<"signout" | "delete" | "reset" | "claim" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionStatus, setActionStatus] = useState<string>();

  useEffect(() => {
    const unsubscribe = auth.subscribe(setSnapshot);
    void auth.initialize().then(() => coordinator?.start()).catch(() => undefined);
    return () => { unsubscribe(); auth.dispose(); };
  }, [auth, coordinator]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    setActionStatus(undefined);
    try { await action(); setChoice(null); setActionStatus("Account action completed."); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Account action failed."); }
    finally { setBusy(false); }
  };

  if (!snapshot.configured) return null;
  if (snapshot.loading) return <span className="auth-status" role="status">Connecting account…</span>;
  if (!snapshot.user) return <div className="auth-controls">{actionError ?? snapshot.error ? <span role="alert">{actionError ?? snapshot.error}</span> : null}<button className="locale-button" disabled={busy} type="button" onClick={() => void run(() => auth.signIn())}>Sign in</button></div>;

  return (
    <div className="auth-controls">
      <span>{snapshot.user.name ?? snapshot.user.email ?? "Signed in"}</span>
      {snapshot.accountClaimRequired ? <><span role="alert">Choose whether this account may upload existing local profiles.</span><button type="button" onClick={() => setChoice("claim")}>Review local profiles</button></> : null}
      {snapshot.epochResetRequired ? <><span role="alert">Hosted data was reset. Review local profiles before reconnecting.</span><button type="button" onClick={() => setChoice("reset")}>Review reset</button></> : null}
      {actionError ?? snapshot.error ? <span role="alert">{actionError ?? snapshot.error}</span> : null}
      {busy || actionStatus ? <span role="status">{busy ? "Working…" : actionStatus}</span> : null}
      <button type="button" disabled={busy || snapshot.epochResetRequired || snapshot.accountClaimRequired} onClick={() => void run(() => coordinator?.manual() ?? auth.sync())}>Sync now</button>
      <button type="button" disabled={busy} onClick={() => setChoice("signout")}>Sign out</button>
      <button type="button" disabled={busy} onClick={() => setChoice("delete")}>Delete hosted data</button>
      {choice ? (
        <div className="auth-choice" role="dialog" aria-modal="true" aria-label={choice === "signout" ? "Sign out options" : choice === "delete" ? "Delete hosted data options" : choice === "reset" ? "Hosted reset options" : "Local profile upload options"}>
          <p>{choice === "signout" ? "Choose what Rootline keeps on this device." : choice === "delete" ? "Hosted profiles will be permanently deleted and the sync epoch will rotate." : choice === "reset" ? snapshot.epochResetPreservesConsentedOutbox ? "Accept the existing hosted epoch. Explicitly consented local profiles remain queued and will be uploaded; other stale cloud-owned changes are never retained." : "Accept the new hosted epoch. Stale queued changes will be discarded and will not be uploaded." : "These profiles may contain absolute paths. Choose whether to upload existing queued profiles to this account."}</p>
          <button type="button" disabled={busy} onClick={() => void run(() => choice === "signout" ? auth.signOut(false) : choice === "delete" ? auth.deleteAccountData(false) : choice === "reset" ? auth.resolveEpochReset(false) : auth.resolveAccountClaim(true))}>{choice === "claim" ? "Upload existing profiles" : "Keep local profiles"}</button>
          <button type="button" disabled={busy} onClick={() => void run(() => choice === "signout" ? auth.signOut(true) : choice === "delete" ? auth.deleteAccountData(true) : choice === "reset" ? auth.resolveEpochReset(true) : auth.resolveAccountClaim(false))}>{choice === "claim" ? "Keep local only" : "Remove local profiles"}</button>
          <button type="button" disabled={busy} onClick={() => setChoice(null)}>Cancel</button>
        </div>
      ) : null}
    </div>
  );
}
