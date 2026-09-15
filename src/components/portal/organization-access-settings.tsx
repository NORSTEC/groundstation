"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  completeOrganizationDomainVerification,
  previewOrganizationDomain,
  removeOrganizationDomain,
  startOrganizationDomainVerification,
  trustOrganizationDomain,
  type PortalManagementResult,
} from "@/app/(portal)/admin/actions";
import { ConfirmDialog } from "@/components/portal/confirm-dialog";
import { Toast } from "@/components/portal/toast";

export type OrganizationAccess = {
  domains: Array<{
    domain: string;
    verifiedAt: string | null;
    verificationMethod:
      | "legacy_admin_attestation"
      | "dns_txt"
      | "portal_admin_attestation";
  }>;
  id: number;
  name: string;
};

type Preview = {
  addressCount: number;
  domain: string;
  wouldJoinCount: number;
};

type DomainVerification = {
  domain: string;
  organizationId: number;
  recordName: string;
  recordValue: string;
  token: string;
};

function verificationStatusLabel(
  domain: OrganizationAccess["domains"][number],
) {
  if (!domain.verifiedAt) return "Not trusted";
  return domain.verificationMethod === "dns_txt"
    ? "DNS verified"
    : domain.verificationMethod === "portal_admin_attestation"
      ? "Trusted by portal administrator"
      : "Legacy mapping — action required";
}

function isTrustedMapping(domain: OrganizationAccess["domains"][number]) {
  return Boolean(
    domain.verifiedAt &&
      (domain.verificationMethod === "dns_txt" ||
        domain.verificationMethod === "portal_admin_attestation"),
  );
}

