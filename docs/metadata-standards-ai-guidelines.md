# Metadata Standards — AI Engineering Guidelines

DDI-L 3.3 · GSIM 2.0 · GSBPM 5.2 · SDC · RBAC/ACL, for AI coding agents and developers working on statistical-metadata systems (NSO-SMR / CSDL Đặc tả & Vi mô). v1.1, 2026-09-28. Opt-in per module (§1). Kept terse on purpose: aidev sends parts of this file with every stage call.

## §0. Labels

- **MUST**: required when the module is enabled. A deviation needs a waiver (§1.5).
- **SHOULD**: the default. Deviate only with a reason stated in the design or PR.
- **MAY**: optional.
- [Inference] = derived, not stated by a source. [Unverified] = not confirmed; check before relying on it. Dx = depends on decision x in §2.2.
- Cite rule IDs (e.g. CORE-04) in designs, PRs and reviews, never in class names or code comments.

---

## §1. Activation protocol (interactive agents)

### 1.1 When

Run 1.2 when a task touches statistical metadata, microdata, classifications, code lists or data permissions; when cloning or taking over a repo; or when the user mentions DDI/GSIM/GSBPM/SDMX/SDC. Otherwise ignore this document.

> aidev (`claude-sdlc-agents`) reads the target's `.metadata-standards.yml` itself and never asks. It sends §0, §2, §3 and the enabled modules' sections, not §1, §12 or §13.

### 1.2 Config lookup

1. `.metadata-standards.yml` at the repo root → apply it as written; do not ask.
2. No file → ask the user (1.3). Never guess.
3. After the answer, offer to write the file (1.4). Write it only if the user agrees.
4. User chose `none` → apply nothing and do not ask again this session.

### 1.3 Question template

Show the §2.1 module list first, then ask:
- Q1 (single) preset: **Full NSO-SMR (Recommended)** = all 8 modules · International standards only = CORE, DDI, GSIM, CLS, GSBPM · Security only = CORE, SDC, AUTHZ · None.
- Q2 (multi, only if the user picks Other): pick modules.
- Q3 (single) mode: **strict** (MUST blocks merge; for new code) · **advisory** (report gaps only; for cloned/legacy code).
- Decisions D1–D9: use the defaults. Ask only when the task directly touches one.

### 1.4 Config template

```yaml
guideline_version: "1.1"
mode: strict            # strict | advisory
modules: [CORE, DDI, GSIM, CLS, GSBPM, SDC, AUTHZ, NSO]   # [] or none = opt out
decisions:
  D1_canonical_model: gsim-canonical        # gsim-canonical | ddi-native
  D2_version_format: semver-overlay         # semver-overlay | integer-revision
  D3_trace_store: relational-closure        # relational-closure | graph | pending-poc
  D4_rule_language: pending-poc             # vtl | native-pseudo-vtl | pending-poc
  D5_authz_impl: spring-security-acl        # spring-security-acl | custom-permission-table | rbac-only
  D6_permission_inheritance: tree-fallback  # tree-fallback | independent-matrices
  D7_population_entity: separate            # separate | ddi-universe-extended
  D8_id_strategy: agency-uuid               # agency-uuid | maintainable-scoped
  D9_sdc_thresholds: international          # international | custom
agency: "vn.gso"
stack: {frontend: reactjs, backend: spring-boot, db: postgresql}
waivers: []   # [{rule: CORE-05, reason: "...", owner: "...", until: "2026-12-31"}]
```

### 1.5 Waivers (comply-or-explain)

If code cannot meet a MUST rule, add a `waivers` entry (rule, reason, owner, until) and mention it in the PR. An agent never adds a waiver without asking the user.

### 1.6 Agent boundaries

- Apply only the enabled modules.
- Advisory mode: report gaps; do not refactor existing code without approval.
- Never invent DDI/GSIM element names (NSO-15).
- Never reverse a decision in §11.2.

---

## §2. Modules and decisions

### 2.1 Modules

- **CORE**: identification (agency/id/version), URN, immutability after publish, early/late-bound references, multilingual text. Base for the rest.
- **DDI**: DDI-L 3.3 conformance: schemes, packages, question/instrument, logical/physical. Needs CORE.
- **GSIM**: GSIM 2.0 canonical model, variable cascade, unit type/universe/population, design vs runtime. Needs CORE.
- **CLS**: code list vs statistical classification, versions, correspondence tables, change typology. Needs CORE.
- **GSBPM**: metadata-driven production, traceability, run pinning, quality gates, consumer integration. Needs CORE.
- **SDC**: microdata confidentiality, pseudonymisation, output checking, four-eyes review.
- **AUTHZ**: global RBAC plus object-level ACL.
- **NSO**: NSO-SMR scope, won't-haves, build order, settled decisions. Needs CORE, GSIM.

