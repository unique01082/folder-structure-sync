import { useEffect, useRef, useState } from "react";

import type { AuthController, AuthSnapshot, ProfileSyncCoordinator } from "../auth";
import { authCopy, type Locale } from "../i18n";

type Choice = "signout" | "delete" | "reset" | "claim";

interface AuthControlsProps {
  auth: AuthController;
  coordinator?: ProfileSyncCoordinator;
  locale?: Locale;
}

export function AuthControls({ auth, coordinator, locale = "en" }: AuthControlsProps): React.JSX.Element | null {
  const text = authCopy[locale];
  const [snapshot, setSnapshot] = useState<AuthSnapshot>(() => auth.snapshot());
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionStatus, setActionStatus] = useState<string>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const dialogCancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const unsubscribe = auth.subscribe(setSnapshot);
    void auth.initialize().then(() => coordinator?.start()).catch(() => undefined);
    return () => { unsubscribe(); auth.dispose(); };
  }, [auth, coordinator]);

  useEffect(() => {
    if (choice) dialogCancelRef.current?.focus();
  }, [choice]);

  const closeChoice = (restoreFocus = true): void => {
    setChoice(null);
    if (restoreFocus) queueMicrotask(() => returnFocusRef.current?.focus());
  };

  const openChoice = (next: Choice, trigger: HTMLButtonElement): void => {
    returnFocusRef.current = trigger;
    setChoice(next);
  };

  const onDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      closeChoice();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const run = async (action: () => Promise<void>, announceCompletion = true): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    setActionStatus(undefined);
    try {
      await action();
      if (choice) closeChoice();
      if (announceCompletion) setActionStatus(text.actionCompleted);
    } catch {
      setActionError(text.authFailed);
    } finally {
      setBusy(false);
    }
  };

  const snapshotError = snapshot.error
    ? snapshot.error === "AUTH_SIGNIN_TIMEOUT" ? text.signInTimeout : text.authFailed
    : undefined;

  if (!snapshot.configured) return null;
  if (snapshot.loading) return <span className="auth-status" role="status">{text.connecting}</span>;
  if (!snapshot.user) {
    return (
      <div className="auth-controls">
        {actionError ?? snapshotError ? <span role="alert">{actionError ?? snapshotError}</span> : null}
        {snapshot.signInPending ? (
          <>
            <span role="status">{text.pending}</span>
            <button type="button" disabled={busy} onClick={() => void run(() => auth.cancelSignIn(), false)}>{text.cancelSignIn}</button>
            <button type="button" disabled={busy} onClick={() => void run(() => auth.signIn(), false)}>{text.retrySignIn}</button>
          </>
        ) : (
          <button className="locale-button" disabled={busy} type="button" onClick={() => void run(() => auth.signIn(), false)}>{text.signIn}</button>
        )}
      </div>
    );
  }

  const dialogBody = choice === "signout" ? text.dialogBody.signout
    : choice === "delete" ? text.dialogBody.delete
      : choice === "reset" ? snapshot.epochResetPreservesConsentedOutbox ? text.dialogBody.resetPreserved : text.dialogBody.reset
        : text.dialogBody.claim;

  return (
    <div className="auth-controls">
      <span>{snapshot.user.name ?? snapshot.user.email ?? text.signedIn}</span>
      {snapshot.accountClaimRequired ? <><span role="alert">{text.accountClaimAlert}</span><button type="button" onClick={(event) => openChoice("claim", event.currentTarget)}>{text.reviewLocal}</button></> : null}
      {snapshot.epochResetRequired ? <><span role="alert">{text.epochResetAlert}</span><button type="button" onClick={(event) => openChoice("reset", event.currentTarget)}>{text.reviewReset}</button></> : null}
      {actionError ?? snapshotError ? <span role="alert">{actionError ?? snapshotError}</span> : null}
      {snapshot.quarantinedMutations ? <span role="status">{text.quarantine(snapshot.quarantinedMutations)}</span> : null}
      {busy || actionStatus ? <span role="status">{busy ? text.working : actionStatus}</span> : null}
      <button type="button" disabled={busy || snapshot.epochResetRequired || snapshot.accountClaimRequired} onClick={() => void run(() => coordinator?.manual() ?? auth.sync())}>{text.syncNow}</button>
      <button type="button" disabled={busy} onClick={(event) => openChoice("signout", event.currentTarget)}>{text.signOut}</button>
      <button type="button" disabled={busy} onClick={(event) => openChoice("delete", event.currentTarget)}>{text.deleteHosted}</button>
      {choice ? (
        <div
          ref={dialogRef}
          className="auth-choice"
          role="dialog"
          aria-modal="true"
          aria-label={text.dialogLabel[choice]}
          onKeyDown={onDialogKeyDown}
        >
          <p>{dialogBody}</p>
          <button ref={dialogCancelRef} type="button" disabled={busy} onClick={() => closeChoice()}>{text.cancel}</button>
          <button type="button" disabled={busy} onClick={() => void run(() => choice === "signout" ? auth.signOut(false) : choice === "delete" ? auth.deleteAccountData(false) : choice === "reset" ? auth.resolveEpochReset(false) : auth.resolveAccountClaim(true))}>{choice === "claim" ? text.uploadExisting : text.keepLocal}</button>
          <button type="button" disabled={busy} onClick={() => void run(() => choice === "signout" ? auth.signOut(true) : choice === "delete" ? auth.deleteAccountData(true) : choice === "reset" ? auth.resolveEpochReset(true) : auth.resolveAccountClaim(false))}>{choice === "claim" ? text.keepLocalOnly : text.removeLocal}</button>
        </div>
      ) : null}
    </div>
  );
}