export function OrganizationAccessSettings({
  organizations,
}: {
  organizations: OrganizationAccess[];
}) {
  const router = useRouter();
  const [domainDrafts, setDomainDrafts] = useState<Record<number, string>>({});
  const [previews, setPreviews] = useState<Record<number, Preview | null>>({});
  const [verification, setVerification] =
    useState<DomainVerification | null>(null);
  const verificationPanelRef = useRef<HTMLDivElement>(null);
  const [copiedField, setCopiedField] = useState<
    "recordName" | "recordValue" | null
  >(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{
    domain: string;
    organizationName: string;
  } | null>(null);
  const [pendingTrust, setPendingTrust] = useState<{
    domain: string;
    organizationId: number;
    organizationName: string;
  } | null>(null);
  const [toast, setToast] = useState<{
    id: number;
    message: string;
    status: "success" | "error";
  } | null>(null);
  const [busy, startTransition] = useTransition();

  useEffect(() => {
    if (!verification) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = verificationPanelRef.current;
      if (!panel) return;
      panel.focus({ preventScroll: true });
      panel.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [verification]);

  function run(action: () => Promise<PortalManagementResult>) {
    startTransition(async () => {
      const result = await action();
      setToast({
        id: Date.now(),
        message: result.message,
        status: result.ok ? "success" : "error",
      });
      if (result.ok) router.refresh();
    });
  }

  // Registering a domain turns every address on it into an organization
  // address and can make a later access request eligible for automatic
  // approval. The number separates an exact domain from a typo, so it is shown
  // before anything is written.
  function checkDomain(organizationId: number) {
    const domain = (domainDrafts[organizationId] ?? "").trim().toLowerCase();
    if (!domain) return;

    startTransition(async () => {
      const result = await previewOrganizationDomain({
        domain,
        organizationId,
      });

      if (!result.ok) {
        setToast({ id: Date.now(), message: result.message, status: "error" });
        return;
      }

      if (result.reservedReason) {
        setPreviews((current) => ({ ...current, [organizationId]: null }));
        setToast({
          id: Date.now(),
          message:
            result.reservedReason === "shared_institution"
              ? `${domain} belongs to a whole institution, so it cannot say which organization somebody is in.`
              : `${domain} is a mailbox provider, so it says nothing about who anybody belongs to.`,
          status: "error",
        });
        return;
      }

      setPreviews((current) => ({
        ...current,
        [organizationId]: {
          addressCount: result.addressCount ?? 0,
          domain,
          wouldJoinCount: result.wouldJoinCount ?? 0,
        },
      }));
    });
  }

  function beginVerification(organizationId: number, domain: string) {
    const action = `start-verification:${organizationId}:${domain}`;
    setPendingAction(action);
    startTransition(async () => {
      try {
        const result = await startOrganizationDomainVerification({
          domain,
          organizationId,
        });

        if (
          !result.ok ||
          !result.domain ||
          !result.recordName ||
          !result.recordValue ||
          !result.token
        ) {
          setToast({
            id: Date.now(),
            message: result.message,
            status: "error",
          });
          return;
        }

        setCopiedField(null);
        setVerification({
          domain: result.domain,
          organizationId,
          recordName: result.recordName,
          recordValue: result.recordValue,
          token: result.token,
        });
        setToast({ id: Date.now(), message: result.message, status: "success" });
      } finally {
        setPendingAction(null);
      }
    });
  }

  function checkVerification() {
    if (!verification) return;
    setPendingAction("check-verification");
    startTransition(async () => {
      try {
        const result = await completeOrganizationDomainVerification({
          domain: verification.domain,
          organizationId: verification.organizationId,
          token: verification.token,
        });
        setToast({
          id: Date.now(),
          message: result.message,
          status: result.ok ? "success" : "error",
        });
        if (!result.ok) return;

        setDomainDrafts((current) => ({
          ...current,
          [verification.organizationId]: "",
        }));
        setPreviews((current) => ({
          ...current,
          [verification.organizationId]: null,
        }));
        setVerification(null);
        router.refresh();
      } finally {
        setPendingAction(null);
      }
    });
  }

  async function copyDnsValue(
    field: "recordName" | "recordValue",
    value: string,
  ) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
    } catch {
      setToast((current) => ({
        id: (current?.id ?? 0) + 1,
        message: "The DNS value could not be copied. Select and copy it manually.",
        status: "error",
      }));
    }
  }

  return (
    <>
      {toast && (
        <Toast key={toast.id} message={toast.message} status={toast.status} />
      )}

      <div className="grid gap-5">
        {organizations.map((organization) => {
          const preview = previews[organization.id] ?? null;

          return (
            <section
              aria-labelledby={`organization-${organization.id}-heading`}
              className="portal-surface p-6 sm:p-7"
              key={organization.id}
            >
              <h2
                className="text-h3"
                id={`organization-${organization.id}-heading`}
              >
                {organization.name}
              </h2>

              <p className="mt-4 max-w-[65ch] text-sm leading-relaxed opacity-65">
                A trusted mapping detects the organization from Google. The
                person still sends a request; a first membership is approved
                automatically. Ended, suspended and planned memberships always
                require review.
              </p>

              <div className="mt-8">
                <h3 className="section-label opacity-45">Domains</h3>
                <ul className="mt-3 grid gap-2">
                  {organization.domains.map((domain) => (
                    <li
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-moody/10 py-3 last:border-b-0"
                      key={domain.domain}
                    >
                      <span className="break-all font-medium">
                        {domain.domain}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-sm opacity-60">
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[1.05rem]"
                        >
                          {isTrustedMapping(domain) ? "verified" : "warning"}
                        </span>
                        {verificationStatusLabel(domain)}
                      </span>
                      {(!domain.verifiedAt ||
                        domain.verificationMethod ===
                          "legacy_admin_attestation") && (
                        <div className="ml-auto flex flex-wrap gap-2">
                          <button
                            className="portal-button"
                            disabled={busy}
                            onClick={() =>
                              setPendingTrust({
                                domain: domain.domain,
                                organizationId: organization.id,
                                organizationName: organization.name,
                              })
                            }
                            type="button"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[1.1rem]"
                            >
                              verified_user
                            </span>
                            Trust mapping
                          </button>
                          <button
                            className="portal-button"
                            disabled={busy}
                            onClick={() =>
                              beginVerification(organization.id, domain.domain)
                            }
                            type="button"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[1.1rem]"
                            >
                              {pendingAction ===
                              `start-verification:${organization.id}:${domain.domain}`
                                ? "progress_activity"
                                : "domain_verification"}
                            </span>
                            {pendingAction ===
                            `start-verification:${organization.id}:${domain.domain}`
                              ? "Preparing…"
                              : "Verify with DNS"}
                          </button>
                        </div>
                      )}
                      <button
                        className={`portal-button ${
                          isTrustedMapping(domain) ? "ml-auto" : ""
                        }`}
                        disabled={busy}
                        onClick={() =>
                          setPendingRemoval({
                            domain: domain.domain,
                            organizationName: organization.name,
                          })
                        }
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[1.1rem]"
                        >
                          close
                        </span>
                        Remove
                      </button>
                    </li>
                  ))}
                  {organization.domains.length === 0 && (
                    <li className="text-sm opacity-60">
                      No domain answers for {organization.name}, so no Google
                      account can prove it belongs here.
                    </li>
                  )}
                </ul>

                {verification?.organizationId === organization.id && (
                  <div
                    className="mt-6 border-t border-moody/20 pt-6 outline-none"
                    ref={verificationPanelRef}
                    tabIndex={-1}
                  >
                    <h3 className="text-xl font-medium">
                      Verify {verification.domain}
                    </h3>
                    <p className="mt-3 max-w-[65ch] text-sm leading-relaxed opacity-65">
                      Add this TXT record in the domain&rsquo;s DNS. Nothing joins
                      the organization until the exact value is visible publicly.
                    </p>
                    <dl className="mt-5 grid gap-4">
                      <div>
                        <dt className="section-label opacity-45">TXT name</dt>
                        <dd className="mt-2 flex items-start gap-2 bg-moody/5 p-3">
                          <code className="min-w-0 flex-1 break-all font-mono text-sm">
                            {verification.recordName}
                          </code>
                          <button
                            aria-label="Copy TXT name"
                            className="portal-button shrink-0"
                            onClick={() =>
                              void copyDnsValue(
                                "recordName",
                                verification.recordName,
                              )
                            }
                            type="button"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[1.1rem]"
                            >
                              {copiedField === "recordName" ? "check" : "content_copy"}
                            </span>
                            {copiedField === "recordName" ? "Copied" : "Copy"}
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt className="section-label opacity-45">TXT value</dt>
                        <dd className="mt-2 flex items-start gap-2 bg-moody/5 p-3">
                          <code className="min-w-0 flex-1 break-all font-mono text-sm">
                            {verification.recordValue}
                          </code>
                          <button
                            aria-label="Copy TXT value"
                            className="portal-button shrink-0"
                            onClick={() =>
                              void copyDnsValue(
                                "recordValue",
                                verification.recordValue,
                              )
                            }
                            type="button"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[1.1rem]"
                            >
                              {copiedField === "recordValue" ? "check" : "content_copy"}
                            </span>
                            {copiedField === "recordValue" ? "Copied" : "Copy"}
                          </button>
                        </dd>
                      </div>
                    </dl>
                    <div className="mt-5 flex flex-wrap gap-3">
                      <button
                        className="portal-button"
                        disabled={busy}
                        onClick={checkVerification}
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[1.1rem]"
                        >
                          {pendingAction === "check-verification"
                            ? "progress_activity"
                            : "dns"}
                        </span>
                        {pendingAction === "check-verification"
                          ? "Checking DNS…"
                          : "Check DNS and verify"}
                      </button>
                      <button
                        className="portal-button"
                        disabled={busy}
                        onClick={() => setVerification(null)}
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[1.1rem]"
                        >
                          close
                        </span>
                        Close instructions
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-5 flex flex-wrap items-end gap-3">
                  <label className="grid min-w-56 flex-1 gap-2">
                    <span className="section-label opacity-45">Add domain</span>
                    <input
                      autoComplete="off"
                      className="portal-field"
                      disabled={busy}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDomainDrafts((current) => ({
                          ...current,
                          [organization.id]: value,
                        }));
                        setPreviews((current) => ({
                          ...current,
                          [organization.id]: null,
                        }));
                      }}
                      placeholder="example.no"
                      spellCheck={false}
                      value={domainDrafts[organization.id] ?? ""}
                    />
                  </label>
                  <button
                    className="portal-button"
                    disabled={busy || !(domainDrafts[organization.id] ?? "").trim()}
                    onClick={() => checkDomain(organization.id)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined text-[1.1rem]"
                    >
                      search
                    </span>
                    Check domain
                  </button>
                </div>

                {preview && (
                  <div className="mt-5 border-t border-moody/20 pt-5">
                    <p className="max-w-[65ch] leading-relaxed">
                      <span className="font-medium">{preview.domain}</span>{" "}
                      matches{" "}
                      {preview.addressCount === 1
                        ? "one address"
                        : `${preview.addressCount} addresses`}{" "}
                      Groundstation already holds.{" "}
                      {`At most ${
                        preview.wouldJoinCount === 1
                          ? "one of them"
                          : `${preview.wouldJoinCount} of them`
                      } has a Google account that can prove this hosted domain. Once the mapping is trusted, a first membership is approved only after that person submits an access request.`}
                    </p>
                    <div className="mt-5 flex flex-wrap gap-3">
                      <button
                        className="portal-button"
                        disabled={busy}
                        onClick={() =>
                          setPendingTrust({
                            domain: preview.domain,
                            organizationId: organization.id,
                            organizationName: organization.name,
                          })
                        }
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[1.1rem]"
                        >
                          verified_user
                        </span>
                        Trust mapping
                      </button>
                      <button
                        className="portal-button"
                        disabled={busy}
                        onClick={() =>
                          beginVerification(organization.id, preview.domain)
                        }
                        type="button"
                      >
                        <span
                          aria-hidden="true"
                          className="material-symbols-outlined text-[1.1rem]"
                        >
                          {pendingAction ===
                          `start-verification:${organization.id}:${preview.domain}`
                            ? "progress_activity"
                            : "domain_verification"}
                        </span>
                        {pendingAction ===
                        `start-verification:${organization.id}:${preview.domain}`
                          ? `Preparing ${preview.domain}…`
                          : `Verify ${preview.domain} with DNS`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {pendingTrust && (
        <ConfirmDialog
          busy={busy}
          confirmIcon="verified_user"
          confirmLabel="Trust mapping"
          onCancel={() => setPendingTrust(null)}
          onConfirm={() => {
            const { domain, organizationId } = pendingTrust;
            setPendingTrust(null);
            run(() =>
              trustOrganizationDomain({
                domain,
                organizationId,
              }),
            );
          }}
          title={`Trust ${pendingTrust.domain} for ${pendingTrust.organizationName}?`}
        >
          <p>
            This records that{" "}
            <span className="font-medium">{pendingTrust.domain}</span> belongs
            to {pendingTrust.organizationName} without DNS proof. Confirm only
            after checking the domain through an official website or a known
            contact at the organization.
          </p>
          <p className="mt-3">
            A Google account carrying this hosted-domain claim will have the
            organization detected automatically. A first membership is approved
            after the person submits the request; previous or suspended
            memberships still require a human decision.
          </p>
        </ConfirmDialog>
      )}

      {pendingRemoval && (
        <ConfirmDialog
          busy={busy}
          confirmIcon="close"
          confirmLabel="Remove domain"
          danger
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => {
            const domain = pendingRemoval.domain;
            setPendingRemoval(null);
            run(() => removeOrganizationDomain({ domain }));
          }}
          title="Remove this domain?"
        >
          <p>
            Accounts on{" "}
            <span className="font-medium">{pendingRemoval.domain}</span> stop
            proving anything about {pendingRemoval.organizationName}. New
            sign-ins with one are treated as personal.
          </p>
          <p className="mt-3">
            Memberships it already produced are left exactly as they are — they
            are somebody&rsquo;s actual standing, and ending them is a separate
            decision. Their addresses become ordinary personal addresses, which
            their owners may then remove themselves.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