### 2.2 Decisions (default first)

- **D1 canonical model:** gsim-canonical (core domain model follows GSIM 2.0; DDI/SDMX are edge adapters) | ddi-native. Default settled in WP-03.
- **D2 version format:** semver-overlay `major.minor.patch` | integer-revision. DDI accepts both (dot-separated integers).
- **D3 trace store:** relational + closure table/recursive CTE, behind a `TraceRepository` interface | graph DB | pending-poc. The product choice is still open (PoC G1).
- **D4 rule language:** pending-poc | vtl | native-pseudo-vtl. Hide it behind a `RuleEngine` interface; do not hardcode a language.
- **D5 authz:** spring-security-acl (settled 2026-09-25) | custom `object_permission` table + `PermissionEvaluator` | rbac-only.
- **D6 permission inheritance:** tree-fallback Collection→Study→Dataset→Variable via ACL `parent_object` | independent matrices (WB Metadata Editor style). [Inference] Needs BA confirmation.
- **D7 population:** separate entity (GSIM) | DDI Universe extended with time/geography. On DDI export, map Population to Universe plus time and geography.
- **D8 ids:** UUID unique within the agency | hierarchical `MaintainableID.ObjectID`.
- **D9 SDC thresholds:** international output-checking rule of thumb (settled) | custom.

---

## §3. Vocabulary and mapping

Unofficial mapping: GSIM 2.0 Principle 14 puts mappings outside GSIM itself. Do not auto-generate mappings without review.

| GSIM 2.0 | DDI-L 3.3 | SDMX 3.x |
|---|---|---|
| Identifiable Artefact | Identifiable / Versionable / Maintainable | Identifiable / MaintainableArtefact |
| Concept | Concept | Concept |
| Unit Type | UnitType | — |
| Universe, Population | Universe (optionally with time/geo; no Population class) | — |
| Conceptual Variable | ConceptualVariable | — |
| Represented Variable | RepresentedVariable | Concept + representation |
| Instance Variable | Variable | DSD component |
| Value Domain | CodeList / other domains [Unverified names: check XSD] | Codelist / TextFormat |
| Statistical Classification | StatisticalClassification (new in 3.3) | Codelist (+hierarchy) |
| Correspondence Table / Map | ClassificationCorrespondenceTable / ClassificationMap | Structure / representation map |
| Data Set | PhysicalInstance / LogicalProduct | Dataset |
| Data Structure (identifier/measure/attribute) | DataRelationship / LogicalRecord + roles | DSD (dimension/measure/attribute) |
| Referential Metadata Set | quality / other material | Reference metadata / MSD (SIMS) |

Common confusions:
- A **Code** is only a symbol; the meaning lives in its **Category**. A **CodeList** pairs codes with categories.
- A **Data Point** is the structural slot; a **Datum** is the value in it.
- **Structural** metadata must travel with the data; **reference** metadata describes method and quality.
- Mapping Unit Type and Population both to DDI Universe is a known error (Statistics Denmark).

---

## §4. CORE — identification, versioning, reuse

- **CORE-01 MUST** Every governed artefact has `agency` + `artefact_id` + `version`, unique together. `artefact_id` stays the same across versions.
- **CORE-02 MUST** Canonical URN `urn:ddi:{agency}:{id}:{version}`; nested objects use `{parentId}.{childId}` when scoped to a maintainable. Store all four parts, not just the URN. Generate the URN; never type it by hand.
- **CORE-03 MUST** IDs are UUIDs (D8). Never expose a DB auto-increment as a business ID.
- **CORE-04 MUST** A published version is immutable: changing its payload means a new version with a mandatory `versionRationale`. Enforce this in the service layer **and** with a DB trigger.
- **CORE-05 MUST** Keep administrative fields (internal notes, tags, audit, user IDs) separate from payload. Only payload changes bump the version. List the payload fields explicitly.
- **CORE-06 MUST** Every reference states its binding: early (pinned version, the default) or late (latest, optionally within a major version). Published data and run logs always use early binding.
- **CORE-07 SHOULD** When a child that a parent references early-bound changes meaning, assess bumping the parent (versioning up the containing tree).
- **CORE-08 MUST** Reuse by reference, never by copying. Deriving from another agency's object, or a change big enough to be a different object, creates a new object with `basedOn`.
- **CORE-09 MUST** Multilingual text carries a language tag (BCP 47 / ISO 639-1) on each value, in the schema from the MVP on.
- **CORE-10 SHOULD** Extensions use key/value pairs (like DDI `UserAttributePair`). Do not repurpose existing fields.
- **CORE-11 SHOULD** Store rich text as Markdown or escaped text with an `isPlainText` flag. Never embed HTML in the schema.
- **CORE-12 MUST** Controlled-vocabulary values store the code plus the vocabulary version, not only the label.
- **CORE-13 SHOULD** A change event is its own entity, N:N with artefacts, so that merges and splits can be recorded.

