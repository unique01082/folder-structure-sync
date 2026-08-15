import { useEffect, useId, useRef, useState } from "react";
import { validateSyncProfile } from "@rootline/contracts";

import { DiffTree } from "./components/DiffTree";
import { AuthControls } from "./components/AuthControls";
import type { AuthController, ProfileSyncCoordinator } from "./auth";
import { copy, type Locale } from "./i18n";
import {
  nativeFailure,
  tauriGateway,
  type ApplyResult,
  type NativeGateway,
  type Profile,
  type ScanPlan,
  type ScanRequest,
} from "./native";

type Step = "choose" | "scanning" | "review" | "applying" | "result";
type RebindRole = "source" | "target" | null;

interface AppProps {
  gateway?: NativeGateway;
  initialProfile?: Profile;
  auth?: AuthController;
  syncCoordinator?: ProfileSyncCoordinator;
}

const defaultExclusions = [".git", ".svn", ".hg", "node_modules", ".DS_Store", "Thumbs.db", "dist", "build"];

function operationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function Mark(): React.JSX.Element {
  return (
    <svg className="brand-mark" aria-hidden="true" viewBox="0 0 48 48">
      <path className="mark-soft" d="M13 9h13a8 8 0 0 1 8 8v2" />
      <path className="mark-line" d="M13 9v30M13 23h21M13 39h13" />
      <circle className="mark-moss" cx="34" cy="23" r="3.5" />
      <circle className="mark-amber" cx="26" cy="39" r="3.5" />
    </svg>
  );
}

