# Membership and directory flows

## Verify or remove an organization domain

Domain ownership is a portal-admin operation. It never approves individual
people.

```mermaid
flowchart TD
    A["Portal admin at AAL2 enters a domain"] --> B["Preview matching addresses and possible joins"]
    B --> C{"Reserved, invalid or registered elsewhere?"}
    C -- "Yes" --> X1["Reject without changing trust"]
    C -- "No" --> D["Generate random verification token"]
    D --> E["Store SHA-256 hash in a 24-hour claim"]
    E --> F["Show DNS TXT name and raw value"]
    F --> G["Administrator publishes TXT record"]
    G --> H["Server resolves public DNS"]
    H --> I{"Exact TXT value present?"}
    I -- "No" --> J["Keep claim; administrator retries later"]
    I -- "Yes" --> K{"Claim hash, organization and expiry still match?"}
    K -- "No" --> X2["Start a new verification"]
    K -- "Yes" --> L["Mark domain DNS verified and audit"]
    L --> M["Reclassify matching addresses as organization addresses"]
    M --> N["Matching Workspace requests may now be approved automatically"]
    N --> O{"Portal admin removes domain later?"}
    O -- "No" --> N
    O -- "Yes" --> P["Delete domain trust and verification claim"]
    P --> Q["Reclassify matching addresses as personal"]
    Q --> R["Existing memberships remain unchanged"]
```

## Trusted-domain access request

Google's hosted-domain claim detects the organization. It never creates a
membership at sign-in; the person must submit the request first. An existing
membership always outranks automatic approval.

```mermaid
flowchart TD
    A["Person opens the access page"] --> B["Read hosted-domain claim copied from auth.identities"]
    B --> C{"Claim present?"}
    C -- "No" --> X1["Outcome: unproven; no membership change"]
    C -- "Yes" --> D{"Domain has current DNS verification for an active organization?"}
    D -- "No" --> X2["No organization preselection; person chooses manually"]
    D -- "Yes" --> E{"Person active and not deleted?"}
    E -- "No" --> X3["Outcome: blocked"]
    E -- "Yes" --> F{"Membership row already exists?"}
    F -- "Active" --> G["Open Groundstation; no duplicate change"]
    F -- "Ended, suspended or planned" --> H["Create pending request for human review"]
    F -- "No" --> I["Person reviews and submits request"]
    I --> J["Create approved request and active member role atomically"]
    J --> K["Open first membership period"]
    K --> L["Audit and queue confirmation email"]
```

## Access request and review

```mermaid
flowchart TD
    A["Signed-in person without current access opens /access"] --> B{"Request type"}
    B -- "Organization account" --> C["Use organization detected from trusted hosted domain"]
    B -- "Personal account" --> C2["Choose active organization except NORSTEC"]
    B -- "Alumni" --> D["No organization selected"]
    C --> E["Validate name, study data and optional message"]
    C2 --> E
    D --> E
    E --> F{"Existing membership, alumni grant or duplicate pending request?"}
    F -- "Yes" --> X1["Reject duplicate or already-granted request"]
    F -- "No" --> G{"Trusted domain and no prior membership?"}
    G -- "Yes" --> G1["Create approved request and active membership atomically"]
    G -- "No" --> G2["Create pending request"]
    G1 --> U
    G2 --> H{"User withdraws before review?"}
    H -- "Yes" --> I["Set request cancelled"]
    H -- "No" --> J{"Who may review?"}
    J -- "Organization request" --> K["Scoped organization admin at AAL2"]
    J -- "Alumni request" --> L["Portal admin at AAL2"]
    K --> M{"Request still pending?"}
    L --> M
    M -- "No" --> X2["Reject stale decision"]
    M -- "Yes" --> N{"Decision"}
    N -- "Approve organization" --> O["Create/reactivate active member role"]
    N -- "Approve alumni" --> P["Grant person-level alumni access"]
    N -- "Reject" --> Q["Record rejected decision and audit snapshot"]
    Q --> R{"Applicant has any other retained portal data?"}
    R -- "No" --> S["Delete temporary profile, Auth users and sessions"]
    R -- "Yes" --> T["Keep person for other relationships"]
    O --> U["Queue decision email in same transaction"]
    P --> U
    S --> U
    T --> U
    U --> V["Return decision immediately; drain email after response"]
```