```java
/** Base for versioned artefacts; payload is immutable once PUBLISHED. */
@MappedSuperclass
public abstract class VersionableArtefact {
    @Id @GeneratedValue private Long pk;                                    // technical key, never exposed
    @Column(nullable = false, updatable = false) private String agency;
    @Column(nullable = false, updatable = false) private UUID artefactId;   // stable across versions
    @Column(nullable = false, updatable = false) private String version;    // D2: "1.2.0"
    @Enumerated(EnumType.STRING) private LifecycleState state;             // NSO governance; not written to DDI
    private String versionRationale;
    private Instant versionDate;
    @Embedded private ArtefactRef basedOn;
    public String urn() { return "urn:ddi:%s:%s:%s".formatted(agency, artefactId, version); }
}
public enum LifecycleState { DRAFT, IN_REVIEW, PUBLISHED, DEPRECATED }

@Embeddable
public record ArtefactRef(String agency, UUID artefactId, String version, boolean lateBound, String typeOfObject) {
    public ArtefactRef { if (!lateBound && version == null) throw new IllegalArgumentException("early-bound ref needs a version"); }
}
```

```sql
-- Blocks payload edits on published rows. PUBLISHED -> DEPRECATED is an admin change and stays allowed.
CREATE OR REPLACE FUNCTION forbid_published_payload_update() RETURNS trigger AS $$
BEGIN
  IF OLD.state = 'PUBLISHED' AND (NEW.payload IS DISTINCT FROM OLD.payload OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'artefact % v% is published: create a new version', OLD.artefact_id, OLD.version;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
```

---

## §5. DDI — DDI Lifecycle 3.3

- **DDI-01 MUST** Hierarchy Identifiable → Versionable → Maintainable. A maintainable is either a module (StudyUnit, Group, ResourcePackage, DataCollection, LogicalProduct, PhysicalDataProduct…) or a scheme (ConceptScheme, CategoryScheme, CodeListScheme, VariableScheme, QuestionScheme…).
- **DDI-02 MUST** Never write workflow state (Draft/InReview/Deprecated) into DDI XML. Export only `isPublished` plus `Version`, `VersionRationale` and `VersionResponsibility`.
- **DDI-03 MUST** Scheme groups (VariableGroup…) are administrative grouping only, never a substitute for the real container.
- **DDI-04 SHOULD** Exchange single items as a FragmentInstance (the item plus what it references). Prefer references over inline content.
- **DDI-05 MUST** Schemes published inside a StudyUnit, Group or ResourcePackage are inline. Resources shared across studies go in a ResourcePackage.
- **DDI-06 MUST** One StudyUnit = one coordinated collection wave. Group several waves with a Group. Never clone a StudyUnit to reuse it.
- **DDI-07 MUST** Keep LogicalProduct (variables, code lists, logical records), PhysicalDataProduct (layout) and PhysicalInstance (one file: fingerprint, summary statistics) separate. Prefer DataRelationshipReference to a detailed record layout.
- **DDI-08 MUST** Question content (QuestionItem/Grid/Block) is separate from flow (control constructs). IfThenElse, Loop, RepeatUntil and RepeatWhile reference only a Sequence. Use QuestionBlock only for questions that share stimulus material.
- **DDI-09 SHOULD** Non-survey measurement (instruments, administrative data) uses MeasurementItem.
- **DDI-10 MUST** A Variable with no ConceptReference (directly or through its RepresentedVariable) is not ISO/IEC 11179 compliant; validation warns.
- **DDI-11 MUST** Keep metadata quality, quality statements (process) and data quality apart.
- **DDI-12 MUST** DDI element and attribute names used in code match the 3.3 XSD verbatim.
- **DDI-13 SHOULD** Publish the organisation's versioning policy (`VersionDistinction` in the OrganizationScheme).
- DDI-L 3.3 has no standard "deprecated" state: retire an item with a new version plus a Note. [Inference] A separate Population class is a DDI-CDI concept. [Unverified]