export function App({ gateway = tauriGateway, initialProfile, auth, syncCoordinator }: AppProps): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>("en");
  const text = copy[locale];
  const [profiles, setProfiles] = useState<Profile[]>(initialProfile ? [initialProfile] : []);
  const [activeProfile, setActiveProfile] = useState<Profile | undefined>(initialProfile);
  const [profileName, setProfileName] = useState(initialProfile?.name ?? "");
  const [sourcePath, setSourcePath] = useState(initialProfile?.sourcePath ?? "");
  const [targetPath, setTargetPath] = useState(initialProfile?.targetPath ?? "");
  const [step, setStep] = useState<Step>("choose");
  const [plan, setPlan] = useState<ScanPlan>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<ApplyResult>();
  const [error, setError] = useState<string>();
  const [rebind, setRebind] = useState<RebindRole>(null);
  const [activeOperation, setActiveOperation] = useState<string>();
  const [deleteCandidate, setDeleteCandidate] = useState<Profile>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const newProfileRef = useRef<HTMLButtonElement>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const returnToScanRef = useRef(false);
  const profileNameId = useId();
  const deleteDialogTitleId = useId();

  const reconcileProfiles = (loaded: Profile[]): void => {
    setProfiles(loaded);
    setActiveProfile((current) => {
      if (!current) return undefined;
      const replacement = loaded.find((profile) => profile.id === current.id);
      if (replacement) {
        setProfileName(replacement.name);
        setSourcePath(replacement.sourcePath);
        setTargetPath(replacement.targetPath);
      } else {
        setProfileName("");
        setSourcePath("");
        setTargetPath("");
        setPlan(undefined);
        setResult(undefined);
        setStep("choose");
      }
      return replacement;
    });
  };

  useEffect(() => {
    if (initialProfile) return;
    let live = true;
    void gateway.listProfiles().then((loaded) => {
      if (live) reconcileProfiles(loaded);
    }).catch(() => {
      // A first-run database failure is surfaced when the user saves; choosing folders still works.
    });
    return () => { live = false; };
  }, [gateway, initialProfile]);

  useEffect(() => {
    if (!auth) return;
    let live = true;
    let dataVersion = auth.snapshot().dataVersion;
    const unsubscribe = auth.subscribe((snapshot) => {
      if (!live || snapshot.dataVersion === dataVersion) return;
      dataVersion = snapshot.dataVersion;
      void gateway.listProfiles().then((loaded) => {
        if (live) reconcileProfiles(loaded);
      }).catch(() => setError("Local profiles changed, but Rootline could not refresh the list."));
    });
    return () => { live = false; unsubscribe(); };
  }, [auth, gateway]);

  useEffect(() => {
    if (step === "choose" && returnToScanRef.current) {
      returnToScanRef.current = false;
      scanButtonRef.current?.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [step]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (deleteCandidate) deleteCancelRef.current?.focus();
  }, [deleteCandidate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || (step !== "review" && step !== "result")) return;
      event.preventDefault();
      returnToScanRef.current = true;
      setStep("choose");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step]);

  const choose = async (role: "source" | "target"): Promise<void> => {
    const path = await gateway.chooseFolder({ role });
    if (!path) return;
    if (role === "source") setSourcePath(path);
    else setTargetPath(path);
    setRebind(null);
    setError(undefined);
    setStep("choose");
  };

  const makeRequest = (id: string): ScanRequest => ({
    operationId: id,
    sourcePath,
    targetPath,
    exclusions: activeProfile?.exclusions ?? defaultExclusions,
  });

  const scan = async (): Promise<void> => {
    const id = operationId("scan");
    setError(undefined);
    setRebind(null);
    setActiveOperation(id);
    setStep("scanning");
    try {
      const nextPlan = await gateway.scan(makeRequest(id));
      setPlan(nextPlan);
      setSelected(new Set(nextPlan.missing));
      setStep("review");
    } catch (unknownError) {
      const failure = nativeFailure(unknownError);
      if (failure.code === "CANCELLED") {
        returnToScanRef.current = true;
        setStep("choose");
      } else if (failure.code === "SOURCE_NOT_FOUND") {
        setRebind("source");
        setError(text.sourceMissing);
        setStep("choose");
      } else if (failure.code === "TARGET_NOT_FOUND") {
        setRebind("target");
        setError(text.targetMissing);
        setStep("choose");
      } else {
        setError(text.genericError);
        setStep("choose");
      }
    } finally {
      setActiveOperation(undefined);
    }
  };

  const apply = async (): Promise<void> => {
    if (!plan) return;
    const id = operationId("apply");
    setActiveOperation(id);
    setError(undefined);
    setStep("applying");
    try {
      const nextResult = await gateway.apply({
        request: makeRequest(id),
        plan: { ...plan, operationId: id },
        selected: [...selected],
        ...(activeProfile ? { profileId: activeProfile.id } : {}),
      });
      setResult(nextResult);
      setStep("result");
    } catch (unknownError) {
      const failure = nativeFailure(unknownError);
      setError(
        failure.code === "STALE_PLAN" ? text.stalePlan
          : failure.code === "SOURCE_NOT_FOUND" ? text.sourceMissing
            : failure.code === "TARGET_NOT_FOUND" ? text.targetMissing
              : failure.code === "CANCELLED" ? text.operationCancelled
                : text.genericError,
      );
      setStep("review");
    } finally {
      setActiveOperation(undefined);
    }
  };

  const cancel = async (): Promise<void> => {
    if (activeOperation) await gateway.cancel(activeOperation);
  };

  const selectProfile = (profile: Profile): void => {
    setActiveProfile(profile);
    setProfileName(profile.name);
    setSourcePath(profile.sourcePath);
    setTargetPath(profile.targetPath);
    setPlan(undefined);
    setResult(undefined);
    setError(undefined);
    setStep("choose");
  };

  const requestProfileDelete = (profile: Profile, returnFocus: HTMLElement): void => {
    deleteReturnFocusRef.current = returnFocus;
    setDeleteCandidate(profile);
  };

  const closeProfileDelete = (): void => {
    setDeleteCandidate(undefined);
    queueMicrotask(() => deleteReturnFocusRef.current?.focus());
  };

  const onDeleteDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeProfileDelete();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [...(deleteDialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
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

  const onProfileKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = (index + delta + profiles.length) % profiles.length;
      document.querySelector<HTMLButtonElement>(`[data-profile-index="${next}"]`)?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectProfile(profiles[index]!);
    } else if (event.key === "Delete") {
      event.preventDefault();
      requestProfileDelete(profiles[index]!, event.currentTarget);
    }
  };

  const newProfile = (): void => {
    setActiveProfile(undefined);
    setProfileName("");
    setSourcePath("");
    setTargetPath("");
    setPlan(undefined);
    setResult(undefined);
    setStep("choose");
  };

  const saveProfile = async (): Promise<void> => {
    const now = new Date().toISOString();
    const profile: Profile = {
      id: activeProfile?.id ?? crypto.randomUUID(),
      name: profileName.trim(),
      sourcePath,
      targetPath,
      exclusions: activeProfile?.exclusions ?? defaultExclusions,
      createdAt: activeProfile?.createdAt ?? now,
      updatedAt: now,
    };
    const issue = validateSyncProfile(profile)[0];
    if (issue) {
      setError(issue.field === "name" ? text.profileNameInvalid : text.profileInvalid);
      return;
    }
    setError(undefined);
    try {
      const saved = await gateway.saveProfile(profile);
      setProfiles((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)]);
      setActiveProfile(saved);
      setProfileName(saved.name);
      syncCoordinator?.profileEdited();
    } catch (unknownError) {
      const failure = nativeFailure(unknownError);
      setError(failure.code === "VALIDATION_FAILED" ? text.profileInvalid : text.genericError);
    }
  };

  const deleteProfile = async (): Promise<void> => {
    if (!deleteCandidate) return;
    const deletedId = deleteCandidate.id;
    try {
      await gateway.deleteProfile(deletedId);
      setProfiles((current) => current.filter((profile) => profile.id !== deletedId));
      if (activeProfile?.id === deletedId) {
        setActiveProfile(undefined);
        setProfileName("");
        setSourcePath("");
        setTargetPath("");
        setPlan(undefined);
        setResult(undefined);
        setRebind(null);
        setStep("choose");
      }
      setDeleteCandidate(undefined);
      setError(undefined);
      syncCoordinator?.profileEdited();
      queueMicrotask(() => newProfileRef.current?.focus());
    } catch {
      setDeleteCandidate(undefined);
      setError(text.genericError);
      queueMicrotask(() => deleteReturnFocusRef.current?.focus());
    }
  };

  const createdCount = result?.directories.filter((entry) => entry.status === "created").length ?? 0;
  const currentStep = step === "choose" ? 0 : step === "scanning" ? 1 : step === "review" ? 2 : 3;

  return (
    <div className="app-shell">
      <aside className="profile-rail" aria-label={text.profiles}>
        <div className="brand">
          <Mark />
          <div><strong>Rootline</strong><span>by baole.space</span></div>
        </div>
        <div className="rail-label"><span>{text.profiles}</span><span>{profiles.length}</span></div>
        <div className="profile-list" role={profiles.length ? "listbox" : "note"} aria-label={text.profiles}>
          {profiles.length === 0 ? <span className="sr-only">{text.noProfiles}</span> : null}
          {profiles.map((profile, index) => (
            <button
              type="button"
              role="option"
              aria-label={profile.name}
              aria-selected={activeProfile?.id === profile.id}
              className="profile-item"
              data-profile-index={index}
              key={profile.id}
              onKeyDown={(event) => onProfileKeyDown(event, index)}
              onClick={() => selectProfile(profile)}
            >
              <span className="profile-dot" aria-hidden="true" />
              <span><strong>{profile.name}</strong><small>{profile.sourcePath.split(/[\\/]/).pop()}</small></span>
            </button>
          ))}
        </div>
        <button ref={newProfileRef} className="new-profile" type="button" onClick={newProfile}><span aria-hidden="true">＋</span>{text.newProfile}</button>
        {activeProfile ? (
          <button
            className="delete-profile"
            type="button"
            aria-label={text.deleteProfile(activeProfile.name)}
            onClick={(event) => requestProfileDelete(activeProfile, event.currentTarget)}
          >
            <span aria-hidden="true">−</span>{text.deleteProfile(activeProfile.name)}
          </button>
        ) : null}
        <div className="rail-footer"><span className="offline-dot" aria-hidden="true" />{text.offline}</div>
      </aside>

      <main className="workbench">
        <header className="topbar">
          <nav aria-label={text.workflowProgress}>
            <ol className="steps">
              {text.steps.map((label, index) => (
                <li key={label} aria-current={currentStep === index ? "step" : undefined} className={currentStep >= index ? "reached" : ""}>
                  <span>{index + 1}</span>{label}
                </li>
              ))}
            </ol>
          </nav>
          <div className="topbar-actions">
            {auth ? <AuthControls auth={auth} locale={locale} {...(syncCoordinator ? { coordinator: syncCoordinator } : {})} /> : null}
            <button className="locale-button" type="button" onClick={() => setLocale(locale === "en" ? "vi" : "en")}>{text.localeButton}</button>
          </div>
        </header>

        <div className="workspace">
          {step === "choose" ? (
            <section className="stage choose-stage" aria-labelledby="choose-title">
              <p className="eyebrow">{text.chooseEyebrow}</p>
              <h1 id="choose-title" ref={headingRef} tabIndex={-1}>{text.chooseTitle}</h1>
              <p className="lede">{text.chooseBody}</p>
              {error ? <div className="error-card" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div> : null}
              <div className="root-pair">
                <article className={rebind === "source" ? "root-card needs-rebind" : "root-card"}>
                  <span className="root-number">01</span><div className="root-copy"><small>{text.source}</small><strong>{sourcePath || text.notChosen}</strong></div>
                  <button type="button" onClick={() => void choose("source")}>{rebind === "source" ? text.rebindSource : text.chooseSource}</button>
                </article>
                <div className="flow-arrow" aria-hidden="true">→</div>
                <article className={rebind === "target" ? "root-card needs-rebind" : "root-card"}>
                  <span className="root-number">02</span><div className="root-copy"><small>{text.target}</small><strong>{targetPath || text.notChosen}</strong></div>
                  <button type="button" onClick={() => void choose("target")}>{rebind === "target" ? text.rebindTarget : text.chooseTarget}</button>
                </article>
              </div>
              <div className="profile-save">
                <label htmlFor={profileNameId}>{text.profileName}</label>
                <input
                  id={profileNameId}
                  value={profileName}
                  required
                  onChange={(event) => setProfileName(event.currentTarget.value)}
                />
                <button type="button" className="secondary-button" disabled={!sourcePath || !targetPath} onClick={() => void saveProfile()}>{text.save}</button>
              </div>
              <button ref={scanButtonRef} className="primary-button" type="button" disabled={!sourcePath || !targetPath} onClick={() => void scan()}>{text.scan}<span aria-hidden="true">↗</span></button>
            </section>
          ) : null}

          {step === "scanning" || step === "applying" ? (
            <section className="stage progress-stage" aria-labelledby="progress-title">
              <div className="scan-figure" aria-hidden="true">
                <div className="scan-trunk"><i /><i /><i /><i /></div>
                <div className="scan-line" />
              </div>
              <h1 id="progress-title" ref={headingRef} tabIndex={-1}>{step === "scanning" ? text.scanning : text.applying}</h1>
              <div role="status" className="progress-status">{step === "scanning" ? text.scanning : text.applying}</div>
              <button className="secondary-button" type="button" onClick={() => void cancel()}>{text.cancel}</button>
            </section>
          ) : null}

          {step === "review" && plan ? (
            <section className="stage review-stage" aria-labelledby="review-title">
              <p className="eyebrow">{text.reviewEyebrow(plan.targetCaseSensitive)}</p>
              <h1 id="review-title" ref={headingRef} tabIndex={-1}>{text.review(plan.missing.length)}</h1>
              <p className="lede">{text.reviewBody}</p>
              {error ? <div className="error-card" role="alert"><span aria-hidden="true">!</span><p>{error}</p></div> : null}
              {plan.skippedLinks.length ? <p className="safety-note">{text.skipped(plan.skippedLinks.length)}</p> : null}
              {plan.missing.length === 0 ? (
                <div className="empty-state"><Mark /><h2>{text.empty}</h2><p>{text.emptyBody}</p></div>
              ) : null}
              {plan.diffEntries.length ? (
                <DiffTree
                  entries={plan.diffEntries}
                  selected={selected}
                  onSelectionChange={setSelected}
                  labels={text.tree}
                />
              ) : null}
              <div className="review-actions">
                <button className="secondary-button" type="button" onClick={() => setStep("choose")}>{text.newPair}</button>
                {plan.missing.length ? <button aria-label={text.apply} className="primary-button" type="button" disabled={selected.size === 0} onClick={() => void apply()}>{text.apply}<span>{selected.size.toLocaleString()}</span></button> : null}
              </div>
            </section>
          ) : null}

          {step === "result" && result ? (
            <section className="stage result-stage" aria-labelledby="result-title">
              <div className={result.cancelled ? "result-mark cancelled" : "result-mark"} aria-hidden="true">{result.cancelled ? "‖" : "✓"}</div>
              <p className="eyebrow">{text.resultEyebrow}</p>
              <h1 id="result-title" ref={headingRef} tabIndex={-1}>{result.cancelled ? text.cancelledResult(createdCount) : text.result(createdCount)}</h1>
              <p className="lede">{result.cancelled ? text.cancelledBody : text.resultBody}</p>
              <div className="result-summary">
                <div><strong>{createdCount}</strong><span>{text.created}</span></div>
                <div><strong>{result.directories.filter((entry) => entry.status === "already-exists").length}</strong><span>{text.alreadyExists}</span></div>
                <div><strong>{result.directories.filter((entry) => entry.status === "failed").length}</strong><span>{text.failed}</span></div>
              </div>
              <ul className="result-details">
                {result.directories.map((entry) => (
                  <li className={`status-${entry.status}`} key={entry.relativePath}>
                    <span className="result-path">{entry.relativePath}</span>
                    <span className="result-status">{entry.status === "created" ? text.created : entry.status === "already-exists" ? text.alreadyExists : text.failed}</span>
                    {entry.error ? <small>{entry.error}</small> : null}
                  </li>
                ))}
              </ul>
              {result.directories.some((entry) => entry.status === "failed") ? <p className="failure-action">{text.failureAction}</p> : null}
              <div className="review-actions">
                <button className="secondary-button" type="button" onClick={() => { setPlan(undefined); setResult(undefined); setStep("choose"); }}>{text.newPair}</button>
                <button className="primary-button" type="button" onClick={() => void scan()}>{text.again}<span aria-hidden="true">↗</span></button>
              </div>
            </section>
          ) : null}
        </div>
      </main>
      {deleteCandidate ? (
        <div className="modal-backdrop">
          <div
            ref={deleteDialogRef}
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={deleteDialogTitleId}
            onKeyDown={onDeleteDialogKeyDown}
          >
            <h2 id={deleteDialogTitleId}>{text.deleteProfileTitle(deleteCandidate.name)}</h2>
            <p>{text.deleteProfileBody}</p>
            <div className="confirm-actions">
              <button ref={deleteCancelRef} type="button" className="secondary-button" onClick={closeProfileDelete}>{text.cancelProfileDelete}</button>
              <button type="button" className="danger-button" onClick={() => void deleteProfile()}>{text.confirmProfileDelete}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