## Membership lifecycle

```mermaid
stateDiagram-v2
    [*] --> planned: imported or scheduled
    [*] --> active: approved request
    [*] --> active: trusted-domain request auto-approved
    planned --> active: explicit activation
    active --> ended: organization admin ends membership
    active --> suspended: administrative lifecycle change
    suspended --> active: explicit restoration
    ended --> active: explicit reactivation
    ended --> ended: later domain sign-in does nothing
    suspended --> suspended: later domain sign-in does nothing

    note right of active
      Membership period is open.
      Role may be member or organization_admin.
    end note

    note right of ended
      Open period and team roles close.
      Role resets to member.
      Reactivation opens a new period.
    end note
```

## Save own profile

```mermaid
flowchart TD
    A["Member edits profile, history, visibility, contact address or avatar"] --> B["Server validates fields, dates, URL and relationships"]
    B --> C{"New avatar supplied?"}
    C -- "Yes" --> D{"Size, MIME type and file signature valid?"}
    D -- "No" --> X1["Reject before upload"]
    D -- "Yes" --> E["Upload to fresh person-scoped UUID path"]
    C -- "No" --> F["Keep current avatar path"]
    E --> G["Call save_own_profile_v6"]
    F --> G
    G --> H["Lock active person and validate all rows again"]
    H --> I{"profile_updated_at and child versions still match?"}
    I -- "No" --> J["Rollback database changes and remove new upload"]
    I -- "Yes" --> K["Update profile, experiences, roles and directory_visible atomically"]
    K --> L{"Avatar replaced?"}
    L -- "Yes" --> M["Delete previous avatar object"]
    L -- "No" --> N["Continue"]
    M --> O{"Contact address changed?"}
    N --> O
    O -- "No" --> P["Refresh portal and /profile?saved=true"]
    O -- "Yes" --> Q["Run separate audited primary-email RPC"]
    Q --> R{"Address update succeeds?"}
    R -- "Yes" --> P
    R -- "No" --> S["Profile remains saved; show contact-address error"]
```

## Directory visibility

Every related table applies the same person decision through RLS.

```mermaid
flowchart TD
    A["Someone queries a person or directory relationship"] --> B{"Requester is the same person?"}
    B -- "Yes" --> S["Return allowed rows"]
    B -- "No" --> C{"Portal admin at AAL2?"}
    C -- "Yes" --> S
    C -- "No" --> D{"Scoped organization admin at AAL2?"}
    D -- "Yes" --> S
    D -- "No" --> E{"Requester is a portal member?"}
    E -- "No" --> H["Return no rows"]
    E -- "Yes" --> F{"Target is active, not deleted and directory_visible?"}
    F -- "No" --> H
    F -- "Yes" --> G{"Target has active/ended membership or alumni access?"}
    G -- "No" --> H
    G -- "Yes" --> S
    S --> I["People, primary contact, memberships, periods, teams and profile history are visible"]
    H --> J["The same related rows are hidden, not merely omitted by UI"]
```

## Organization and team administration

```mermaid
flowchart TD
    A["Administrator opens organization management"] --> B{"Active scoped admin role and AAL2?"}
    B -- "No" --> X1["Redirect or require MFA"]
    B -- "Yes" --> C{"Operation"}
    C -- "Edit organization" --> D["Change public organization fields"]
    D --> E["Confirm save and validate input"]
    E --> F{"Expected updated_at still current?"}
    F -- "No" --> X2["Conflict: reload before overwriting"]
    F -- "Yes" --> G["Save organization settings"]
    C -- "Create team" --> H["Validate name and generate unique slug"]
    H --> I["Insert team"]
    C -- "Edit team" --> J["Confirm details and full selected roster"]
    J --> K{"Every selected person belongs to organization?"}
    K -- "No" --> X3["Reject invalid team member"]
    K -- "Yes" --> L{"Expected team updated_at still current?"}
    L -- "No" --> X4["Conflict: reload"]
    L -- "Yes" --> M["Update details; archive removed memberships; restore or insert selected memberships"]
    C -- "Delete team" --> N["Confirm member count and deletion"]
    N --> O["Delete team; team-membership rows cascade"]
    G --> P["Revalidate portal views"]
    I --> P
    M --> P
    O --> P
```