---

## §6. GSIM — conceptual model and variable cascade

- **GSIM-01 MUST (D1)** The core domain model follows GSIM 2.0 (Base, Business, Concepts, Exchange, Structures). DDI/SDMX-only notions (Dataflow, FragmentInstance…) stay in adapters.
- **GSIM-02 MUST** The variable cascade is four tables linked by foreign keys: Concept → ConceptualVariable (+UnitType) → RepresentedVariable (+ValueDomain) → InstanceVariable (in a DataSet). Never one `variable` table with nullable columns.
- **GSIM-03 MUST** No shortcut FK from InstanceVariable to ConceptualVariable that skips RepresentedVariable.
- **GSIM-04 MUST** An InstanceVariable stores only what narrows or differs: narrower population, top-coding, `localId` (the column name). It never redefines the concept or the representation.
- **GSIM-05 MUST (D7)** UnitType (no time/geo) → Universe (no time/geo) → Population (+`geography`, +`referencePeriod`) are separate entities, never free-text columns.
- **GSIM-06 MUST** A value domain is either substantive or sentinel. Use one system-wide sentinel set, e.g. `S_X` unspecified, `S_Z` not applicable, `S_R` refused, `S_U` unknown.
- **GSIM-07 MUST** Design-time objects (ProcessDesign, StatisticalProgramDesign) and runtime objects (ProcessStepInstance, execution logs) live in separate tables.
- **GSIM-08 MUST** Data structure components have explicit roles (identifier/measure/attribute). An attribute has an explicit `attachmentLevel` (DataSet/Series/Group/Observation).
- **GSIM-09 MUST** `id` (global) and `localId` (name in one context, such as a column) are separate fields.
- **GSIM-10 SHOULD** Referential metadata structures are configurable per subject type (programme, dataset, classification…). Never hardcode one quality-report schema.
- **GSIM-11 SHOULD** Metadata is linked, not free text: a variable links to its concept, classification, unit of measure, population, dataset and outputs.
- **GSIM-12 SHOULD** Agents are individuals, organisations or software. Roles (owner, maintainer, contact) are assigned through AgentInRole.

---

## §7. CLS — classifications and code lists

- **CLS-01 MUST** CodeList and StatisticalClassification are separate entities. A code list is flat or survey-specific and may include missing codes. A classification is a national or international standard, hierarchical, and at each level its items are mutually exclusive and jointly exhaustive.
- **CLS-02 MUST** Categories (meaning) are separate from codes (symbols). One CategoryScheme serves many code lists.
- **CLS-03 MUST** Hierarchy: ClassificationFamily → ClassificationSeries → StatisticalClassification (a version) → Level → ClassificationItem.
- **CLS-04 MUST** A classification records `current`, `floating`, `isUpdate`, `updatesPossible`, `predecessor`/`successor` and `changesFromPreviousVersion`.
- **CLS-05 MUST** An item records code, parent, level, includes/includesAlso/excludes, `isGenerated`, `validFrom`/`validTo`, `changesFromPriorVersion` and successor.
- **CLS-06 MUST** A new classification version (e.g. VSIC 2007→2018) requires a correspondence table whose `relationshipType` (1:1, 1:N, N:1, M:N) is stored explicitly, never inferred from join counts.
- **CLS-07 SHOULD** Each map records its change types: VC1 code change, VC2 name change, RC1 deletion, RC2 creation, RC3.1 merger, RC3.2 take-over, RC4.1 breakdown, RC4.2 split-off, RC5 transfer. Several types can apply at once.
- **CLS-08 MUST** Numeric-looking industry and occupation codes are strings (leading zeros matter). Declare `recommendedDataType`.
- **CLS-09 MUST** A coded response or value domain may reference only a PUBLISHED code list or classification.
- **CLS-10 MAY** A classification index (free text → item) supports automatic coding.

---

## §8. GSBPM — metadata-driven production and traceability

GSBPM 5.2 phases: 1 Specify needs, 2 Design, 3 Build, 4 Collect, 5 Process, 6 Analyse, 7 Disseminate, 8 Evaluate. Overarching activities: quality, metadata, data, process data, knowledge and supplier management.

- **GSBPM-01 MUST** Metadata is active: it generates validation, forms, instruments and exports, and is not written after the fact. Every feature answers "which production step does this metadata drive?"
- **GSBPM-02 MUST** Capture metadata early, at the source, automatically where possible. For example, importing CSV/SPSS/Stata generates DRAFT structural metadata.
- **GSBPM-03 MUST** Each metadata element has one authoritative source. Consumers read it through the API/SDK; nobody copies it by hand.
- **GSBPM-04 MUST** A processing run pins the exact versions of the methods, rules and parameters it used in its execution log (early-bound), reads only PUBLISHED ones, and hardcodes no rules in the engine.
- **GSBPM-05 MUST** Traceability is bidirectional and queryable in one call, with at least six traces: requirement, concept, data, method, quality, release.
- **GSBPM-06 MUST** Run impact analysis before versioning up or deprecating a shared artefact.
- **GSBPM-07 MUST** A state change emits an event so consumers refresh their caches. Consumers keep working when the metadata repository is down (consumer-side cache).
- **GSBPM-08 MUST** Automation stops for a human before anything is published, even when every check passes. Metadata supports quality assurance; it is not quality assurance.
- **GSBPM-09 SHOULD** Documentation requirements depend on `data_state` (raw → input → complete microdata → statistics → published).
- **GSBPM-10 SHOULD** Every metadata object has an owner and an editor. Governance roles: owner, editor, subject-matter expert, quality reviewer, system owner, governance body.
- **GSBPM-11 MUST** UI and API run the same permission checks. There is no back door.

```sql
-- Trace links (D3 relational), behind TraceRepository so a graph store can replace it.
CREATE TABLE trace_link (source_urn text NOT NULL, target_urn text NOT NULL,
  link_type text NOT NULL,  -- REQUIREMENT|CONCEPT|DATA|METHOD|QUALITY|RELEASE|USES|DERIVED_FROM
  PRIMARY KEY (source_urn, target_urn, link_type));
-- Everything that depends on :urn, directly or not
WITH RECURSIVE impacted(urn, depth) AS (
  SELECT source_urn, 1 FROM trace_link WHERE target_urn = :urn
  UNION SELECT t.source_urn, i.depth + 1 FROM trace_link t JOIN impacted i ON t.target_urn = i.urn WHERE i.depth < 20
) SELECT DISTINCT urn FROM impacted;
```

---

## §9. SDC — confidentiality and disclosure control

- **SDC-01 MUST** Individual and unit data are strictly confidential and used only for statistics. A public API never returns record-level microdata.
- **SDC-02 MUST** Files released to users contain no direct identifiers (name, address, national ID, tax ID, social insurance number…). Linkage keys are meaningless pseudonyms.
- **SDC-03 MUST** SDC parameters are confidential metadata, kept in a separate schema or partition that only SDC officers can access.
- **SDC-04 MUST** A unit dataset without disclosure-risk and pseudonymisation metadata cannot get an access level below `licensed`.
- **SDC-05 MUST** Microdata access comes only from an ACTIVE provision agreement (request → data steward assessment → approval → agreement → grant → log). No manual grants.
- **SDC-06 MUST** Output checking has two tiers: automated rules pre-check, and a human checker makes the final decision.
- **SDC-07 MUST (D9)** Rule of thumb: at least 10 unweighted units behind every table cell; models need at least 10 degrees of freedom and at least 10 units. Keep the values in confidential configuration, not in code.
- **SDC-08 SHOULD** Four-eyes review (technical plus subject matter). One reviewer is the minimum.
- **SDC-09 MUST** An access or export request states its purpose, datasets and variables, and has a signed confidentiality undertaking. Reject it otherwise.

---

## §10. AUTHZ — RBAC plus object-level ACL

Roles (following the WB Metadata Editor):
- **Global:** MEMBER (no rights until activated), VIEWER, CONTRIBUTOR, COLLECTION_MANAGER, ADMIN.
- **Per object:** VIEWER (view and export metadata, never data), EDITOR, REVIEWER (view plus lock/version), EDITOR_REVIEWER, OWNER/CO_OWNER (plus share, delete, transfer ownership).
- Adding a study to a collection needs owner/admin on the study **and** edit/admin on the collection.

Rules:
- **AUTHZ-01 MUST** Global roles use `hasRole()`; instance rights use `hasPermission()`. Do not mix the two.
- **AUTHZ-02 MUST** Check permissions in the service layer (`@PreAuthorize`), shared by UI and API. An API key inherits exactly its user's rights.
- **AUTHZ-03 MUST** Each object type (Study, Dataset, Variable, Collection, Classification, CodeList) is its own `acl_class`. `object_id_identity` = `artefact_id` (UUID), so a grant covers every version.
- **AUTHZ-04 MUST** Shared classifications and code lists have their own ACL (`parent_object` NULL) and never inherit from the study tree. [Inference]
- **AUTHZ-05 MUST** Exporting data is its own permission (`EXPORT_DATA`), separate from reading metadata.
- **AUTHZ-06 MUST** Microdata access is granted only through SDC-05. Every allow/deny decision is audited.
- **AUTHZ-07 SHOULD** Do not `@PostFilter` large lists (it breaks paging). Join the ACL tables in the query, or fetch the allowed IDs first.

Implementation (D5 = spring-security-acl, D6 = tree-fallback):
- **Schema:** use Spring Security's official PostgreSQL script (`createAclSchemaPostgres.sql`), the variant with `acl_class.class_id_type` and `object_id_identity varchar(36)`, applied through Flyway/Liquibase. Do not hand-write the DDL.
- **Tree:** `acl_object_identity.parent_object` builds Collection→Study→Dataset→Variable. ACE order matters: the first matching entry wins.

```java
public class NsoPermission extends BasePermission {   // READ=1 WRITE=2 CREATE=4 DELETE=8 ADMINISTRATION=16
    public static final Permission EXPORT_DATA = new NsoPermission(1 << 5, 'X');
    public static final Permission REVIEW      = new NsoPermission(1 << 6, 'V');
    protected NsoPermission(int mask, char code) { super(mask, code); }
}

@Configuration
@EnableMethodSecurity
class AclConfig {
    private static final PermissionFactory PERMISSIONS = new DefaultPermissionFactory(NsoPermission.class);
    @Bean AclAuthorizationStrategy aclAuthorizationStrategy() { return new AclAuthorizationStrategyImpl(new SimpleGrantedAuthority("ROLE_ADMIN")); }
    @Bean PermissionGrantingStrategy permissionGrantingStrategy() { return new DefaultPermissionGrantingStrategy(new ConsoleAuditLogger()); } // swap for a DB audit logger (AUTHZ-06)
    @Bean AclCache aclCache(CacheManager cm, PermissionGrantingStrategy pgs, AclAuthorizationStrategy aas) {
        return new SpringCacheBasedAclCache(cm.getCache("acl"), pgs, aas);
    }
    @Bean LookupStrategy lookupStrategy(DataSource ds, AclCache cache, AclAuthorizationStrategy aas, PermissionGrantingStrategy pgs) {
        var s = new BasicLookupStrategy(ds, cache, aas, pgs);
        s.setPermissionFactory(PERMISSIONS);
        s.setAclClassIdSupported(true);   // UUID object ids
        return s;
    }
    @Bean JdbcMutableAclService aclService(DataSource ds, LookupStrategy ls, AclCache cache) {
        var s = new JdbcMutableAclService(ds, ls, cache);
        s.setAclClassIdSupported(true);
        s.setClassIdentityQuery("select currval(pg_get_serial_sequence('acl_class', 'id'))");
        s.setSidIdentityQuery("select currval(pg_get_serial_sequence('acl_sid', 'id'))");
        return s;
    }
    @Bean MethodSecurityExpressionHandler expressionHandler(AclService aclService) {
        var evaluator = new AclPermissionEvaluator(aclService);
        evaluator.setPermissionFactory(PERMISSIONS);   // enables hasPermission(..., 'EXPORT_DATA')
        var h = new DefaultMethodSecurityExpressionHandler();
        h.setPermissionEvaluator(evaluator);
        return h;
    }
}

// On create: the owner gets ADMINISTRATION and the study inherits from its primary collection.
MutableAcl acl = aclService.createAcl(new ObjectIdentityImpl(Study.class, studyId));
acl.setOwner(new PrincipalSid(owner));
acl.setParent(aclService.readAclById(new ObjectIdentityImpl(Collection.class, primaryCollectionId)));
acl.setEntriesInheriting(true);
acl.insertAce(acl.getEntries().size(), BasePermission.ADMINISTRATION, new PrincipalSid(owner), true);
aclService.updateAcl(acl);

@PreAuthorize("hasPermission(#datasetId, 'vn.gso.smr.domain.Dataset', 'EXPORT_DATA')") Resource exportData(UUID datasetId);
```

Notes:
- The type argument of `hasPermission` is the fully qualified class name and must equal `acl_class.class`.
- An ACL has one parent. A study in several collections inherits only from its primary collection; the others are grouping only. [Inference]
- Evict the cache only when ACEs change; new versions need no ACL change.
- Read the ACL release notes before a major Spring Security upgrade. [Unverified: deprecation roadmap]
- Tests: owner, role inherited from a collection, a deny ACE overriding a grant, classifications not inheriting, `EXPORT_DATA` separate from `READ`.

---

## §11. NSO — NSO-SMR project constraints

Source of truth: proposal v1.2 (2026-06-13), which supersedes catalog v1.0.

### 11.1 Scope

- NSO-SMR (statistical metadata repository) is the **control plane**. Data never flows through it (COL→DAT→DIS stays outside).
- 9 subsystems M1–M9 cover FR-001–FR-075, plus consumer enablement (SDK and conformance kit).
- Roadmap: G1 foundation → G2 pilot → G3 integration → G4 scale-out, each with a go/no-go gate.

### 11.2 Settled — never reverse

- **NSO-01** Canonical model = GSIM 2.0. DDI-L 3.3 and SDMX 3.x are the implementation/exchange layer.
- **NSO-02** Won't-have: no raw microdata storage, only metadata plus URIs (FR-035). No statistical computation (sampling, weighting, imputation), only method descriptions (FR-034). It does not replace the DW, BI or CAPI systems.
- **NSO-03** DRAFT → IN_REVIEW → PUBLISHED → DEPRECATED is a governance overlay and is never written to DDI (DDI-02).
- **NSO-04** Impact analysis (FR-031), correspondence tables (from phase 2) and the six traces (from the MVP) are MUST.
- **NSO-05** A PUBLISHED StudyUnit traces to a PUBLISHED statistical programme design (SPD). A PUBLISHED SPD traces to at least one statistical need. An SPD spans cycles; a StudyUnit is one cycle.
- **NSO-06** A weight variable links to an approved weighting methodology.
- **NSO-07** A product cannot be published without a PUBLISHED reference metadata set, the phase 6/7 gates passed, and complete traces.
- **NSO-08** The public portal shows only PUBLISHED content. SDMX REST is separate from the internal API (FR-025 vs FR-067).
- **NSO-09** Hybrid build: open components for commodity parts; build the GSIM registry, trace store, M7–M9 and the integration gateway in-house.
- **NSO-13** Stack (settled 2026-09-25): ReactJS + Spring Boot + PostgreSQL (JSONB allowed for extensions and multilingual text). Agency `vn.gso`. Authorisation `spring-security-acl`. International SDC thresholds.

### 11.3 Open — never hardcode

- **NSO-10** Base product (WB Metadata Editor / Colectica / FMR / in-house): keep it behind an adapter.
- **NSO-11** Trace store: `TraceRepository` (D3).
- **NSO-12** Rule language: `RuleEngine` (D4).
- **NSO-14** Real names of satellite systems (COL-01, PRC-01…): configuration placeholders.

### 11.4 Build order

AC-02 Registry + AC-03 Repository → AC-05 Workflow + AC-06 Validation → AC-01 Gateway + AC-11 Portal → AC-04 Trace → AC-07 Ops metadata + AC-15 Extractor → AC-13 DDI adapter → AC-08 Quality gate → AC-09 Access governance → AC-14 SDMX + AC-12 Events + AC-16 SDK → AC-10 Semantic search / AC-17 Harvest.

### 11.5 Other

- **NSO-15 MUST** DDI element names in code are verbatim. Names listed as "NOT VERIFIED" in `user-stories-ddi33` appendix B (e.g. NumericDomain/DateTimeDomain, coverage children; there is no SubGroup, use GroupReference) must be checked against the XSD first.
- **NSO-16 MUST** The minimum MVP DDI profile: StudyUnit, Concept/Universe, CodeList/Category, QuestionItem, Variable, PhysicalInstance.

---

## §12. Cloning or taking over code (interactive)

1. Run §1.2 to get the modules and the mode.
2. Locate the entities for §3's concepts: concept, variable, code list, classification, study, dataset, permission.
3. Write a gap report to `plans/reports/metadata-standards-gap-{date}.md`: rule | OK/GAP/N/A | evidence `file:line` | risk | proposal.
4. Fix in this order: CORE-04, SDC-01..03, AUTHZ-02, GSIM-02, then the rest.
5. Advisory mode: report only. Strict mode: fix within the task. A large refactor needs a plan the user approved.
6. Never migrate data or change a public API or schema without the user's confirmation.

---

## §13. PR checklist (enabled modules only)

- [ ] agency/artefact_id/version present; URN generated (CORE-01..03)
- [ ] No payload edits on PUBLISHED rows; versionRationale set (CORE-04/05)
- [ ] References state their binding; run logs and published data are early-bound (CORE-06, GSBPM-04)
- [ ] Reuse by reference, no copied definitions (CORE-08)
- [ ] Language tags on text (CORE-09)
- [ ] Four-tier variable cascade, no shortcut FK (GSIM-02/03)
- [ ] CodeList and classification kept separate; correspondence table on a new version (CLS-01/06)
- [ ] No workflow state in DDI XML (DDI-02)
- [ ] Impact analysis before version-up or deprecation (GSBPM-06)
- [ ] No auto-publish; a human gate exists (GSBPM-08, SDC-06)
- [ ] No microdata or direct identifiers exposed; SDC parameters partitioned (SDC-01..03)
- [ ] Permission checks in the service layer, UI = API; EXPORT_DATA separate (AUTHZ-02/05)
- [ ] No won't-have features; open items not hardcoded (NSO-02, NSO-10..14)

---

## §14. Open questions and unverified points

Resolved 2026-09-25 (user): stack, agency `vn.gso`, `spring-security-acl`, international SDC thresholds.

1. Is `vn.gso` registered at registry.ddialliance.org? [Unverified]
2. What is the `spring-security-acl` roadmap in future Spring Security releases? [Unverified]
3. Proposal v1.2 §A.5 still says "pending PoC G1": update it to the settled stack.
4. DDI-L 3.3 deprecation: no standard field was found; this document uses a new version plus a Note. [Inference]
5. Population: DDI-CDI has its own class [Unverified]; the DDI-CDI spec was not read.
6. There is no official GSIM↔DDI↔SDMX mapping. The Copenhagen Mapping and the GSIM classification model on statswiki.unece.org were unreachable (HTTP 403).
7. The ToR says only "DDI-Lifecycle", without a version.
8. The object↔ACL mapping (§10) and D6 are inferences; a BA must confirm them.
9. Not read: NotebookLM (needs a Google login), the live SVN (401; used the local backup `D:\Tai-lieu-bak\CSDL_VIMO`, possibly older), `01.HoSoThau` (missing from the backup), UN Handbook chapters 8, 12 and 15 (only the tables of contents), the DDI 3.3 XSD.

---

## §15. Sources

Per-rule citations (page/slide) are in v1.0 of this file (git history) and in the research reports under `C:\Users\minhdn39\plans\reports\` (`researcher-260925-*`).

- DDI-L 3.3 model: https://ddialliance.github.io/ddimodel-web/DDI-L-3.3/ · Technical Guide 3.3, Best Practices 3.2, DDI training slides (SVN `30.REFERENCE/30.OTHER/04.TaiLieuQuocTe/DDI/`)
- GSIM 2.0: https://unece.github.io/GSIM-2.0/ · User Guide https://unece.org/sites/default/files/2025-03/GSIM%20User%20Guide.pdf
- GSBPM v5.2 (`04.TaiLieuQuocTe/GSBPM/`)
- Statistics Denmark and Statistics Canada material (`04.TaiLieuQuocTe/ThongKeDanMach/`)
- WB Metadata Editor: https://worldbank.github.io/metadata-editor-docs/ · UN Handbook NSS: https://projects.officialstatistics.org/hb-mgnt-org-nss/handbook/intro.html
- Output-checking guidelines (`04.TaiLieuQuocTe/Output-checking-guidelines.pdf`)
- Spring Security ACL: https://www.baeldung.com/spring-security-acl · docs.spring.io
- NSO-SMR research: proposal-v12, fd-01..09, wp-01..05, design-archimate, user-stories-ddi33, Template_Danhmuc (`30.REFERENCE/30.OTHER/05.KetQuaNghienCuu/`)
